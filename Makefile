# Load balancer demo: Traefik + 5 backend + MariaDB + monitoring k6.
#
# Seluruh perintah operasional project ada di sini (sebelumnya di package.json
# "scripts"). Butuh GNU Make. Di Windows recipe sengaja dijalankan lewat cmd.exe
# supaya tidak bergantung pada shell Unix yang kebetulan ada di PATH; di
# Linux/macOS dipakai /bin/sh bawaan. Setiap recipe tetap satu perintah utuh.

ifeq ($(OS),Windows_NT)
SHELL := cmd.exe
endif

NODE ?= node
BUN  ?= bun

COMPOSE_DB      := docker compose -p lb-db -f docker-compose.db.yml
COMPOSE_TRAEFIK := docker compose -p lb-traefik -f docker-compose.traefik.yml
COMPOSE_DEMO    := docker compose -p lb-demo -f docker-compose.yml
COMPOSE_K6      := docker compose -p lb-k6 -f docker-compose.monitoring.yml

# Jalur belajar Kubernetes. Cluster dan namespace sengaja terpisah dari
# Compose; port host 18080 supaya Traefik Compose (:80) tetap bisa hidup.
# (8080 di mesin ini dipakai container lain, traefik-traefik-1.)
K8S_CLUSTER   ?= lb-k8s
K8S_CONTEXT   ?= k3d-$(K8S_CLUSTER)
K8S_NAMESPACE ?= lb-demo
K8S_MONITORING_NAMESPACE ?= monitoring
K8S_IMAGE     ?= lb-backend:dev
K8S_TRAEFIK_CHART   ?= 39.0.7
K8S_TRAEFIK_IMAGE   ?= traefik:v3.6.6
# Image pihak ketiga yang sudah ada di Docker host. Di-import sekali supaya
# tidak bergantung pada pull dari registry saat pod pertama kali jalan.
K8S_IMAGES ?= traefik:v3.6.6 prom/prometheus:v3.16.0 grafana/grafana:13.3.1 mariadb:11.4 mariadb/maxscale:24.02.9 prom/mysqld-exporter:v0.17.2 grafana/k6:2.4.0
# cert-manager: versi chart = versi image, jadi keduanya dipin bersama.
K8S_CERT_MANAGER_VERSION ?= v1.18.2
K8S_CERT_MANAGER_IMAGES ?= quay.io/jetstack/cert-manager-controller:$(K8S_CERT_MANAGER_VERSION) quay.io/jetstack/cert-manager-webhook:$(K8S_CERT_MANAGER_VERSION) quay.io/jetstack/cert-manager-cainjector:$(K8S_CERT_MANAGER_VERSION) quay.io/jetstack/cert-manager-acmesolver:$(K8S_CERT_MANAGER_VERSION) quay.io/jetstack/cert-manager-startupapicheck:$(K8S_CERT_MANAGER_VERSION)
# Argo CD. Chart 10.19.1 memakai argocd v3.6.3; image-nya di-import seperti
# komponen lain supaya tidak bergantung pada registry saat pod pertama jalan.
K8S_ARGOCD_CHART   ?= 10.19.1
K8S_ARGOCD_VERSION ?= v3.6.3
K8S_ARGOCD_IMAGES  ?= quay.io/argoproj/argocd:$(K8S_ARGOCD_VERSION) ecr-public.aws.com/docker/library/redis:8.6.4-alpine
# Semua kustomization di repo ini membaca file dari folder lain (SQL, dashboard),
# jadi build memakai flag yang sama dengan Argo CD.
K8S_KUSTOMIZE = kubectl --context $(K8S_CONTEXT) kustomize --load-restrictor LoadRestrictionsNone

# Parameter uji CRUD acak; bisa dioverride dari command line, mis.
# make crud-load COUNT=500 USERS=20 MODE=create KEEP=1
COUNT  ?= 100
USERS  ?= 10
MODE   ?= full
BASE_URL ?=
KEEP   ?=
REPORT ?=
# Node yang di-rejoin. Default: bekas primary, kasus yang paling sering.
DB_NODE ?= mariadb-primary

MAKEFLAGS += --no-print-directory

# stack-up/stack-down bergantung pada urutan, bukan paralelisme.
.NOTPARALLEL:

.DEFAULT_GOAL := help

.PHONY: help \
	net-up \
	db-up db-down db-reset db-ps db-logs db-status db-rejoin db-grant-users \
	traefik-up traefik-down traefik-logs \
	docker-up docker-down docker-ps docker-logs \
	k6-up k6-run k6-watch k6-down k6-logs \
	stack stack-up stack-down clean \
	test test-backend test-docker test-db crud-load \
	k6-install k6 k6-load k6-failover \
	k8s-cluster k8s-import k8s-ingress k8s-image k8s-up k8s-down k8s-bootstrap \
	k8s-status k8s-logs k8s-load k8s-smoke k8s-destroy k8s-monitoring k8s-monitoring-down k8s-db k8s-db-down k8s-cert-manager k8s-tls k8s-argocd k8s-gitops

help:
	@echo Daftar target Makefile:
	@echo   Stack:
	@echo     make stack-up          Nyalakan network, database, Traefik, backend, monitoring
	@echo     make stack-down        Matikan semuanya dengan urutan yang benar
	@echo     make stack             Sama dengan stack-up
	@echo     make clean             stack-down + hapus image lokal lb-demo - volume tetap
	@echo   Network:
	@echo     make net-up            Buat network bersama lb-net - idempotent
	@echo   Database (1 primary + 2 replika + MaxScale):
	@echo     make db-up             Nyalakan cluster, grant user, clone replika, lalu MaxScale
	@echo     make db-down           Matikan cluster - data di volume tetap
	@echo     make db-reset          Hapus 3 volume DB, buat ulang skema + seed, clone ulang
	@echo     make db-status         Siapa primary, status replika, lag, dan jalur MaxScale
	@echo     make db-rejoin         Kembalikan node ke cluster: DB_NODE=mariadb-primary
	@echo     make db-ps             Status + health container database
	@echo     make db-logs           Log MariaDB, MaxScale, Adminer
	@echo     make db-grant-users    Buat/segarkan user lb_app, lb_repl, lb_monitor, lb_exporter
	@echo   Traefik:
	@echo     make traefik-up        Traefik saja - project lb-traefik
	@echo     make traefik-down      Matikan Traefik
	@echo     make traefik-logs      Access log Traefik
	@echo   Backend:
	@echo     make docker-up         5 backend dengan build ulang - project lb-demo
	@echo     make docker-down       Matikan 5 backend
	@echo     make docker-ps         Status + health container backend
	@echo     make docker-logs       Log 5 backend
	@echo   Monitoring:
	@echo     make k6-up             Grafana, Prometheus, k6-runner, exporter, Loki, Alloy
	@echo     make k6-run            Jalankan k6 sekali di container
	@echo     make k6-watch          k6 + web dashboard di http://k6.localhost
	@echo     make k6-down           Matikan stack monitoring - data di volume tetap
	@echo     make k6-logs           Log Grafana/Prometheus/Loki/k6
	@echo   Test:
	@echo     make test              Test Docker end-to-end - butuh Docker
	@echo     make test-backend      Unit test bun:test (kontrak HTTP + validasi + metrik) - tanpa Docker
	@echo     make test-docker       Sama dengan make test
	@echo     make test-db           Uji failover database sungguhan - mematikan primary
	@echo     make crud-load         Uji CRUD acak: COUNT=100 USERS=10 MODE=full
	@echo   k6 lokal:
	@echo     make k6-install        Unduh binary k6 resmi ke tools/k6/ - butuh Bun
	@echo     make k6                Cek versi k6 yang terpasang
	@echo     make k6-load          100 req/detik selama 15 detik
	@echo     make k6-failover      50 req/detik selama 40 detik - untuk uji failover
	@echo   Kubernetes - belajar orkestrasi, port 18080:
	@echo     make k8s-bootstrap     Buat cluster k3d + Traefik + image + manifest + monitoring
	@echo     make k8s-up            Terapkan manifest saja
	@echo     make k8s-import        Impor image pihak ketiga dari Docker host
	@echo     make k8s-db            MariaDB + MaxScale di dalam cluster
	@echo     make k8s-monitoring    Prometheus + Grafana in-cluster
	@echo     make k8s-cert-manager  cert-manager + CRD (sertifikat otomatis)
	@echo     make k8s-tls           Issuer, Certificate, HTTPS di port 18443
	@echo     make k8s-argocd        Argo CD (GitOps controller)
	@echo     make k8s-gitops        Application yang menarik k8s/gitops dari repo
	@echo     make k8s-status        Deployment, pod, Service, HPA, IngressRoute
	@echo     make k8s-load          Jalankan k6 sebagai Job - memicu HPA
	@echo     make k8s-logs          Log semua pod backend
	@echo     make k8s-smoke         GET http://server.localhost:18080 lewat ingress
	@echo     make k8s-down          Hapus resource Kubernetes - cluster tetap
	@echo     make k8s-destroy       Hapus cluster k3d seluruhnya

# --- network bersama -------------------------------------------------------

net-up:
	$(NODE) scripts/network.js

# --- database --------------------------------------------------------------
#
# Urutannya penting dan sengaja tidak diserahkan ke `depends_on`:
# 1. tiga node MariaDB naik,
# 2. user dibuat di SEMUA node (grant tidak direplikasi),
# 3. replika di-clone dari node yang sedang bisa ditulis,
# 4. MaxScale baru dinyalakan setelah ada replika yang sehat — kalau tidak,
#    ia sempat melihat replika yang belum punya data.
# Semua langkah idempotent, jadi `make db-up` aman diulang.

db-up:
	$(COMPOSE_DB) up -d mariadb-primary mariadb-replica-1 mariadb-replica-2
	$(NODE) scripts/db-grant-users.js
	$(NODE) scripts/db-replica-clone.js
	$(COMPOSE_DB) up -d maxscale adminer

db-down:
	$(COMPOSE_DB) down

db-reset:
	$(COMPOSE_DB) down -v
	$(COMPOSE_DB) up -d mariadb-primary mariadb-replica-1 mariadb-replica-2
	$(NODE) scripts/db-grant-users.js
	$(NODE) scripts/db-replica-clone.js
	$(COMPOSE_DB) up -d maxscale adminer

db-status:
	$(NODE) scripts/db-cluster-status.js

# Primary lama tidak pernah masuk kembali otomatis (`auto_rejoin=false`).
# Perintah ini membuang datanya yang mungkin bercabang lalu meng-clone ulang
# dari primary yang sah, jadi aman dipakai juga untuk replika yang rusak.
db-rejoin:
ifeq ($(origin NODE),command line)
ifneq ($(origin DB_NODE),command line)
	$(error Gunakan DB_NODE=$(NODE) - variabel NODE dipakai Makefile untuk binary Node.js)
endif
endif
	$(NODE) scripts/db-grant-users.js $(DB_NODE)
	$(NODE) scripts/db-replica-clone.js --force $(DB_NODE)

db-ps:
	$(COMPOSE_DB) ps

db-logs:
	$(COMPOSE_DB) logs --tail=80

db-grant-users:
	$(NODE) scripts/db-grant-users.js

# --- traefik ---------------------------------------------------------------

traefik-up:
	$(COMPOSE_TRAEFIK) up -d

traefik-down:
	$(COMPOSE_TRAEFIK) down

traefik-logs:
	$(COMPOSE_TRAEFIK) logs --tail=80

# --- backend ---------------------------------------------------------------

docker-up:
	$(COMPOSE_DEMO) up -d --build

docker-down:
	$(COMPOSE_DEMO) down --remove-orphans

docker-ps:
	$(COMPOSE_DEMO) ps

docker-logs:
	$(COMPOSE_DEMO) logs --tail=80

# --- monitoring ------------------------------------------------------------

k6-up:
	$(COMPOSE_K6) up -d --build grafana prometheus k6-runner mysqld-exporter-primary mysqld-exporter-replica-1 mysqld-exporter-replica-2 loki alloy

k6-run:
	$(COMPOSE_K6) run --rm k6

k6-watch:
	$(COMPOSE_K6) run --rm --service-ports -e K6_WEB_DASHBOARD=true k6

k6-down:
	$(COMPOSE_K6) down --remove-orphans

k6-logs:
	$(COMPOSE_K6) logs --tail=80

# --- seluruh stack ---------------------------------------------------------

stack: stack-up

# Prasyarat dijalankan berurutan karena .NOTPARALLEL di atas.
stack-up: net-up db-up traefik-up docker-up k6-up

stack-down: k6-down docker-down traefik-down db-down

clean: stack-down
	$(COMPOSE_DEMO) down --rmi local

# --- test ------------------------------------------------------------------

test:
	$(NODE) --test --test-reporter=spec test/docker/lb-docker.test.js

test-docker: test

test-backend:
	$(BUN) test test/backend

test-db:
	$(NODE) --test --test-reporter=spec test/docker/db-failover.test.js test/docker/alert-rules.test.js

# Uji CRUD acak lewat load balancer (butuh stack hidup). Data dibersihkan lagi
# di akhir kecuali KEEP=1. Mode: full (POST/GET/PUT/GET/DELETE/GET 404) atau
# create (POST saja).
crud-load:
	$(NODE) scripts/crud-load.js --count $(COUNT) --users $(USERS) --mode $(MODE) $(if $(BASE_URL),--base $(BASE_URL)) $(if $(filter-out 0,$(KEEP)),--keep) $(if $(REPORT),--report $(REPORT))

# --- k6 lokal (binary, bukan container) ------------------------------------

k6-install:
	$(BUN) scripts/install-k6.js

k6:
	$(BUN) scripts/k6.js

k6-load:
	$(BUN) scripts/k6.js run k6/load-test.js

k6-failover:
	$(BUN) scripts/k6.js run k6/failover.js -e DURATION=40s

# --- Kubernetes (jalur belajar orkestrasi) ---------------------------------
#
# Berdampingan dengan Compose, bukan menggantikannya: Traefik Compose tetap di
# port 80, Traefik k8s di port 18080. Cluster punya network sendiri, jadi pod
# menjangkau MaxScale lewat `host.docker.internal:4006` (port host dibuka oleh
# docker-compose.db.yml). Dokumentasi lengkap: docs/kubernetes.md

k8s-cluster:
	k3d cluster create --config k8s/cluster/k3d-config.yaml

# Image pihak ketiga (Traefik, Prometheus, Grafana, MariaDB, MaxScale, exporter,
# k6) di-import dari Docker host. `make k8s-image` khusus image backend yang
# dibangun dari repo ini.
k8s-import:
	$(BUN) scripts/k8s-image.js $(K8S_IMAGES) --cluster $(K8S_CLUSTER)

# Image Traefik di-import dulu ke node: Docker Hub menolak sebagian layer
# Traefik 3.8 di mesin ini, dan `k3d image import` rusak (lihat
# scripts/k8s-image.js). Chart 39 + image 3.6.6 = versi yang sama dengan
# stack Compose.
k8s-ingress:
	docker image inspect $(K8S_TRAEFIK_IMAGE) >/dev/null 2>&1 || docker pull $(K8S_TRAEFIK_IMAGE)
	$(BUN) scripts/k8s-image.js $(K8S_TRAEFIK_IMAGE) --cluster $(K8S_CLUSTER)
	helm repo add traefik https://traefik.github.io/charts --force-update
	helm repo update traefik
	helm upgrade --install traefik traefik/traefik --version $(K8S_TRAEFIK_CHART) --namespace traefik --create-namespace --values k8s/cluster/traefik-values.yaml --wait

k8s-image:
	docker build -f docker/backend.Dockerfile -t $(K8S_IMAGE) .
	$(BUN) scripts/k8s-image.js $(K8S_IMAGE) --cluster $(K8S_CLUSTER)
	-kubectl --context $(K8S_CONTEXT) -n $(K8S_NAMESPACE) rollout restart deploy/backend
	-kubectl --context $(K8S_CONTEXT) -n $(K8S_NAMESPACE) rollout status deploy/backend --timeout=120s

k8s-up:
	kubectl --context $(K8S_CONTEXT) apply -k k8s/overlays/local

k8s-down:
	kubectl --context $(K8S_CONTEXT) delete -k k8s/overlays/local --ignore-not-found
	kubectl --context $(K8S_CONTEXT) delete -k k8s/db --ignore-not-found
	kubectl --context $(K8S_CONTEXT) delete -k k8s/monitoring --ignore-not-found
	kubectl --context $(K8S_CONTEXT) delete -f k8s/monitoring/traefik-metrics.yaml --ignore-not-found

# Monitoring in-cluster. ConfigMap Grafana dibuat dari folder monitoring/
# (satu sumber dengan Compose), bukan disalin ke YAML.
k8s-monitoring:
	kubectl --context $(K8S_CONTEXT) apply -f k8s/monitoring/traefik-metrics.yaml
	$(K8S_KUSTOMIZE) k8s/monitoring | kubectl --context $(K8S_CONTEXT) apply -f -
	kubectl --context $(K8S_CONTEXT) -n $(K8S_MONITORING_NAMESPACE) rollout restart deploy/prometheus
	kubectl --context $(K8S_CONTEXT) -n $(K8S_MONITORING_NAMESPACE) rollout status deploy/prometheus deploy/grafana --timeout=180s

k8s-monitoring-down:
	kubectl --context $(K8S_CONTEXT) delete -k k8s/monitoring --ignore-not-found
	kubectl --context $(K8S_CONTEXT) delete -f k8s/monitoring/traefik-metrics.yaml --ignore-not-found

# cert-manager: CRD + controller. Image di-import dulu karena registry bisa
# menolak sebagian layer di mesin ini.
k8s-cert-manager:
	$(BUN) scripts/k8s-image.js $(K8S_CERT_MANAGER_IMAGES) --cluster $(K8S_CLUSTER)
	helm repo add jetstack https://charts.jetstack.io --force-update
	helm repo update jetstack
	helm upgrade --install cert-manager jetstack/cert-manager --version $(K8S_CERT_MANAGER_VERSION) --namespace cert-manager --create-namespace --set crds.enabled=true --wait --timeout 5m

# Issuer + Certificate, lalu IngressRoute dipasang ulang supaya TLS-nya aktif.
# HTTPS: https://server.localhost:18443 (sertifikat self-signed).
k8s-tls:
	kubectl --context $(K8S_CONTEXT) apply -f k8s/tls/clusterissuer.yaml
	kubectl --context $(K8S_CONTEXT) apply -f k8s/tls/certificates.yaml
	kubectl --context $(K8S_CONTEXT) -n $(K8S_NAMESPACE) wait --for=condition=Ready certificate/backend-tls --timeout=120s
	kubectl --context $(K8S_CONTEXT) -n $(K8S_MONITORING_NAMESPACE) wait --for=condition=Ready certificate/monitoring-tls --timeout=120s
	kubectl --context $(K8S_CONTEXT) apply -k k8s/overlays/local
	$(K8S_KUSTOMIZE) k8s/monitoring | kubectl --context $(K8S_CONTEXT) apply -f -

# Argo CD: satu Application menarik seluruh folder k8s/gitops dari repo, lalu
# menyinkronkan sendiri setiap perubahan yang di-push.
# UI: http://argocd.localhost:18080 (admin + password di Secret
# argocd-initial-admin-secret).
k8s-argocd:
	$(BUN) scripts/k8s-image.js $(K8S_ARGOCD_IMAGES) --cluster $(K8S_CLUSTER)
	helm repo add argo https://argoproj.github.io/argo-helm --force-update
	helm repo update argo
	helm upgrade --install argocd argo/argo-cd --version $(K8S_ARGOCD_CHART) --namespace argocd --create-namespace --values k8s/cluster/argocd-values.yaml --wait --timeout 10m
	kubectl --context $(K8S_CONTEXT) wait --for=condition=Established crd/applications.argoproj.io --timeout=120s

# Pasang manifest GitOps sekali dari mesin ini, lalu Application `lb-demo` yang
# mengambil alih. Butuh repo sudah di-push: Argo membaca dari GitHub, bukan dari
# working tree lokal.
k8s-gitops:
	$(K8S_KUSTOMIZE) k8s/gitops | kubectl --context $(K8S_CONTEXT) apply -f -
	kubectl --context $(K8S_CONTEXT) apply -f k8s/gitops/application.yaml
	kubectl --context $(K8S_CONTEXT) -n argocd rollout status deploy/argocd-server --timeout=180s

# Database in-cluster. ConfigMap init dibuat dari SQL yang juga dipakai Compose
# (001-schema.sql), ditambah user khas Kubernetes (002-users.sql).
k8s-db:
	$(K8S_KUSTOMIZE) k8s/db | kubectl --context $(K8S_CONTEXT) apply -f -
	kubectl --context $(K8S_CONTEXT) -n $(K8S_NAMESPACE) rollout status statefulset/mariadb --timeout=240s
	kubectl --context $(K8S_CONTEXT) -n $(K8S_NAMESPACE) rollout status deploy/maxscale deploy/mysqld-exporter --timeout=180s

# PVC `data-mariadb-0` sengaja tidak dihapus: data tetap ada kalau StatefulSet
# dibuat ulang. Hapus manual kalau ingin mulai dari nol.
k8s-db-down:
	kubectl --context $(K8S_CONTEXT) delete -k k8s/db --ignore-not-found

k8s-bootstrap: k8s-cluster k8s-import k8s-ingress k8s-image k8s-db k8s-up k8s-monitoring k8s-cert-manager k8s-tls k8s-argocd k8s-gitops k8s-argocd k8s-gitops

k8s-status:
	kubectl --context $(K8S_CONTEXT) -n $(K8S_NAMESPACE) get deploy,statefulset,pods,svc,hpa,ingressroutes
	kubectl --context $(K8S_CONTEXT) -n $(K8S_MONITORING_NAMESPACE) get deploy,pods,svc

k8s-logs:
	kubectl --context $(K8S_CONTEXT) -n $(K8S_NAMESPACE) logs -l app=backend --tail=50 --prefix=true

# ConfigMap dibuat dari folder k6/ (bukan disalin ke manifest), lalu Job
# dijalankan ulang. `kubectl wait` membuat make berhenti kalau k6 gagal.
k8s-load:
	kubectl --context $(K8S_CONTEXT) -n $(K8S_NAMESPACE) create configmap k6-scripts --from-file=load-test.js=k6/load-test.js --from-file=backend-counters.js=k6/lib/backend-counters.js --dry-run=client -o yaml | kubectl --context $(K8S_CONTEXT) apply -f -
	kubectl --context $(K8S_CONTEXT) -n $(K8S_NAMESPACE) delete job k6-load --ignore-not-found
	kubectl --context $(K8S_CONTEXT) -n $(K8S_NAMESPACE) apply -f k8s/jobs/k6-load-job.yaml
	kubectl --context $(K8S_CONTEXT) -n $(K8S_NAMESPACE) wait --for=condition=complete job/k6-load --timeout=180s
	kubectl --context $(K8S_CONTEXT) -n $(K8S_NAMESPACE) logs job/k6-load

k8s-smoke:
	curl -s -H "Host: server.localhost" http://127.0.0.1:18080/

k8s-destroy:
	k3d cluster delete $(K8S_CLUSTER)


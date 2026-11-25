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
# Compose; port host 8080 supaya Traefik Compose (:80) tetap bisa hidup.
K8S_CLUSTER   ?= lb-k8s
K8S_CONTEXT   ?= k3d-$(K8S_CLUSTER)
K8S_NAMESPACE ?= lb-demo
K8S_IMAGE     ?= lb-backend:dev
K8S_TRAEFIK_CHART   ?= 39.0.7
K8S_TRAEFIK_IMAGE   ?= traefik:v3.6.6

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
	k8s-cluster k8s-ingress k8s-image k8s-up k8s-down k8s-bootstrap \
	k8s-status k8s-logs k8s-load k8s-smoke k8s-destroy

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
	@echo   Kubernetes - belajar orkestrasi, port 8080:
	@echo     make k8s-bootstrap     Buat cluster k3d + Traefik + image + manifest
	@echo     make k8s-up            Terapkan manifest saja
	@echo     make k8s-status        Deployment, pod, Service, HPA, IngressRoute
	@echo     make k8s-load          Jalankan k6 sebagai Job - memicu HPA
	@echo     make k8s-logs          Log semua pod backend
	@echo     make k8s-smoke         GET http://server.localhost:8080 lewat ingress
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
# port 80, Traefik k8s di port 8080. Cluster punya network sendiri, jadi pod
# menjangkau MaxScale lewat `host.docker.internal:4006` (port host dibuka oleh
# docker-compose.db.yml). Dokumentasi lengkap: docs/kubernetes.md

k8s-cluster:
	k3d cluster create --config k8s/cluster/k3d-config.yaml

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

k8s-bootstrap: k8s-cluster k8s-ingress k8s-image k8s-up

k8s-status:
	kubectl --context $(K8S_CONTEXT) -n $(K8S_NAMESPACE) get deploy,pods,svc,hpa,ingressroutes

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
	curl -s -H "Host: server.localhost" http://127.0.0.1:8080/

k8s-destroy:
	k3d cluster delete $(K8S_CLUSTER)


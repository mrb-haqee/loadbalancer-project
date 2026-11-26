# Kubernetes — jalur belajar orkestrasi

Dokumen ini menjelaskan **jalur kedua** untuk menjalankan project ini: stack yang
sama, tetapi backend-nya dikelola Kubernetes (k3d) alih-alih Docker Compose.

> **Status: sarana belajar, bukan produksi.** Stack Compose tetap menjadi cara
> utama menjalankan demo. Jalur ini dibuat untuk mempelajari Deployment, Service,
> probe, rolling update, HPA, Job, dan Ingress dengan beban kerja yang sudah
> dikenal — bukan karena project ini membutuhkan Kubernetes. Alasan dan
> trade-off-nya ada di [`docs/adr/0016-kubernetes-learning-track.md`](adr/0016-kubernetes-learning-track.md).

## 1. Prasyarat

| Kebutuhan | Versi yang dipakai | Cara pasang (Windows) |
|---|---|---|
| Docker Desktop | 28.3.3 (Linux containers) | sudah ada |
| GNU Make + Node.js | — | sudah dipakai stack Compose |
| [k3d](https://k3d.io) | 5.9.0 | `winget install --id k3d.k3d --exact` |
| [Helm](https://helm.sh) | 4.3.2 | `winget install --id Helm.Helm --exact` |
| kubectl | bawaan Docker Desktop | sudah ada |

Setelah instalasi, buka terminal baru supaya `PATH` diperbarui. Cek dengan:

```powershell
k3d version
helm version --short
kubectl version --client
```

**k3s dipin ke `v1.32.9-k3s1`.** k3s 1.33+ menolak berjalan di host dengan
cgroup v1, dan Docker Desktop di mesin ini masih memakai cgroup v1 — kubelet
langsung mati dengan pesan `kubelet is configured to not run on a host using
cgroup v1`. Versi dipin di `k8s/cluster/k3d-config.yaml`; naikkan setelah
Docker Desktop memakai cgroup v2 (cek: `docker info | Select-String Cgroup`).

Database **juga berjalan di dalam cluster** (fase 3): MariaDB sebagai
StatefulSet dengan PVC, MaxScale di depannya. Cluster k3d punya network sendiri
yang terpisah dari `lb-net`, jadi tidak ada port database yang dibuka ke host.
Jalur Compose tetap memakai database Compose sendiri; keduanya berdiri sendiri.

## 2. Quickstart

```powershell
make k8s-bootstrap   # cluster + image + database + aplikasi + monitoring + TLS + Argo CD
make k8s-status      # Deployment, pod, Service, HPA, IngressRoute
make k8s-smoke       # GET lewat ingress
```

`k8s-bootstrap` menjalankan berurutan:

1. `k8s-cluster` — `k3d cluster create` dari `k8s/cluster/k3d-config.yaml`.
2. `k8s-import` — impor image pihak ketiga (Traefik, Prometheus, Grafana,
   MariaDB, MaxScale, exporter, k6) dari Docker host.
3. `k8s-ingress` — import image Traefik, lalu `helm upgrade --install`.
4. `k8s-image` — `docker build` image backend, lalu impor ke tiap node.
5. `k8s-db` — MariaDB StatefulSet + MaxScale + exporter.
6. `k8s-up` — Deployment, Service, HPA, PDB, quota, IngressRoute.
7. `k8s-monitoring` — Prometheus + Grafana in-cluster.
8. `k8s-cert-manager` + `k8s-tls` — sertifikat otomatis, HTTPS.
9. `k8s-argocd` + `k8s-gitops` — Argo CD, lalu Application yang menarik folder
   `k8s/gitops` dari repo.

Impor image memakai `scripts/k8s-image.js` (`docker save` → `docker cp` →
`ctr images import`), bukan `k3d image import`. Di setup Windows/Docker Desktop
ini `k3d image import` gagal dengan `ctr: content digest ...: not found`. Skrip
itu menarik image dari registry kalau belum ada di Docker host.

Fase 9 (`k8s-gitops`) membaca repo GitHub, jadi commit harus sudah di-push.
Setelah Application dibuat, Argo CD yang menyinkronkan perubahan berikutnya;
`make k8s-up`/`k8s-db`/`k8s-monitoring` berhenti dipakai untuk perubahan
sehari-hari (keduanya sama-sama aman dipanggil, tetapi job Argo yang menang).

### URL

| URL | Arti |
|---|---|
| `https://server.localhost:18443/` | Load balancing ke 5 pod backend |
| `https://server.localhost:18443/ui` | UI katalog |
| `https://grafana.localhost:18443/` | Grafana (admin/admin) |
| `https://prometheus.localhost:18443/` | Prometheus |
| `https://argocd.localhost:18443/` | Argo CD (admin + password di Secret) |
| `https://traefik.localhost:18443/dashboard/` | Dashboard Traefik |
| `http://server.localhost:18080/` | HTTP biasa, dialihkan (301) ke HTTPS |

Port **18080/18443**, bukan 80/443: Traefik Compose tetap memegang port 80.
Kedua jalur bisa hidup bersamaan dan dibandingkan. Sertifikatnya self-signed,
jadi browser memperingatkan; `curl -k` untuk uji cepat.

## 3. Arsitektur

```
 host Windows
 ┌──────────────────────────────────────────────────────────────┐
 │  Compose (tetap)                    k3d cluster lb-k8s       │
 │  ┌────────────────────┐             ┌──────────────────────┐ │
 │  │ Traefik :80        │             │ Traefik :80/:443     │ │
 │  │ 5 backend :3000    │             │  ↳ IngressRoute TLS  │ │
 │  │ MariaDB + MaxScale │             │ 5 pod backend :3000  │ │
 │  │ monitoring         │             │ MariaDB + MaxScale   │ │
 │  └────────────────────┘             │ Prometheus + Grafana │ │
 │                                     │ Argo CD              │ │
 │                                     └──────────────────────┘ │
 │         ▲                                    ▲               │
 │         └────── port 80 ──────────────────────┴─ 18080/18443 ─┘
 └──────────────────────────────────────────────────────────────┘
```

Cluster: 1 server + 2 agent (k3s di dalam container Docker), network sendiri,
terpisah dari `lb-net`. Dua jalur tidak berbagi apa pun — database Compose dan
database k8s masing-masing berdiri sendiri. Yang menyamakan keduanya hanya
sumber manifest (SQL dan dashboard dibaca dari folder yang sama lewat
`configMapGenerator`) dan port host yang berbeda.

## 4. Peta Compose → Kubernetes

| Compose | Kubernetes | File |
|---|---|---|
| 5 service `server-1..5` | 1 Deployment `replicas: 5` | `k8s/base/backend-deployment.yaml` |
| `BACKEND_ID: server-N` | `BACKEND_ID` = `metadata.name` (Downward API) | idem |
| `traefik.http.services.demo` | Service `backend` (ClusterIP) | `k8s/base/backend-service.yaml` |
| Label router `demo` | IngressRoute `backend` | `k8s/base/backend-ingressroute.yaml` |
| Middleware retry | Middleware `backend-retry` | idem |
| `serversTransport.forwardingTimeouts` | ServersTransport `backend-transport` | idem |
| `environment:` | ConfigMap + Secret | `backend-configmap.yaml`, `backend-secret.yaml` |
| `HEALTHCHECK` + health check Traefik | startup/readiness/liveness probe | `backend-deployment.yaml` |
| `restart: unless-stopped` | ReplicaSet + probe (self-healing) | idem |
| `docker compose up --build` | `make k8s-image` + rollout | Makefile |
| `make k6-run` | Job `k6-load` | `k8s/jobs/k6-load-job.yaml` |
| — (tidak ada) | HPA 5–10 pod | `k8s/base/backend-hpa.yaml` |
| `traefik.yml` (file statis) | values chart Traefik | `k8s/cluster/traefik-values.yaml` |
| service `db`/`maxscale` (Compose) | StatefulSet `mariadb` + Deployment `maxscale` | `k8s/db/` |
| volume `db-data` | `volumeClaimTemplates` + PVC 1Gi | `k8s/db/mariadb.yaml` |
| `db/init/001-schema.sql` | ConfigMap `mariadb-init` (generator) | `k8s/db/kustomization.yaml` |
| `db-exporter` | Deployment `mysqld-exporter` | `k8s/db/exporter.yaml` |
| Prometheus/Grafana (profil Compose) | Deployment + PVC + IngressRoute | `k8s/monitoring/` |
| dashboard JSON di `monitoring/grafana` | ConfigMap `grafana-dashboards` (generator) | `k8s/monitoring/kustomization.yaml` |
| — (TLS tidak ada) | cert-manager + Certificate + IngressRoute `websecure` | `k8s/tls/`, `k8s/base/http-redirect.yaml` |
| Secret YAML | SealedSecret (terenkripsi di repo) | `k8s/base/backend-sealedsecret.yaml` |
| `docker compose up` | Argo CD Application `lb-demo` | `k8s/gitops/` |

Perbedaan yang disengaja:

- **Identitas**: Compose memakai `server-1`, k8s memakai nama pod
  (`backend-7d9f8c6b5-2xk4p`). Header `X-Served-By` karena itu lebih panjang;
  skrip k6 sudah menerima keduanya.
- **Router langsung `server-N.localhost` tidak dibuat.** Di k8s, akses satu pod
  dilakukan dengan `kubectl port-forward`, bukan host khusus — ini justru
  memperlihatkan bahwa pod adalah unit yang sementara.
- **Metrik tetap per proses.** `/metrics` tiap pod hanya berisi angka pod itu.
  Agregasi adalah tugas Prometheus (fase 2), sama seperti di Compose.
- **Readiness mengecek database**, liveness tidak. Database mati mengeluarkan
  pod dari Service tanpa me-restart-nya. Konsekuensinya endpoint echo juga ikut
  tidak dilayani selama DB mati; itu trade-off yang disengaja untuk latihan.

## 5. Isi direktori

```
k8s/
├── cluster/
│   ├── k3d-config.yaml          # 1 server + 2 agent, k3s 1.32, port 18080/18443
│   ├── traefik-values.yaml      # dashboard, access log, metrik Prometheus
│   └── argocd-values.yaml       # Argo CD ramping (dex/notifications mati)
├── base/                        # manifest generik
│   ├── kustomization.yaml
│   ├── namespace.yaml
│   ├── backend-configmap.yaml
│   ├── backend-sealedsecret.yaml
│   ├── backend-deployment.yaml  # 5 replika, probe, resource, spread
│   ├── backend-service.yaml
│   ├── backend-hpa.yaml
│   ├── backend-pdb.yaml
│   ├── quota.yaml               # ResourceQuota + LimitRange
│   ├── backend-ingressroute.yaml
│   └── http-redirect.yaml       # redirect HTTP -> HTTPS
├── db/
│   ├── kustomization.yaml       # generator ConfigMap mariadb-init
│   ├── mariadb.yaml             # StatefulSet + PVC + headless Service
│   ├── maxscale.yaml            # Deployment + Service maxscale:4006
│   ├── exporter.yaml            # mysqld-exporter
│   └── 002-users.sql            # user lb_app/lb_monitor/lb_exporter
├── monitoring/
│   ├── kustomization.yaml       # generator ConfigMap dashboard & provisioning
│   ├── prometheus.yaml          # Deployment + RBAC + scrape config
│   ├── grafana.yaml             # Deployment + PVC + IngressRoute
│   ├── traefik-metrics.yaml     # Service metrik Traefik (namespace traefik)
│   └── namespace.yaml
├── tls/
│   ├── clusterissuer.yaml       # ClusterIssuer self-signed
│   └── certificates.yaml        # Certificate backend + monitoring
├── gitops/
│   ├── kustomization.yaml       # gabungan semua di atas
│   ├── application.yaml         # Argo CD Application `lb-demo`
│   └── argocd.yaml              # Certificate + IngressRoute UI Argo CD
├── overlays/
│   └── local/kustomization.yaml # tag image `dev`
└── jobs/
    └── k6-load-job.yaml         # k6 sebagai Job
```

Di luar `k8s/`, satu skrip membantu memasukkan image ke cluster:
`scripts/k8s-image.js` (dipakai `make k8s-image`, `k8s-import`, `k8s-argocd`).

Base sengaja tidak menyebut tag image; overlay `local` yang menetapkan
`lb-backend:dev`. Overlay lain (mis. `prod`) tinggal ditambahkan tanpa
menyentuh base.

`configMapGenerator` membaca SQL dan dashboard dari folder aslinya (di luar
root kustomization), jadi build memakai
`kubectl kustomize --load-restrictor LoadRestrictionsNone`. Makefile
membungkusnya di variabel `K8S_KUSTOMIZE`; Argo CD mendapat flag yang sama lewat
`configs.cm."kustomize.buildOptions"` di `argocd-values.yaml`.

## 6. Latihan bertahap

Semua perintah memakai context `k3d-lb-k8s` dan namespace `lb-demo`.

### 6.1 Melihat apa yang berjalan

```powershell
kubectl --context k3d-lb-k8s -n lb-demo get deploy,pods,svc,hpa,ingressroutes
kubectl --context k3d-lb-k8s -n lb-demo get endpoints backend
kubectl --context k3d-lb-k8s -n lb-demo describe pod -l app=backend
```

Perhatikan: 5 pod tersebar di 3 node (topology spread), dan `endpoints backend`
berisi 5 IP pod — itulah yang dipakai Service.

### 6.2 Skala manual vs HPA

```powershell
kubectl -n lb-demo scale deploy/backend --replicas=8
kubectl -n lb-demo get pods -l app=backend -w
kubectl -n lb-demo scale deploy/backend --replicas=5
```

HPA akan mengembalikan jumlah ke minimal 5. Untuk melihat HPA bekerja:

```powershell
kubectl -n lb-demo get hpa backend -w
make k8s-load
```

Job k6 mengirim 100 req/detik selama 30 detik ke Service `backend`. Kalau CPU
rata-rata melewati 70% dari request (50m), HPA menambah pod sampai 10.

Hasil yang terukur di mesin ini: 3001 request, 0 gagal, p95 ≈ 1,3 ms; HPA naik
dari 5 ke 10 pod dalam hitungan detik, lalu menyusut lagi setelah beban
berhenti (default `stabilizationWindowSeconds` 300 detik untuk scale down).

### 6.3 Rolling update tanpa downtime

```powershell
kubectl -n lb-demo rollout restart deploy/backend
kubectl -n lb-demo rollout status deploy/backend
```

Sambil rollout, jalankan di terminal lain:

```powershell
while ($true) { curl.exe -sk -o NUL -w "%{http_code}`n" --resolve server.localhost:18443:127.0.0.1 https://server.localhost:18443/ }
```

`maxUnavailable: 0` + `maxSurge: 1` + `preStop` menjaga tidak ada request yang
jatuh ke pod yang sudah mati.

### 6.4 Self-healing

```powershell
kubectl -n lb-demo delete pod -l app=backend --wait=false
kubectl -n lb-demo get pods -l app=backend -w
```

ReplicaSet membuat pod pengganti. Bandingkan dengan `docker rm -f` di Compose:
hasilnya mirip, tetapi di sini ada controller yang menjamin jumlah replika.

### 6.5 Readiness vs liveness

Matikan database (MaxScale) sementara:

```powershell
kubectl -n lb-demo scale deploy/maxscale --replicas=0
kubectl -n lb-demo get pods -l app=backend -w      # READY 0/1, STATUS Running
kubectl -n lb-demo get endpoints backend           # kosong
curl.exe -sk -i --resolve server.localhost:18443:127.0.0.1 https://server.localhost:18443/
kubectl -n lb-demo scale deploy/maxscale --replicas=1
```

Pod **tidak restart** (liveness tetap `/health`), tetapi dikeluarkan dari
Service. Setelah MaxScale hidup lagi, readiness pulih sendiri. Ini perbedaan
penting antara "proses hidup" dan "siap melayani".

Dengan `automated.selfHeal`, Argo CD akan mengembalikan replika MaxScale ke 1
dalam beberapa menit. Untuk latihan yang tidak "dikoreksi" Argo, lakukan pada
cluster tanpa Application, atau uji lewat `kubectl delete pod`.

### 6.6 Akses satu pod

```powershell
kubectl -n lb-demo get pods -l app=backend
kubectl -n lb-demo port-forward pod/<nama-pod> 3001:3000
curl.exe http://127.0.0.1:3001/halo
```

Ini pengganti `server-N.localhost` di Compose.

### 6.7 Log dan metrics

```powershell
kubectl -n lb-demo logs -l app=backend --tail=20 --prefix=true
kubectl -n lb-demo exec deploy/backend -- wget -qO- http://127.0.0.1:3000/metrics
```

### 6.8 Melihat isi manifest setelah Kustomize

```powershell
kubectl kustomize --load-restrictor LoadRestrictionsNone k8s/gitops
```

Perintah ini tidak menyentuh cluster; berguna untuk melihat hasil akhir
sebelum `apply`. Flag `--load-restrictor` diperlukan karena generator membaca
file di luar root kustomization.

### 6.9 Database in-cluster

```powershell
kubectl -n lb-demo get statefulset,pvc
kubectl -n lb-demo exec mariadb-0 -- mariadb -uroot -plb_root_password -e "SHOW DATABASES;"
kubectl -n lb-demo scale statefulset/mariadb --replicas=0   # lalu naikkan lagi
```

Saat StatefulSet dibuat ulang, PVC `data-mariadb-0` **tidak** ikut terhapus —
data tetap ada. Hapus manual kalau ingin mulai dari nol.

MariaDB butuh limit memori 1Gi. Dengan 512Mi, container `OOMKilled`: page cache
PVC ikut dihitung cgroup saat InnoDB memuat ulang.

### 6.10 Monitoring in-cluster

```powershell
kubectl -n monitoring get pods,svc
kubectl -n monitoring port-forward svc/prometheus 9090:9090   # lalu buka /targets
```

`make k8s-monitoring` memasang Prometheus + Grafana tanpa operator. Dashboard
dan datasource dibaca dari `monitoring/grafana` lewat ConfigMap. ServiceMonitor,
Loki, dan Alloy sengaja tidak dipakai (butuh operator/DaemonSet).

### 6.11 TLS dan rahasia terjaga

```powershell
kubectl get certificate -A
kubectl -n lb-demo get sealedsecret,secret backend-secret
```

Certificate melahirkan Secret `backend-tls`/`monitoring-tls` dan memperbaruinya
otomatis. `backend-sealedsecret.yaml` memuat password terenkripsi; controller
SealedSecrets mendekripsinya jadi Secret. Uji: hapus Secret-nya, controller
membuat ulang.

```powershell
kubectl -n lb-demo delete secret backend-secret
kubectl -n lb-demo get secret backend-secret -o jsonpath='{.metadata.ownerReferences[0].name}'
```

`kubeseal` dipakai untuk membuat SealedSecret:
`tools/kubeseal/kubeseal.exe --format yaml --namespace lb-demo < secret.yaml`.
Folder `tools/kubeseal/` di-`.gitignore`.

### 6.12 GitOps dengan Argo CD

```powershell
kubectl -n argocd get application lb-demo
kubectl -n argocd get application lb-demo -o jsonpath='{.status.sync.status}'
```

Argo CD menyinkronkan folder `k8s/gitops` dari repo. Coba: ubah jumlah replika
HPA lalu lihat Argo **tidak** menimpanya (`ignoreDifferences` pada
`spec.replicas`). Lalu ubah sesuatu di git, push, dan Argo menariknya sendiri.

```powershell
kubectl -n lb-demo scale deploy/backend --replicas=6   # HPA mengembalikan; Argo diam
kubectl -n argocd annotate application lb-demo argocd.argoproj.io/refresh=normal --overwrite
```

## 7. Status tiap fase

| Fase | Isi | Status |
|---|---|---|
| 1 | backend Deployment + IngressRoute, probe, rolling update, HPA, Job k6 | selesai |
| 2 | PDB, ResourceQuota + LimitRange, Prometheus + Grafana in-cluster | selesai |
| 3 | MariaDB StatefulSet + PVC, MaxScale, mysqld-exporter | selesai |
| 4 | cert-manager + TLS, SealedSecrets, Argo CD | selesai |

Yang **sengaja belum** dikerjakan, bersama alasan dan jalur naiknya:

| Belum | Alasan | Kalau mau lanjut |
|---|---|---|
| ServiceMonitor, Loki, Alloy | butuh Prometheus Operator/DaemonSet; `kubernetes_sd` sudah cukup untuk metrik | pasang kube-prometheus-stack, lalu `loki.source.kubernetes` |
| NetworkPolicy | flannel bawaan k3s tidak menegakkannya | pasang Calico/Cilium |
| GitOps untuk Traefik/cert-manager/Argo CD sendiri | dipasang Helm sekali, di luar `k8s/gitops` | buat Application per chart (app-of-apps) |
| Operator MariaDB/MaxScale | satu replika cukup untuk belajar | pasang mariadb-operator, uji failover |
| Repo privat + Argo CD | butuh credential/deploy key | tambahkan repository secret di Argo CD |

Fase 1 sengaja berhenti di backend + ingress supaya setiap konsep dicerna
sebelum menambah kompleksitas.

## 8. Troubleshooting

| Gejala | Penyebab umum | Solusi |
|---|---|---|
| Node `NotReady`, log server berhenti sendiri | k3s 1.33+ di cgroup v1 | pakai `image: rancher/k3s:v1.32.9-k3s1` di `k3d-config.yaml` |
| `kubectl` → `connection refused` ke `host.docker.internal` | kubeconfig memakai nama host, bukan loopback | `kubeAPI.host: 127.0.0.1` di `k3d-config.yaml`; atau `kubectl config set-cluster k3d-lb-k8s --server=https://127.0.0.1:<port>` |
| `k3d cluster create` gagal: port dipakai | 18080/18443 sudah dipakai proses lain | ubah `ports` di `k8s/cluster/k3d-config.yaml`, buat ulang cluster |
| `k3d image import`: `ctr: content digest ... not found` | bug k3d di Windows/Docker Desktop | pakai `bun scripts/k8s-image.js <image>` (dipakai `make k8s-image`) |
| `docker pull` gagal: `tls: bad record MAC` | registry menolak satu layer | coba lagi; `scripts/k8s-image.js` menarik image yang belum ada |
| Helm: `values don't meet the specifications ... '/service/type'` | values chart 43 dipakai dengan chart 39 | pasangkan `k8s/cluster/traefik-values.yaml` dengan chart 39 |
| Pod `ImagePullBackOff` | image belum di-import | `make k8s-image` (sekaligus rollout restart) |
| Pod `Running` tapi `READY 0/1` | `/ready` gagal: MaxScale tidak terjangkau | cek `kubectl -n lb-demo get pods,endpoints`; pastikan `mariadb-0` dan `maxscale` Ready |
| `mariadb-0` `OOMKilled` / `CrashLoopBackOff` | limit memori 512Mi terlalu kecil (page cache PVC) | limit 1Gi sudah disetel di `k8s/db/mariadb.yaml` |
| Ingress 404 padahal pod Ready | router punya `tls` hanya cocok di `websecure` | IngressRoute TLS pakai `entryPoints: [websecure]`; HTTP dialihkan `http-redirect.yaml` |
| Ingress 503 | tidak ada endpoint Ready | cek `kubectl -n lb-demo get endpoints backend` |
| `HostRegexp` tidak cocok | sejak Traefik v3 polanya Go regexp biasa | tulis `` HostRegexp(`^[a-z-]+\.localhost$`) ``, bukan `{nama:...}` |
| HPA `<unknown>` | metrics-server belum siap | tunggu 30–60 detik, `kubectl -n kube-system get pods` |
| SealedSecret `Resource ... is not managed by SealedSecret` | Secret lama (buatan `kubectl apply`) masih ada | hapus Secret lama atau `` kubectl -n lb-demo delete sealedsecret backend-secret ``, lalu `make k8s-up` |
| Argo: `app path does not exist` | commit belum di-push, atau Argo masih membaca revisi lama | `git push`, lalu `` kubectl -n argocd annotate application lb-demo argocd.argoproj.io/refresh=normal --overwrite `` |
| Argo: `unknown field spec.source.kustomize.buildOptions` | Argo CD 3.x memindahkannya ke config global | `configs.cm."kustomize.buildOptions"` di `k8s/cluster/argocd-values.yaml` |
| Certificate tidak `Ready` | cert-manager atau ClusterIssuer belum ada | `make k8s-cert-manager k8s-tls`; cek `kubectl get clusterissuer` |
| `helm`/`k3d` tidak dikenal | `PATH` belum diperbarui | buka terminal baru |

Perintah diagnosa cepat:

```powershell
kubectl --context k3d-lb-k8s get nodes -o wide
kubectl --context k3d-lb-k8s -n lb-demo describe pod -l app=backend
kubectl --context k3d-lb-k8s -n traefik get pods,svc
kubectl --context k3d-lb-k8s -n lb-demo logs deploy/backend --tail=50
```

## 9. Keamanan

Sama seperti stack Compose, ini **hanya untuk lokal**:

- Traefik dashboard tanpa login; API CRUD backend tanpa autentikasi. Argo CD
  sudah punya login (admin + password acak di Secret `argocd-initial-admin-secret`).
- TLS memakai sertifikat **self-signed** cert-manager. Browser akan
  memperingatkan; tidak ada verifikasi ke CA publik. Nama host `.localhost`
  memang tidak bisa diverifikasi Let's Encrypt.
- Password backend disimpan sebagai **SealedSecret** (terenkripsi dengan kunci
  cluster). Secret Grafana (`grafana-admin`, admin/admin) masih YAML biasa.
- `grafana-admin` dan `backend-sealedsecret` adalah kredensial demo. Untuk
  cluster sungguhan, ganti password dan gunakan External Secrets atau Vault.
- Tidak ada port database yang dibuka ke host. Jangan mengekspos 18080/18443
  ke internet.

Untuk cluster sungguhan: IngressRoute diberi autentikasi (middleware
`basicAuth`/`forwardAuth`), issuer diganti ACME, dan SealedSecrets dirotasi
dengan kunci yang disimpan di luar repo.

## 10. Bersih-bersih

```powershell
make k8s-down      # hapus Deployment/Service/HPA/IngressRoute, cluster tetap
make k8s-destroy   # hapus cluster k3d seluruhnya
```

Stack Compose tidak tersentuh oleh kedua perintah di atas.

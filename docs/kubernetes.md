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

Database **tetap** dijalankan oleh Compose (`make db-up`). Cluster k3d punya
network sendiri, jadi pod menjangkau MaxScale lewat `host.docker.internal:4006`.
Port 4006 dibuka di host oleh `docker-compose.db.yml` khusus untuk jalur ini —
hanya untuk lokal, jangan diekspos ke internet.

## 2. Quickstart

```powershell
make db-up           # database + MaxScale (port 4006 dibuka ke host)
make k8s-bootstrap   # cluster k3d + Traefik + image + manifest
make k8s-status      # Deployment, pod, Service, HPA, IngressRoute
make k8s-smoke       # GET lewat ingress
```

`k8s-bootstrap` menjalankan berurutan:

1. `k3d cluster create --config k8s/cluster/k3d-config.yaml` — 1 server + 2 agent.
2. `make k8s-ingress` — import image Traefik, lalu `helm upgrade --install`.
3. `make k8s-image` — `docker build`, lalu impor image ke tiap node.
4. `kubectl apply -k k8s/overlays/local` — semua resource.

Impor image memakai `scripts/k8s-image.js` (`docker save` → `docker cp` →
`ctr images import`), bukan `k3d image import`. Di setup Windows/Docker Desktop
ini `k3d image import` gagal dengan `ctr: content digest ...: not found`.

Kalau `make db-up` belum jalan, pod akan `Running` tetapi **belum `Ready`**
(readiness mengecek database). Nyalakan database lebih dulu:

```powershell
make db-up
```

### URL

| URL | Arti |
|---|---|
| `http://server.localhost:18080/` | Load balancing ke 5 pod backend |
| `http://server.localhost:18080/ui` | UI katalog (butuh database) |
| `http://traefik.localhost:18080/dashboard/` | Dashboard Traefik (IngressRoute) |
| `http://127.0.0.1:18080/` | Butuh header `Host: server.localhost` |

Port **8080**, bukan 80: Traefik Compose tetap memegang port 80. Kedua jalur
bisa hidup bersamaan dan dibandingkan.

## 3. Arsitektur

```
 host Windows
 ┌──────────────────────────────────────────────────────────────┐
 │  Compose (tetap)                    k3d cluster lb-k8s       │
 │  ┌────────────────────┐             ┌──────────────────────┐ │
 │  │ Traefik :80        │             │ Traefik :80          │ │
 │  │ 5 backend :3000    │             │  ↳ IngressRoute      │ │
 │  │ MariaDB + MaxScale │◀── :4006 ───│ 5 pod backend :3000  │ │
 │  │ monitoring         │             │ HPA 5–10             │ │
 │  └────────────────────┘             └──────────────────────┘ │
 │         ▲                                    ▲               │
 │         └──────────── port 80 ───────────────┴─ port 18080 ───┘
 └──────────────────────────────────────────────────────────────┘
```

Cluster: 1 server + 2 agent (k3s di dalam container Docker), network sendiri.
Yang menghubungkannya ke stack Compose:

- `host.docker.internal:4006` → port MaxScale yang dibuka di host;
- image backend di-import langsung tanpa registry;
- port host 18080/18443 dipetakan ke Traefik di cluster.

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
│   ├── k3d-config.yaml          # 1 server + 2 agent, k3s 1.32, port 18080
│   └── traefik-values.yaml      # dashboard, access log, metrik Prometheus
├── base/                        # manifest generik
│   ├── kustomization.yaml
│   ├── namespace.yaml
│   ├── backend-configmap.yaml
│   ├── backend-secret.yaml
│   ├── backend-deployment.yaml  # 5 replika, probe, resource, spread
│   ├── backend-service.yaml
│   ├── backend-hpa.yaml
│   └── backend-ingressroute.yaml
├── overlays/
│   └── local/kustomization.yaml # tag image `dev`
└── jobs/
    └── k6-load-job.yaml         # k6 sebagai Job
```

Di luar `k8s/`, satu skrip membantu memasukkan image ke cluster:
`scripts/k8s-image.js` (dipakai `make k8s-image` dan `make k8s-ingress`).

Base sengaja tidak menyebut tag image; overlay `local` yang menetapkan
`lb-backend:dev`. Overlay lain (mis. `prod`) tinggal ditambahkan tanpa
menyentuh base.

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
while ($true) { curl.exe -s -o NUL -w "%{http_code}`n" -H "Host: server.localhost" http://127.0.0.1:18080/ }
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

Matikan database sementara:

```powershell
docker stop lb-db-maxscale-1
kubectl -n lb-demo get pods -l app=backend -w      # READY 0/1, STATUS Running
kubectl -n lb-demo get endpoints backend           # kosong
curl.exe -i -H "Host: server.localhost" http://127.0.0.1:18080/
docker start lb-db-maxscale-1
```

Pod **tidak restart** (liveness tetap `/health`), tetapi dikeluarkan dari
Service. Setelah MaxScale hidup lagi, readiness pulih sendiri. Ini perbedaan
penting antara "proses hidup" dan "siap melayani".

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
kubectl kustomize k8s/overlays/local
```

Perintah ini tidak menyentuh cluster; berguna untuk melihat hasil akhir
sebelum `apply`.

## 7. Fase berikutnya (belum dikerjakan)

| Fase | Isi | Konsep yang dipelajari |
|---|---|---|
| 2 | Prometheus/Grafana/Loki/Alloy in-cluster, ServiceMonitor | operator, CRD, DaemonSet, PVC |
| 2 | PodDisruptionBudget, NetworkPolicy, resource quota | availability & isolasi |
| 3 | MariaDB sebagai StatefulSet + PVC | stateful workload, headless Service |
| 3 | MaxScale sebagai Deployment, atau ganti dengan operator MariaDB | kenapa stateful di k8s butuh operator |
| 4 | cert-manager + TLS, SealedSecrets, Argo CD/Flux | GitOps & manajemen rahasia |

Fase 1 sengaja berhenti di backend + ingress supaya setiap konsep dicerna
sebelum menambah kompleksitas.

## 8. Troubleshooting

| Gejala | Penyebab umum | Solusi |
|---|---|---|
| Node `NotReady`, log server berhenti sendiri | k3s 1.33+ di cgroup v1 | pakai `image: rancher/k3s:v1.32.9-k3s1` di `k3d-config.yaml` |
| `kubectl` → `connection refused` ke `host.docker.internal` | kubeconfig memakai nama host, bukan loopback | `kubeAPI.host: 127.0.0.1` di `k3d-config.yaml`; atau `kubectl config set-cluster k3d-lb-k8s --server=https://127.0.0.1:<port>` |
| `k3d cluster create` gagal: port dipakai | 18080/18443 sudah dipakai proses lain | ubah `ports` di `k8s/cluster/k3d-config.yaml`, buat ulang cluster |
| `k3d image import`: `ctr: content digest ... not found` | bug k3d di Windows/Docker Desktop | pakai `bun scripts/k8s-image.js <image>` (dipakai `make k8s-image`) |
| `docker pull` gagal: `tls: bad record MAC` | registry menolak satu layer | pakai image lokal yang sudah ada (mis. `traefik:v3.6.6`) |
| Helm: `values don't meet the specifications ... '/service/type'` | values chart 43 dipakai dengan chart 39 | pasangkan `k8s/cluster/traefik-values.yaml` dengan chart 39 |
| Pod `ImagePullBackOff` | image belum di-import | `make k8s-image` (sekaligus rollout restart) |
| Pod `Running` tapi `READY 0/1` | `/ready` gagal: MaxScale tidak terjangkau | `make db-up`; cek `kubectl exec deploy/backend -- nslookup host.docker.internal` |
| Ingress 404 | IngressRoute/CRD belum ada | `make k8s-ingress`, cek `kubectl -n lb-demo get ingressroutes` |
| Ingress 503 | tidak ada endpoint Ready | cek `kubectl -n lb-demo get endpoints backend` |
| HPA `<unknown>` | metrics-server belum siap | tunggu 30–60 detik, `kubectl -n kube-system get pods` |
| `host.docker.internal` tidak resolve | bukan Docker Desktop (mis. Linux) | ganti `DB_HOST` ke IP gateway Docker dan tambahkan `extra_hosts` di k3d |
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

- Traefik dashboard tanpa login, API CRUD tanpa autentikasi.
- Secret disimpan sebagai YAML biasa (password demo yang sama dengan Compose).
- Tidak ada TLS; port 118080/18443 hanya untuk localhost.
- Port 4006 (MaxScale) dibuka di host agar pod bisa menjangkau database. Ini
  terbuka ke LAN mesin, jadi jangan diekspos ke internet.
- Jangan mengekspos port 18080 ke internet.

Untuk cluster sungguhan, Secret seperti ini harus diganti SealedSecrets /
External Secrets, dan dashboard diberi autentikasi.

## 10. Bersih-bersih

```powershell
make k8s-down      # hapus Deployment/Service/HPA/IngressRoute, cluster tetap
make k8s-destroy   # hapus cluster k3d seluruhnya
```

Stack Compose tidak tersentuh oleh kedua perintah di atas.

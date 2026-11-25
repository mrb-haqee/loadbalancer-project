# 0016 — Jalur belajar Kubernetes berdampingan dengan Compose

- **Status:** Diterima
- **Tanggal:** 25 November 2026

## Konteks

Project ini adalah demo load balancing yang berjalan penuh di satu Docker host:
Traefik, 5 backend, cluster MariaDB + MaxScale, dan monitoring. README menyatakan
sendiri bahwa stack ini untuk lokal, tanpa TLS/autentikasi, dan tidak boleh
diekspos ke internet. Tidak ada kebutuhan produksi, multi-tenant, SLA, atau
multi-host yang bisa dibuktikan dari kode.

Namun tujuan yang diminta bukan "menjalankan beban produksi", melainkan
**belajar orkestrasi**. Pertanyaannya berubah: orkestrator apa yang paling
berguna untuk dipelajari, dan bagaimana memasukkannya tanpa merusak demo yang
sudah terukur test?

Batasan yang disepakati:

1. Stack Compose tetap utuh dan tetap menjadi cara utama menjalankan demo.
2. Jalur Kubernetes harus bisa hidup berdampingan (port dan network terpisah).
3. Fokus pada pemahaman konsep, bukan parity fitur.
4. Database tetap di Compose pada fase pertama.

## Pilihan yang dipertimbangkan

1. **Docker Swarm.** Paling dekat dengan Compose dan hampir tanpa instalasi,
   tetapi konsep yang dipelajari paling sedikit (tidak ada probe, HPA, CRD,
   ekosistem operator) dan bukan arah industri.
2. **Nomad.** Ringan dan menarik, tetapi ekosistem serta materi belajarnya jauh
   lebih kecil; kurang berguna sebagai keterampilan umum.
3. **Kubernetes managed (EKS/GKE/AKS).** Realistis untuk produksi, tetapi
   menambah biaya, kredensial cloud, dan waktu tunggu provisioning untuk latihan
   yang bisa dilakukan lokal.
4. **Kubernetes bawaan Docker Desktop.** Nol instalasi, tetapi satu node;
   scheduling, spread, dan kegagalan node tidak terasa.
5. **k3d (k3s di dalam Docker), 1 server + 2 agent.** Multi-node, cepat dibuat
   dan dihapus, berjalan di mesin yang sama dengan Compose.
6. **Menulis ulang stack sebagai Helm chart sejak awal.** Menyembunyikan justru
   konsep yang ingin dipelajari (Deployment, Service, probe, selector).
7. **Konversi otomatis dengan Kompose.** Cepat, tetapi menghasilkan manifest
   yang tidak menjelaskan mengapa field-nya ada.

## Keputusan

Memilih **k3d 1 server + 2 agent**, dengan penegasan:

- **Berdampingan, bukan menggantikan.** Compose tetap di port 80; Traefik k8s di
  port 8080. Cluster memakai network k3d sendiri; MaxScale dijangkau lewat
  `host.docker.internal:4006` (port host dibuka khusus untuk latihan ini).
  Percobaan menaruh cluster di `lb-net` ditinggalkan karena DNS fix k3d
  mengganti resolver node dan nama container Compose tidak resolve dari pod.
- **Traefik bawaan k3s dimatikan.** Ingress dipasang sendiri lewat chart resmi
  (`make k8s-ingress`) supaya langkah instalasi dan CRD-nya terlihat.
- **YAML tulisan tangan + Kustomize**, bukan Helm/Kompose. Base berisi manifest
  generik; overlay `local` hanya menetapkan tag image.
- **Satu Deployment `replicas: 5`**, bukan lima Deployment. Identitas pod
  diambil dari `metadata.name` lewat Downward API. Router `direct-N` diganti
  `kubectl port-forward` — pod memang unit yang sementara.
- **Readiness mengecek database (`/ready`), liveness tidak (`/health`).**
  Endpoint `/ready` ditambahkan ke backend dan diuji tanpa database.
- **HPA 5–10 pod pada 70% CPU** dengan metrics-server bawaan k3s, agar latihan
  scaling memakai beban k6 yang sudah ada.
- **Database tetap di Compose pada fase 1.** StatefulSet MariaDB + MaxScale
  adalah fase 3, karena masalahnya bukan orkestrasi stateless lagi.
- **k6 dijalankan sebagai Job**, bukan container long-running, untuk
  memperlihatkan model kerja "sekali jalan lalu selesai".

Catatan implementasi (lingkungan mesin ini):

- **k3s dipin ke 1.32.** k3s 1.33+ menolak kubelet di cgroup v1, yang masih
  dipakai Docker Desktop di mesin ini. Pin ini murni kompatibilitas, bukan
  pilihan arsitektur.
- **Image masuk lewat `scripts/k8s-image.js`** (`docker save` → `docker cp` →
  `ctr images import`) karena `k3d image import` gagal di setup ini.
- **Traefik chart 39.0.7 + image v3.6.6**, bukan chart 43/Traefik 3.8: satu layer
  image 3.8 gagal diunduh dari Docker Hub (`tls: bad record MAC`). Versi 3.6.6
  sama dengan yang dipakai Compose, jadi perilakunya bisa dibandingkan.
- **kubeconfig memakai `127.0.0.1`**, bukan `host.docker.internal`, karena nama
  itu bisa resolve ke IP LAN dan tidak menjawab dari host.

## Konsekuensi

**Positif**

- Setiap konsep inti k8s punya padanan yang bisa dibandingkan langsung dengan
  Compose: Deployment↔5 service, Service↔Traefik service, probe↔HEALTHCHECK,
  HPA↔tidak ada, Job↔`k6-run`.
- Demo lama tidak berubah; test Compose tetap berlaku.
- Multi-node membuat topology spread, eviction, dan kegagalan node bisa
  diperagakan di laptop.
- Tidak ada biaya cloud dan tidak ada kredensial baru.

**Negatif / biaya**

- Dua jalur deployment harus dijaga konsisten (env, image, nama host).
- Cluster k3d menambah konsumsi RAM/CPU di mesin pengembang (3 node + Traefik).
- Image harus di-import manual setiap kali berubah; belum ada registry lokal.
- Readiness yang bergantung pada DB membuat endpoint non-DB ikut tidak
  dilayani saat database mati. Ini trade-off latihan, bukan keputusan produksi.
- Belum ada monitoring in-cluster, TLS, PDB, NetworkPolicy, atau GitOps; semua
  itu sengaja ditunda ke fase berikutnya.

**Verifikasi (25 November 2026, cluster `lb-k8s`)**

- 5 pod `Ready 1/1` di 3 node; `endpoints backend` berisi 5 IP pod.
- Ingress `server.localhost:8080` mengembalikan 200 dari kelima pod (round robin
  terlihat dari `servedBy`).
- `make k8s-load`: 3001 request, 0 gagal, p95 ≈ 1,3 ms; HPA naik 5 → 10 pod.
- MaxScale dimatikan: kelima pod `Running` tetapi `READY 0/1`, endpoint kosong,
  ingress 503, `restartCount` tetap 0. Setelah MaxScale hidup lagi, semuanya
  pulih tanpa intervensi.
- `make k8s-image` (build + impor + rolling restart) selesai tanpa downtime.

**Kapan keputusan ini ditinjau ulang**

- Kalau project benar-benar akan dipakai produksi: pindah ke cluster managed,
  registry image, secret manager, TLS, dan monitoring — bukan sekadar menambah
  manifest.
- Kalau tujuan belajar selesai: jalur k8s boleh dihapus tanpa menyentuh Compose.

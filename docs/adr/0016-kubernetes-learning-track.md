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
4. Database tetap di Compose pada fase 1; pindah ke dalam cluster pada fase 3.

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
  port 18080/18443 (8080 dipakai container lain di mesin ini). Cluster memakai
  network k3d sendiri, terpisah dari `lb-net`.
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
- **Database dipindah ke dalam cluster pada fase 3.** MariaDB sebagai
  StatefulSet + PVC, MaxScale sebagai Deployment di depannya. Tidak ada lagi
  port database yang dibuka ke host.
- **k6 dijalankan sebagai Job**, bukan container long-running, untuk
  memperlihatkan model kerja "sekali jalan lalu selesai".
- **Fase 2: PDB + kuota.** `PodDisruptionBudget minAvailable: 3` dan
  ResourceQuota/LimitRange dipakai untuk memperlihatkan availability dan
  pembatasan. NetworkPolicy tidak ditulis karena flannel bawaan k3s tidak
  menegakkannya (butuh Calico/Cilium).
- **Fase 2: monitoring tanpa operator.** Prometheus memakai `kubernetes_sd_config`
  role pod dan RBAC, bukan ServiceMonitor. Grafana membaca provisioning dan
  dashboard dari folder `monitoring/grafana` yang sama dengan Compose.
- **Fase 4: TLS via cert-manager self-signed.** Nama host `.localhost` tidak
  bisa diverifikasi ACME, jadi ClusterIssuer self-signed. Semua IngressRoute
  yang punya `tls` hanya memakai entrypoint `websecure`; HTTP dialihkan oleh
  router `HostRegexp` + middleware `redirectScheme` (port 18443).
- **Fase 4: SealedSecrets.** `backend-secret.yaml` diganti SealedSecret supaya
  password demo tetap terenkripsi di repo.
- **Fase 4: GitOps dengan Argo CD.** Satu Application `lb-demo` menyinkronkan
  folder `k8s/gitops` (gabungan aplikasi, database, monitoring, TLS, dan UI
  Argo CD). `ignoreDifferences` pada `spec.replicas` mencegah Argo bertabrakan
  dengan HPA. SQL dan dashboard tetap satu sumber lewat `configMapGenerator`.

Catatan implementasi (lingkungan mesin ini):

- **k3s dipin ke 1.32.** k3s 1.33+ menolak kubelet di cgroup v1, yang masih
  dipakai Docker Desktop di mesin ini. Pin ini murni kompatibilitas, bukan
  pilihan arsitektur.
- **Image masuk lewat `scripts/k8s-image.js`** (`docker save` → `docker cp` →
  `ctr images import`) karena `k3d image import` gagal di setup ini. Skrip
  menarik image ke Docker host lebih dulu kalau belum ada.
- **Traefik chart 39.0.7 + image v3.6.6**, bukan chart 43/Traefik 3.8: satu layer
  image 3.8 gagal diunduh dari Docker Hub (`tls: bad record MAC`). Versi 3.6.6
  sama dengan yang dipakai Compose, jadi perilakunya bisa dibandingkan.
- **cert-manager v1.18.2 dan Argo CD chart 10.19.1** dipin dengan alasan yang
  sama (image tersedia lokal). Argo CD 3.x memindahkan opsi build Kustomize dari
  per-Application ke `configs.cm."kustomize.buildOptions"`.
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
- `mariadb-0` butuh limit memori 1Gi; dengan 512Mi container `OOMKilled` karena
  page cache PVC ikut dihitung cgroup.
- Traefik, cert-manager, dan Argo CD sendiri dipasang Helm sekali, di luar
  `k8s/gitops`. Jadi belum sepenuhnya GitOps; hanya beban kerja yang dikelola
  Argo.
- Belum ada ServiceMonitor, Loki/Alloy, NetworkPolicy, atau operator MariaDB;
  semua itu sengaja dilewati (lihat `docs/kubernetes.md` bagian status fase).

**Verifikasi (26 November 2026, cluster `lb-k8s`)**

Fase 1 (25 November):

- 5 pod `Ready 1/1` di 3 node; `endpoints backend` berisi 5 IP pod.
- Ingress mengembalikan 200 dari kelima pod (round robin terlihat dari `servedBy`).
- `make k8s-load`: 3001 request, 0 gagal, p95 ≈ 1,3 ms; HPA naik 5 → 10 pod.
- MaxScale dimatikan: kelima pod `Running` tetapi `READY 0/1`, endpoint kosong,
  ingress 503, `restartCount` tetap 0. Setelah MaxScale hidup lagi, semuanya
  pulih tanpa intervensi.
- `make k8s-image` (build + impor + rolling restart) selesai tanpa downtime.

Fase 2–4:

- `kubectl drain` pada satu node berhasil karena `PodDisruptionBudget`
  `minAvailable: 3`; LimitRange + ResourceQuota menolak pod tanpa resource.
- Prometheus in-cluster melaporkan 6 target `up`; tiga dashboard (LB, MariaDB,
  k6) termuat di Grafana lewat provisioning.
- MariaDB `mariadb-0` `Ready 1/1` di atas PVC 1Gi; backend melaporkan
  `lb_app@maxscale:4006/lb_demo`; `mysql_up=1`; CRUD `/api/servers` jalan;
  k6 3001 request tanpa gagal.
- Certificate `backend-tls` dan `monitoring-tls` `Ready`; HTTPS di port 18443
  mengembalikan 200 untuk backend, Grafana, Prometheus, dan Argo CD; HTTP
  dialihkan 301 ke `https://<host>:18443`.
- Menghapus Secret `backend-secret` memicu controller SealedSecrets membuat
  ulang dari SealedSecret.
- Argo CD `Application lb-demo` berstatus `Synced` + `Healthy`. Menaikkan
  replika Deployment secara manual **tidak** dilawan Argo (HPA yang
  mengembalikannya), membuktikan `ignoreDifferences` bekerja; perubahan di git
  yang di-push ditarik Argo pada refresh berikutnya.

**Kapan keputusan ini ditinjau ulang**

- Kalau project benar-benar akan dipakai produksi: pindah ke cluster managed,
  registry image, secret manager, TLS, dan monitoring — bukan sekadar menambah
  manifest.
- Kalau tujuan belajar selesai: jalur k8s boleh dihapus tanpa menyentuh Compose.

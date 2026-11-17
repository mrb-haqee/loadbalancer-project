# 0003 — Varian container memakai Traefik, bukan Nginx

- **Status:** Diterima
- **Tanggal:** 17 November 2026

## Konteks

Versi Node (ADR 0001) berjalan sebagai proses lokal. Project pengguna sudah berada di Docker, sehingga dibutuhkan varian yang juga berjalan di container. Syarat yang disepakati:

- Tidak boleh mengubah atau menyentuh container/network project yang sudah ada (`proxy`, `sanmedclinic_internal`, `shared-api`, container lama `traefik-traefik-1`).
- Backend juga ikut container, bukan proses di host.
- Cakupan tetap 3 backend demo, belum meneruskan ke aplikasi nyata.
- Varian Node tetap dipertahankan sebagai pembanding yang bisa diuji.

Lingkungan: Docker Desktop 28.3.3 (Linux/WSL2), Compose v2.39.2, image `traefik:latest` = 3.6.6 dan `nginx:stable` sudah tersedia.

## Pilihan yang dipertimbangkan

1. **Traefik** — provider Docker dengan auto-discovery lewat label, dashboard + API bawaan, health check per server, dan middleware `retry` untuk failover pasif.
2. **Nginx** — `upstream` statis dan config paling gamblang (`least_conn`, bobot), tetapi menemukan container secara manual dan tidak punya UI untuk membuktikan status server.
3. **Tetap Node, hanya dibungkus image** — mempertahankan `/stats`, tetapi tidak memperlihatkan pola load balancer yang lazim dipakai di Docker.

## Keputusan

Memilih **Traefik 3.6** untuk varian container, berdampingan dengan varian Node.

Detail yang ikut diputuskan:

- Project compose sendiri: `lb-demo`; network sendiri: `lb-net`; port aplikasi **8088**, dashboard **8089** — agar tidak bentrok dengan project lain maupun varian Node di 8080.
- Satu image backend (`lb-demo-backend`), tiga container dengan `BACKEND_ID` berbeda.
- Ketiga container memakai **satu nama service** Traefik (`demo`) sehingga terbentuk 3 server di satu load balancer (`wrr`).
- Health check dua lapis: `HEALTHCHECK` Docker (interval 2s) dan health check Traefik (interval 2s).
- Failover pasif memakai middleware `retry` (3 percobaan, interval awal 100ms), karena Traefik **tidak** mengulang request secara default.
- `providers.docker.exposedByDefault: false` agar hanya container berlabel yang terdaftar.

## Konsekuensi

**Positif**
- Backend baru cukup diberi label — tidak ada daftar upstream manual.
- Dashboard + API (`/api/http/services`, `/api/http/routers`) memberi bukti eksplisit bahwa 3 server terdaftar dan `UP`.
- Isolasi penuh: tidak ada container/network project lain yang tersentuh.
- Hasil terukur: keluar rotasi ~1,1 detik, kembali ~6,1 detik, 12 request saat jendela transisi semuanya 200, 300 request/20 konkuren 0 gagal.

**Negatif / biaya**
- Menambah satu teknologi yang harus dipahami (`docker.sock`, label, provider) dibanding sekadar config Nginx.
- Statistik internal versi Node (`/stats`, dashboard sendiri) tidak ada; harus lewat API Traefik.
- `retry` default tidak berlaku untuk POST/PATCH/LOCK; perlu `retryNonIdempotentMethod=true` bila diinginkan.
- Mounting `docker.sock` memberi akses ke Docker API; dapat diterima untuk demo lokal, tidak untuk lingkungan terbuka.
- Timeout start lebih lama (Docker health `start-period` 5 detik) dibanding varian Node yang langsung siap.

**Kapan ditinjau ulang**
- Jika demo perlu memperlihatkan algoritma non-default (least connections, bobot tidak sama), Traefik membatasinya pada `wrr` per service — varian Node (atau Nginx) lebih eksplisit untuk tujuan itu.
- Jika harus meneruskan ke aplikasi nyata, tambahkan label pada compose project tersebut dan sambungkan network-nya; jangan mengubah stack ini.

# 0003 — Varian container memakai Traefik, bukan Nginx

- **Status:** Diterima — **satu-satunya varian yang tersisa** di project ini
- **Tanggal:** 17 November 2026
- **Revisi 17 November 2026:** varian Node dihapus atas permintaan pemilik project (hanya ingin versi container). Bagian di bawah yang menyebut varian Node dipertahankan sebagai catatan konteks saat keputusan diambil.

## Konteks

Versi Node (ADR 0001) berjalan sebagai proses lokal. Project pengguna sudah berada di Docker, sehingga dibutuhkan varian yang juga berjalan di container. Syarat yang disepakati:

- Tidak boleh mengubah atau menyentuh container/network project yang sudah ada (`proxy`, `sanmedclinic_internal`, `shared-api`, container lama `traefik-traefik-1`).
- Backend juga ikut container, bukan proses di host.
- Cakupan tetap 3 backend demo, belum meneruskan ke aplikasi nyata.
- Varian Node tetap dipertahankan sebagai pembanding yang bisa diuji. *(Revisi: sudah dihapus.)*

Lingkungan: Docker Desktop 28.3.3 (Linux/WSL2), Compose v2.39.2, image `traefik:latest` = 3.6.6 dan `nginx:stable` sudah tersedia.

## Pilihan yang dipertimbangkan

1. **Traefik** — provider Docker dengan auto-discovery lewat label, dashboard + API bawaan, health check per server, dan middleware `retry` untuk failover pasif.
2. **Nginx** — `upstream` statis dan config paling gamblang (`least_conn`, bobot), tetapi menemukan container secara manual dan tidak punya UI untuk membuktikan status server.
3. **Tetap Node, hanya dibungkus image** — mempertahankan `/stats`, tetapi tidak memperlihatkan pola load balancer yang lazim dipakai di Docker.

## Keputusan

Memilih **Traefik 3.6** untuk varian container, berdampingan dengan varian Node *(sejak revisi: varian Node dihapus, Traefik menjadi satu-satunya load balancer)*.

Detail yang ikut diputuskan:

- Project compose sendiri: `lb-demo`; network sendiri: `lb-net`; port aplikasi **80** (plus 8088 sebagai cadangan), dashboard **8089** — agar tidak bentrok dengan project lain maupun varian Node di 8080.
- Satu image backend (`lb-demo-backend`), tiga container dengan `BACKEND_ID` berbeda: `server-1`, `server-2`, `server-3` (nama container ikut `server-N`, bukan `backend-N`, supaya sama dengan bahasa pengguna dan varian Node).
- Ketiga container memakai **satu nama service** Traefik (`demo`) sehingga terbentuk 3 server di satu load balancer (`wrr`).
- **Tiap server punya URL sendiri**: `server.localhost` untuk load balancer, `server-1/2/3.localhost` untuk akses langsung ke satu server. `*.localhost` dipilih karena resolve otomatis di Windows/Linux/macOS modern — tanpa hosts file dan tanpa hak admin (hosts file di mesin ini memang tidak bisa diedit karena shell bukan admin).
- Akses langsung tetap lewat Traefik (router `direct-N` berprioritas 100 + `Host()`), bukan membuka port 3001-3003: satu pintu masuk, tetap tercatat di access log, dan bisa dibuktikan lewat dashboard.
- Router `demo` mengecualikan `server-N.localhost` (`!HostRegexp`), supaya URL server yang mati **gagal** dan tidak diam-diam dialihkan ke server lain.
- Router `demo` **wajib** punya label `routers.demo.service: demo`. Tanpa itu Traefik membuangnya (`cannot be linked automatically with multiple Services`) karena tiap container kini mendefinisikan dua service.
- `serversTransport.forwardingTimeouts` (`responseHeaderTimeout: 2s`, `dialTimeout: 2s`). Tanpa batas ini, request yang telanjur dikirim ke container yang baru mati menggantung tanpa akhir — retry tidak pernah jalan.
- Health check dua lapis: `HEALTHCHECK` Docker (interval 2s) dan health check Traefik (interval 2s).
- Failover pasif memakai middleware `retry` (3 percobaan, interval awal 100ms), karena Traefik **tidak** mengulang request secara default.
- `providers.docker.exposedByDefault: false` agar hanya container berlabel yang terdaftar.

## Konsekuensi

**Positif**
- Backend baru cukup diberi label — tidak ada daftar upstream manual.
- Dashboard + API (`/api/http/services`, `/api/http/routers`) memberi bukti eksplisit bahwa 3 server terdaftar dan `UP`.
- Isolasi penuh: tidak ada container/network project lain yang tersentuh.
- Hasil terukur: keluar rotasi ~1,1 detik, kembali ~6,1 detik, 12 request saat jendela transisi 12/12 sukses 200, 300 request/20 konkuren 0 gagal (±600–770 req/detik), `test:docker` 6/6 lulus 3 kali berturut-turut.
- k6 terhadap `http://server.localhost`: 480 request, 0 gagal, sebaran tepat 160/160/160. Skenario failover 2001 request: 1 gagal (0,04%) — request yang sudah setengah jalan saat container dibunuh, tetap di bawah ambang 1%.

**Negatif / biaya**
- Menambah satu teknologi yang harus dipahami (`docker.sock`, label, provider) dibanding sekadar config Nginx.
- Statistik internal versi Node (`/stats`, dashboard sendiri) tidak ada; harus lewat API Traefik.
- `retry` default tidak berlaku untuk POST/PATCH/LOCK; perlu `retryNonIdempotentMethod=true` bila diinginkan.
- Mounting `docker.sock` memberi akses ke Docker API; dapat diterima untuk demo lokal, tidak untuk lingkungan terbuka.
- Timeout start lebih lama (Docker health `start-period` 5 detik) dibanding varian Node yang langsung siap.
- Port 80 dipakai, jadi stack ini tidak bisa hidup berdampingan dengan aplikasi lain yang juga memakai port 80 (mis. Nginx lokal). Port 8088 tetap tersedia sebagai cadangan.
- `responseHeaderTimeout 2s` memotong endpoint yang sengaja lambat lebih dari 2 detik bila lewat Traefik; nilai ini harus dinaikkan bila ada endpoint lambat yang sah.
- Kehilangan request tidak bisa nol: membunuh container selalu berisiko memutus request yang sedang berjalan. Terukur 1 dari 2001 (0,04%).

**Kapan ditinjau ulang**
- Jika demo perlu memperlihatkan algoritma non-default (least connections, bobot tidak sama), Traefik membatasinya pada `wrr` per service — varian Node (atau Nginx) lebih eksplisit untuk tujuan itu.
- Jika harus meneruskan ke aplikasi nyata, tambahkan label pada compose project tersebut dan sambungkan network-nya; jangan mengubah stack ini.

# Load Balancer — 3 Server

Implementasi **load balancer dari nol** (Node.js, tanpa dependency eksternal) yang membagi trafik ke **3 backend server**, lengkap dengan **dashboard** dan **test suite** untuk membuktikan semuanya benar-benar berjalan.

Ada dua varian:

| Varian | Load balancer | Cara jalan |
|---|---|---|
| **Node** (from scratch) | `src/load-balancer` | `npm start` — proses lokal, ada `/stats` + dashboard sendiri |
| **Container** | **Traefik 3.6** | `npm run docker:up` — 1 + 3 container di Docker, network terisolasi |

Keduanya memakai backend aplikasi yang sama (`src/backend/server.js`).

Pada varian container, **tiap server punya URL sendiri**:

| URL | Arti |
|---|---|
| `http://server.localhost` | Load balancer (3 server bergiliran) |
| `http://server-1.localhost` | Langsung ke server-1 |
| `http://server-2.localhost` | Langsung ke server-2 |
| `http://server-3.localhost` | Langsung ke server-3 |
| `http://127.0.0.1:8089/dashboard/` | Dashboard Traefik |

`*.localhost` resolve otomatis di OS modern — tanpa edit hosts file, tanpa admin.

## 1. Arsitektur

```
                        ┌───────────────────────────────┐
   Browser / curl ────▶ │  Load Balancer  :8080         │
                        │  • round-robin / least-conn    │
                        │  • health check aktif          │
                        │  • retry → failover pasif      │
                        └───────┬───────┬───────┬────────┘
                                │       │       │
                ┌───────────────┘       │       └───────────────┐
                ▼                       ▼                       ▼
        ┌───────────────┐       ┌───────────────┐       ┌───────────────┐
        │ server-1 :3001│       │ server-2 :3002│       │ server-3 :3003│
        │ Node.js       │       │ Node.js       │       │ Node.js       │
        └───────────────┘       └───────────────┘       └───────────────┘
```

4 proses: 1 load balancer + 3 backend. Ketiganya membaca **satu file konfigurasi** (`config.json`).

## 2. Struktur project

```
loadBalancer/
├── config.json                   # port, algoritma, interval health check, daftar backend
├── package.json                  # npm start / npm test (tanpa dependency)
├── src/
│   ├── backend/server.js         # aplikasi backend (dijalankan 3x, beda BACKEND_ID)
│   ├── load-balancer/
│   │   ├── index.js              # HTTP server LB: /stats, /health, dashboard, proxy
│   │   ├── balancer.js           # algoritma: round-robin, least-connections
│   │   ├── registry.js           # status backend + health check aktif + hitungan
│   │   └── proxy.js              # forward request, retry, failover pasif
│   ├── dashboard/index.html      # dashboard auto-refresh 1 detik
│   └── shared/                   # loader konfigurasi + logger
├── scripts/run-all.js            # jalankan 3 backend + LB sekaligus (Ctrl+C = matikan semua)
├── scripts/request.js            # tembak N request ke LB yang sedang berjalan + ringkasan
├── scripts/install-k6.js         # unduh binary k6 resmi lewat Bun → tools/k6/
├── scripts/k6.js                 # pembungkus k6 (Windows/Linux/macOS)
├── k6/
│   ├── load-test.js              # uji beban + threshold
│   ├── failover.js               # skenario failover (sambil backend dimatikan)
│   └── lib/backend-counters.js   # counter per backend agar sebaran terlihat
├── docker-compose.yml            # varian container: Traefik + 3 server (network lb-net, port 80/8088/8089, URL per server)
├── docker/
│   ├── backend.Dockerfile        # image backend (Node 22 alpine + HEALTHCHECK)
│   └── traefik/traefik.yml       # config statis Traefik (provider Docker, timeout backend, dashboard, access log)
├── test/
│   ├── helpers/cluster.js        # cluster terisolasi per test (port acak, proses terpisah)
│   ├── smoke.test.js
│   ├── distribution.test.js
│   ├── least-connections.test.js
│   ├── failover.test.js
│   ├── load.test.js
│   └── docker/
│       ├── helpers/docker-stack.js  # start/stop stack compose untuk test
│       └── lb-docker.test.js        # smoke, distribusi, beban, failover versi container
├── GLOSSARY.md
└── docs/adr/                     # catatan keputusan desain
```

## 3. Menjalankan

```bash
npm start
```

Output:

```
================================================================
  LOAD BALANCER SIAP
================================================================
  Dashboard     : http://127.0.0.1:8080/
  Stats (JSON)  : http://127.0.0.1:8080/stats
  Health LB     : http://127.0.0.1:8080/health
  Algoritma     : round-robin
  ...
```

| URL | Fungsi |
|---|---|
| `http://127.0.0.1:8080/` | Dashboard (jumlah request per server, status hidup/mati) |
| `http://127.0.0.1:8080/stats` | Statistik JSON |
| `http://127.0.0.1:8080/health` | Kesehatan LB (200 bila ≥1 backend sehat, 503 bila tidak) |
| `http://127.0.0.1:8080/apa-saja` | Diteruskan ke backend — response menyebut `servedBy` |

Uji cepat dari terminal lain:

```powershell
1..9 | % { (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8080/halo).Headers['x-served-by'] }
# server-1 server-2 server-3 server-1 server-2 server-3 server-1 server-2 server-3
```

`Ctrl+C` di terminal `npm start` mematikan keempat proses sekaligus.

### Menguji request manual

`npm test` menyalakan cluster-nya sendiri. Kalau ingin menembak LB yang **sedang berjalan** (misal sambil melihat dashboard), pakai `scripts/request.js`:

```powershell
# 1 request saja — lihat siapa yang melayani
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8080/halo | % { $_.Headers['x-served-by'] }

# 9 request berurutan — harus server-1,2,3,1,2,3,...
node scripts/request.js --requests 9 --verbose

# 600 request, 50 paralel — uji beban + latensi p95
node scripts/request.js --requests 600 --concurrency 50

# POST dengan body JSON
node scripts/request.js --requests 3 --method POST --path /kirim --body '{"pesan":"halo"}' --verbose

# backend tertentu, tanpa lewat LB (untuk membandingkan)
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3002/halo
```

| Flag | Default | Arti |
|---|---|---|
| `--requests` | 30 | Jumlah request |
| `--concurrency` | 1 | Jumlah request paralel |
| `--path` | `/halo` | Path tujuan |
| `--method` | `GET` | Metode HTTP |
| `--body` | – | Body request (dipakai bersama `--method POST`) |
| `--verbose` | otomatis bila ≤20 request | Tampilkan tiap request + backend + latensi |
| `--base` | dari `config.json` | Alamat LB lain |

Contoh output `node scripts/request.js --requests 9 --verbose`:

```
#  1  200    server-1     40ms
#  2  200    server-2      6ms
...
Sebaran backend
Backend      Request   Porsi
server-1           3    33.3%  ████████░░░░░░░░░░░░░░░░
server-2           3    33.3%  ████████░░░░░░░░░░░░░░░░
server-3           3    33.3%  ████████░░░░░░░░░░░░░░░░
```

> Catatan: panggil lewat `node scripts/request.js ...`. Bentuk `npm run request -- --requests 9` tidak dipakai karena npm 11 di Windows menelan flag tersebut sebagai config npm, sehingga skrip jatuh ke nilai default.

### Menguji failover dengan request

```powershell
# terminal 1: jalankan LB
npm start

# terminal 2: kirim request sambil mematikan server-2 di terminal 3
node scripts/request.js --requests 200 --concurrency 10
```

Selama proses itu berjalan, matikan `server-2`; request tetap sukses 200 dan porsi `server-2` hilang dari ringkasan. Tanpa dashboard pun terbukti.

## 4. Testing otomatis: apakah semuanya berjalan?

```bash
npm test
```

Test suite ini **bukan unit test palsu**: tiap skenario menyalakan 3 backend + 1 load balancer sebagai proses sungguhan di port acak, lalu bicara lewat HTTP.

| # | Skenario | Yang dibuktikan |
|---|---|---|
| 1 | `smoke.test.js` | 3 backend hidup, LB hidup, dashboard & proxy jalan, GET/POST diteruskan utuh |
| 2 | `distribution.test.js` | 9 request round-robin → tepat `server-1,2,3,1,2,3,1,2,3` (3-3-3) |
| 3 | `distribution.test.js` | least-connections saat semua idle → tetap adil (2-2-2) |
| 4 | `least-connections.test.js` | backend yang sedang menahan koneksi lambat **tidak** dikirimi request baru |
| 5 | `failover.test.js` | backend dimatikan → request tetap 200 (retry), lalu dikeluarkan dari rotasi, lalu pulih otomatis saat dihidupkan |
| 6 | `failover.test.js` | semua backend mati → LB membalas `503` dengan pesan jelas, `/health` jadi `degraded` |
| 7 | `load.test.js` | 600 request / 50 konkuren → 0 gagal, terbagi persis 200-200-200 |

Hasil verifikasi terakhir (17 Nov 2026, Windows + Node v22.18.0):

```
✔ round-robin: 9 request dibagi bergiliran 3-3-3
✔ least-connections: 6 request bergiliran karena semua idle (tie-break round robin)
✔ failover: backend dimatikan → request tetap 200, lalu dikeluarkan dari rotasi, dan pulih otomatis
✔ failover: semua backend mati → load balancer membalas 503 dengan jelas
✔ least-connections: backend yang sedang sibuk tidak dikirimi request baru
✔ beban: 600 request / 50 konkuren, semua sukses dan terbagi rata
✔ smoke: 3 backend + load balancer hidup, dashboard & proxy berfungsi

tests 7 | pass 7 | fail 0
```

### Uji beban dengan k6

k6 adalah binary Go, **bukan** paket JavaScript — `bun add k6` tidak bisa dipakai (paket npm bernama `k6` hanya dummy untuk autocomplete editor). Instalasinya tetap lewat Bun:

```bash
npm run k6:install     # = bun scripts/install-k6.js → unduh rilis resmi ke tools/k6/k6.exe
npm run k6             # cek versi
```

| Perintah | Arti |
|---|---|
| `npm run k6:load` | 100 req/detik selama 15 detik ke `http://server.localhost` |
| `npm run k6:failover` | 50 req/detik selama 40 detik, untuk diuji sambil mematikan server |

Ganti target atau intensitas (mis. varian Node di 8080, atau port cadangan 8088):

```bash
bun scripts/k6.js run k6/load-test.js -e BASE_URL=http://127.0.0.1:8080 -e RATE=200 -e DURATION=20s
bun scripts/k6.js run k6/failover.js -e BASE_URL=http://127.0.0.1:8088 -e DURATION=60s
```

Threshold yang dipakai: `http_req_failed < 1%`, `p(95) < 500ms`, `checks > 99%`. k6 keluar dengan exit code ≠ 0 bila salah satu gagal, jadi aman dipakai di CI.

Hasil terukur (varian container, `http://server.localhost`):

```
# beban: 480 request / 80 req per detik
http_req_failed: 0.00%   checks_succeeded: 100.00%
served_server_1: 160   served_server_2: 160   served_server_3: 160

# failover: server-2 dimatikan detik ke-8, dihidupkan detik ke-22 (diulang 2x, hasil sama)
http_reqs: 2001   http_req_failed: 0.04% (1 request)   checks_succeeded: 99.95%
served_server_1: 836   served_server_2: 326   served_server_3: 838
exit code: 0
```

Cara membaca angka failover itu:

- `server-2` hanya dapat ±330 request karena ia absen ±14 detik dari 40 detik skenario.
- **1 dari 2001 request gagal** (0,04%) — request yang sudah setengah jalan saat container dimatikan paksa, sehingga sudah tidak bisa diulang. Ini masih jauh di bawah ambang 1%, dan bukan 0%: saya tulis apa adanya.
- k6 tetap exit 0 karena ambang terpenuhi.

## 5. Varian container: Traefik + 3 container (tiap server punya URL sendiri)

Semua dibuat dari nol di folder ini. **Tidak menyentuh project yang sudah ada**: project compose sendiri (`lb-demo`), network sendiri (`lb-net`), port sendiri (80/8088/8089), jadi `proxy`, `sanmedclinic_internal`, `shared-api`, dan container lama `traefik-traefik-1` tidak tersentuh.

```
              ┌──────────────────────────────────────────────────────┐
              │  Traefik :80  (apps)   :8089 (dashboard + API)        │
              │  network: lb-net                                      │
              └───┬──────────┬──────────┬───────────────┬────────────┘
                  │          │          │               │
   Host() router  │          │          │               │
   ───────────────┘          │          │               │
   server.localhost → service "demo" (3 server, wrr)    │
   server-1.localhost → service "direct-1" (1 server) ──┘
   server-2.localhost → service "direct-2" (1 server)
   server-3.localhost → service "direct-3" (1 server)
```

### URL

| URL | Arti |
|---|---|
| `http://server.localhost/` | **Load balancer** — request dibagi bergiliran ke 3 server |
| `http://server-1.localhost/` | **Langsung ke `server-1`** (tidak ikut load balancing) |
| `http://server-2.localhost/` | Langsung ke `server-2` |
| `http://server-3.localhost/` | Langsung ke `server-3` |
| `http://127.0.0.1:8088/` | Cadangan: LB lewat port, kalau port 80 dipakai aplikasi lain |
| `http://127.0.0.1:8089/dashboard/` | Dashboard Traefik (routers, services, status tiap server) |
| `http://127.0.0.1:8089/api/http/services` | JSON: berapa server terdaftar & statusnya |

`*.localhost` di-resolve otomatis oleh Windows/Linux/macOS modern — **tidak perlu mengedit hosts file** dan tidak perlu admin. Sudah diuji di mesin ini lewat IPv4 (`127.0.0.1`) maupun IPv6 (`::1`).

### Menjalankan

```bash
npm run docker:up      # docker compose -p lb-demo up -d --build
npm run docker:ps      # status + health tiap container
npm run docker:logs    # access log Traefik (siapa melayani apa)
npm run docker:down    # berhenti + hapus container & network (image tetap)
```

Cek cepat:

```powershell
1..6 | % { curl.exe -s "http://server.localhost/halo?i=$_" | Select-String 'servedBy' }
curl.exe -s http://server-2.localhost/siapa   # selalu server-2
```

### Bagaimana Traefik tahu servernya

Semua ada di `docker-compose.yml` + `docker/traefik/traefik.yml`:

- `traefik.enable=true` dan `...loadbalancer.server.port=3000` → container ikut terdaftar (yang tidak berlabel diabaikan karena `exposedByDefault: false`).
- Ketiga container memakai **nama service yang sama** (`demo`) → Traefik menggabungkannya menjadi satu service berisi 3 server, algoritma default `wrr` (weighted round robin).
- **Router `demo`** menangkap `Host(server.localhost)` plus semua path sebagai fallback, tapi **mengecualikan** `server-1/2/3.localhost`:
  `Host(`server.localhost`) || (PathPrefix(`/`) && !HostRegexp(`server-[0-9]+[.]localhost`))`
- **Router `direct-N`** (prioritas 100, mengalahkan `demo` yang prioritas 1) dipatok ke satu container saja. Karena `direct-N` tidak memakai middleware `retry`, saat server itu mati URL-nya **gagal** (bukan diam-diam dialihkan ke server lain).
- Label `...routers.demo.service: demo` **wajib** ada: tiap container mendefinisikan dua service (`demo` dan `direct-N`), dan tanpa label ini Traefik membuang router `demo` dengan error `cannot be linked automatically with multiple Services`. Gejalanya: `server.localhost` balas 404.
- **Health check aktif**: label `...healthcheck.path=/health` (interval 2s) + `HEALTHCHECK` di `docker/backend.Dockerfile`. Container mati/unhealthy otomatis keluar dari rotasi.
- **Failover pasif**: middleware `retry` 3× (`initialInterval 100ms`) mengulang request bila server tidak menjawab.
- **Batas waktu backend** di `traefik.yml`: `responseHeaderTimeout: 2s`, `dialTimeout: 2s`. Tanpa ini, request yang telanjur dikirim ke container yang baru mati **menggantung tanpa batas** (Traefik default: tanpa timeout) walau retry tersedia.
- Access log aktif, jadi setiap request tercatat di `npm run docker:logs`.

### Testing

```bash
npm run test:docker
```

```
▶ varian container: Traefik 3 server + URL sendiri per server
  ✔ smoke: 3 container sehat, dashboard hidup, 4 URL menjawab
  ✔ round robin: 30 request ke server.localhost terbagi rata
  ✔ URL per server tidak ikut load balancing (6x tetap server yang sama)
  ✔ beban: 300 request / 20 konkuren ke server.localhost, nol gagal
  ✔ failover: server-2 mati → LB tetap 200, URL server-2 tidak menipu
ℹ pass 6 | fail 0
```

Suite ini menyalakan stack sendiri, menguji lewat HTTP seperti user sungguhan, lalu `docker compose down` di akhir. Kalau Docker Desktop mati, test otomatis **skip** dengan pesan jelas (bukan gagal).

Untuk menjalankan keduanya sekaligus: `npm run test:all`.

### Angka terukur (bukan asumsi)

| Peristiwa | Hasil |
|---|---|
| `docker compose stop server-2` → hilang dari rotasi | **~1,1 detik** |
| `docker compose start server-2` → kembali ke rotasi | **~6,1 detik** (Docker `start-period` 5s + Traefik poll) |
| 12 request tepat setelah server dimatikan | **12/12 sukses 200**; satu request tertahan ~4,3 s lalu tetap 200 (retry) |
| `http://server-2.localhost` saat server-2 mati | **404** — tidak menipu dengan mengalihkan ke server lain |
| 300 request / 20 konkuren via `server.localhost` | **0 gagal**, ±600–770 req/detik (bervariasi antar run) |
| Sebaran 30 request | selalu 3 server kebagian, tiap server 9–11 request |
| `npm run test:docker` diulang 3× | **6/6 lulus** setiap kali |

### Batasan varian ini

- Tidak ada `/stats` dan dashboard buatan sendiri — statistik diambil dari API/dashboard Traefik.
- `responseHeaderTimeout 2s` berarti endpoint yang sengaja lambat > 2 detik (mis. `/slow?ms=5000`) akan dipotong bila lewat Traefik. Naikkan nilainya di `docker/traefik/traefik.yml` bila perlu (lalu `docker compose restart traefik`, karena config statis hanya dibaca saat start).
- `retry` Traefik secara default hanya untuk metode idempotent (GET/HEAD); POST tidak diulang. Bisa diubah dengan `retryNonIdempotentMethod=true` bila memang aman.
- `docker.sock` di-mount read-only, tapi tetap memberi akses ke Docker API — hanya untuk demo lokal, jangan diekspos ke internet.
- Dashboard `api.insecure=true` tanpa login di port 8089.

## 6. Uji failover manual (versi Node)

1. `npm start`
2. Buka dashboard `http://127.0.0.1:8080/`
3. Matikan backend `server-2` dari terminal lain (PowerShell):

   ```powershell
   $conn = Get-NetTCPConnection -LocalPort 3002 -State Listen
   Stop-Process -Id $conn.OwningProcess -Force
   ```

   (Alternatif: matikan proses Node.js `server.js` lewat Task Manager.)
4. Dalam ≤2 detik kartu backend itu jadi **merah / mati**, dan semua request tetap **200** dan hanya dilayani 2 server sisanya.
5. Untuk menghidupkannya lagi tanpa mematikan LB:

   ```powershell
   $env:BACKEND_ID='server-2'; npm run start:backend
   ```

   Kartu kembali hijau dan rotasi normal lagi.

## 7. Mengganti algoritma

Edit `config.json`, lalu restart:

```json
"loadBalancer": {
  "algorithm": "least-connections"
}
```

Pilihan: `round-robin`, `least-connections`.

## 8. Konfigurasi (`config.json`)

| Field | Arti |
|---|---|
| `loadBalancer.port` | Port LB (default 8080) |
| `loadBalancer.algorithm` | `round-robin` atau `least-connections` |
| `healthCheck.intervalMs` | Jarak antar probe (default 2000 ms) |
| `healthCheck.timeoutMs` | Batas waktu satu probe |
| `healthCheck.failureThreshold` | Jumlah gagal berturut-turut sebelum backend dianggap mati |
| `backends[]` | `id`, `host`, `port` tiap backend |

## 9. Cara kerja singkat (versi Node)

- **Round robin** — penunjuk bergilir per request, hanya menghitung backend sehat.
- **Least connections** — pilih backend dengan `activeConnections` paling kecil; bila seri, diputar round robin agar tidak selalu menumpuk di server pertama.
- **Health check aktif** — LB memanggil `/health` tiap 2 detik. Gagal → backend ditandai mati dan keluar dari rotasi. Berhasil → kembali masuk rotasi.
- **Failover pasif** — kalau koneksi ke backend gagal di tengah request (mis. proses baru saja dimatikan), backend langsung ditandai mati dan request dicoba ulang ke backend lain, sehingga klien tetap menerima 200.
- **Tidak ada backend sehat** → `503` dengan `{"error": "...", "tried": [...]}`.

## 10. Batasan (sengaja, karena ini project demo/pembelajaran)

- Body request/response di-buffer di memori (batas 1 MB untuk request) agar retry bisa dilakukan — bukan untuk file besar.
- Belum ada TLS, autentikasi, sticky session, rate limiting, atau circuit breaker.
- Backend tidak menyimpan state; request berikutnya bisa dilayani server lain.

Keputusan desain beserta alasannya ada di [`docs/adr/`](docs/adr/), istilah teknis di [`GLOSSARY.md`](GLOSSARY.md).

## 11. Troubleshooting

| Gejala | Penyebab & solusi |
|---|---|
| `EADDRINUSE` saat `npm start` | Port 8080/3001/3002/3003 dipakai. Ubah `config.json` atau matikan proses lain. |
| Dashboard menampilkan "load balancer tidak merespons" | LB sudah mati — jalankan `npm start` lagi. |
| Test gagal "Timeout menunggu load balancer hidup" | Port acak bentrok (jarang). Jalankan ulang `npm test`. |
| `node: command not found` | Node.js belum terpasang; butuh Node 20+. |
| Port 8080/3001-3003 masih terpakai setelah terminal di-force close | Proses anak bisa tertinggal. Bersihkan: `Get-CimInstance Win32_Process -Filter "Name='node.exe'" \| Where-Object { $_.CommandLine -like '*loadBalancer*' } \| ForEach-Object { Stop-Process -Id $_.ProcessId -Force }` |
| `test:docker` dilewati ("Docker daemon tidak berjalan") | Nyalakan Docker Desktop, tunggu status "running", ulangi. |
| `bind: address already in use` saat `docker:up` | Port 80/8088/8089 dipakai proses lain. Bebaskan port 80, atau tetap pakai `http://127.0.0.1:8088` (sudah dipetakan juga). |
| `http://server.localhost` balas **404** | Traefik membuang router `demo` karena ambigu. Cek `docker compose -p lb-demo logs traefik \| Select-String "cannot be linked"`. Pastikan label `traefik.http.routers.demo.service: demo` ada, lalu `docker compose -p lb-demo restart traefik`. |
| Perubahan `traefik.yml` tidak berefek | Config statis hanya dibaca saat start: `docker compose -p lb-demo restart traefik` (bind mount saja tidak cukup). |
| `server.localhost` tidak resolve (`curl exit 7`) | Berarti tidak ada yang listen, bukan masalah DNS. Pastikan stack hidup. Bila OS benar-benar tidak resolve `*.localhost`, tambahkan `127.0.0.1 server.localhost server-1.localhost server-2.localhost server-3.localhost` ke hosts file (butuh admin). |
| Request menggantung lama saat server dimatikan | `responseHeaderTimeout` di `traefik.yml` (2s) yang membatasi; tanpa itu request bisa menunggu tanpa batas. |
| Dashboard Traefik kosong / service tidak muncul | Cek `npm run docker:logs`; pastikan container berstatus `healthy` (`npm run docker:ps`). |
| Ingin bersih total (termasuk image) | `docker compose -p lb-demo down --rmi local --remove-orphans` |
| `k6 belum terpasang` | `npm run k6:install` (butuh Bun + akses GitHub). |
| `k6:install` gagal HTTP 403 | Rate limit GitHub API; tunggu beberapa menit atau unduh manual rilis k6. |

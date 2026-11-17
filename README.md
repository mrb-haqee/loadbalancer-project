# Load Balancer — 3 Server (Traefik + Docker)

Load balancer yang membagi trafik ke **3 backend server** memakai **Traefik 3.6** di Docker, dengan **URL sendiri untuk tiap server**, dashboard, test suite, dan skenario uji beban k6.

Semua dibuat dari nol di folder ini. **Tidak menyentuh project yang sudah ada**: project compose sendiri (`lb-demo`), network sendiri (`lb-net`), port sendiri (80/8088/8089). Jadi `proxy`, `sanmedclinic_internal`, `shared-api`, dan container lama `traefik-traefik-1` tidak tersentuh.

> Sebelumnya ada varian load balancer yang ditulis sendiri di Node.js. Varian itu **sudah dihapus** dari project ini karena yang dipakai hanya versi container. Catatan sejarahnya tetap ada di [`docs/adr/`](docs/adr/).

## URL

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

## 1. Arsitektur

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

4 container: 1 Traefik + 3 backend, semuanya satu image backend dan satu network `lb-net`.

## 2. Struktur project

```
loadBalancer/
├── config.json                   # peta identitas backend (dipakai saat backend jalan tanpa env)
├── package.json                  # script docker/test/k6
├── docker-compose.yml            # Traefik + 3 server (network lb-net, port 80/8088/8089)
├── docker/
│   ├── backend.Dockerfile        # image backend (Node 22 alpine + HEALTHCHECK)
│   └── traefik/traefik.yml       # config statis Traefik (provider Docker, timeout backend, dashboard, access log)
├── src/
│   ├── backend/server.js         # aplikasi backend (dijalankan 3x, beda BACKEND_ID)
│   └── shared/                   # loader config.json + logger
├── test/
│   └── docker/
│       ├── helpers/docker-stack.js  # start/stop stack compose untuk test
│       └── lb-docker.test.js        # smoke, URL per server, distribusi, beban, failover
├── scripts/
│   ├── install-k6.js             # unduh binary k6 resmi lewat Bun → tools/k6/
│   └── k6.js                     # pembungkus k6 (Windows/Linux/macOS)
├── k6/
│   ├── load-test.js              # uji beban + threshold
│   ├── failover.js               # skenario failover (sambil server dimatikan)
│   └── lib/backend-counters.js   # counter per server agar sebaran terlihat
├── GLOSSARY.md
└── docs/adr/                     # catatan keputusan desain
```

## 3. Menjalankan

```bash
npm run docker:up      # docker compose -p lb-demo up -d --build
npm run docker:ps      # status + health tiap container
npm run docker:logs    # access log Traefik (siapa melayani apa)
npm run docker:down    # berhenti + hapus container & network (image tetap)
```

Cek cepat:

```powershell
# 6 request ke load balancer — harus bergiliran ke 3 server
1..6 | % { curl.exe -s "http://server.localhost/halo?i=$_" | Select-String 'servedBy' }

# URL per server — selalu server itu
curl.exe -s http://server-2.localhost/siapa
```

Respons backend menyebut identitas dirinya:

```json
{
  "servedBy": "server-2",
  "port": 3000,
  "pid": 1,
  ...
}
```

## 4. Bagaimana Traefik tahu servernya

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

## 5. Testing otomatis: apakah semuanya berjalan?

```bash
npm test          # sama dengan npm run test:docker
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

Test suite ini **bukan unit test palsu**: ia menyalakan stack compose sendiri, menguji lewat HTTP seperti user sungguhan, lalu `docker compose down` di akhir. Kalau Docker Desktop mati, test otomatis **skip** dengan pesan jelas (bukan gagal).

## 6. Uji beban dengan k6

k6 adalah binary Go, **bukan** paket JavaScript — `bun add k6` tidak bisa dipakai (paket npm bernama `k6` hanya dummy untuk autocomplete editor). Instalasinya tetap lewat Bun:

```bash
npm run k6:install     # = bun scripts/install-k6.js → unduh rilis resmi ke tools/k6/k6.exe
npm run k6             # cek versi
```

| Perintah | Arti |
|---|---|
| `npm run k6:load` | 100 req/detik selama 15 detik ke `http://server.localhost` |
| `npm run k6:failover` | 50 req/detik selama 40 detik, untuk diuji sambil mematikan server |

Ganti target atau intensitas (mis. port cadangan 8088):

```bash
bun scripts/k6.js run k6/load-test.js -e RATE=200 -e DURATION=20s
bun scripts/k6.js run k6/failover.js -e BASE_URL=http://127.0.0.1:8088 -e DURATION=60s
```

Threshold yang dipakai: `http_req_failed < 1%`, `p(95) < 500ms`, `checks > 99%`. k6 keluar dengan exit code ≠ 0 bila salah satu gagal, jadi aman dipakai di CI.

Hasil terukur (`http://server.localhost`):

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
- **1 dari 2001 request gagal** (0,04%) — request yang sudah setengah jalan saat container dimatikan paksa, sehingga sudah tidak bisa diulang. Ini jauh di bawah ambang 1%, dan bukan 0%: saya tulis apa adanya.
- k6 tetap exit 0 karena ambang terpenuhi.

## 7. Angka terukur (bukan asumsi)

| Peristiwa | Hasil |
|---|---|
| `docker compose stop server-2` → hilang dari rotasi | **~1,1 detik** |
| `docker compose start server-2` → kembali ke rotasi | **~6,1 detik** (Docker `start-period` 5s + Traefik poll) |
| 12 request tepat setelah server dimatikan | **12/12 sukses 200**; satu request tertahan ~4,3 s lalu tetap 200 (retry) |
| `http://server-2.localhost` saat server-2 mati | **404** — tidak menipu dengan mengalihkan ke server lain |
| 300 request / 20 konkuren via `server.localhost` | **0 gagal**, ±600–770 req/detik (bervariasi antar run) |
| Sebaran 30 request | selalu 3 server kebagian, tiap server 9–11 request |
| `npm test` diulang 3× | **6/6 lulus** setiap kali |

## 8. Batasan (sengaja, karena ini project demo/pembelajaran)

- Statistik tidak dikumpulkan sendiri — dibaca dari API/dashboard Traefik.
- `responseHeaderTimeout 2s` berarti endpoint yang sengaja lambat > 2 detik (mis. `/slow?ms=5000`) akan dipotong bila lewat Traefik. Naikkan nilainya di `docker/traefik/traefik.yml` bila perlu (lalu `docker compose -p lb-demo restart traefik`, karena config statis hanya dibaca saat start).
- `retry` Traefik secara default hanya untuk metode idempotent (GET/HEAD); POST tidak diulang. Bisa diubah dengan `retryNonIdempotentMethod=true` bila memang aman.
- Belum ada TLS, autentikasi, sticky session, rate limiting, atau circuit breaker.
- Backend tidak menyimpan state; request berikutnya bisa dilayani server lain.
- `docker.sock` di-mount read-only, tapi tetap memberi akses ke Docker API — hanya untuk demo lokal, jangan diekspos ke internet.
- Dashboard `api.insecure=true` tanpa login di port 8089.

Keputusan desain beserta alasannya ada di [`docs/adr/`](docs/adr/), istilah teknis di [`GLOSSARY.md`](GLOSSARY.md).

## 9. Troubleshooting

| Gejala | Penyebab & solusi |
|---|---|
| `test` dilewati ("Docker daemon tidak berjalan") | Nyalakan Docker Desktop, tunggu status "running", ulangi. |
| `bind: address already in use` saat `docker:up` | Port 80/8088/8089 dipakai proses lain. Bebaskan port 80, atau tetap pakai `http://127.0.0.1:8088` (sudah dipetakan juga). |
| `http://server.localhost` balas **404** | Traefik membuang router `demo` karena ambigu. Cek `docker compose -p lb-demo logs traefik \| Select-String "cannot be linked"`. Pastikan label `traefik.http.routers.demo.service: demo` ada, lalu `docker compose -p lb-demo restart traefik`. |
| Perubahan `traefik.yml` tidak berefek | Config statis hanya dibaca saat start: `docker compose -p lb-demo restart traefik` (bind mount saja tidak cukup). |
| `server.localhost` tidak resolve (`curl exit 7`) | Berarti tidak ada yang listen, bukan masalah DNS. Pastikan stack hidup. Bila OS benar-benar tidak resolve `*.localhost`, tambahkan `127.0.0.1 server.localhost server-1.localhost server-2.localhost server-3.localhost` ke hosts file (butuh admin). |
| Request menggantung lama saat server dimatikan | `responseHeaderTimeout` di `traefik.yml` (2s) yang membatasi; tanpa itu request bisa menunggu tanpa batas. |
| Dashboard Traefik kosong / service tidak muncul | Cek `npm run docker:logs`; pastikan container berstatus `healthy` (`npm run docker:ps`). |
| Ingin bersih total (termasuk image) | `docker compose -p lb-demo down --rmi local --remove-orphans` |
| `k6 belum terpasang` | `npm run k6:install` (butuh Bun + akses GitHub). |
| `k6:install` gagal HTTP 403 | Rate limit GitHub API; tunggu beberapa menit atau unduh manual rilis k6. |

# Load Balancer — 3 Server (Traefik + Docker)

Load balancer yang membagi trafik ke **3 backend server** memakai **Traefik 3.6** di Docker, dengan **URL sendiri untuk tiap server**, dashboard, test suite, dan skenario uji beban k6.

Semua dibuat dari nol di folder ini. **Tidak menyentuh project yang sudah ada**: project compose sendiri, network sendiri (`lb-net`), port sendiri (80/8088/8089). Jadi `proxy`, `sanmedclinic_internal`, `shared-api`, dan container lama `traefik-traefik-1` tidak tersentuh.

Tiga project compose terpisah, semuanya berbagi network `lb-net`:

| Project | File | Isi |
|---|---|---|
| `lb-traefik` | `docker-compose.traefik.yml` | Traefik saja — pintu masuk semua URL |
| `lb-demo` | `docker-compose.yml` | 3 backend (`server-1/2/3`) |
| `lb-k6` | `docker-compose.monitoring.yml` | k6, InfluxDB, Grafana |

Traefik tidak "memiliki" backend maupun dashboard monitoring: apa pun yang diberi label dan menempel di `lb-net` otomatis dapat URL. Grafana dan web dashboard k6 karena itu bisa dibuka lewat `grafana.localhost` dan `k6.localhost`, bukan hanya lewat port.

> Sebelumnya ada varian load balancer yang ditulis sendiri di Node.js. Varian itu **sudah dihapus** dari project ini karena yang dipakai hanya versi container. Catatan sejarahnya tetap ada di [`docs/adr/`](docs/adr/).

## URL

| URL | Arti |
|---|---|
| `http://server.localhost/` | **Load balancer** — request dibagi bergiliran ke 3 server |
| `http://server-1.localhost/` | **Langsung ke `server-1`** (tidak ikut load balancing) |
| `http://server-2.localhost/` | Langsung ke `server-2` |
| `http://server-3.localhost/` | Langsung ke `server-3` |
| `http://grafana.localhost/` | **Grafana** — dashboard hasil k6 **dan** dashboard realtime trafik |
| `http://traefik.localhost/dashboard/` | Dashboard Traefik (routers, services, status tiap server) |
| `http://k6.localhost/` | Web dashboard k6 — **hanya saat `npm run k6:watch`** |
| `http://127.0.0.1:8088/` | Cadangan: LB lewat port, kalau port 80 dipakai aplikasi lain |
| `http://127.0.0.1:8089/dashboard/` | Cadangan: dashboard Traefik lewat port |
| `http://127.0.0.1:3000/` | Cadangan: Grafana lewat port |
| `http://127.0.0.1:8089/api/http/services` | JSON: berapa server terdaftar & statusnya |

`*.localhost` di-resolve otomatis oleh Windows/Linux/macOS modern — **tidak perlu mengedit hosts file** dan tidak perlu admin. Sudah diuji di mesin ini lewat IPv4 (`127.0.0.1`) maupun IPv6 (`::1`).

## 1. Arsitektur

```
 project lb-traefik        project lb-demo        project lb-k6
 ┌──────────────────┐      ┌──────────────┐       ┌───────────────────┐
 │ Traefik          │      │ server-1     │       │ Grafana :3000     │
 │ :80 :8088 :8089  │      │ server-2     │       │ InfluxDB :8086    │
 │ docker.sock (ro) │      │ server-3     │       │ k6 (sekali pakai) │
 └────────┬─────────┘      └──────┬───────┘       └─────────┬─────────┘
          └───────────── lb-net (external) ─────────────────┘
```

6 container: 1 Traefik, 3 backend, InfluxDB + Grafana. Network `lb-net` dibuat **di luar compose** (`npm run net:up`) dan dipakai bersama; masing-masing project bisa naik/turun sendiri.

## 2. Struktur project

```
loadBalancer/
├── config.json                   # peta identitas backend (dipakai saat backend jalan tanpa env)
├── package.json                  # script docker/traefik/test/k6/monitoring
├── docker-compose.traefik.yml    # Traefik saja (project lb-traefik, network lb-net external)
├── docker-compose.yml            # 3 backend server (project lb-demo)
├── docker-compose.monitoring.yml # k6 + InfluxDB + Grafana (project lb-k6)
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
│   ├── network.js                # buat network lb-net sekali (idempotent)
│   ├── install-k6.js             # unduh binary k6 resmi lewat Bun → tools/k6/
│   └── k6.js                     # pembungkus k6 (Windows/Linux/macOS)
├── k6/
│   ├── load-test.js              # uji beban + threshold
│   ├── failover.js               # skenario failover (sambil server dimatikan)
│   └── lib/backend-counters.js   # counter per server agar sebaran terlihat
├── monitoring/
│   ├── prometheus/prometheus.yml # scrape Traefik + 3 backend tiap 2 detik
│   ├── grafana/provisioning/     # datasource InfluxDB + Prometheus, provider dashboard
│   ├── grafana/dashboards/k6/    # k6.json (hasil test)
│   ├── grafana/dashboards/lb/    # lb-realtime.json (trafik nyata)
│   └── reports/                  # hasil ekspor report.html dari k6 web dashboard
├── GLOSSARY.md
└── docs/adr/                     # catatan keputusan desain
```

## 3. Menjalankan

Cara normal — satu perintah untuk semuanya:

```bash
npm run stack:up       # net:up → traefik:up → docker:up → k6:up
npm run stack:down     # k6:down → docker:down → traefik:down (urutan terbalik)
```

Per project, kalau hanya butuh sebagian atau sedang debug:

| Perintah | Arti |
|---|---|
| `npm run net:up` | Buat network bersama `lb-net` sekali (aman diulang) |
| `npm run traefik:up` / `traefik:down` | Traefik saja (project `lb-traefik`) |
| `npm run docker:up` / `docker:down` | 3 backend saja (project `lb-demo`) |
| `npm run k6:up` / `k6:down` | InfluxDB + Grafana (project `lb-k6`) |
| `npm run traefik:logs` | Access log Traefik (siapa melayani apa) |
| `npm run docker:ps` | Status + health container backend |
| `npm run docker:logs` | Log 3 backend server |

Urutan penting: network **sebelum** traefik, traefik **sebelum** yang lain. Saat mematikan, balik urutannya — `lb-net` tidak bisa dihapus selama masih ada container yang menempel.

Cek cepat:

```powershell
# 6 request ke load balancer — harus bergiliran ke 3 server
1..6 | % { curl.exe -s "http://server.localhost/halo?i=$_" | Select-String 'servedBy' }

# URL per server — selalu server itu
curl.exe -s http://server-2.localhost/siapa

# dashboard lain lewat Traefik, bukan port
curl.exe -s -o NUL -w "%{http_code}`n" http://grafana.localhost/login
curl.exe -s -o NUL -w "%{http_code}`n" http://traefik.localhost/dashboard/
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

Traefik hidup di project sendiri (`docker-compose.traefik.yml`), backend di `docker-compose.yml`, monitoring di `docker-compose.monitoring.yml`. Semua container yang menempel di `lb-net` dan berlabel dibaca Traefik — termasuk Grafana dan k6.

Aturan backend ada di `docker-compose.yml` + `docker/traefik/traefik.yml`:

- `traefik.enable=true` dan `...loadbalancer.server.port=3000` → container ikut terdaftar (yang tidak berlabel diabaikan karena `exposedByDefault: false`).
- Ketiga container memakai **nama service yang sama** (`demo`) → Traefik menggabungkannya menjadi satu service berisi 3 server, algoritma default `wrr` (weighted round robin).
- **Router `demo`** menangkap `Host(server.localhost)` plus semua path sebagai fallback, tapi **mengecualikan** `server-1/2/3.localhost`:
  `Host(`server.localhost`) || (PathPrefix(`/`) && !HostRegexp(`server-[0-9]+[.]localhost`))`
- **Router `direct-N`** (prioritas 100, mengalahkan `demo` yang prioritas 1) dipatok ke satu container saja. Karena `direct-N` tidak memakai middleware `retry`, saat server itu mati URL-nya **gagal** (bukan diam-diam dialihkan ke server lain).
- Label `...routers.demo.service: demo` **wajib** ada: tiap container mendefinisikan dua service (`demo` dan `direct-N`), dan tanpa label ini Traefik membuang router `demo` dengan error `cannot be linked automatically with multiple Services`. Gejalanya: `server.localhost` balas 404.
- **Health check aktif**: label `...healthcheck.path=/health` (interval 2s) + `HEALTHCHECK` di `docker/backend.Dockerfile`. Container mati/unhealthy otomatis keluar dari rotasi.
- **Failover pasif**: middleware `retry` 3× (`initialInterval 100ms`) mengulang request bila server tidak menjawab.
- **Batas waktu backend** di `traefik.yml`: `responseHeaderTimeout: 2s`, `dialTimeout: 2s`. Tanpa ini, request yang telanjur dikirim ke container yang baru mati **menggantung tanpa batas** (Traefik default: tanpa timeout) walau retry tersedia.
- Access log aktif, jadi setiap request tercatat di `npm run traefik:logs`.

Dashboard lain memakai pola yang sama, hanya beda host dan port:

| Host | Router | Service | Prioritas |
|---|---|---|---|
| `grafana.localhost` | `grafana` | container Grafana :3000 | 200 |
| `traefik.localhost` | `traefik-dash` | `api@internal` | 200 |
| `k6.localhost` | `k6-web` | container k6 :5665 | 200 |

**Kenapa prioritas 200?** Router `demo` sengaja menangkap *semua* host (`PathPrefix(/)`) supaya `http://127.0.0.1:8088` tetap berfungsi. Tanpa prioritas lebih tinggi, `grafana.localhost` akan ikut dilempar ke backend. Prioritas 200 membuat router spesifik menang, dan aturan `demo` tidak perlu diubah setiap kali ada host baru.

`k6.localhost` hanya hidup selama `npm run k6:watch` berjalan — begitu container k6 selesai, Traefik menghapus routernya (gejalanya 404, bukan halaman kosong).

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

Test suite ini **bukan unit test palsu**: ia memastikan network `lb-net` dan Traefik hidup (idempotent, tidak menyalakan ulang kalau sudah jalan), menyalakan 3 backend, menguji lewat HTTP seperti user sungguhan, lalu **hanya `lb-demo`** yang dimatikan di akhir. Traefik dibiarkan hidup karena mungkin sedang dipakai Grafana/k6. Kalau Docker Desktop mati, test otomatis **skip** dengan pesan jelas (bukan gagal).

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

## 7. Monitoring: k6, trafik nyata, dan Grafana

Semua ada di `docker-compose.monitoring.yml` dengan project sendiri (`lb-k6`), jadi tidak mengganggu stack `lb-demo` maupun `npm test`. Grafana dan k6 ikut menempel di `lb-net`, jadi keduanya juga punya URL lewat Traefik.

Ada **dua sumber data** dengan arti berbeda:

| Sumber | Isi | Dashboard |
|---|---|---|
| InfluxDB 1.8 | hasil **test k6** (hanya terisi saat `k6:run` / `k6:watch`) | `k6-lb` |
| Prometheus | **trafik nyata** Traefik + 3 backend, scrape tiap 2 detik | `lb-realtime` |

```
k6 (container) ──HTTP──> traefik:80 (server.localhost)
      │
      └── output influxdb ──> influxdb:8086 (db `k6`) ──┐
                                                          ├──> grafana:3000
traefik:8080/metrics + server-N:3000/metrics              │
      └── scrape 2s ──> prometheus:9090 ──────────────────┘
```

| URL | Arti |
|---|---|
| `http://grafana.localhost/` | **Grafana** (admin/admin, viewer anonim aktif). Dua dashboard: folder `k6` → `k6-lb`, folder `load-balancer` → `lb-realtime` |
| `http://grafana.localhost/d/lb-realtime` | Langsung ke dashboard realtime |
| `http://grafana.localhost/d/k6-lb` | Langsung ke dashboard hasil k6 |
| `http://127.0.0.1:3000` | Cadangan: Grafana lewat port |
| `http://k6.localhost/` | Web dashboard bawaan k6, **hanya hidup saat `npm run k6:watch`** |
| `http://127.0.0.1:5665` | Cadangan: web dashboard k6 lewat port |

InfluxDB dan Prometheus **tidak** diekspos ke host maupun lewat Traefik. InfluxDB tidak punya UI; Prometheus hanya dikonsumsi Grafana.

| Perintah | Arti |
|---|---|
| `npm run k6:up` | Nyalakan InfluxDB + Grafana + Prometheus (image diunduh sekali) |
| `npm run k6:run` | Jalankan k6 sekali di container, hasil masuk InfluxDB + Grafana |
| `npm run k6:watch` | Sama, tapi dashboard web k6 hidup di `http://k6.localhost` / `http://127.0.0.1:5665` dan hasilnya diekspor ke `monitoring/reports/report.html` |
| `npm run k6:down` | Matikan stack monitoring (data di volume tetap) |
| `npm run k6:logs` | Log InfluxDB/Grafana/k6 |

Alur pemakaian:

```bash
npm run stack:up       # network + traefik + backend + monitoring
npm run k6:run         # k6 di container: 100 req/detik selama 15 detik
# buka http://grafana.localhost → folder k6 → dashboard k6-lb
# buka http://grafana.localhost/d/lb-realtime kapan saja (tanpa k6)
npm run stack:down     # urutan shutdown sudah diurus script
```

Panel dashboard: total request, request gagal, check lulus, VU maksimum, request/detik, latensi p50/p95/p99, sebaran request per server, dan status code. Ada variabel **Run** untuk memfilter satu eksekusi tertentu — tiap run diberi tag `run` berisi timestamp, jadi run lama tetap bisa dibandingkan.

### 7a. Dashboard realtime `lb-realtime` (Prometheus)

Dashboard ini **tidak bergantung pada k6**. Selama backend hidup, Prometheus menembak `/metrics` tiap 2 detik dan grafik diperbarui tiap 5 detik, jadi request manual dari browser pun langsung terlihat.

Sumber angkanya dua, dan bedanya penting:

| Metrik | Dari | Arti |
|---|---|---|
| `traefik_entrypoint_requests_total` | Traefik | request yang **masuk** ke Traefik (termasuk yang nanti gagal) |
| `lb_backend_requests_total` | tiap backend | request yang **benar-benar diterima** server |
| `lb_backend_request_duration_seconds` | tiap backend | histogram durasi, dipakai untuk p95 |
| `up{job=...}` | Prometheus | target scrape hidup atau mati |

Panel (10):

| Panel | Query inti |
|---|---|
| Request masuk / detik | `sum(rate(traefik_entrypoint_requests_total{protocol="http"}[30s]))` |
| Request diterima / detik | `sum(rate(lb_backend_requests_total[30s]))` |
| Error 5xx / detik | `rate(...{code=~"5.."}[1m])` |
| Backend sehat | `sum(up{job="backend"})` (0–3) |
| Masuk vs diterima (grafik) | dua rate di atas, satu grafik |
| Diterima per server | `sum by (server) (rate(lb_backend_requests_total[30s]))` |
| Masuk per service | `sum by (service) (rate(traefik_service_requests_total[30s]))` |
| Status code | `sum by (code) (rate(...))` |
| Latensi p95 per server | `histogram_quantile(0.95, sum by (server, le) (rate(lb_backend_request_duration_seconds_bucket[1m])))` |
| Status target scrape | `up{job=~"backend\|traefik"}` → UP/DOWN per target |

Selisih "masuk" dan "diterima" itu normal dan bukan bug: health check Traefik (`/health`) tidak dihitung backend, sementara `/metrics` dan `/health` sengaja dikecualikan dari counter backend agar angkanya tidak tercemar probe 2 detik.

Endpoint `/metrics` backend adalah teks polos tanpa dependency (`src/backend/server.js`), berisi counter `lb_backend_requests_total`, `lb_backend_slow_requests_total`, dan histogram `lb_backend_request_duration_seconds`. Bisa dicek langsung:

```bash
curl http://server-1.localhost/metrics
```

Konfigurasi scrape ada di `monitoring/prometheus/prometheus.yml` (job `traefik` + satu target per backend, label `server`). Datasource Grafana-nya uid `prometheus` (`monitoring/grafana/provisioning/datasources/prometheus.yml`).


Ganti intensitas atau skenario (env var diteruskan ke container lewat `-e`):

```bash
docker compose -p lb-k6 -f docker-compose.monitoring.yml run --rm -e DURATION=60s -e RATE=200 k6
docker compose -p lb-k6 -f docker-compose.monitoring.yml run --rm k6 run failover.js
```

Catatan jujur soal versi: k6 v2.4.0 menandai output `influxdb` (dan `experimental-prometheus-rw`) sebagai **deprecated**, rencananya dihapus di k6 v3 dan diganti OpenTelemetry. Untuk demo ini tetap dipakai karena paling stabil dan dashboard-nya sudah terbukti berisi data; kalau nanti pindah ke k6 v3, ganti ke output OpenTelemetry + datasource Prometheus/Tempo.

Hasil terukur dari container (`npm run k6:run`, 15 detik, 100 req/detik):

```
http_reqs: 1501   100.96/detik
http_req_failed: 0.00%   checks_succeeded: 100.00%
served_server_1: 500   served_server_2: 500   served_server_3: 501
report.html (k6:watch): 167 KB
```

`k6:watch` menahan proses selama tab browser dashboard masih terbuka — tutup tab (atau tekan Ctrl+C) kalau run sudah selesai.

## 8. Angka terukur (bukan asumsi)

| Peristiwa | Hasil |
|---|---|
| `docker compose stop server-2` → hilang dari rotasi | **~1,1 detik** |
| `docker compose start server-2` → kembali ke rotasi | **~6,1 detik** (Docker `start-period` 5s + Traefik poll) |
| 12 request tepat setelah server dimatikan | **12/12 sukses 200**; satu request tertahan ~4,3 s lalu tetap 200 (retry) |
| `http://server-2.localhost` saat server-2 mati | **404** — tidak menipu dengan mengalihkan ke server lain |
| 300 request / 20 konkuren via `server.localhost` | **0 gagal**, ±600–770 req/detik (bervariasi antar run) |
| Sebaran 30 request | selalu 3 server kebagian, tiap server 9–11 request |
| `npm test` diulang 3× | **6/6 lulus** setiap kali |
| `grafana.localhost` / `traefik.localhost` setelah dipisah | **200**, tidak nyasar ke backend (router prioritas 200 menang atas fallback `demo` prioritas 1) |
| `k6.localhost` saat `npm run k6:watch` | **200** selama run, router hilang ~6 detik setelah k6 selesai |
| `npm run stack:up` dijalankan ulang | **idempotent**: "network lb-net sudah ada", container yang sudah hidup tidak dibuat ulang |
| Dashboard `lb-realtime` saat backend hidup | 10 panel berisi data; scrape 4 target (`traefik` + 3 backend) `up=1` |
| 30 request manual ke `server.localhost` | masuk 14,48 req/detik, diterima 13,89 req/detik, per server 4,3 / 4,7 / 4,9, p95 ±4,7 ms |

## 9. Batasan (sengaja, karena ini project demo/pembelajaran)

- Statistik tidak dikumpulkan sendiri — dibaca dari API/dashboard Traefik.
- `responseHeaderTimeout 2s` berarti endpoint yang sengaja lambat > 2 detik (mis. `/slow?ms=5000`) akan dipotong bila lewat Traefik. Naikkan nilainya di `docker/traefik/traefik.yml` bila perlu (lalu `npm run traefik:down && npm run traefik:up`, karena config statis hanya dibaca saat start).
- `retry` Traefik secara default hanya untuk metode idempotent (GET/HEAD); POST tidak diulang. Bisa diubah dengan `retryNonIdempotentMethod=true` bila memang aman.
- Belum ada TLS, autentikasi, sticky session, rate limiting, atau circuit breaker.
- Backend tidak menyimpan state; request berikutnya bisa dilayani server lain.
- `docker.sock` di-mount read-only, tapi tetap memberi akses ke Docker API — hanya untuk demo lokal, jangan diekspos ke internet.
- Dashboard `api.insecure=true` tanpa login di port 8089 **dan** di `http://traefik.localhost/dashboard/`. Endpoint `/metrics` Traefik juga ikut terbuka di sana (port 8080 tidak dipublikasikan, tapi 8089 memuat API yang sama).
- Grafana memakai kredensial default `admin/admin` dan viewer anonim; InfluxDB tanpa autentikasi dan tidak dipublikasikan ke host. Hanya untuk lokal.
- Prometheus tanpa autentikasi dan tanpa port publik — hanya bisa diakses dari network `lb-net` / `lb-k6-net`. Retensi 7 hari.
- Data monitoring disimpan di volume Docker (`influxdb-data`, `prometheus-data`); `npm run k6:down` tidak menghapusnya, `... down -v` menghapusnya.
- Metrik backend disimpan di memori proses: counter kembali 0 setiap container backend dibuat ulang, dan Prometheus ikut melihatnya sebagai reset (rate tetap benar, angka total tidak).
- Scrape 2 detik berarti puncak trafik yang lebih pendek dari 2 detik bisa terlewat. Ini kompromi "cukup realtime" vs beban scrape.
- `npm test` hanya mematikan `lb-demo`; Traefik dibiarkan hidup. Kalau ingin benar-benar bersih, jalankan `npm run stack:down`.
- Network `lb-net` dibuat di luar compose, jadi `docker network prune` bisa menghapusnya saat semua container mati; pulihkan dengan `npm run net:up`.

Keputusan desain beserta alasannya ada di [`docs/adr/`](docs/adr/), istilah teknis di [`GLOSSARY.md`](GLOSSARY.md).

## 10. Troubleshooting

| Gejala | Penyebab & solusi |
|---|---|
| `test` dilewati ("Docker daemon tidak berjalan") | Nyalakan Docker Desktop, tunggu status "running", ulangi. |
| `bind: address already in use` saat `docker:up` | Port 80/8088/8089 dipakai proses lain. Bebaskan port 80, atau tetap pakai `http://127.0.0.1:8088` (sudah dipetakan juga). |
| `http://server.localhost` balas **404** | Traefik membuang router `demo` karena ambigu. Cek `docker compose -p lb-traefik -f docker-compose.traefik.yml logs traefik \| Select-String "cannot be linked"`. Pastikan label `traefik.http.routers.demo.service: demo` ada, lalu `npm run docker:up`. |
| Perubahan `traefik.yml` tidak berefek | Config statis hanya dibaca saat start: `npm run traefik:down && npm run traefik:up` (bind mount saja tidak cukup). |
| `server.localhost` tidak resolve (`curl exit 7`) | Berarti tidak ada yang listen, bukan masalah DNS. Pastikan stack hidup. Bila OS benar-benar tidak resolve `*.localhost`, tambahkan `127.0.0.1 server.localhost server-1.localhost server-2.localhost server-3.localhost` ke hosts file (butuh admin). |
| Request menggantung lama saat server dimatikan | `responseHeaderTimeout` di `traefik.yml` (2s) yang membatasi; tanpa itu request bisa menunggu tanpa batas. |
| Dashboard Traefik kosong / service tidak muncul | Cek `docker compose -p lb-traefik -f docker-compose.traefik.yml logs traefik`; pastikan container backend berstatus `healthy` (`npm run docker:ps`). |
| Ingin bersih total (termasuk image) | `npm run stack:down`, lalu `docker compose -p lb-demo down --rmi local` |
| `k6 belum terpasang` | `npm run k6:install` (butuh Bun + akses GitHub). |
| `k6:install` gagal HTTP 403 | Rate limit GitHub API; tunggu beberapa menit atau unduh manual rilis k6. |
| Grafana kosong / "No data" | Pastikan sudah ada run: `npm run k6:run`. Cek datasource: `http://grafana.localhost/api/datasources` harus berisi `k6-influxdb`. Cek data: `docker compose -p lb-k6 -f docker-compose.monitoring.yml exec -T influxdb influx -database k6 -execute 'SHOW MEASUREMENTS'`. |
| Dashboard tidak muncul di Grafana | Dashboard dibaca dari `monitoring/grafana/dashboards/k6` dan `.../lb`; `docker compose -p lb-k6 -f docker-compose.monitoring.yml restart grafana`, lalu cek log `npm run k6:logs`. |
| `lb-realtime` kosong / "No data" | Datasource `prometheus` belum ada atau Prometheus mati. Cek `http://grafana.localhost/api/datasources` (harus ada uid `prometheus`), lalu `npm run k6:up`. |
| Panel "Status target scrape" merah (DOWN) | Target tidak bisa di-scrape. Cek `docker compose -p lb-k6 -f docker-compose.monitoring.yml logs prometheus`. Penyebab umum: backend mati, atau Prometheus tidak menempel di `lb-net` (`npm run k6:down && npm run k6:up`). |
| Metrik `traefik_*` tidak ada di Prometheus | `metrics.prometheus` di `docker/traefik/traefik.yml` hanya dibaca saat start: `npm run traefik:down && npm run traefik:up`. Verifikasi: `curl http://127.0.0.1:8089/metrics \| Select-String traefik_entrypoint_requests_total`. |
| `k6` di container gagal resolve `server.localhost` | Alias network hanya aktif kalau traefik dibuat ulang setelah `docker-compose.traefik.yml` diubah: `npm run traefik:down && npm run traefik:up`. Cek: `docker run --rm --network lb-net alpine:3 nslookup server.localhost`. |
| `docker compose` gagal: `network lb-net declared as external, but could not be found` | Network belum dibuat: `npm run net:up`. |
| `grafana.localhost` balas JSON backend | Label router Grafana hilang atau prioritasnya tidak lebih tinggi dari `demo` (harus 200). Cek `http://127.0.0.1:8089/api/http/routers` dan pastikan `grafana@docker` berstatus `enabled`. |
| `k6.localhost` balas 404 | Normal kalau k6 tidak sedang jalan — router hanya ada selama `npm run k6:watch`. |
| `k6:watch` tidak bisa dibuka di 5665 | `docker compose run` tidak mempublikasikan port kecuali `--service-ports` — script sudah memakainya. Pastikan port 5665 bebas. |
| `report.html` tidak dibuat | k6 melewati ekspor bila run terlalu pendek ("not enough data"): butuh durasi > 3× `K6_WEB_DASHBOARD_PERIOD` (di sini 2s → minimal ~6s). |

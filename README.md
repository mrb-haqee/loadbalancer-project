# Load Balancer — 5 Server (Traefik + Docker)

Load balancer yang membagi trafik ke **5 backend server** memakai **Traefik 3.6** di Docker, dengan **URL sendiri untuk tiap server**, dashboard, test suite, skenario uji beban k6, **CRUD katalog server di MariaDB**, dan **monitoring database** (metrik, dashboard, alert, log error).

Semua dibuat dari nol di folder ini. **Tidak menyentuh project yang sudah ada**: project compose sendiri, network sendiri (`lb-net`), port sendiri (80/8088/8089). Jadi `proxy`, `sanmedclinic_internal`, `shared-api`, dan container lama `traefik-traefik-1` tidak tersentuh.

Empat project compose terpisah, semuanya berbagi network `lb-net`:

| Project | File | Isi |
|---|---|---|
| `lb-traefik` | `docker-compose.traefik.yml` | Traefik saja — pintu masuk semua URL |
| `lb-demo` | `docker-compose.yml` | 5 backend (`server-1` … `server-5`) |
| `lb-db` | `docker-compose.db.yml` | MariaDB 11.4 + Adminer |
| `lb-k6` | `docker-compose.monitoring.yml` | k6, Grafana, Prometheus, exporter MariaDB, Loki + Alloy |

Traefik tidak "memiliki" backend maupun dashboard monitoring: apa pun yang diberi label dan menempel di `lb-net` otomatis dapat URL. Grafana dan web dashboard k6 karena itu bisa dibuka lewat `grafana.localhost` dan `k6.localhost`, bukan hanya lewat port. MariaDB dan exporter-nya tetap tanpa rute Traefik: yang dibuka hanya dashboard-nya.

> Sebelumnya ada varian load balancer yang ditulis sendiri di Node.js. Varian itu **sudah dihapus** dari project ini karena yang dipakai hanya versi container. Catatan sejarahnya tetap ada di [`docs/adr/`](docs/adr/).

## URL

| URL | Arti |
|---|---|
| `http://server.localhost/` | **Load balancer** — request dibagi bergiliran ke 5 server |
| `http://server.localhost/ui` | **UI CRUD katalog server** (MariaDB), dilayani backend mana pun |
| `http://server-1.localhost/` | **Langsung ke `server-1`** (tidak ikut load balancing) |
| `http://server-2.localhost/` | Langsung ke `server-2` |
| `http://server-3.localhost/` | Langsung ke `server-3` |
| `http://server-4.localhost/` | Langsung ke `server-4` |
| `http://server-5.localhost/` | Langsung ke `server-5` |
| `http://server-N.localhost/ui` | UI yang sama, selalu dilayani `server-N` |
| `http://adminer.localhost/` | **Adminer** — pembaca isi database MariaDB (lewat Traefik) |
| `http://grafana.localhost/` | **Grafana** — dashboard hasil k6, realtime trafik, dan **database MariaDB** |
| `http://grafana.localhost/d/db-monitoring` | **Dashboard database** — status, koneksi, query, error, dan log |
| `http://traefik.localhost/dashboard/` | Dashboard Traefik (routers, services, status tiap server) |
| `http://k6.localhost/` | Web dashboard k6 — **hanya saat `make k6-watch`** |
| `http://127.0.0.1:8081/` | Cadangan: Adminer lewat port loopback, tetap jalan walau Traefik mati |
| `http://127.0.0.1:8088/` | Cadangan: LB lewat port, kalau port 80 dipakai aplikasi lain |
| `http://127.0.0.1:8089/dashboard/` | Cadangan: dashboard Traefik lewat port |
| `http://127.0.0.1:3000/` | Cadangan: Grafana lewat port |
| `http://127.0.0.1:8089/api/http/services` | JSON: berapa server terdaftar & statusnya |

`*.localhost` biasanya di-resolve otomatis oleh Windows/Linux/macOS modern — **tidak perlu mengedit hosts file** dan tidak perlu admin. Di mesin ini `server.localhost`, `server-1…3.localhost`, dan `adminer.localhost` resolve lewat IPv4/IPv6; `server-4/5` tidak selalu, karena itu test otomatis mengirim header `Host` ke `127.0.0.1` dan tidak bergantung pada resolusi OS. Kalau browser/curl Anda tidak resolve salah satu nama, tambahkan entri hosts (lihat Troubleshooting).

## 1. Arsitektur

```
 project lb-traefik        project lb-demo          project lb-db
 ┌──────────────────┐      ┌──────────────┐         ┌────────────────────────────┐
 │ Traefik          │      │ server-1..5  │         │ MaxScale :4006 (satu pintu)│
 │ :80 :8088 :8089  │      │ :3000        │         │  ├ mariadb-primary  :3306  │
 │ docker.sock (ro) │      │              │         │  ├ mariadb-replica-1       │
 └────────┬─────────┘      └──────┬───────┘         │  └ mariadb-replica-2       │
          └────────────── lb-net (external) ───────┴──── Adminer :8080 ──────────┘
                               project lb-k6
                               ┌───────────────────────────┐
                               │ Grafana · Prometheus      │
                               │ k6-runner · Loki · Alloy  │
                               │ 3× mysqld-exporter        │
                               └───────────────────────────┘
```

18 container: 1 Traefik, 5 backend, 3 MariaDB + MaxScale + Adminer, serta Grafana + Prometheus + k6-runner + 3 exporter + Loki + Alloy. Network `lb-net` dibuat **di luar compose** (`make net-up`) dan dipakai bersama; masing-masing project bisa naik/turun sendiri.

## 2. Struktur project

```
loadBalancer/
├── .env.example                  # contoh kredensial DB (salin ke .env bila perlu)
├── config.json                   # peta identitas backend (dipakai saat backend jalan tanpa env)
├── Makefile                      # semua perintah operasional: stack, db, traefik, test, k6
├── package.json                  # metadata Node + dependency mysql2 (tanpa script)
├── docker-compose.traefik.yml    # Traefik saja (project lb-traefik, network lb-net external)
├── docker-compose.yml            # 5 backend server (project lb-demo)
├── docker-compose.db.yml         # 3 MariaDB + MaxScale + Adminer (project lb-db)
├── docker-compose.monitoring.yml # k6 + Grafana + Prometheus + 3 exporter + Loki/Alloy (project lb-k6)
├── db/init/001-schema.sql        # skema registered_servers + seed 5 server
├── docker/
│   ├── backend.Dockerfile        # image backend (Node 22 alpine + mysql2 + HEALTHCHECK)
│   ├── maxscale/maxscale.cnf     # router master + monitor failover (bukan config Traefik)
│   └── traefik/traefik.yml       # config statis Traefik (provider Docker, timeout backend, dashboard, access log)
├── src/
│   ├── backend/server.js         # aplikasi backend (dijalankan 5x, beda BACKEND_ID)
│   ├── backend/http.js           # helper respons JSON/HTML + pembatas body
│   ├── backend/db.js             # pool koneksi mysql2 (lazy, timeout 1 detik)
│   ├── backend/db-metrics.js     # metrik query DB yang diekspor lewat /metrics
│   ├── backend/servers/          # validasi, repository, dan route /api/servers
│   ├── backend/public/index.html # UI CRUD katalog di /ui
│   └── shared/                   # loader config.json + logger
├── test/
│   ├── backend/                  # unit test validasi (tanpa Docker/DB)
│   └── docker/
│       ├── helpers/docker-stack.js  # start/stop stack compose untuk test
│       ├── helpers/db-stack.js      # peran node, replikasi, SQL lewat MaxScale
│       ├── db-failover.test.js      # primary dimatikan sungguhan, diukur
│       └── lb-docker.test.js        # smoke, URL per server, distribusi, beban, failover
├── scripts/
│   ├── network.js                # buat network lb-net sekali (idempotent)
│   ├── db-grant-users.js         # user lb_app/lb_repl/lb_monitor/lb_exporter di tiap node
│   ├── db-replica-clone.js       # isi/segarkan replika dari primary aktif
│   ├── db-cluster-status.js      # siapa primary, status replika, lag, jalur MaxScale
│   ├── crud-load.js              # uji CRUD acak: COUNT entitas, USERS paralel
│   ├── install-k6.js             # unduh binary k6 resmi lewat Bun → tools/k6/
│   └── k6.js                     # pembungkus k6 (Windows/Linux/macOS)
├── k6/
│   ├── load-test.js              # uji beban + threshold
│   ├── failover.js               # skenario failover (sambil server dimatikan)
│   └── lib/backend-counters.js   # counter per server agar sebaran terlihat
├── monitoring/
│   ├── prometheus/prometheus.yml # scrape Traefik + backend tiap 2 detik + 3 node MariaDB
│   ├── loki/loki.yml             # penyimpanan log, retensi 7 hari
│   ├── alloy/config.alloy        # kirim log container berlabel lb.logs=true ke Loki
│   ├── grafana/provisioning/     # datasource Prometheus/Loki, provider dashboard, alert
│   ├── grafana/dashboards/k6/    # k6.json (hasil test)
│   ├── grafana/dashboards/lb/    # lb-realtime.json (trafik nyata)
│   ├── grafana/dashboards/db/    # database.json (MariaDB + log)
│   └── reports/                  # hasil ekspor report.html dari k6 web dashboard
├── GLOSSARY.md
└── docs/
    ├── database-crud.md          # panduan database, API, dan UI CRUD
    ├── database-monitoring.md    # metrik, dashboard, alert, dan log database
    └── adr/                      # catatan keputusan desain
```

## 3. Menjalankan

Semua perintah operasional ada di `Makefile`. Butuh **GNU Make** (Windows: `choco install make` atau GnuWin32 Make; Linux: paket `make`; macOS: `xcode-select --install`). `make` tanpa argumen menampilkan daftar target.

Cara normal — satu perintah untuk semuanya:

```bash
make stack-up       # net-up → db-up → traefik-up → docker-up → k6-up
make stack-down     # k6-down → docker-down → traefik-down → db-down
```

Per project, kalau hanya butuh sebagian atau sedang debug:

| Perintah | Arti |
|---|---|
| `make net-up` | Buat network bersama `lb-net` sekali (aman diulang) |
| `make db-up` / `db-down` | Cluster DB (3 node + MaxScale) + Adminer; `db-up` juga grant user dan clone replika |
| `make db-reset` | Hapus **tiga** volume DB, buat ulang skema + seed, grant, clone ulang |
| `make db-status` | Siapa primary, status replika, lag, dan node yang dilayani `maxscale:4006` |
| `make db-rejoin` | Kembalikan node ke cluster (`DB_NODE=mariadb-primary`), data bercabang dibuang |
| `make db-grant-users` | Buat/segarkan `lb_app`, `lb_repl`, `lb_monitor`, `lb_exporter` di semua node |
| `make traefik-up` / `traefik-down` | Traefik saja (project `lb-traefik`) |
| `make docker-up` / `docker-down` | 5 backend saja (project `lb-demo`) |
| `make k6-up` / `k6-down` | Grafana + Prometheus + k6-runner + exporter + Loki + Alloy (project `lb-k6`) |
| `make traefik-logs` | Access log Traefik (siapa melayani apa) |
| `make docker-ps` | Status + health container backend |
| `make docker-logs` | Log 5 backend server |
| `make db-logs` | Log MariaDB, MaxScale (termasuk keputusan failover), Adminer |

Urutan penting: network **sebelum** database/traefik/backend. Saat mematikan, balik urutannya — `lb-net` tidak bisa dihapus selama masih ada container yang menempel. Di dalam `db-up` urutannya juga tetap: tiga node → grant user → clone replika → baru MaxScale, supaya monitor tidak pernah melihat replika yang belum punya data.

Cek cepat:

```powershell
# 10 request ke load balancer — harus bergiliran ke 5 server
1..10 | % { curl.exe -s "http://server.localhost/halo?i=$_" | Select-String 'servedBy' }

# URL per server — selalu server itu
curl.exe -s http://server-2.localhost/siapa

# katalog server di MariaDB (dilayani backend mana pun)
curl.exe -s http://server.localhost/api/servers

# pembaca database lewat Traefik (login: maxscale / lb_app / lb_app_password)
curl.exe -s -o NUL -w "%{http_code}`n" http://adminer.localhost/

# dashboard lain lewat Traefik, bukan port
curl.exe -s -o NUL -w "%{http_code}`n" http://grafana.localhost/login
curl.exe -s -o NUL -w "%{http_code}`n" http://grafana.localhost/d/db-monitoring
curl.exe -s -o NUL -w "%{http_code}`n" http://traefik.localhost/dashboard/
```

Buka **http://server.localhost/ui** untuk CRUD katalog. Panduan database, skema, API, dan Adminer ada di [`docs/database-crud.md`](docs/database-crud.md).

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

Traefik hidup di project sendiri (`docker-compose.traefik.yml`), backend di `docker-compose.yml`, database di `docker-compose.db.yml`, monitoring di `docker-compose.monitoring.yml`. Semua container yang menempel di `lb-net` dan berlabel dibaca Traefik — termasuk Grafana dan k6. MariaDB dan Adminer tidak diberi label Traefik, jadi tidak pernah masuk rotasi.

Aturan backend ada di `docker-compose.yml` + `docker/traefik/traefik.yml`:

- `traefik.enable=true` dan `...loadbalancer.server.port=3000` → container ikut terdaftar (yang tidak berlabel diabaikan karena `exposedByDefault: false`).
- Kelima container memakai **nama service yang sama** (`demo`) → Traefik menggabungkannya menjadi satu service berisi 5 server, algoritma default `wrr` (weighted round robin).
- **Router `demo`** menangkap `Host(server.localhost)` plus semua path sebagai fallback, tapi **mengecualikan** `server-1/2/…/N.localhost`:
  `Host(`server.localhost`) || (PathPrefix(`/`) && !HostRegexp(`server-[0-9]+[.]localhost`))`
- **Router `direct-N`** (prioritas 100, mengalahkan `demo` yang prioritas 1) dipatok ke satu container saja. Karena `direct-N` tidak memakai middleware `retry`, saat server itu mati URL-nya **gagal** (bukan diam-diam dialihkan ke server lain).
- Label `...routers.demo.service: demo` **wajib** ada: tiap container mendefinisikan dua service (`demo` dan `direct-N`), dan tanpa label ini Traefik membuang router `demo` dengan error `cannot be linked automatically with multiple Services`. Gejalanya: `server.localhost` balas 404.
- **Health check aktif**: label `...healthcheck.path=/health` (interval 2s) + `HEALTHCHECK` di `docker/backend.Dockerfile`. Container mati/unhealthy otomatis keluar dari rotasi.
- **Failover pasif**: middleware `retry` 3× (`initialInterval 100ms`) mengulang request bila server tidak menjawab.
- **Batas waktu backend** di `traefik.yml`: `responseHeaderTimeout: 2s`, `dialTimeout: 2s`. Tanpa ini, request yang telanjur dikirim ke container yang baru mati **menggantung tanpa batas** (Traefik default: tanpa timeout) walau retry tersedia.
- Access log aktif, jadi setiap request tercatat di `make traefik-logs`.

Dashboard lain memakai pola yang sama, hanya beda host dan port:

| Host | Router | Service | Prioritas |
|---|---|---|---|
| `grafana.localhost` | `grafana` | container Grafana :3000 | 200 |
| `traefik.localhost` | `traefik-dash` | `api@internal` | 200 |
| `k6.localhost` | `k6-web` | container k6 :5665 | 200 |
| `adminer.localhost` | `adminer` | container Adminer :8080 (project `lb-db`) | 200 |

**Kenapa prioritas 200?** Router `demo` sengaja menangkap *semua* host (`PathPrefix(/)`) supaya `http://127.0.0.1:8088` tetap berfungsi. Tanpa prioritas lebih tinggi, `grafana.localhost` atau `adminer.localhost` akan ikut dilempar ke backend. Prioritas 200 membuat router spesifik menang, dan aturan `demo` tidak perlu diubah setiap kali ada host baru.

`k6.localhost` hanya hidup selama `make k6-watch` berjalan — begitu container k6 selesai, Traefik menghapus routernya (gejalanya 404, bukan halaman kosong). `adminer.localhost` hanya hidup selama stack `lb-db` berjalan; kalau Traefik mati, Adminer tetap bisa dibuka di `http://127.0.0.1:8081`.

## 5. Testing otomatis: apakah semuanya berjalan?

```bash
make test          # sama dengan make test-docker (butuh Docker)
make test-backend  # unit test validasi CRUD + metrik DB, tanpa Docker/DB
```

```
▶ varian container: Traefik 5 server + URL sendiri per server
  ✔ smoke: 5 container sehat, dashboard hidup, semua URL menjawab
  ✔ round robin: 30 request ke server.localhost terbagi rata
  ✔ URL per server tidak ikut load balancing (6x tetap server yang sama)
  ✔ beban: 300 request / 20 konkuren ke server.localhost, nol gagal
  ✔ failover: server-2 mati → LB tetap 200, URL server-2 tidak menipu
ℹ pass 6 | fail 0
```

Test suite ini **bukan unit test palsu**: ia memastikan network `lb-net` dan Traefik hidup (idempotent, tidak menyalakan ulang kalau sudah jalan), menyalakan 5 backend, menguji lewat HTTP seperti user sungguhan, lalu **hanya `lb-demo`** yang dimatikan di akhir. Traefik dibiarkan hidup karena mungkin sedang dipakai Grafana/k6. Kalau Docker Desktop mati, test otomatis **skip** dengan pesan jelas (bukan gagal).

Test tidak bergantung pada resolusi `*.localhost` milik OS (di sebagian Windows hanya sebagian nama yang resolve): untuk host `.localhost`, helper menembak `127.0.0.1` sambil tetap mengirim header `Host` yang sama, jadi aturan router Traefik tetap diuji apa adanya.

### 5a. Uji CRUD dengan data acak

`make test` sengaja deterministik dan cepat. Untuk membanjiri katalog dengan data acak sekaligus memverifikasi seluruh siklus CRUD, ada alat terpisah:

```bash
make crud-load                        # 100 entitas, 10 user paralel, siklus penuh
make crud-load COUNT=1000 USERS=50    # lebih besar dan lebih paralel
make crud-load COUNT=500 MODE=create  # hanya POST (isi data), lalu dibersihkan
make crud-load COUNT=200 KEEP=1       # biarkan data di katalog untuk diperiksa
make crud-load COUNT=500 REPORT=monitoring/reports/crud.json
```

Setiap entitas menjalani `POST → GET → PUT → GET → DELETE → GET (404)` lewat `http://server.localhost`, jadi request ikut dibagi Traefik ke 5 backend. `USERS` adalah jumlah worker paralel yang berbagi **satu** antrean: `COUNT=1000 USERS=20` tetap 1000 entitas, bukan 20.000. Data dihapus lagi di akhir (termasuk saat run gagal) kecuali `KEEP=1`.

| Parameter | Arti |
|---|---|
| `COUNT` | Jumlah entitas yang dibuat (default 100) |
| `USERS` | Jumlah worker paralel (default 10) |
| `MODE` | `full` (siklus CRUD, default) atau `create` (hanya POST) |
| `BASE_URL` | Default `http://server.localhost`; cadangan `http://127.0.0.1:8088` |
| `KEEP` | `KEEP=1` mempertahankan data; default dibersihkan |
| `REPORT` | Path JSON untuk ringkasan lengkap |

Ringkasan menampilkan jumlah request sesuai harapan, kegagalan per operasi, latensi p50/p95/max, throughput, sebaran `x-served-by`, dan sisa data. Exit code 1 bila ada entitas gagal atau pembersihan gagal. Detail dan batasannya ada di [`docs/database-crud.md`](docs/database-crud.md).

## 6. Uji beban dengan k6

k6 adalah binary Go, **bukan** paket JavaScript — `bun add k6` tidak bisa dipakai (paket npm bernama `k6` hanya dummy untuk autocomplete editor). Instalasinya tetap lewat Bun:

```bash
make k6-install     # = bun scripts/install-k6.js → unduh rilis resmi ke tools/k6/k6.exe
make k6               # cek versi
```

| Perintah | Arti |
|---|---|
| `make k6-load` | 100 req/detik selama 15 detik ke `http://server.localhost` |
| `make k6-failover` | 50 req/detik selama 40 detik, untuk diuji sambil mematikan server |

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

Semua ada di `docker-compose.monitoring.yml` dengan project sendiri (`lb-k6`), jadi tidak mengganggu stack `lb-demo` maupun `make test`. Grafana dan k6 ikut menempel di `lb-net`, jadi keduanya juga punya URL lewat Traefik.

Ada **dua penyimpan data** untuk tiga dashboard:

| Sumber | Isi | Dashboard |
|---|---|---|
| Prometheus (remote write) | hasil **test k6** (terisi saat `k6-run` / `k6-watch` / Trigger, difilter label `run`) | `k6-lb` |
| Prometheus (scrape 2s) | **trafik nyata** service backend Traefik + `/metrics` semua backend | `lb-realtime` |
| Prometheus + Loki | **kesehatan MariaDB**: `mysql_up`, koneksi, slow query, error CRUD, dan log container | `db-monitoring` |

```
k6 (container) ──HTTP──> traefik:80 (server.localhost)
      │
      └── remote write ──> prometheus:9090 ───────────────┐
                                                          ├──> grafana:3000
traefik:8080/metrics + server-N:3000/metrics              │
      └── scrape 2s ────> prometheus:9090 ────────────────┤
mariadb-*:3306 ──> mysqld-exporter-*:9104 ── scrape ─────────┤
container (lb.logs=true) ──> alloy ──> loki:3100 ─────────┘
```

| URL | Arti |
|---|---|
| `http://grafana.localhost/` | **Grafana** (admin/admin, viewer anonim aktif). Tiga dashboard: folder `k6` → `k6-lb`, folder `load-balancer` → `lb-realtime`, folder `database` → `db-monitoring` |
| `http://grafana.localhost/d/lb-realtime` | Langsung ke dashboard realtime |
| `http://grafana.localhost/d/k6-lb` | Langsung ke dashboard hasil k6 |
| `http://grafana.localhost/d/db-monitoring` | Langsung ke dashboard database + log error |
| `http://127.0.0.1:3000` | Cadangan: Grafana lewat port |
| `http://k6.localhost/` | Web dashboard bawaan k6, **hanya hidup saat `make k6-watch`** |
| `http://127.0.0.1:5665` | Cadangan: web dashboard k6 lewat port |
| `http://trigger.localhost/cgi-bin/trigger` | Pemicu Run k6 dari browser (dipakai link "Run k6" di dashboard) |

Prometheus, Loki, Alloy, dan `mysqld-exporter` **tidak** diekspos ke host maupun lewat Traefik; semuanya hanya dikonsumsi Grafana atau runner internal.

Ketiga dashboard memakai urutan baca yang sama: **kartu kesimpulan → trafik/latensi → detail per Backend atau node → alert dan log**. Di bar atas tiap dashboard ada tautan pindah ke dua dashboard lain dan ke pemicu Run. Setiap panel punya ikon ⓘ berisi **Arti · Normal · Jika merah**, dan istilahnya mengikuti `GLOSSARY.md` (`Backend`, `Rotasi`, `Primary`, `Replika`, `Lag`, `Split Brain`, `Run`).

| Perintah | Arti |
|---|---|
| `make k6-up` | Nyalakan Grafana + Prometheus + k6-runner + exporter MariaDB + Loki + Alloy (image diunduh/di-build sekali) |
| `make k6-run` | Jalankan k6 sekali di container, hasil masuk Prometheus + Grafana |
| `make k6-watch` | Sama, tapi dashboard web k6 hidup di `http://k6.localhost` / `http://127.0.0.1:5665` dan hasilnya diekspor ke `monitoring/reports/report.html` |
| `make k6-down` | Matikan stack monitoring (data di volume tetap) |
| `make k6-logs` | Log Grafana/Prometheus/Loki/k6 |

Alur pemakaian:

```bash
make stack-up       # network + traefik + backend + monitoring
make k6-run         # k6 di container: 100 req/detik selama 15 detik
# buka http://grafana.localhost → folder k6 → dashboard k6-lb
# buka http://grafana.localhost/d/lb-realtime kapan saja (tanpa k6)
make stack-down     # urutan shutdown sudah diurus script
```

Dashboard `k6-lb` berisi **10 panel data** dalam empat baris: ringkasan (total request, gagal, check lulus, VU maksimum), beban (request/detik + latensi p50/p95/p99 dengan ambang 0,5 detik), sebaran (tabel jumlah + porsi per Backend, status code per kelompok), dan detail (VU aktif vs maksimum, iterasi/detik). Variabel **Run** default ke **Run terbaru** dan tidak lagi punya opsi `All`; memilih beberapa Run sekaligus hanya dipakai bila memang ingin membandingkan.

Sebaran per server memakai satu metric `served` (`k6_served_total` di Prometheus) dengan label `server`, dan panelnya satu query `sum by (server) (...)`. Jadi server baru otomatis muncul tanpa menyunting skrip k6 atau dashboard. Konsekuensinya, ringkasan konsol k6 hanya menampilkan total `served`, bukan per server.

### 7a. Dashboard realtime `lb-realtime` (Prometheus)

Dashboard ini **tidak bergantung pada k6**. Selama backend hidup, Prometheus menembak `/metrics` tiap 2 detik dan grafik diperbarui tiap 5 detik, jadi request manual dari browser pun langsung terlihat.

Sumber angkanya dua, dan bedanya penting:

| Metrik | Dari | Arti |
|---|---|---|
| `traefik_service_requests_total` | Traefik | request khusus service LB/backend (`demo@docker`, `direct-*`), tidak tercemar trafik Grafana/Adminer/scrape |
| `lb_backend_requests_total` | tiap backend | request yang **benar-benar diterima** server |
| `lb_backend_request_duration_seconds` | tiap backend | histogram durasi, dipakai untuk p95 |
| `up{job=...}` | Prometheus | target scrape hidup atau mati |

Panel (**14 data** + 1 panduan + 6 baris sekat = 21):

| Baris | Panel | Query inti |
|---|---|---|
| Kartu | Backend sehat | `count(up{job="backend"} == 1) or vector(0)` (0–5) |
| Kartu | Error server (5xx) / detik | `sum(rate(traefik_service_requests_total{service=~"demo@docker\|direct-.*@docker",code=~"5.."}[1m]))` |
| Kartu | Request masuk LB / detik | `sum(rate(...{service=~"demo@docker\|direct-.*@docker"}[1m]))` |
| Kartu | Latensi p95 Backend | `histogram_quantile(0.95, sum by (le) (rate(lb_backend_request_duration_seconds_bucket[5m])))` |
| 1 | Masuk LB vs diterima Backend | dua rate di atas + `sum(rate(lb_backend_requests_total[1m]))` |
| 1 | Status code aplikasi | `2xx`, `4xx`, `5xx` dipisah tiga seri agar 5xx tidak tenggelam di sumbu yang sama |
| 2 | Request diterima per Backend | `sum by (server) (rate(lb_backend_requests_total[1m]))` |
| 2 | Jumlah & porsi per Backend | `increase(...[$__range])` + persentase, digabung `labelsToFields` → `joinByField` |
| 3 | Latensi p95 per Backend | `histogram_quantile(...)`, garis ambang putus-putus 0,5 detik |
| 3 | Latensi rata-rata per Backend | `_sum / _count` histogram |
| 4 | Alert Load Balancer | `alertlist` difilter label `component=load-balancer`, status Normal ikut tampil |
| 4 | Log error Backend & Traefik | Loki `{project=~"lb-traefik\|lb-demo"} \|~ "(?i)error\|warning\|..."`, nama service di awal baris |
| 5 | Trafik internal per service | `grafana@docker`, `adminer@docker`, `k6-trigger@docker` — sengaja dipisah dari aplikasi |
| 5 | Status target scrape | `up{job="backend"}` + `up{job="traefik"}` dengan mapping HIDUP/MATI |

Selisih "masuk" dan "diterima" itu normal dan bukan bug: retry `Failover Pasif` menambah
"masuk" tanpa menambah "diterima", health check Traefik (`/health`) tidak dihitung backend,
sementara `/metrics` dan `/health` sengaja dikecualikan dari counter backend agar angkanya
tidak tercemar probe 2 detik. Trafik ke Grafana, Adminer, dan pemicu k6 tidak masuk panel
aplikasi sama sekali; ia punya panel sendiri di baris terakhir.

Endpoint `/metrics` backend adalah teks polos tanpa dependency (`src/backend/server.js`), berisi counter `lb_backend_requests_total`, `lb_backend_slow_requests_total`, histogram `lb_backend_request_duration_seconds`, serta metrik query database `lb_db_*` (lihat bagian 7c). Bisa dicek langsung:

```bash
curl http://server-1.localhost/metrics
```

Daftar backend **tidak ditulis** di `monitoring/prometheus/prometheus.yml`. Prometheus menemukan sendiri container backend lewat Docker API (`docker_sd_configs`): hanya container berlabel `lb.monitor=true` (ada di `x-main-labels`, jadi otomatis ikut semua server), difilter ke network `lb-net`, dan label `server` diambil dari nama service compose. Tambah `server-6` di compose → target Prometheus muncul sendiri.

Socket Docker di-mount **read-only** ke Prometheus hanya untuk penemuan target. Karena socket hanya bisa dibaca root, container Prometheus berjalan sebagai root (`user: "0:0"`) — jangan diekspos ke host.

Datasource Grafana-nya uid `prometheus` (`monitoring/grafana/provisioning/datasources/prometheus.yml`).

Ganti intensitas atau skenario (env var diteruskan ke container lewat `-e`):

```bash
docker compose -p lb-k6 -f docker-compose.monitoring.yml run --rm -e DURATION=60s -e RATE=200 k6
docker compose -p lb-k6 -f docker-compose.monitoring.yml run --rm k6 run failover.js
```

Catatan jujur soal versi: k6 v2.4.0 menandai output `experimental-prometheus-rw` sebagai **deprecated**, rencananya dihapus di k6 v3 dan diganti OpenTelemetry. Untuk demo ini dipakai karena tidak memerlukan kolektor tambahan di depan Prometheus; kalau nanti pindah ke k6 v3, arahkan output OpenTelemetry ke endpoint OTLP Prometheus/Alloy.

Hasil terukur dari container (`make k6-run`, 15 detik, 100 req/detik):

```
http_reqs: 1500   99.99/detik
http_req_failed: 0.00%   checks_succeeded: 100.00%
served: 1500 (total; rincian per server di Grafana)
  server-1 375 · server-2 375 · server-3 375 · server-4 375
report.html (k6-watch): 167 KB
```

`k6-watch` menahan proses selama tab browser dashboard masih terbuka — tutup tab (atau tekan Ctrl+C) kalau run sudah selesai.

### 7b. Memicu k6 dari Grafana

Grafana tidak bisa menjalankan perintah sendiri (tidak ada plugin self-hosted untuk itu, dan endpoint Actions tidak tersedia di 13.3.1). Yang dipakai: **link dashboard** yang memanggil service kecil `k6-runner`.

- Di dashboard `k6-lb`, pojok kanan atas ada link **"Run k6 (15 detik)"**.
- Klik → browser membuka halaman konfirmasi `http://trigger.localhost/cgi-bin/trigger` (`GET` aman dari prefetch/reload) → klik tombol **Jalankan Run sekarang** (`POST`) → satu Run k6 dimulai → halaman redirect ke dashboard setelah 2 detik.
- Parameter tetap: 100 req/detik, 15 detik, skrip `load-test.js`. Hasil masuk Prometheus dengan label `run` baru, jadi bisa dibandingkan dengan run sebelumnya lewat variabel **Run**.
- Hanya **satu Run pada satu waktu**; `/tmp` memakai `tmpfs` sehingga lock tidak pernah tertinggal permanen saat container restart.
- Log run: `docker exec lb-k6-k6-runner-1 tail -20 /tmp/k6-run.log`.

Kenapa begini:

- `k6-runner` menjalankan binary k6 langsung di container-nya (image alpine + binary dari image k6). **Tidak** memakai Docker socket — runner tidak bisa membuat/mematikan container lain.
- Container hanya bisa diakses lewat `trigger.localhost` (Traefik, prioritas 200); port 8080 tidak dipublikasikan ke host.
- Endpoint ini **tanpa autentikasi**. Siapa pun yang bisa membuka `trigger.localhost` bisa memulai Run; guard-nya cuma single-flight. Untuk lokal aman, jangan diekspos ke internet tanpa auth.
- Ganti intensitas: ubah `RATE` / `DURATION` di service `k6-runner` (`docker-compose.monitoring.yml`), lalu `docker compose -p lb-k6 -f docker-compose.monitoring.yml up -d k6-runner`.

Alternatif tanpa Grafana tetap ada: `make k6-run` (sekali) dan `make k6-watch` (plus web dashboard k6 + `report.html`).

### 7c. Monitoring database MariaDB

Database tidak hanya bisa dibaca isinya lewat Adminer — kesehatannya juga dipantau. Semua alat tinggal di `lb-k6`, jadi `lb-db` hanya berisi tiga node MariaDB, MaxScale, dan Adminer.

```
mariadb-primary ────> mysqld-exporter-primary ──┐
mariadb-replica-1 ──> mysqld-exporter-replica-1 ┤─scrape──> Prometheus ──> Grafana (db-monitoring)
mariadb-replica-2 ──> mysqld-exporter-replica-2 ┘
maxscale + mariadb + backend (label lb.logs=true) ──> Alloy ──> Loki ──> Grafana (panel log)
backend /metrics (lb_db_*) ─────────────────────────────────> Prometheus ──> Grafana + alert
```

Satu exporter per node, bukan satu untuk semua: exporter hanya bisa menembak satu alamat, dan tanpa pemisahan ini `mysql_up` tidak bisa membedakan node mana yang mati. Label `node` di Prometheus memakai nama service compose (`mariadb-primary`, `mariadb-replica-1`, `mariadb-replica-2`), jadi panel dan alert menyebut nama node, bukan IP.

| URL | Arti |
|---|---|
| `http://grafana.localhost/d/db-monitoring` | Dashboard database: peran node, replikasi & lag, koneksi, query/detik, slow query, latensi CRUD, error per kode, log |
| `http://grafana.localhost/alerting/list` | Alert rule `database` (firing/pending/no data) |

| Sumber | Metrik | Arti |
|---|---|---|
| 3× `mysqld-exporter` | `mysql_up`, `mysql_global_status_*`, `mysql_global_variables_read_only`, `mysql_slave_status_*` | isi tiap node (butuh user `lb_exporter` dengan `PROCESS`) |
| backend `/metrics` | `lb_db_queries_total`, `lb_db_errors_total`, `lb_db_query_duration_seconds` | query CRUD dari sisi aplikasi, kode error driver, latensi |
| Prometheus | `up{job="mariadb"}` | target **exporter** hidup (0 = exporter mati, bukan DB) |
| Loki | log `{project="lb-db"}` dan `{project="lb-demo"}` | error/warning asli, termasuk keputusan failover MaxScale |

Tiga metrik yang menjawab pertanyaan berbeda:

| Pertanyaan | Metrik |
|---|---|
| Node mana yang menerima tulisan? | `mysql_global_variables_read_only{node=...}`: 0 = primary, 1 = replika |
| Apakah replikasi jalan? | `mysql_slave_status_slave_io_running`, `..._slave_sql_running` (hanya ada di node yang punya replika) |
| Berapa data yang bisa hilang kalau primary mati sekarang? | `mysql_slave_status_seconds_behind_master` — itulah RPO (replikasi asinkron) |

Sebelas alert Grafana (provisioning, tanpa Alertmanager): tiga untuk Load Balancer (`lb-backend-down`, `lb-backend-degraded`, `lb-5xx-spike`) dan delapan untuk database: `db-no-primary` (tidak ada node `read_only=OFF`), `db-multiple-writable` (lebih dari satu — risiko split brain), `db-node-down` (per node), `db-replica-stopped` (per node), `db-replica-lag` (per node), `mariadb-connections-high`, `mariadb-slow-queries`, `api-db-errors`. Belum ada contact point keluar — statusnya dilihat di Grafana. Cara menambah email/Telegram ada di panduan.

`make db-up` dan `db-reset` otomatis menjalankan `scripts/db-grant-users.js`, jadi volume database lama tidak perlu dihapus untuk mengaktifkan monitoring. Untuk tiga exporter, tidak ada yang perlu disunting saat node diganti nama: nama service = label `node`.

Panduan lengkap (metrik, LogQL, alert, uji gangguan, troubleshooting) ada di [`docs/database-monitoring.md`](docs/database-monitoring.md); keputusan desainnya di [`docs/adr/0010-monitoring-database.md`](docs/adr/0010-monitoring-database.md) dan [`docs/adr/0013-mariadb-primary-replika-maxscale.md`](docs/adr/0013-mariadb-primary-replika-maxscale.md).

## 8. Database MariaDB: 1 primary + 2 replika di belakang MaxScale

Database berada di **project compose sendiri** (`lb-db`, file `docker-compose.db.yml`), jadi bisa naik/turun tanpa menyentuh Traefik, backend, atau monitoring. Adminer punya rute Traefik sendiri (`adminer.localhost`, prioritas 200), tetapi stack DB **tidak bergantung** pada Traefik: port loopback `127.0.0.1:8081` tetap tersedia.

| Komponen | Project | Alamat |
|---|---|---|
| MaxScale 24.02 | `lb-db` | `maxscale:4006` — **satu-satunya pintu aplikasi**, hanya di `lb-net` |
| MariaDB 11.4 primary | `lb-db` | `mariadb-primary:3306`, hanya di `lb-net` |
| MariaDB 11.4 replika | `lb-db` | `mariadb-replica-1:3306`, `mariadb-replica-2:3306`, `read_only=ON` |
| Adminer | `lb-db` | `http://adminer.localhost` (lewat Traefik) · cadangan `http://127.0.0.1:8081` |
| UI CRUD | `lb-demo` | `http://server.localhost/ui` (atau `server-N.localhost/ui`) |
| API CRUD | `lb-demo` | `http://server.localhost/api/servers` |
| Monitoring DB | `lb-k6` | `http://grafana.localhost/d/db-monitoring` (peran node, lag, alert, log Loki) |

```bash
make db-up      # 3 node → grant user → clone replika → MaxScale + Adminer
make db-status  # siapa primary, io/sql replika, lag, dan jawaban maxscale:4006
make db-rejoin  # DB_NODE=mariadb-primary — kembalikan node ke cluster
make db-reset   # buang KETIGA volume DB, skema + seed ulang, clone ulang
make db-down    # data di volume tetap
```

Kredensial demo: database `lb_demo`, user `lb_app`, password `lb_app_password` (bisa diganti lewat `.env`; lihat `.env.example`). Buka `http://adminer.localhost` (cadangan: `http://127.0.0.1:8081`); di Adminer, server diisi **`maxscale`**, bukan `localhost` maupun `mariadb`.

### 8a. Peran node dan kenapa begini

- **Nama bukan peran.** `mariadb-primary` hanya menandai peran **awal**. Setelah failover, primary bisa `mariadb-replica-1`. Skrip dan dashboard mencari primary dari `@@read_only`, bukan dari nama service.
- **Replika tidak melayani klien.** MaxScale memakai router `readconnroute` dengan `router_options=master`: setiap koneksi — baca maupun tulis — hanya ke node yang sedang menjadi primary. Baca dari replika asinkron berarti `POST` lalu `GET` bisa mengembalikan data lama atau 404.
- **Driver tidak tahu soal cluster.** `mysql2` 3.24.6 tidak punya mode multi-host/failover. Karena itu `DB_HOST=maxscale` dan `DB_PORT=4006` di `docker-compose.yml`: aplikasi hanya pernah tahu satu alamat, dan MaxScale yang memindahkannya.
- **Failover otomatis, rejoin manual.** `auto_failover=true` mempromosikan replika dengan GTID paling maju. `auto_rejoin=false` disengaja: primary lama yang kembali bisa membawa tulisan yang tidak pernah sampai ke replika. Memasukkannya kembali butuh `make db-rejoin`.
- **Replika menolak tulisan aplikasi.** `read_only=ON` sejak start, dan `lb_app` tidak punya `SUPER` (MariaDB tidak mengenal `super_read_only`; root tetap bisa menulis).
- **Node yang dipromosikan menulis binlog** (`--log-slave-updates=ON`), supaya replika lain bisa melanjutkan replikasi dari sana.

### 8b. Alur failover dan pemulihan

1. Primary mati → MaxScale `mariadbmon` (interval 1 detik, `master_failure_timeout=3s`) menandai `master_down`.
2. Monitor memilih replika dengan GTID paling maju, menjalankannya sebagai master, lalu mengarahkan replika lain ke node baru itu.
3. Koneksi aplikasi berikutnya lewat `maxscale:4006` dilayani node baru. Request yang **sedang** berjalan saat primary mati gagal; request sesudahnya berhasil tanpa restart backend.
4. Saat node lama hidup lagi, ia **tidak** masuk otomatis. Ia masih `read_only=OFF`, jadi bisa menerima tulisan langsung dan bercabang:

   ```bash
   make db-status                              # pastikan siapa primary sekarang
   make db-rejoin DB_NODE=mariadb-primary      # dump dari primary aktif, restore, START SLAVE
   ```

   `db-rejoin` membuang database node itu lebih dulu (`DROP DATABASE` dengan `sql_log_bin=0`), lalu meng-clone ulang. Data yang sempat ditulis ke node lama **hilang** — itu disengaja: menggabungkannya otomatis akan menciptakan dua riwayat yang tidak bisa didamaikan.

Jendela gagal dan jumlah tulisan yang hilang **diukur** oleh `make test-db` dan dicatat di bagian 9. Replikasi asinkron berarti RPO > 0; kalau butuh RPO 0, ganti ke semi-sync atau Galera, keduanya menambah biaya tulis yang tidak dibahas di demo ini.

Skema ada di `db/init/001-schema.sql`, tabel `registered_servers` (`id`, `name`, `host`, `port`, `weight`, `enabled`, `note`, `created_at`, `updated_at`) dengan seed `server-1`…`server-5`. Skrip init hanya dijalankan node primary saat volume `lb-db-data` masih kosong; replika mendapat isinya dari `mariadb-dump` + restore. Perubahan skema pada volume lama butuh `make db-reset`.

API:

| Metode | Path | Sukses |
|---|---|---|
| GET | `/api/servers` | 200, array |
| GET | `/api/servers/:id` | 200 |
| POST | `/api/servers` | 201 + `Location` |
| PUT | `/api/servers/:id` | 200 |
| DELETE | `/api/servers/:id` | 204 |

Validasi: `name` unik 1–64 karakter, `host` 1–255 tanpa spasi, `port` 1–65535, `weight` 1–100, `note` ≤ 255 karakter. Error memakai JSON `{ "error": { "code", "message", "details" } }`: 400 validasi/JSON, 404 tidak ada, 405 metode, 409 nama duplikat, 413 body > 64 KB, 503 DB tidak tersedia/belum diinisialisasi.

Tiga hal yang sengaja begitu:

- **Katalog bukan rotasi.** Menambah/menghapus baris tidak mengubah server yang dipakai Traefik; rotasi tetap dari label container. UI menuliskan ini terang-terangan.
- **`/health` tidak mengecek DB.** Kalau MariaDB mati, semua backend tetap sehat dan endpoint demo tetap jalan; hanya CRUD yang membalas 503. `connectTimeout` driver 1 detik membuat klien menerima 503 sebelum `responseHeaderTimeout` Traefik (2 detik) berubah jadi 504.
- **State dibagi bersama.** Semua replika memakai satu database: tulis lewat `server.localhost`, baca lewat `server-3.localhost`, datanya sama. Header `x-served-by` di setiap respons menunjukkan backend yang melayani.

Panduan lengkap (skema, contoh `curl`, status code, Adminer, batasan) ada di [`docs/database-crud.md`](docs/database-crud.md). Cara memantau kesehatan database dan membaca log error ada di [`docs/database-monitoring.md`](docs/database-monitoring.md).

## 9. Angka terukur (bukan asumsi)

| Peristiwa | Hasil |
|---|---|
| `docker compose stop server-2` → hilang dari rotasi | **~1,1 detik** |
| `docker compose start server-2` → kembali ke rotasi | **~6,1 detik** (Docker `start-period` 5s + Traefik poll) |
| 12 request tepat setelah server dimatikan | **12/12 sukses 200**; satu request tertahan ~4,3 s lalu tetap 200 (retry) |
| `http://server-2.localhost` saat server-2 mati | **404** — tidak menipu dengan mengalihkan ke server lain |
| 300 request / 20 konkuren via `server.localhost` | **0 gagal**, ±600–1685 req/detik (bervariasi antar run) |
| Sebaran 30 request | **6 request tiap server**, kelima server kebagian |
| `make test` diulang | **6/6 lulus** (dengan 5 server) |
| `grafana.localhost` / `traefik.localhost` setelah dipisah | **200**, tidak nyasar ke backend (router prioritas 200 menang atas fallback `demo` prioritas 1) |
| `k6.localhost` saat `make k6-watch` | **200** selama run, router hilang ~6 detik setelah k6 selesai |
| `make stack-up` dijalankan ulang | **idempotent**: "network lb-net sudah ada", container yang sudah hidup tidak dibuat ulang |
| Dashboard `lb-realtime` saat backend hidup | 14 panel data; scrape 6 target (`traefik` + 5 backend) `up=1`; trafik aplikasi dan trafik internal dipisah |
| 30 request manual ke `server.localhost` | test mengukur 6 request per server, tanpa gagal |
| Klik "Run k6" di dashboard Grafana | halaman konfirmasi `GET` 200 → submit `POST` 202 → Run 15 detik selesai (1500 request) → label `run` baru muncul di Prometheus; klik kedua saat run berjalan dibalas 409 "Run masih berjalan" |
| Tambah `server-4` di compose saja | Prometheus menemukan target `server-4` otomatis (`up=1`), panel `lb-realtime` dan sebaran k6 bertambah tanpa menyunting config monitoring |
| Porsi per Backend pada Run 1501 request | server-1 **20,1%** · server-2 **20,0%** · server-3 **20,1%** · server-4 **19,9%** · server-5 **20,0%** |
| CRUD lintas backend | POST lewat `server.localhost` dilayani `server-5` (201); GET id yang sama lewat `server-3.localhost` mengembalikan data identik (`x-served-by: server-3`) |
| Primary dimatikan (`stop mariadb-primary`) | MaxScale mempromosikan replika; tulis lewat `maxscale:4006` gagal **~32 detik** lalu sukses lagi tanpa restart backend |
| Rincian jendela itu | deteksi `master_down` mendominasi (~23 s), promosi + konfirmasi replika ~6 s, sisa ~3 s sampai tulis pertama dijawab |
| RPO terukur saat primary mati | **6 tulis sudah di-ACK, 0 hilang**; lag replika saat dimatikan **0 detik** |
| `make db-rejoin DB_NODE=mariadb-primary` | **6,0 detik** sampai node kembali sebagai replika (`read_only=ON`, IO/SQL `Yes`) |
| Primary lama hidup tanpa rejoin | MaxScale tetap melayani node baru (`server_id` pindah, bukan balik) — `auto_rejoin=false` terbukti |
| Tulis langsung ke replika sebagai `lb_app` | ditolak `ERROR 1290 ... read-only` |
| Data bercabang di primary lama | **hilang** setelah rejoin (dibuang, bukan digabung); jumlah node bisa ditulis tetap 1 |
| `make test-db` | **7/7 lulus** dalam **186 detik** (failover + restart promoted primary + rejoin) |
| MariaDB dimatikan saat CRUD | **503** `DATABASE_UNAVAILABLE` dalam **1,1 detik** lewat Traefik; `/health` tetap **200**; GET kembali **200** setelah DB hidup |
| Adminer | `http://adminer.localhost` → **200** (login server `maxscale`, user `lb_app` melihat `registered_servers`); cadangan `127.0.0.1:8081` → **200**; tidak ada node DB yang punya port host |
| Validasi & konflik | port 0 → **400** + `details`; nama `server-1` duplikat → **409**; id tak ada → **404**; PATCH koleksi → **405** + `Allow` |
| Exporter MariaDB | 3 target `mariadb` `up=1`, label `node` per node; `mysql_up=1`; `mysql_global_variables_read_only` 0 di primary dan 1 di dua replika |
| Metrik DB backend | `curl server-1.localhost/metrics` memuat `lb_db_queries_total{operation="list",result="success"}`, histogram durasi, dan `lb_db_errors_total{code="ER_DUP_ENTRY"}` setelah POST duplikat |
| Dashboard database | `db-monitoring` terprovisi (18 panel data, folder `database`), datasource `loki` ada, 8 alert rule database termuat, tabel `Status per node` setara `make db-status` |
| Log error terpusat | baris `CRUD ditolak: nama server duplikat` dari `lb-demo-server-1-1` muncul di Loki < 10 detik; log `Version: '11.4.13-MariaDB'` dari `lb-db-mariadb-primary-1` dan baris `[mariadbmon] Performing automatic failover` dari MaxScale juga masuk |
| Primary dimatikan (monitoring) | `mysql_up{node="mariadb-primary"}` → **0**, dua node lain tetap **1**; `mysql_slave_status_seconds_behind_master` hilang dari node yang dipromosikan (normal) |
| Alert database | 8 rule terprovisi; `db-node-down`/`db-replica-stopped`/`db-replica-lag` memakai `for: 1m`, jadi gangguan yang pulih sendiri dalam semenit hanya terlihat di panel, belum sempat firing |
| DB dihidupkan lagi | `mysql_up` → **1**, CRUD **200**, tanpa restart backend; `make db-grant-users` idempotent |

## 10. Batasan (sengaja, karena ini project demo/pembelajaran)

- Statistik tidak dikumpulkan sendiri — dibaca dari API/dashboard Traefik.
- `responseHeaderTimeout 2s` berarti endpoint yang sengaja lambat > 2 detik (mis. `/slow?ms=5000`) akan dipotong bila lewat Traefik. Naikkan nilainya di `docker/traefik/traefik.yml` bila perlu (lalu `make traefik-down && make traefik-up`, karena config statis hanya dibaca saat start).
- `retry` Traefik secara default hanya untuk metode idempotent (GET/HEAD); POST tidak diulang. Bisa diubah dengan `retryNonIdempotentMethod=true` bila memang aman.
- Belum ada TLS, autentikasi, sticky session, rate limiting, atau circuit breaker.
- Endpoint demo (`/`, `/slow`) tidak menyimpan state; request berikutnya bisa dilayani server lain. Katalog server **disimpan** di MariaDB dan dibagi semua backend.
- UI CRUD dan API `/api/servers` **tanpa autentikasi**: siapa pun yang bisa membuka `/ui` bisa menulis. Hanya untuk lokal.
- Katalog server **bukan** sumber konfigurasi rotasi. Menambah/menghapus baris tidak mengubah server yang dipakai Traefik; rotasi tetap dari label container.
- MariaDB memakai kredensial demo (`lb_app` / `lb_app_password`), tanpa port 3306 ke host, dan **tanpa backup** (replika bukan backup: `DROP TABLE` ikut tereplikasi). Adminer tanpa auth tambahan: lewat `adminer.localhost` ia ikut terbuka di port 80 (bisa dijangkau mesin lain di LAN bila nama itu resolve), sedangkan `127.0.0.1:8081` hanya loopback.
- **Replikasi asinkron, jadi RPO > 0.** Tulisan yang sudah di-ACK bisa hilang kalau primary mati sebelum event sampai ke replika. Angkanya diukur `make test-db` (lihat bagian 9), bukan diasumsikan nol.
- **Yang diuji hanya kegagalan proses/container database** (primary dimatikan). Host mati, disk penuh, atau network putus tidak termasuk: MaxScale dan ketiga node ada di satu mesin Docker yang sama, jadi mesin itu tetap titik tunggal.
- **`maxscale:4006` adalah satu-satunya pintu aplikasi.** MaxScale sendiri tidak punya cadangan; kalau container MaxScale mati, aplikasi kehilangan database walau ketiga node MariaDB sehat. `restart: unless-stopped` hanya menutup crash proses, bukan jaminan uptime.
- **Replika tidak menambah kapasitas baca.** Semua SELECT tetap ke primary. Menambah replika hanya menambah kandidat failover.
- **`auto_rejoin=false`**: node yang kembali harus di-rejoin manual, dan datanya yang bercabang dibuang. Tidak ada penggabungan otomatis, dan itu memang tidak mungkin dilakukan dengan benar.
- Password `lb_monitor` dan `lb_app` ditulis **dua kali**: di `.env` (`MARIADB_MONITOR_PASSWORD`, `MARIADB_PASSWORD`) dan di `docker/maxscale/maxscale.cnf`, karena MaxScale tidak membaca env. Ganti keduanya lalu `make db-grant-users` + restart MaxScale.
- `lb_app` punya `SELECT` pada `mysql.*`. Itu dibutuhkan MaxScale untuk menyusun cache autentikasi; isi database aplikasi tetap dibatasi `GRANT ... ON lb_demo.*`.
- Listener MaxScale di demo ini **tanpa TLS**, sehingga klien MariaDB 11.4 perlu `--skip-ssl` saat menyambung langsung (backend Node tidak terpengaruh: `mysql2` tidak memaksa TLS).
- `make db-reset` sekarang menghapus **tiga** volume (`lb-db-data`, `lb-db-replica-1-data`, `lb-db-replica-2-data`).
- `make test` hanya menguji jalur HTTP; failover database diuji terpisah oleh `make test-db` karena ia benar-benar mematikan primary.
- `db/init/001-schema.sql` hanya dijalankan saat volume `lb-db-data` kosong. Perubahan skema pada volume lama butuh `make db-reset`, yang **menghapus data**.
- `docker.sock` di-mount read-only, tapi tetap memberi akses ke Docker API — hanya untuk demo lokal, jangan diekspos ke internet.
- Dashboard `api.insecure=true` tanpa login di port 8089 **dan** di `http://traefik.localhost/dashboard/`. Endpoint `/metrics` Traefik juga ikut terbuka di sana (port 8080 tidak dipublikasikan, tapi 8089 memuat API yang sama).
- Grafana memakai kredensial default `admin/admin` dan viewer anonim. Hanya untuk lokal.
- Prometheus tanpa autentikasi dan tanpa port publik — hanya bisa diakses dari network `lb-net` / `lb-k6-net`. Retensi 7 hari. Loki juga tanpa auth, tanpa port host, retensi 7 hari.
- User `lb_exporter` memakai password demo (`lb_exporter_password`) dan punya `PROCESS` + `REPLICATION CLIENT` + `SLAVE MONITOR` pada semua database. Ganti lewat `MARIADB_EXPORTER_PASSWORD` + `make db-grant-users` bila perlu.
- Alert dikelola Grafana dan **belum punya contact point**: status firing hanya terlihat di Grafana, tidak ada email/Telegram/webhook. Slow query log MariaDB juga belum diaktifkan, jadi `slow_queries` adalah status server.
- Loki menyimpan baris log container yang diberi label `lb.logs=true` (3 node MariaDB, MaxScale, semua backend, serta access log error/lambat Traefik). Retensi 7 hari membatasi pertumbuhan.
- Grafana hanya membaca ulang datasource/dashboard/alert provisioning saat start. Prometheus otomatis memuat ulang perubahan `prometheus.yml` (`--config.auto-reload`), sedangkan perubahan provisioning Grafana butuh `docker compose -p lb-k6 -f docker-compose.monitoring.yml restart grafana`.
- Data monitoring disimpan di volume Docker (`prometheus-data`, `loki-data`, `alloy-data`, `grafana-data`); `make k6-down` tidak menghapusnya, `... down -v` menghapusnya.
- Metrik backend disimpan di memori proses: counter kembali 0 setiap container backend dibuat ulang, dan Prometheus ikut melihatnya sebagai reset (rate tetap benar, angka total tidak). Ini termasuk `lb_db_*`.
- Scrape 2 detik berarti puncak trafik yang lebih pendek dari 2 detik bisa terlewat. Ini kompromi "cukup realtime" vs beban scrape.
- Pemicu `trigger.localhost` tanpa autentikasi, mewajibkan `POST` (konfirmasi di halaman `GET`), dan hanya menjaga single-flight: siapa pun yang bisa mengakses host itu bisa memulai Run. Parameter Run juga tetap, tidak bisa diubah dari UI.
- Runner memegang binary k6 dan menjalankan tepat satu Run per submit; tidak ada antrean, tidak ada riwayat status selain label `run` di Prometheus dan `/tmp/k6-run.log` di dalam container (`tmpfs`).
- Prometheus memegang `docker.sock` read-only dan berjalan sebagai root hanya untuk penemuan target. Container tanpa label `lb.monitor=true` tidak akan dipantau, walau ada di `lb-net`.
- Riwayat k6 terputus sekali: run sebelum metric `served` diperkenalkan memakai `served_server_N` dan tidak lagi tampil di panel sebaran. Run baru memakai `served` + tag `server`.
- Panel total (`2xx`, `4xx+5xx`) memakai `increase(...[$__range])`, jadi angkanya ikut rentang waktu dashboard, bukan total seumur hidup. Counter Traefik reset saat container Traefik dibuat ulang.
- `make test` hanya mematikan `lb-demo`; Traefik dibiarkan hidup. Kalau ingin benar-benar bersih, jalankan `make stack-down`.
- Network `lb-net` dibuat di luar compose, jadi `docker network prune` bisa menghapusnya saat semua container mati; pulihkan dengan `make net-up`.

Keputusan desain beserta alasannya ada di [`docs/adr/`](docs/adr/), istilah teknis di [`GLOSSARY.md`](GLOSSARY.md), panduan database/CRUD di [`docs/database-crud.md`](docs/database-crud.md), panduan monitoring database di [`docs/database-monitoring.md`](docs/database-monitoring.md), dan cara menambah server baru di [`docs/menambah-server.md`](docs/menambah-server.md).

## 11. Troubleshooting

| Gejala | Penyebab & solusi |
|---|---|
| `make` tidak dikenali (`'make' is not recognized` / `command not found`) | GNU Make belum terpasang. Windows: `choco install make` atau GnuWin32 Make; Linux: paket `make`; macOS: `xcode-select --install`. Buka terminal baru setelah instalasi, lalu coba `make help`. |
| `make crud-load` gagal `ECONNREFUSED` / 503 | Stack atau database belum hidup. Jalankan `make stack-up` (atau minimal `make net-up db-up traefik-up docker-up`), lalu ulangi. |
| `test` dilewati ("Docker daemon tidak berjalan") | Nyalakan Docker Desktop, tunggu status "running", ulangi. |
| `bind: address already in use` saat `docker-up` | Port 80/8088/8089 dipakai proses lain. Bebaskan port 80, atau tetap pakai `http://127.0.0.1:8088` (sudah dipetakan juga). |
| `http://server.localhost` balas **404** | Traefik membuang router `demo` karena ambigu. Cek `docker compose -p lb-traefik -f docker-compose.traefik.yml logs traefik \| Select-String "cannot be linked"`. Pastikan label `traefik.http.routers.demo.service: demo` ada, lalu `make docker-up`. |
| Perubahan `traefik.yml` tidak berefek | Config statis hanya dibaca saat start: `make traefik-down && make traefik-up` (bind mount saja tidak cukup). |
| `server.localhost` tidak resolve (`curl exit 7`) | Berarti tidak ada yang listen, bukan masalah DNS. Pastikan stack hidup. Bila OS benar-benar tidak resolve `*.localhost`, tambahkan `127.0.0.1 server.localhost server-1.localhost server-2.localhost server-3.localhost server-4.localhost server-5.localhost` ke hosts file (butuh admin). Test otomatis tidak butuh ini karena memakai header `Host`. |
| Request menggantung lama saat server dimatikan | `responseHeaderTimeout` di `traefik.yml` (2s) yang membatasi; tanpa itu request bisa menunggu tanpa batas. |
| Dashboard Traefik kosong / service tidak muncul | Cek `docker compose -p lb-traefik -f docker-compose.traefik.yml logs traefik`; pastikan container backend berstatus `healthy` (`make docker-ps`). |
| Ingin bersih total (termasuk image) | `make clean` — sama dengan `make stack-down`, lalu menghapus image lokal `lb-demo`. Volume tidak disentuh. |
| `k6 belum terpasang` | `make k6-install` (butuh Bun + akses GitHub). |
| `k6-install` gagal HTTP 403 | Rate limit GitHub API; tunggu beberapa menit atau unduh manual rilis k6. |
| Dashboard `k6-lb` kosong / "No data" | Variabel **Run** tidak menemukan Run pada rentang waktu dashboard. Jalankan `make k6-run` atau klik tautan "Run k6 (15 detik)", lalu pastikan rentang waktu mencakup waktu Run. Cek juga datasource `prometheus` ada di `http://grafana.localhost/api/datasources`. |
| Dashboard tidak muncul di Grafana | Dashboard dibaca dari tiga folder: `monitoring/grafana/dashboards/{k6,lb,db}`. Grafana memuat ulang tiap 30 detik; kalau tetap tidak muncul, `docker compose -p lb-k6 -f docker-compose.monitoring.yml restart grafana`, lalu cek log `make k6-logs`. |
| Tabel `Status per node` atau `Jumlah & porsi per Backend` kosong | Panel memakai transformasi `labelsToFields`/`joinByField`. Pastikan label `node`/`server` ada di query (jangan hapus `by (node)`/`by (server)`), lalu muat ulang dashboard. |
| `lb-realtime` kosong / "No data" | Datasource `prometheus` belum ada atau Prometheus mati. Cek `http://grafana.localhost/api/datasources` (harus ada uid `prometheus`), lalu `make k6-up`. |
| Panel "Status target scrape" merah (DOWN) | Target tidak bisa di-scrape. Cek `docker compose -p lb-k6 -f docker-compose.monitoring.yml logs prometheus`. Penyebab umum: backend mati, atau Prometheus tidak menempel di `lb-net` (`make k6-down && make k6-up`). |
| Target backend baru tidak muncul di Prometheus | Container tidak punya label `lb.monitor=true` (cek `docker inspect <container> --format '{{index .Config.Labels "lb.monitor"}}'`) — label ini ada di `x-main-labels`, jadi server baru otomatis dapat. Kalau log Prometheus berisi `permission denied ... docker.sock`, pastikan mount socket read-only dan `user: "0:0"` masih ada, lalu recreate Prometheus. |
| Panel sebaran k6 kosong untuk semua server | Panel membaca metric `served` (tag `server`). Run lama memakai `served_server_N` dan tidak tampil. Jalankan Run baru lewat tautan "Run k6". |
| Metrik `traefik_*` tidak ada di Prometheus | `metrics.prometheus` di `docker/traefik/traefik.yml` hanya dibaca saat start: `make traefik-down && make traefik-up`. Verifikasi: `curl http://127.0.0.1:8089/metrics \| Select-String traefik_entrypoint_requests_total`. |
| `k6` di container gagal resolve `server.localhost` | Alias network hanya aktif kalau traefik dibuat ulang setelah `docker-compose.traefik.yml` diubah: `make traefik-down && make traefik-up`. Cek: `docker run --rm --network lb-net alpine:3 nslookup server.localhost`. |
| `docker compose` gagal: `network lb-net declared as external, but could not be found` | Network belum dibuat: `make net-up`. |
| `grafana.localhost` balas JSON backend | Label router Grafana hilang atau prioritasnya tidak lebih tinggi dari `demo` (harus 200). Cek `http://127.0.0.1:8089/api/http/routers` dan pastikan `grafana@docker` berstatus `enabled`. |
| `adminer.localhost` balas JSON backend / 404 | Label router Adminer belum termuat atau prioritasnya bukan 200. `make db-up` (recreate Adminer), lalu cek `http://127.0.0.1:8089/api/http/routers` dan pastikan `adminer@docker` `enabled`. Selama itu pakai `http://127.0.0.1:8081`. |
| `adminer.localhost` tidak resolve | DNS OS tidak menangani nama itu. Tambahkan `127.0.0.1 adminer.localhost` ke hosts file, atau langsung pakai `http://127.0.0.1:8081`. |
| `k6.localhost` balas 404 | Normal kalau k6 tidak sedang jalan — router hanya ada selama `make k6-watch`. |
| Link "Run k6" di Grafana tidak berefek / `trigger.localhost` 404 | `k6-runner` belum jalan: `make k6-up`. Cek `docker compose -p lb-k6 -f docker-compose.monitoring.yml ps k6-runner` dan log container-nya. |
| Submit "Run k6" tapi dashboard tidak terisi | Lihat log run: `docker exec lb-k6-k6-runner-1 tail -30 /tmp/k6-run.log`. Cek `K6_PROMETHEUS_RW_SERVER_URL` menunjuk `http://prometheus:9090/api/v1/write` dan runner ada di network `lb-k6-net` + `lb-net`. |
| Klik "Run k6" dibalas "Run masih berjalan" padahal tidak ada run | Lock tertinggal setelah runner mati di tengah run: `docker exec lb-k6-k6-runner-1 rmdir /tmp/k6.lock` (atau restart container). |
| `k6-watch` tidak bisa dibuka di 5665 | `docker compose run` tidak mempublikasikan port kecuali `--service-ports` — script sudah memakainya. Pastikan port 5665 bebas. |
| `report.html` tidak dibuat | k6 melewati ekspor bila run terlalu pendek ("not enough data"): butuh durasi > 3× `K6_WEB_DASHBOARD_PERIOD` (di sini 2s → minimal ~6s). |
| `/ui` menampilkan "Database tidak bisa dihubungi" / API 503 | MariaDB belum hidup atau kredensial beda: `make db-up`, lalu cek `make db-ps`. Pesan `DATABASE_NOT_INITIALIZED` berarti tabel belum ada: `make db-reset`. |
| CRUD terasa lambat lalu 504 | `connectTimeout` DB harus di bawah `responseHeaderTimeout` Traefik (2s). Nilai saat ini 1 detik (`DB_CONNECT_TIMEOUT_MS`), jangan dinaikkan melewati 2 detik. |
| Adminer gagal connect | Isi server **`maxscale`** (nama service), bukan `localhost`/`mariadb`. User `lb_app`, database `lb_demo`. Adminer hanya jalan setelah MaxScale hidup. |
| `mariadb` CLI: `ERROR 2026 (HY000): TLS/SSL error: SSL is required` | Klien 11.4 mencoba TLS, listener MaxScale demo ini tanpa TLS. Pakai `--skip-ssl`, atau sambung langsung ke node dengan `docker compose -p lb-db -f docker-compose.db.yml exec mariadb-primary mariadb -uroot -p`. |
| CRUD 503 sesaat setelah `docker compose stop mariadb-primary` | Jendela failover. MaxScale butuh mendeteksi `master_down` lalu mempromosikan replika; request yang lewat di antaranya gagal. `make db-status` menunjukkan primary baru sesudahnya. Kalau tidak pernah pulih, lihat `make db-logs`. |
| `make db-status`: "ada lebih dari satu node bisa ditulis" | Bekas primary sudah hidup tapi belum di-rejoin (`read_only=OFF`). Jalankan `make db-rejoin DB_NODE=<node itu>`; jangan menulis ke kedua node. |
| `make db-status`: "tidak ada node yang bisa ditulis" | Semua node `read_only=ON` — failover gagal atau MaxScale mati sebelum promosi. Nyalakan MaxScale (`make db-up`) lalu cek `make db-logs`; promosi manual lewat `docker exec lb-db-maxscale-1 maxctrl promote server mariadb-replica-1`. |
| `make db-rejoin` menolak: "MaxScale belum bisa dihubungi" | Rejoin butuh tahu primary yang **sah**, dan itu dibaca lewat `maxscale:4006`. Jalankan `make db-up` dulu, lalu ulangi. |
| Replika `Slave_SQL_Running: No` dan log memuat `out-of-order sequence number ... gtid strict mode` | Binlog node itu bercabang. Perbaiki dengan `make db-rejoin DB_NODE=<node>`, yang mengosongkan binlog lalu meng-clone ulang. |
| `mysql_slave_status_*` tidak ada untuk satu node | Normal pada node yang sedang menjadi primary: ia tidak punya `SHOW SLAVE STATUS`. Node yang mati juga hilang; lihat `mysql_up{node=...}`. |
| Alert `db-replica-lag` menyala tapi `make db-status` menunjukkan lag 0 | Alert memakai rata-rata 1 menit; lag bisa sempat naik saat clone atau beban tulis besar. Kalau terus menyala, periksa IO network container dan `Seconds_Behind_Master` di dashboard. |
| `up{job="mariadb"}` = 0 / `mysql_up` kosong | Exporter tidak bisa di-scrape atau gagal login. Cek `docker logs lb-k6-mysqld-exporter-primary-1` (atau `-replica-1/2`), jalankan `make db-grant-users`, pastikan `MARIADB_EXPORTER_PASSWORD` sama di `.env` dan compose. |
| Target `mariadb` hilang dari Prometheus setelah edit config | `prometheus.yml` dibaca ulang otomatis, tetapi menghapus target lama butuh recreate: `docker compose -p lb-k6 -f docker-compose.monitoring.yml up -d --remove-orphans`, lalu cek `/api/v1/targets`. |
| Alert `mariadb-down` masih muncul padahal sudah dihapus dari YAML | Grafana tidak menghapus rule yang hilang dari file. `rules.yml` memuat blok `deleteRules` untuk membersihkannya saat restart; kalau masih ada, `docker restart lb-k6-grafana-1` lalu cek `/api/v1/provisioning/alert-rules`. |
| Panel log database kosong | Container tidak berlabel `lb.logs=true` (label ada di `x-mariadb-common` untuk 3 node, di service `maxscale`, dan di `x-main-labels` untuk backend; recreate dengan `make db-up` / `make docker-up`), atau Alloy/Loki mati: `docker logs lb-k6-alloy-1`. |
| `bind: address already in use` saat `db-up` | Port 8081 dipakai proses lain. Set `ADMINER_PORT=8082` di `.env`, lalu `make db-up`. |
| Perubahan `db/init/001-schema.sql` tidak berefek | SQL init hanya jalan saat volume kosong: `make db-reset` (menghapus data katalog). |
| `make db-down` lalu `make db-up`, data hilang | Data tidak hilang oleh `down`; hanya `down -v` / `db-reset` yang menghapus volume `lb-db-data` dan dua volume replika. Pastikan tidak ada perintah `down -v` manual. |
| Dashboard `db-monitoring` tidak muncul / datasource `loki` tidak ada | File provisioning baru hanya dibaca saat Grafana start: `docker compose -p lb-k6 -f docker-compose.monitoring.yml restart grafana`. Cek `http://grafana.localhost/api/datasources`. |
| Alert `Backend gagal mengakses database` terus NoData | Query alert harus selalu punya nilai. Rule ini memakai `or vector(0)`; kalau menambah rule baru, pakai pola sama atau set `noDataState: OK`. |
| Alert firing tetapi tidak ada email/Telegram | Memang belum ada contact point: Grafana → Alerting → Contact points, lalu arahkan notification policy grup `database`. |
| `db-grant-users` gagal `Access denied for user 'root'` | `MARIADB_ROOT_PASSWORD` di `.env` beda dengan password volume lama. Pakai password yang benar; `db-reset` hanya pilihan terakhir karena menghapus data. |
| `npm install` tidak perlu untuk menjalankan stack | Image backend sudah `npm ci`; `npm install` lokal hanya untuk menjalankan backend/unit test tanpa Docker. |

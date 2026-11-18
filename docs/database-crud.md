# Database MariaDB + CRUD katalog server

Panduan stack database (`lb-db`) dan halaman CRUD `/ui`.

## Batas yang penting

Halaman ini **mengelola katalog**, bukan rotasi load balancer. Menambah atau menghapus
baris di MariaDB tidak mengubah server mana yang dipakai Traefik. Rotasi tetap berasal
dari label container di `docker-compose.yml`. Alasannya ada di
[`adr/0009-mariadb-compose-terpisah-dan-katalog.md`](adr/0009-mariadb-compose-terpisah-dan-katalog.md).

## Komponen

| Komponen | Project compose | Alamat |
|---|---|---|
| MaxScale 24.02 | `lb-db` | `maxscale:4006`, hanya di network `lb-net` |
| MariaDB 11.4 primary | `lb-db` | `mariadb-primary:3306`, hanya di `lb-net` |
| MariaDB 11.4 replika | `lb-db` | `mariadb-replica-1:3306`, `mariadb-replica-2:3306` (`read_only=ON`) |
| Adminer (pembaca database) | `lb-db` | `http://adminer.localhost` (lewat Traefik) · cadangan `http://127.0.0.1:8081` |
| UI CRUD | `lb-demo` (dilayani semua backend) | `http://server.localhost/ui` |
| API CRUD | `lb-demo` (dilayani semua backend) | `http://server.localhost/api/servers` |
| Monitoring database | `lb-k6` | `http://grafana.localhost/d/db-monitoring` (metrik, alert, log) |

MariaDB dan MaxScale sengaja **tidak** dipublikasikan ke host dan **tidak** dirutekan lewat Traefik. Aplikasi hanya mengenal `maxscale:4006`; node mana yang melayani ditentukan monitor, bukan konfigurasi backend.
Adminer punya dua pintu: `http://adminer.localhost` (router `adminer`, prioritas 200 —
pola yang sama dengan `grafana.localhost`) dan `http://127.0.0.1:8081` (loopback,
cadangan). Stack database tetap bisa hidup walau Traefik dan backend dimatikan; label
Traefik hanya menambah rute bila Traefik hidup.

## Menjalankan

```bash
make net-up     # sekali: network lb-net
make db-up      # 3 node -> grant user -> clone replika -> MaxScale + Adminer
make docker-up  # 5 backend (project lb-demo), image Bun + Elysia + Drizzle/Bun SQL
```

Semua sekaligus:

```bash
make stack-up   # net-up -> db-up -> traefik-up -> docker-up -> k6-up
make stack-down # k6-down -> docker-down -> traefik-down -> db-down
```

| Perintah | Arti |
|---|---|
| `make db-up` | Nyalakan tiga node, buat user, clone replika, lalu MaxScale + Adminer |
| `make db-down` | Matikan semuanya (data di tiga volume tetap) |
| `make db-reset` | Hapus **tiga** volume, buat ulang skema + seed, clone ulang |
| `make db-status` | Siapa primary, IO/SQL tiap replika, lag, dan jawaban `maxscale:4006` |
| `make db-rejoin` | `DB_NODE=<node>` — kembalikan node ke cluster (data bercabang dibuang) |
| `make db-grant-users` | Buat/segarkan `lb_app`, `lb_repl`, `lb_monitor`, `lb_exporter` di tiap node |
| `make db-logs` | Log MariaDB, MaxScale, Adminer |
| `make db-ps` | Status + health container database |

Urutan penting: `lb-net` harus ada sebelum `db-up` dan `docker-up`. Di dalam `db-up` urutannya juga tetap — MaxScale baru dinyalakan setelah replika punya data.

## Kredensial

Nilai di bawah adalah **kredensial demo**, bukan rahasia produksi:

| Variabel | Default |
|---|---|
| `MARIADB_DATABASE` | `lb_demo` |
| `MARIADB_USER` | `lb_app` |
| `MARIADB_PASSWORD` | `lb_app_password` (juga ditulis di `docker/maxscale/maxscale.cnf`) |
| `MARIADB_ROOT_PASSWORD` | `lb_root_password` |
| `MARIADB_REPL_PASSWORD` | `lb_repl_password` (user replikasi antar node) |
| `MARIADB_MONITOR_PASSWORD` | `lb_monitor_password` (user monitor MaxScale; juga ditulis di `docker/maxscale/maxscale.cnf`) |
| `MARIADB_EXPORTER_PASSWORD` | `lb_exporter_password` (user monitoring, bukan untuk aplikasi) |
| `ADMINER_PORT` | `8081` |

Ganti lewat `.env` di root project (contoh di `.env.example`). `.env` sudah masuk
`.gitignore`. Compose memakai nilai default yang sama bila `.env` tidak ada.

Login Adminer di `http://adminer.localhost` (atau `http://127.0.0.1:8081`):

- System: **MySQL / MariaDB**
- Server: `maxscale`
- Username: `lb_app`
- Password: `lb_app_password` (atau nilai `.env`)
- Database: `lb_demo`

Server **`maxscale`**, bukan `mariadb-primary`: setelah failover, hanya nama itu yang masih menunjuk node yang benar.

## Topologi dan failover

Tiga node MariaDB 11.4: satu primary, dua replika asinkron. Semuanya di belakang
MaxScale, yang menjadi satu-satunya alamat bagi aplikasi.

- **Primary** menerima semua baca dan tulis. **Replika** `read_only=ON` dan tidak
  melayani klien — dengan replikasi asinkron, membaca dari replika berarti `POST` lalu
  `GET` bisa melihat data lama.
- **Nama bukan peran.** `mariadb-primary` hanya peran awal. Setelah failover, primary
  bisa `mariadb-replica-1`; skrip mencari primary dari `@@read_only` dan dari node yang
  dilayani `maxscale:4006`.
- **Failover otomatis.** Monitor MaxScale (interval 1 detik, `master_failure_timeout`
  3 detik) menandai primary mati, mempromosikan replika dengan GTID paling maju, lalu
  mengarahkan replika lain ke node baru.
- **Rejoin manual.** `auto_rejoin=false`: node yang hidup lagi tidak masuk sendiri.
  Datanya bisa bercabang, jadi pemulihannya eksplisit:

  ```bash
  make db-status                              # siapa primary sekarang
  make db-rejoin DB_NODE=mariadb-primary      # buang data node itu, clone dari primary
  ```

  Data yang sempat ditulis ke node lama **hilang**. Itu disengaja; menggabungkan dua
  riwayat otomatis tidak bisa dilakukan dengan benar.
- **RPO > 0.** Recovery Point Objective (jumlah tulisan yang sudah dijawab sukses ke
  aplikasi tetapi hilang saat failover) pada replikasi asinkron tidak pernah dijamin
  nol. Ukurannya dibaca dari lag replika; `make test-db` mengukurnya langsung dengan
  mematikan primary. Setiap transaksi diberi penanda **GTID** (`domain-server-seq`)
  dan ketiga node memakai `--sync-binlog=1`, sehingga replika melanjutkan dari posisi
  transaksi yang presisi tanpa bergantung pada nama file binlog.

Melihat keadaan sekarang:

```bash
make db-status
# node               role     read_only  io  sql  lag   master
# mariadb-primary    PRIMARY  OFF       -   -    -     -
# mariadb-replica-1  replica  ON        Yes  Yes  0s    mariadb-primary
# mariadb-replica-2  replica  ON        Yes  Yes  0s    mariadb-primary
#
# maxscale:4006 -> mariadb-primary (read_only=0)
```

Kalau `db-status` mengeluh "ada lebih dari satu node bisa ditulis", bekas primary sudah
hidup tanpa di-rejoin. Jangan menulis ke dua-duanya; jalankan `make db-rejoin`.

## Skema

File: `db/init/001-schema.sql`. Dijalankan otomatis oleh node primary **hanya saat
volume `lb-db-data` masih kosong**. Replika tidak memakai file ini: isinya datang dari
`mariadb-dump` + restore yang dijalankan `scripts/db-replica-clone.js`.

Tabel `registered_servers`:

| Kolom | Tipe | Aturan |
|---|---|---|
| `id` | `INT UNSIGNED` | primary key, auto increment |
| `name` | `VARCHAR(64)` | wajib, unik |
| `host` | `VARCHAR(255)` | wajib |
| `port` | `SMALLINT UNSIGNED` | 1–65535 |
| `weight` | `TINYINT UNSIGNED` | 1–100, default 1 |
| `enabled` | `TINYINT(1)` | default 1 |
| `note` | `VARCHAR(255)` | boleh kosong |
| `created_at` | `TIMESTAMP` | otomatis |
| `updated_at` | `TIMESTAMP` | otomatis |

Seed berisi `server-1` sampai `server-5`, sesuai backend di `docker-compose.yml`.

Kalau file init diubah setelah volume dibuat, perubahan **tidak** otomatis masuk.
Jalankan:

```bash
make db-reset
```

## API

Semua endpoint dilayani backend mana pun yang dipilih Traefik. Respons membawa header
`x-served-by` berisi nama backend yang melayani, jadi UI bisa menunjukkan bukti bahwa
state-nya dibagi bersama.

| Metode | Path | Arti | Sukses |
|---|---|---|---|
| GET | `/api/servers` | daftar semua server | 200, array |
| GET | `/api/servers/:id` | satu server | 200 |
| POST | `/api/servers` | tambah server | 201 + `Location` |
| PUT | `/api/servers/:id` | ganti seluruh field | 200 |
| DELETE | `/api/servers/:id` | hapus | 204 |

Contoh:

```bash
curl -s http://server.localhost/api/servers

curl -s -X POST http://server.localhost/api/servers \
  -H "content-type: application/json" \
  -d '{"name":"server-6","host":"server-6","port":3000,"weight":1,"enabled":true,"note":"cadangan"}'

curl -s -X PUT http://server-2.localhost/api/servers/6 \
  -H "content-type: application/json" \
  -d '{"name":"server-6","host":"server-6","port":3100,"weight":2,"enabled":false,"note":"diedit"}'

curl -i -X DELETE http://server-3.localhost/api/servers/6
```

### Status dan error

| Status | `code` | Kapan |
|---|---|---|
| 400 | `VALIDATION_ERROR` | field tidak valid; `details` berisi per-field |
| 400 | `INVALID_JSON` | body kosong / bukan JSON |
| 404 | `NOT_FOUND` | id atau endpoint tidak ada |
| 405 | `METHOD_NOT_ALLOWED` | metode salah; header `Allow` disertakan |
| 409 | `DUPLICATE_NAME` | `name` sudah dipakai |
| 413 | `BODY_TOO_LARGE` | body > 64 KB |
| 503 | `DATABASE_UNAVAILABLE` | MariaDB mati / kredensial salah |
| 503 | `DATABASE_NOT_INITIALIZED` | tabel belum ada, jalankan `db-reset` |

`/health` **tidak** mengecek database. Kalau MariaDB mati, Traefik tetap menganggap
backend sehat dan endpoint demo (`/`, `/slow`, `/metrics`) tetap bekerja; hanya CRUD
yang membalas 503. `connectTimeout` driver diset 1 detik — di bawah
`responseHeaderTimeout` Traefik 2 detik — supaya klien menerima 503, bukan 504.

## UI

Buka `http://server.localhost/ui` (atau `http://server-N.localhost/ui`). Satu halaman
HTML/CSS/JS tanpa framework dan tanpa build step, berisi:

- tabel katalog + status aktif/nonaktif,
- form tambah/edit dengan validasi HTML dan pesan error dari API,
- tombol hapus dengan konfirmasi,
- badge "Dilayani oleh" dari header `x-served-by`,
- tautan ke Adminer (`adminer.localhost`, cadangan `127.0.0.1:8081`).

Halaman ini statis dan disalin ke image backend; setelah mengubah
`src/backend/public/index.html`, jalankan `make docker-up` lagi.
`/` tetap mengembalikan JSON echo seperti sebelumnya — UI sengaja di path terpisah
supaya test load balancing tidak berubah.

## Monitoring

Kesehatan database dipantau dari stack `lb-k6`, bukan dari `lb-db`:

- Tiga `mysqld-exporter` (satu per node) membaca status lewat user `lb_exporter`
  (`PROCESS` + `REPLICATION CLIENT` + `SLAVE MONITOR`) yang dibuat `make db-grant-users`.
  Label Prometheus `node` memakai nama service, jadi alert menyebut node yang bermasalah.
- Backend menambahkan metrik `lb_db_queries_total`, `lb_db_errors_total`, dan
  `lb_db_query_duration_seconds` ke `/metrics`.
- Log tiga node MariaDB, MaxScale, dan backend dikirim Alloy ke Loki (label `lb.logs=true`).

Dashboard: `http://grafana.localhost/d/db-monitoring`. Alert yang tersedia:
`db-no-primary`, `db-multiple-writable`, `db-node-down`, `db-replica-stopped`,
`db-replica-lag`, `mariadb-connections-high`, `mariadb-slow-queries`, `api-db-errors`.
Panduan lengkap ada di [`database-monitoring.md`](database-monitoring.md).

## Verifikasi yang sudah dijalankan

```bash
# tulis lewat load balancer, baca lewat server lain: datanya sama
curl -s -X POST http://server.localhost/api/servers -d '...'   # 201, x-served-by: server-5
curl -s http://server-3.localhost/api/servers/6                # 200, x-served-by: server-3

# validasi & duplikat
curl -s -X POST ... (port 0)                                   # 400 VALIDATION_ERROR
curl -s -X POST ... (name server-1)                            # 409 DUPLICATE_NAME

# primary dimatikan: aplikasi pindah ke replika tanpa restart backend
docker compose -p lb-db -f docker-compose.db.yml stop mariadb-primary
make db-status                                                    # primary pindah, satu node DOWN
curl -s -o /dev/null -w '%{http_code}' http://server-1.localhost/api/servers  # 200 setelah jendela failover
docker compose -p lb-db -f docker-compose.db.yml start mariadb-primary
make db-rejoin DB_NODE=mariadb-primary                            # kembali sebagai replika
make test-db                                                      # otomatis, termasuk RPO

# Adminer lewat Traefik dan lewat port cadangan
curl -s -o /dev/null -w '%{http_code}' http://adminer.localhost/               # 200 (halaman login)
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8081/                  # 200 cadangan
# login lb_app lewat adminer.localhost -> daftar tabel berisi registered_servers
```

## Uji CRUD dengan data acak

Test suite Docker membuktikan rotasi dan failover, bukan isi katalog. Untuk menguji CRUD
dengan banyak data, pakai:

```bash
make crud-load                         # 100 entitas, 10 user paralel
make crud-load COUNT=2000 USERS=50     # 2000 entitas, 50 worker
make crud-load COUNT=500 MODE=create   # hanya POST, lalu dibersihkan
make crud-load COUNT=200 KEEP=1        # data dipertahankan di katalog
make crud-load COUNT=500 REPORT=monitoring/reports/crud.json
```

Aturannya:

- **`COUNT` = jumlah entitas**, bukan jumlah request. Mode `full` menghasilkan 6 request
  per entitas (POST, GET, PUT, GET, DELETE, lalu GET terakhir yang harus 404); mode
  `create` hanya 1 request per entitas.
- **`USERS` = worker paralel** yang berbagi satu antrean `COUNT`. `COUNT=1000 USERS=20`
  tetap 1000 entitas.
- Nama entitas selalu berprefix `crud-<runId>-<nomor>` sehingga tidak bentrok dengan seed
  `server-1`…`server-5` maupun dengan run lain yang berjalan bersamaan.
- Field lain acak tetapi tetap valid menurut `src/backend/servers/validation.ts`: host
  `10.x.y.z`, port 1–65535, bobot 1–100, `enabled` acak, catatan ≤ 255 karakter.
  Generator sengaja tidak memakai library tambahan.
- Setiap langkah diperiksa, bukan hanya status: `POST` harus 201 + `Location`, `GET` harus
  mengembalikan field yang sama, `PUT` harus mengganti seluruh field, `DELETE` harus 204,
  dan `GET` sesudahnya harus 404 `NOT_FOUND`.
- **Data dibersihkan di akhir**, termasuk entitas yang gagal di tengah siklus. `KEEP=1`
  melewati pembersihan. Mode `create` tanpa `KEEP` menghapus semua yang baru dibuat.
- Base URL default `http://server.localhost` (lewat Traefik, jadi request ikut dibagi ke
  5 backend); `BASE_URL=http://127.0.0.1:8088` dipakai bila nama `*.localhost` tidak
  resolve.
- Ringkasan memuat jumlah request sesuai harapan, kegagalan per operasi, p50/p95/max,
  throughput, sebaran `x-served-by`, dan sisa data. Exit code 1 bila ada entitas gagal
  atau pembersihan gagal; error koneksi/5xx menghentikan run lebih awal.
- `REPORT=path.json` menyimpan ringkasan yang sama dalam JSON (konfigurasi, operasi,
  sebaran backend, maksimal 50 kegagalan pertama).

Karena `GET /api/servers` mengembalikan seluruh baris, siklus per entitas memakai
`GET /api/servers/:id`, bukan list. Jangan menjalankan `COUNT` besar tanpa `KEEP` di
katalog yang sedang dipakai presentasi: selama run, jumlah baris naik dan UI ikut
memuat semuanya.

## Batasan

- Tanpa autentikasi: siapa pun yang bisa membuka `/ui` bisa menulis. Hanya untuk lokal.
- Adminer tanpa auth tambahan. Lewat `adminer.localhost` ia ikut terbuka di port 80 dan bisa dijangkau mesin lain di LAN bila nama itu resolve; `127.0.0.1:8081` hanya loopback. Jangan diekspos ke internet.
- Kredensial demo tersimpan sebagai default compose dan bisa dilihat di repo.
- Katalog tidak mengubah rotasi Traefik dan tidak dibaca oleh Prometheus/k6.
- Monitoring database hanya untuk lokal: Grafana/Loki tanpa auth tambahan, exporter memakai password demo, dan alert belum punya notifikasi keluar.
- Failover hanya menutup kegagalan proses/container database. Ketiga node dan MaxScale ada di satu mesin Docker, jadi mesin itu tetap titik tunggal; host mati, disk penuh, dan network putus tidak termasuk.
- Replikasi asinkron: RPO > 0. Tidak ada semi-sync maupun Galera.
- Replika tidak menambah kapasitas baca — semua SELECT tetap ke primary.
- `maxscale:4006` adalah satu-satunya pintu aplikasi; MaxScale sendiri tidak punya cadangan.
- `db-reset` menghapus **tiga** volume (`lb-db-data`, `lb-db-replica-1-data`, `lb-db-replica-2-data`).

# Monitoring database MariaDB

Panduan memantau cluster MariaDB: peran tiap node (primary/replika), status replikasi
dan lag, metrik server, query CRUD dari backend, serta **log error** MariaDB, MaxScale,
dan backend. Semua alat tinggal di stack monitoring `lb-k6`, bukan di stack database
`lb-db`.

## Kenapa dipisah dari `lb-db`

`lb-db` sengaja hanya berisi data (3 node MariaDB + MaxScale + Adminer). Yang membaca
data tinggal di `lb-k6`:

- MariaDB dan MaxScale tetap tanpa port host dan tanpa rute Traefik.
- `make db-down` tidak ikut mematikan dashboard atau alat pantau.
- `make k6-down` tidak menyentuh database.
- Jembatannya tiga `mysqld-exporter` (satu per node), yang menempel di `lb-net` untuk
  menjangkau `mariadb-*:3306` dan di `lb-k6-net` supaya bisa di-scrape Prometheus.
  Dipisah per node karena satu exporter hanya bisa menembak satu alamat; digabung,
  `mysql_up` tidak bisa menunjukkan node mana yang mati.

## Komponen

| Komponen | Project | Alamat internal | Peran |
|---|---|---|---|
| `mysqld-exporter-primary` | `lb-k6` | `mysqld-exporter-primary:9104` | Status `mariadb-primary` |
| `mysqld-exporter-replica-1` | `lb-k6` | `mysqld-exporter-replica-1:9104` | Status `mariadb-replica-1` |
| `mysqld-exporter-replica-2` | `lb-k6` | `mysqld-exporter-replica-2:9104` | Status `mariadb-replica-2` |
| Prometheus | `lb-k6` | `prometheus:9090` | Scrape job `mariadb` (3 target, label `node`) + backend, retensi 7 hari |
| Loki | `lb-k6` | `loki:3100` | Menyimpan log container, retensi 7 hari |
| Alloy | `lb-k6` | `alloy:12345` | Mengirim log container berlabel `lb.logs=true` ke Loki |
| Grafana | `lb-k6` | `grafana:3000` | Dashboard `db-monitoring` + 8 alert rule database |

Nama service exporter mengikuti node supaya `docker compose ps` langsung terbaca. Label
Prometheus `node` berisi nama service MariaDB, jadi panel dan alert menyebut
`mariadb-replica-2`, bukan IP container yang berubah setiap recreate.

Jalankan semuanya:

```bash
make db-up        # 3 node + MaxScale + Adminer, grant user, clone replika
make k6-up        # Grafana, Prometheus, 3 exporter, Loki, Alloy, ...
```

`db-up` dan `db-reset` otomatis memanggil `scripts/db-grant-users.js`. Kalau user
exporter perlu disegarkan tanpa menyalakan ulang DB:

```bash
make db-grant-users
```

## User exporter

`lb_app` hanya punya hak pada database `lb_demo`, sehingga tidak bisa membaca
`SHOW GLOBAL STATUS` sepenuhnya. Karena itu ada user khusus di **setiap** node:

| Hal | Nilai |
|---|---|
| User | `lb_exporter` (host `%`) |
| Password | `MARIADB_EXPORTER_PASSWORD`, default `lb_exporter_password` |
| Hak | `PROCESS`, `REPLICATION CLIENT`, `SLAVE MONITOR` pada `*.*` |

Dibuat idempotent oleh `scripts/db-grant-users.js` (bukan lewat `db/init`), supaya volume
yang sudah ada ikut mendapatkannya tanpa `db-reset` — `db-reset` menghapus data katalog.
User yang sama juga dibuat di replika karena **siapa pun bisa menjadi primary** setelah
failover; menunggu replikasi `GRANT` berarti exporter kehilangan akses tepat saat
dibutuhkan.

Ekspor password ke exporter lewat anchor compose:

```yaml
x-mysqld-exporter: &mysqld-exporter
  image: prom/mysqld-exporter:v0.17.2
  environment:
    MYSQLD_EXPORTER_PASSWORD: ${MARIADB_EXPORTER_PASSWORD:-lb_exporter_password}
```

Kalau password diganti di `.env`, jalankan `make db-grant-users`, lalu
`docker compose -p lb-k6 -f docker-compose.monitoring.yml up -d mysqld-exporter-primary mysqld-exporter-replica-1 mysqld-exporter-replica-2`.

## Metrik

### Dari MariaDB (lewat exporter)

| Metrik | Arti |
|---|---|
| `mysql_up` | 1 = exporter berhasil login ke node itu |
| `mysql_global_variables_read_only` | **0 = primary, 1 = replika** |
| `mysql_slave_status_slave_io_running` / `_slave_sql_running` | 1 = thread replikasi jalan (hanya ada di node yang punya replika) |
| `mysql_slave_status_seconds_behind_master` | lag replikasi = batas RPO |
| `mysql_slave_status_master_server_id` | `server_id` primary yang disalin |
| `mysql_global_status_threads_connected` | koneksi terbuka saat ini |
| `mysql_global_status_threads_running` | koneksi yang sedang menjalankan query |
| `mysql_global_variables_max_connections` | batas `max_connections` |
| `mysql_global_status_queries` | counter total query |
| `mysql_global_status_slow_queries` | counter slow query (status server, bukan log) |
| `mysql_global_status_aborted_connects` / `aborted_clients` | koneksi gagal / terputus |
| `mysql_global_status_innodb_buffer_pool_reads` / `_read_requests` | dipakai untuk hit ratio |

Tiga tingkat yang harus dibedakan:

| Pertanyaan | Metrik |
|---|---|
| Exporter bisa di-scrape? | `up{job="mariadb",node="..."}` |
| Exporter bisa login ke node itu? | `mysql_up{node="..."}` |
| Node itu menerima tulisan? | `mysql_global_variables_read_only{node="..."} == 0` |

Karena itu dashboard dan alert **tidak** memakai `up` saja: exporter tetap membalas HTTP
200 walau node di belakangnya mati (`mysql_up 0`). `mariadb-primary` yang dimatikan
membuat `mysql_up{node="mariadb-primary"} = 0`, sementara dua node lain tetap 1 — persis
informasi yang dibutuhkan saat failover.

`mysql_slave_status_*` tidak muncul di node yang sedang menjadi primary. Itu normal,
bukan data hilang: node itu tidak punya `SHOW SLAVE STATUS`.

### Dari backend (aplikasi)

`/metrics` setiap backend sekarang juga memuat metrik query database:

| Metrik | Label | Arti |
|---|---|---|
| `lb_db_queries_total` | `server`, `operation`, `result` | jumlah query (`list`, `get`, `insert`, `update`, `delete`; `success`/`error`) |
| `lb_db_errors_total` | `server`, `code` | query gagal per kode driver (`ER_DUP_ENTRY`, `ETIMEDOUT`, …) |
| `lb_db_query_duration_seconds` | `server`, `le` | histogram durasi query |

Kenapa perlu metrik aplikasi kalau sudah ada exporter:

- Saat MariaDB mati, exporter juga tidak bisa connect. Metrik backend tetap
  menunjukkan **dari sisi aplikasi** bahwa CRUD gagal (`ETIMEDOUT`) dan berapa lama
  klien menunggu.
- `ER_DUP_ENTRY` bisa dibedakan dari gangguan nyata; konflik nama bukan insiden.
- Latensi CRUD terlihat per operasi tanpa membuka slow query log.

Cek langsung:

```bash
curl -s http://server-1.localhost/metrics | Select-String '^lb_db_'
```

Counter disimpan di memori proses: angka kembali 0 saat container backend dibuat ulang.

## Dashboard

Buka `http://grafana.localhost/d/db-monitoring` (uid `db-monitoring`, folder
`database`). Dashboard ini juga muncul di daftar dashboard Grafana.

Urutan panel sengaja mengikuti pertanyaan, bukan urutan metrik:

| Baris | Pertanyaan | Isi |
|---|---|---|
| Kartu atas | Apakah cluster sehat? | `Primary aktif` (harus 1), `Replika sehat` (harus 2), `Lag replika maksimum`, `Error DB/menit`, `Koneksi terpakai`, `Cache InnoDB terpakai` |
| 1 | Siapa Primary, siapa Replika? | Tabel `Status per node`: Node · Koneksi · Peran · Thread IO · Thread SQL · Lag (setara `make db-status`) |
| 2 | Apakah replikasi mengejar? | `Thread replikasi` (IO/SQL per node) dan `Lag replika` dengan garis ambang 10 detik |
| 3 | Seberapa sibuk server? | `Query MariaDB/detik`, `Koneksi per node`, `Slow query/detik`, `Koneksi gagal/terputus` |
| 4 | Apakah aplikasi terganggu? | `Latensi query CRUD`, `Query CRUD per operasi`, `Error DB per kode` |
| 5 | Apa penyebabnya? | `Alert database` (hanya label `component=database`) dan log MariaDB/MaxScale/backend |

Setiap panel punya ikon ⓘ berisi **Arti · Normal · Jika merah**, dan tiap baris sekat
menyebut pertanyaan yang dijawab. Tautan di bar atas berpindah ke `LB Realtime`,
`Pengujian k6`, dan pemicu Run k6 tanpa kehilangan konteks.

Panel per-node memakai legenda `{{node}}`. Legenda sengaja dibuat unik per seri
(`{{node}} · terbuka`, `{{node}} · jalan`, `{{node}} · batas`) supaya tiga garis tidak
tampil dengan nama sama. Tabel `Status per node` menggabungkan lima query dengan
transformasi `labelsToFields` → `joinByField` → `filterFieldsByName` → `organize`, jadi
kolomnya manusiawi, bukan nama metrik mentah.

Warna panel status memakai threshold: hijau = normal, kuning = waspada, merah =
bermasalah. Dashboard di-provision dari `monitoring/grafana/dashboards/db/database.json`
(`allowUiUpdates: false`), jadi edit permanen dilakukan di file itu. Grafana membaca ulang
file setiap 30 detik; kalau tidak berubah, restart container Grafana.

## Log error

Alur:

```
container berlabel lb.logs=true
        │  Docker API (socket read-only)
        ▼
      Alloy  ──push──>  Loki  ──query──>  Grafana (datasource `loki`)
```

Label yang dipasang Alloy pada tiap baris log:

| Label | Isi | Contoh query |
|---|---|---|
| `project` | project compose | `{project="lb-db"}` |
| `service` | nama service compose | `{service="mariadb-replica-1"}`, `{service="maxscale"}` |
| `container` | nama container | `{container="lb-demo-server-1-1"}` |

Label `lb.logs=true` ada di:

- `docker-compose.db.yml` → `x-mariadb-common` (ketiga node) dan service `maxscale`
- `docker-compose.yml` → `x-main-labels`, jadi ikut semua backend
- `docker-compose.traefik.yml` → service `traefik` (hanya access log 4xx/5xx dan request lambat ≥ 500ms)

Adminer dan container monitoring sengaja tidak dilabeli supaya Loki tidak
penuh log yang tidak diminta. Log MaxScale penting karena di situlah keputusan
failover terlihat (`master_down`, `Performing automatic failover`, `Failover ... performed`).

Contoh query di Grafana Explore (datasource `loki`):

```logql
# semua error/warning MariaDB, MaxScale, dan backend
{project=~"lb-db|lb-demo"} |~ "(?i)error|warning|fatal|denied|tidak tersedia"

# hanya MaxScale (keputusan failover)
{service="maxscale"} |~ "mariadbmon|state"

# satu node
{service="mariadb-replica-1"}

# log peringatan CRUD dari backend
{project="lb-demo"} |= "CRUD ditolak"

# gagal connect ke database
{project="lb-demo"} |= "database tidak tersedia"
```

MariaDB dan MaxScale menulis log ke stdout container (`docker logs lb-db-mariadb-primary-1`,
`docker logs lb-db-maxscale-1`), karena itu Alloy membaca lewat Docker API, bukan file
`/var/lib/docker/containers` — Docker Desktop di Windows tidak membagikan path host itu ke container.

Retensi Loki 168 jam (7 hari), sama dengan Prometheus. Log lama dibuang oleh compactor.

## Alert

Alert dikelola Grafana (`monitoring/grafana/provisioning/alerting/rules.yml`), bukan
Prometheus/Alertmanager, supaya tidak menambah container dan statusnya langsung terlihat
di menu **Alerting** serta panel **Alert database**.

| UID | Nama | Kondisi | For | Severity |
|---|---|---|---|---|
| `db-no-primary` | Tidak ada node bisa ditulis | `count(mysql_global_variables_read_only == 0) or vector(0) < 1` | 30s | critical |
| `db-multiple-writable` | Lebih dari satu node bisa ditulis | `count(... == 0) or vector(0) > 1` | 1m | critical |
| `db-node-down` | Satu node tidak terjangkau | `min by (node) (mysql_up) or vector(0) < 1` | 1m | warning |
| `db-replica-stopped` | Replikasi berhenti | `min by (node) (mysql_slave_status_slave_sql_running) or vector(0) < 1` | 1m | warning |
| `db-replica-lag` | Replika tertinggal | `max by (node) (mysql_slave_status_seconds_behind_master) or vector(0) > 10` | 1m | warning |
| `mariadb-connections-high` | Koneksi hampir penuh | `max by (node) (threads_connected / max_connections) > 0.8` | 2m | warning |
| `mariadb-slow-queries` | Slow query menumpuk | `increase(slow_queries[5m]) > 5` | 1m | warning |
| `api-db-errors` | Backend gagal mengakses database | `sum(rate(lb_db_errors_total{code!="ER_DUP_ENTRY"}[2m])) > 0` | 1m | warning |

Catatan:

- `db-no-primary` memakai `noDataState: Alerting`: kalau ketiga exporter hilang sama
  sekali, alert tetap menyala. `or vector(0)` membuat "semua node read_only" bernilai 0,
  bukan NoData.
- `db-multiple-writable` adalah alarm **split brain**. Normalnya tidak pernah menyala
  karena MaxScale memaksa `read_only=ON` pada semua node non-master. Kalau menyala,
  jangan menulis ke node mana pun sebelum `make db-status` menjelaskan siapa primary.
- `db-node-down` sengaja **warning**, bukan critical: satu replika mati tidak
  menghentikan aplikasi, cukup menurunkan jumlah kandidat failover. Yang critical adalah
  `db-no-primary`.
- `db-replica-stopped` dan `db-replica-lag` memakai `noDataState: OK` karena metrik
  `mysql_slave_status_*` memang tidak ada di node yang menjadi primary.
- `api-db-errors` memakai `or vector(0)` supaya "tidak ada error" berarti nilai 0, bukan
  NoData. Tanpa itu, Grafana terus menampilkan alert NoData saat sistem sehat.
- `ER_DUP_ENTRY` dikecualikan: itu konflik nama dari UI, bukan gangguan database.
- Slow query log MariaDB **belum** diaktifkan; angka `slow_queries` berasal dari status
  server dengan `long_query_time` default.

### Menambah notifikasi keluar

Saat ini belum ada contact point, jadi alert hanya berstatus **firing** di Grafana.
Untuk mengirim email/Telegram/webhook:

1. Grafana → **Alerting** → **Contact points** → **Add contact point**.
2. Isi tipe dan alamat tujuan, lalu **Test**.
3. **Alerting** → **Notification policies** → arahkan grup `database` ke contact point
   itu.
4. Simpan lewat UI. Kalau ingin permanen di repo, tambahkan
   `monitoring/grafana/provisioning/alerting/contact-points.yml` dan
   `.../policies.yml` (format provisioning Grafana), lalu restart Grafana.

Karena contact point berisi token/URL rahasia, jangan di-commit; simpan di `.env` dan
rujuk lewat `$__env{VARIABEL}` bila memakai provisioning.

## Uji gangguan (outage drill)

Dua skenario berbeda: **primary mati** (aplikasi harus pulih sendiri) dan **seluruh
database mati** (aplikasi harus gagal dengan jelas).

### 1. Primary mati: failover

```bash
# 1. matikan node yang sedang menjadi primary
make db-status
docker compose -p lb-db -f docker-compose.db.yml stop mariadb-primary

# 2. tulis lewat aplikasi: gagal selama jendela failover, lalu normal lagi
curl.exe -s -o NUL -w "%{http_code}`n" -X POST http://server-1.localhost/api/servers `
  -H "content-type: application/json" -d "{\"name\":\"drill-1\",\"host\":\"x\",\"port\":3000}"

# 3. sesudah pulih
make db-status        # primary sekarang node lain, satu node DOWN

# 4. metrik: node yang mati saja yang 0
curl.exe -s -u admin:admin "http://127.0.0.1:3000/api/datasources/proxy/uid/prometheus/api/v1/query?query=mysql_up%7Bjob%3D%22mariadb%22%7D"

# 5. hidupkan lagi dan rejoin manual (data lamanya dibuang)
docker compose -p lb-db -f docker-compose.db.yml start mariadb-primary
make db-rejoin DB_NODE=mariadb-primary
```

Angka terukur pada mesin ini (Windows + Docker Desktop, `make test-db`):

| Peristiwa | Hasil |
|---|---|
| Primary dimatikan | tulis lewat `maxscale:4006` gagal **~32 detik** lalu berhasil lagi tanpa restart backend |
| Rincian jendela | deteksi `master_down` ~23 s, promosi + konfirmasi replika ~6 s, sisanya sampai tulis pertama dijawab |
| RPO | **6 tulis di-ACK, 0 hilang**; lag replika saat primary dimatikan **0 detik** |
| Rejoin primary lama | **6,0 detik** sampai `read_only=ON` dengan IO/SQL `Yes` |
| Primary lama hidup tanpa rejoin | MaxScale tetap melayani node baru — `auto_rejoin=false` bekerja |
| Tulis ke replika sebagai `lb_app` | ditolak (`ERROR 1290 ... read-only`) |
| `make test-db` | **7/7 lulus** dalam **186 detik** |
| Log | baris `[mariadbmon] Performing automatic failover` dan `Failover ... performed` muncul di Loki |

### 2. Seluruh database mati: gagal dengan jelas

```bash
docker compose -p lb-db -f docker-compose.db.yml stop mariadb-primary mariadb-replica-1 mariadb-replica-2

# aplikasi: 503, bukan menggantung
curl.exe -s -o NUL -w "%{http_code}`n" http://server-1.localhost/api/servers   # 503
curl.exe -s -o NUL -w "%{http_code}`n" http://server-1.localhost/health        # 200

# metrik: ketiga target melaporkan mysql_up 0; tidak ada node read_only=0
# alert db-no-primary -> firing setelah 30 detik

docker compose -p lb-db -f docker-compose.db.yml start mariadb-primary mariadb-replica-1 mariadb-replica-2
make db-up     # idempotent: grant + clone ulang node yang tertinggal
```

Karena `connectTimeout` driver 1 detik dan MaxScale menolak koneksi saat tidak punya
master, klien menerima 503 cepat — bukan menunggu sampai `responseHeaderTimeout` Traefik
(2 detik) berubah menjadi 504.

## Batasan

- Tiga target exporter untuk tiga node; tidak ada penemuan otomatis node baru. Menambah
  node keempat butuh satu service exporter + satu target di `prometheus.yml`.
- Replikasi asinkron: `db-replica-lag` menunjukkan batas RPO, bukan jaminan nol data hilang.
- Failover hanya untuk kegagalan proses/container. Host mati, disk penuh, dan network
  putus tidak tertangani: MaxScale dan ketiga node berada di satu mesin Docker.
- `maxscale:4006` adalah satu-satunya pintu aplikasi; MaxScale tidak punya cadangan.
- `performance_schema` dimatikan di MariaDB demo, jadi metrik per-query tidak tersedia.
- Alert hanya terlihat di Grafana; belum ada notifikasi keluar.
- Grafana, Loki, dan Prometheus tanpa autentikasi tambahan. Hanya untuk lokal.
- Grafana hanya membaca ulang **provisioning datasource/dashboard/alert** saat start.
  Setelah menambah file provisioning baru: `docker compose -p lb-k6 -f
  docker-compose.monitoring.yml restart grafana`.
- Prometheus memuat ulang `prometheus.yml` otomatis (`--config.auto-reload`), tetapi
  Perubahan besar (menambah job) sebaiknya diikuti `docker restart lb-k6-prometheus-1`.
- Metrik backend hilang saat container dibuat ulang; Prometheus menandainya sebagai
  reset. Angka total tidak bisa dijumlahkan lintas restart.
- Dashboard hanya menyimpan data 7 hari (Prometheus) dan 7 hari (Loki).

## Troubleshooting

| Gejala | Penyebab & solusi |
|---|---|
| `up{job="mariadb"}` = 0, `mysql_up` tidak ada | Exporter gagal login. Cek `docker logs lb-k6-mysqld-exporter-primary-1` (atau `-replica-1/2`); jalankan `make db-grant-users`; pastikan `MARIADB_EXPORTER_PASSWORD` sama di DB dan compose. |
| `mysql_up` = 0 tetapi exporter hidup | User ada tapi hak kurang, atau node-nya memang mati. Cek `SHOW GRANTS FOR 'lb_exporter'@'%'` lewat Adminer/root; harus ada `PROCESS`, `REPLICATION CLIENT`, `SLAVE MONITOR`. |
| Satu target `mariadb` hilang setelah upgrade dari topologi lama | Exporter lama `mysqld-exporter` masih ada di project: `docker compose -p lb-k6 -f docker-compose.monitoring.yml up -d --remove-orphans`. |
| `mysql_slave_status_*` tidak ada | Normal di node yang sedang menjadi primary, dan pada node yang mati (lihat `mysql_up`). Kalau hilang di replika yang hidup, replikasinya berhenti — `make db-status`. |
| Kartu `Primary aktif` menunjukkan 2 / SPLIT BRAIN | Bekas primary hidup tanpa `read_only=ON`. Jangan menulis ke dua-duanya: `make db-status`, lalu `make db-rejoin DB_NODE=<node>`. |
| Dashboard kosong setelah `k6-up` | Grafana belum membaca provisioning baru: `docker compose -p lb-k6 -f docker-compose.monitoring.yml restart grafana`. |
| Target `mariadb` tidak ada di Prometheus | `prometheus.yml` belum dimuat: `docker restart lb-k6-prometheus-1`. Cek `/api/v1/targets` lewat Grafana. |
| Alert `mariadb-down` masih tampil padahal sudah dihapus dari YAML | Grafana tidak menghapus rule yang hilang dari file. `rules.yml` memuat blok `deleteRules` untuk itu; kalau masih ada, restart Grafana lalu cek `/api/v1/provisioning/alert-rules`. |
| Panel log kosong | Container tidak punya label `lb.logs=true` (cek `docker inspect`), atau Alloy/Loki mati. `docker logs lb-k6-alloy-1` dan `docker logs lb-k6-loki-1`. |
| Log MariaDB lama tidak muncul | Retensi 7 hari; Loki hanya menyimpan sejak Alloy pertama jalan. Log sebelum itu tetap ada di `docker logs`. |
| Alloy log `could not inspect container info ... No such container` | Normal sesaat setelah container di-recreate (`make test`, `docker-up`): Alloy sempat menail container lama. Log container baru tetap masuk; pesan hilang sendiri. |
| Alert NoData terus menyala | Query alert mengembalikan deret kosong. `db-no-primary` memakai `or vector(0)`; rule baru harus mengikuti pola yang sama atau mengatur `noDataState: OK`. |
| Alert firing tapi tidak ada notifikasi | Memang belum ada contact point; lihat bagian "Menambah notifikasi keluar". |
| `db-grant-users` gagal "Access denied" | `MARIADB_ROOT_PASSWORD` di `.env` berbeda dengan password volume lama. Pakai password yang benar, atau `make db-reset` (menghapus data). |

## Verifikasi cepat

```bash
# tiga exporter hidup dan login (jalankan dari container yang punya wget)
docker exec lb-k6-prometheus-1 wget -qO- http://mysqld-exporter-primary:9104/metrics | Select-String '^mysql_up'
docker exec lb-k6-prometheus-1 wget -qO- http://mysqld-exporter-replica-1:9104/metrics | Select-String '^mysql_up'

# peran dan lag per node, dari sisi Prometheus
curl.exe -s -u admin:admin "http://127.0.0.1:3000/api/datasources/proxy/uid/prometheus/api/v1/query?query=mysql_global_variables_read_only%7Bjob%3D%22mariadb%22%7D"
curl.exe -s -u admin:admin "http://127.0.0.1:3000/api/datasources/proxy/uid/prometheus/api/v1/query?query=mysql_slave_status_seconds_behind_master%7Bjob%3D%22mariadb%22%7D"

# target Prometheus: harus ada 3 seri dengan label node berbeda
curl.exe -s -u admin:admin "http://127.0.0.1:3000/api/datasources/proxy/uid/prometheus/api/v1/query?query=up%7Bjob%3D%22mariadb%22%7D"

# dashboard + 8 alert rule database terprovisi
curl.exe -s -u admin:admin "http://127.0.0.1:3000/api/dashboards/uid/db-monitoring"
curl.exe -s -u admin:admin "http://127.0.0.1:3000/api/v1/provisioning/alert-rules"

# log terakhir dari cluster database (termasuk MaxScale)
curl.exe -s -u admin:admin "http://127.0.0.1:3000/api/datasources/proxy/uid/loki/loki/api/v1/query_range?query=%7Bproject%3D%22lb-db%22%7D&limit=3"
```

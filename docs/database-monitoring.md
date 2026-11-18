# Monitoring database MariaDB

Panduan memantau MariaDB: status hidup/mati, metrik server, query CRUD dari backend,
dan **log error** MariaDB + backend. Semua alat tinggal di stack monitoring `lb-k6`,
bukan di stack database `lb-db`.

## Kenapa dipisah dari `lb-db`

`lb-db` sengaja hanya berisi data (MariaDB + Adminer). Yang membaca data tinggal di
`lb-k6`:

- MariaDB tetap tanpa port host dan tanpa rute Traefik.
- `make db-down` tidak ikut mematikan dashboard atau alat pantau.
- `make k6-down` tidak menyentuh database.
- Satu-satunya jembatan adalah `mysqld-exporter`, yang menempel di `lb-net` untuk
  menjangkau `mariadb:3306` dan di `lb-k6-net` supaya bisa di-scrape Prometheus.

## Komponen

| Komponen | Project | Alamat internal | Peran |
|---|---|---|---|
| `mysqld-exporter` | `lb-k6` | `mysqld-exporter:9104` | Membaca status MariaDB lewat user `lb_exporter` |
| Prometheus | `lb-k6` | `prometheus:9090` | Scrape target statis `mariadb` + backend, retensi 7 hari |
| Loki | `lb-k6` | `loki:3100` | Menyimpan log container, retensi 7 hari |
| Alloy | `lb-k6` | `alloy:12345` | Mengirim log container berlabel `lb.logs=true` ke Loki |
| Grafana | `lb-k6` | `grafana:3000` | Dashboard `db-monitoring` + 4 alert rule |

Jalankan semuanya:

```bash
make db-up        # MariaDB + Adminer, lalu menyegarkan user lb_exporter
make k6-up        # Grafana, Prometheus, exporter, Loki, Alloy, ...
```

`db-up` dan `db-reset` otomatis memanggil `scripts/db-grant-exporter.js`. Kalau user
exporter perlu disegarkan tanpa menyalakan ulang DB:

```bash
make db-grant-exporter
```

## User exporter

`lb_app` hanya punya hak pada database `lb_demo`, sehingga tidak bisa membaca
`SHOW GLOBAL STATUS` sepenuhnya. Karena itu ada user khusus:

| Hal | Nilai |
|---|---|
| User | `lb_exporter` (host `%`) |
| Password | `MARIADB_EXPORTER_PASSWORD`, default `lb_exporter_password` |
| Hak | `PROCESS`, `REPLICATION CLIENT` pada `*.*` |

Dibuat idempotent oleh `scripts/db-grant-exporter.js` (bukan lewat `db/init`), supaya
volume `lb-db-data` yang sudah ada ikut mendapatkannya tanpa `db-reset` — `db-reset`
menghapus data katalog.

Ekspor password ke exporter lewat env compose:

```yaml
mysqld-exporter:
  environment:
    MYSQLD_EXPORTER_PASSWORD: ${MARIADB_EXPORTER_PASSWORD:-lb_exporter_password}
```

Kalau password diganti di `.env`, jalankan `make db-grant-exporter`, lalu
`docker compose -p lb-k6 -f docker-compose.monitoring.yml up -d mysqld-exporter`.

## Metrik

### Dari MariaDB (lewat exporter)

Contoh yang dipakai dashboard dan alert:

| Metrik | Arti |
|---|---|
| `mysql_up` | 1 = exporter berhasil login ke MariaDB |
| `mysql_global_status_threads_connected` | koneksi terbuka saat ini |
| `mysql_global_status_threads_running` | koneksi yang sedang menjalankan query |
| `mysql_global_variables_max_connections` | batas `max_connections` |
| `mysql_global_status_queries` | counter total query |
| `mysql_global_status_slow_queries` | counter slow query (status server, bukan log) |
| `mysql_global_status_aborted_connects` / `aborted_clients` | koneksi gagal / terputus |
| `mysql_global_status_innodb_buffer_pool_reads` / `_read_requests` | dipakai untuk hit ratio |

`up{job="mariadb"}` adalah metrik Prometheus, bukan eksporter: 0 berarti exporter tidak
bisa di-scrape **atau** tidak bisa login ke MariaDB. Dua-duanya patut diberi alert.

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
`Database`). Dashboard ini juga muncul di daftar dashboard Grafana.

| Panel | Isi |
|---|---|
| Status MariaDB | `up{job="mariadb"}` dengan mapping UP/DOWN |
| Error DB dari backend / menit | `sum(rate(lb_db_errors_total{code!="ER_DUP_ENTRY"}[2m])) * 60` |
| Koneksi aktif | `mysql_global_status_threads_connected` |
| Slow query (5 menit) | `increase(mysql_global_status_slow_queries[5m])` |
| Query MariaDB / detik | `rate(mysql_global_status_queries[1m])` |
| Koneksi MariaDB | connected, running, max_connections |
| Slow query / detik | `rate(mysql_global_status_slow_queries[5m])` |
| InnoDB buffer pool hit ratio | 1 − reads / read_requests |
| Koneksi gagal / terputus | rate `aborted_connects` dan `aborted_clients` |
| Latensi query CRUD | p95 + rata-rata dari histogram backend |
| Query CRUD per operasi & error per kode | rate `lb_db_queries_total` dan `lb_db_errors_total` |
| Log error MariaDB + backend | panel log dari Loki |
| Alert database | panel `alertlist` (firing/pending/no data) |

Warna panel status memakai threshold: hijau = normal, merah = bermasalah. Dashboard
di-provision dari `monitoring/grafana/dashboards/db/database.json`
(`allowUiUpdates: false`), jadi edit permanen dilakukan di file itu.

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
| `service` | nama service compose | `{service="mariadb"}` |
| `container` | nama container | `{container="lb-demo-server-1-1"}` |

Label `lb.logs=true` ada di:

- `docker-compose.db.yml` → service `mariadb`
- `docker-compose.yml` → `x-main-labels`, jadi ikut semua backend

Adminer, Traefik, dan container monitoring sengaja tidak dilabeli supaya Loki tidak
penuh log yang tidak diminta.

Contoh query di Grafana Explore (datasource `loki`):

```logql
# semua error/warning MariaDB dan backend
{project=~"lb-db|lb-demo"} |~ "(?i)error|warning|fatal|denied|tidak tersedia"

# hanya MariaDB
{service="mariadb"}

# log peringatan CRUD dari backend
{project="lb-demo"} |= "CRUD ditolak"

# gagal connect ke database
{project="lb-demo"} |= "database tidak tersedia"
```

MariaDB menulis log ke stdout container (`docker logs lb-db-mariadb-1`), karena itu
Alloy membaca lewat Docker API, bukan file `/var/lib/docker/containers` — Docker
Desktop di Windows tidak membagikan path host itu ke container.

Retensi Loki 168 jam (7 hari), sama dengan Prometheus. Log lama dibuang oleh compactor.

## Alert

Alert dikelola Grafana (`monitoring/grafana/provisioning/alerting/rules.yml`), bukan
Prometheus/Alertmanager, supaya tidak menambah container dan statusnya langsung terlihat
di menu **Alerting** serta panel **Alert database**.

| UID | Nama | Kondisi | For | Severity |
|---|---|---|---|---|
| `mariadb-down` | MariaDB tidak terjangkau | `up{job="mariadb"} < 1` | 30s | critical |
| `mariadb-connections-high` | Koneksi MariaDB hampir penuh | `threads_connected / max_connections > 0.8` | 2m | warning |
| `mariadb-slow-queries` | Slow query menumpuk | `increase(slow_queries[5m]) > 5` | 1m | warning |
| `api-db-errors` | Backend gagal mengakses database | `sum(rate(lb_db_errors_total{code!="ER_DUP_ENTRY"}[2m])) > 0` | 1m | warning |

Catatan:

- `mariadb-down` memakai `noDataState: Alerting`: kalau exporter hilang sama sekali,
  alert tetap menyala.
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

Hasil terukur pada mesin ini (Windows + Docker Desktop):

```bash
# 1. matikan database
docker compose -p lb-db -f docker-compose.db.yml stop mariadb

# 2. CRUD harus 503, demo tetap 200
curl.exe -s -o NUL -w "%{http_code}`n" http://server-1.localhost/api/servers   # 503
curl.exe -s -o NUL -w "%{http_code}`n" http://server-1.localhost/              # 200

# 3. Prometheus melihat target mati (tunggu ~10 detik)
#    query: up{job="mariadb"}   -> 0
# 4. alert mariadb-down -> firing setelah ~90 detik (evaluasi 1 menit + for 30 detik)

# 5. hidupkan lagi
docker compose -p lb-db -f docker-compose.db.yml start mariadb
make db-grant-exporter
#    mysql_up -> 1, CRUD -> 200, alert kembali normal
```

Angka yang terukur:

| Peristiwa | Hasil |
|---|---|
| MariaDB dimatikan | `up{job="mariadb"}` = **0** dalam satu siklus scrape |
| CRUD saat DB mati | **503** `DATABASE_UNAVAILABLE`; `lb_db_errors_total{code="ETIMEDOUT"}` naik |
| Endpoint demo saat DB mati | tetap **200**; `/health` tetap **200** |
| Alert `mariadb-down` | **firing** setelah ±90 detik, `health: ok` |
| MariaDB dihidupkan + grant | `mysql_up` = **1**, CRUD **200** |
| Log error | baris `CRUD ditolak` / `database tidak tersedia` muncul di Loki < 10 detik |

## Batasan

- Satu target exporter untuk satu MariaDB; tidak ada replika atau failover DB.
- `performance_schema` dimatikan di MariaDB demo, jadi metrik per-query tidak tersedia.
- Alert hanya terlihat di Grafana; belum ada notifikasi keluar.
- Grafana, Loki, dan Prometheus tanpa autentikasi tambahan. Hanya untuk lokal.
- Grafana hanya membaca ulang **provisioning datasource/dashboard/alert** saat start.
  Setelah menambah file provisioning baru: `docker compose -p lb-k6 -f
  docker-compose.monitoring.yml restart grafana`.
- Prometheus tidak memuat ulang `prometheus.yml` otomatis (tanpa
  `--web.enable-lifecycle`); setelah mengubah config: `docker restart lb-k6-prometheus-1`.
- Metrik backend hilang saat container dibuat ulang; Prometheus menandainya sebagai
  reset. Angka total tidak bisa dijumlahkan lintas restart.
- Dashboard hanya menyimpan data 7 hari (Prometheus) dan 7 hari (Loki).

## Troubleshooting

| Gejala | Penyebab & solusi |
|---|---|
| `up{job="mariadb"}` = 0, `mysql_up` tidak ada | Exporter gagal login. Cek `docker logs lb-k6-mysqld-exporter-1`; jalankan `make db-grant-exporter`; pastikan `MARIADB_EXPORTER_PASSWORD` sama di DB dan compose. |
| `mysql_up` = 0 tetapi exporter hidup | User ada tapi hak kurang. Cek `SHOW GRANTS FOR 'lb_exporter'@'%'` lewat Adminer/root; harus ada `PROCESS` dan `REPLICATION CLIENT`. |
| Dashboard kosong setelah `k6-up` | Grafana belum membaca provisioning baru: `docker compose -p lb-k6 -f docker-compose.monitoring.yml restart grafana`. |
| Target `mariadb` tidak ada di Prometheus | `prometheus.yml` belum dimuat: `docker restart lb-k6-prometheus-1`. Cek `/api/v1/targets` lewat Grafana. |
| Panel log kosong | Container tidak punya label `lb.logs=true` (cek `docker inspect`), atau Alloy/Loki mati. `docker logs lb-k6-alloy-1` dan `docker logs lb-k6-loki-1`. |
| Log MariaDB lama tidak muncul | Retensi 7 hari; Loki hanya menyimpan sejak Alloy pertama jalan. Log sebelum itu tetap ada di `docker logs`. |
| Alloy log `could not inspect container info ... No such container` | Normal sesaat setelah container di-recreate (`make test`, `docker-up`): Alloy sempat menail container lama. Log container baru tetap masuk; pesan hilang sendiri. |
| Alert NoData terus menyala | Query alert mengembalikan deret kosong. Untuk `api-db-errors` sudah ditambahkan `or vector(0)`; rule baru harus mengikuti pola yang sama atau mengatur `noDataState: OK`. |
| Alert firing tapi tidak ada notifikasi | Memang belum ada contact point; lihat bagian "Menambah notifikasi keluar". |
| `db-grant-exporter` gagal "Access denied" | `MARIADB_ROOT_PASSWORD` di `.env` berbeda dengan password volume lama. Pakai password yang benar, atau `make db-reset` (menghapus data). |

## Verifikasi cepat

```bash
# exporter hidup dan login
docker exec lb-k6-prometheus-1 wget -qO- http://mysqld-exporter:9104/metrics | Select-String '^mysql_up'

# target Prometheus
curl.exe -s -u admin:admin "http://127.0.0.1:3000/api/datasources/proxy/uid/prometheus/api/v1/query?query=up%7Bjob%3D%22mariadb%22%7D"

# dashboard + alert terprovisi
curl.exe -s -u admin:admin "http://127.0.0.1:3000/api/dashboards/uid/db-monitoring"
curl.exe -s -u admin:admin "http://127.0.0.1:3000/api/v1/provisioning/alert-rules"

# log terakhir dari MariaDB
curl.exe -s -u admin:admin "http://127.0.0.1:3000/api/datasources/proxy/uid/loki/loki/api/v1/query_range?query=%7Bproject%3D%22lb-db%22%7D&limit=3"
```

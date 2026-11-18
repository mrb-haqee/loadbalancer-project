# 0010 — Monitoring database: exporter, dashboard, alert, dan log terpusat

- **Status:** Diterima
- **Tanggal:** 17 November 2026

## Konteks

Setelah MariaDB menjadi bagian tetap project (ADR 0009), muncul kebutuhan: kalau database
bermasalah, pemilik project harus bisa melihat **apa** yang salah dan **di mana** error-nya,
tanpa menebak dari 503 di UI CRUD.

Yang tersedia saat itu: `docker logs lb-db-mariadb-1`, Adminer, dan dashboard trafik
`lb-realtime` (Prometheus). Tidak ada metrik isi MariaDB, tidak ada riwayat log, dan tidak
ada peringatan otomatis. Membaca log satu per satu lewat CLI juga tidak nyaman saat ada
lima backend + satu database.

Batasan yang harus dijaga:

- Stack database `lb-db` tetap **hanya data**; alat pantau tidak boleh membuatnya
  bergantung pada stack monitoring.
- MariaDB tetap tanpa port host dan tanpa rute Traefik.
- Katalog server tetap bukan pengatur rotasi; data monitoring tidak boleh memengaruhi
  Traefik.
- Demo, `npm test`, CRUD, dan Adminer tidak boleh rusak, dan volume DB lama tidak boleh
  perlu `db:reset` hanya untuk mengaktifkan monitoring.
- Docker Desktop di Windows: file log host `/var/lib/docker/containers` tidak tersedia di
  dalam container.

## Pilihan yang dipertimbangkan

1. **Exporter + Prometheus + dashboard Grafana + alert Grafana + Loki/Alloy, semua di
   `lb-k6`; metrik DB aplikasi ditambahkan ke `/metrics` backend.**
2. Hanya dashboard Grafana di atas metrik yang sudah ada (`lb_backend_*`). Murah, tetapi
   tidak memperlihatkan koneksi, slow query, buffer pool, atau penyebab error.
3. Exporter + Prometheus + Alertmanager terpisah. Lebih lengkap untuk produksi, tetapi
   menambah satu container dan jalur notifikasi yang belum dibutuhkan demo.
4. Membaca file log host langsung (Promtail/Alloy dengan mount
   `/var/lib/docker/containers`). Tidak jalan di Docker Desktop Windows tanpa akses ke
   VM Docker.
5. Menaruh exporter di stack `lb-db`. Paling dekat ke database, tetapi membuat stack data
   memuat proses monitoring dan menggoda orang mengekspos port-nya.

## Keputusan

Memilih **(1)**:

- **`mysqld-exporter` di `lb-k6`**, menempel di `lb-net` (menjangkau `mariadb:3306`) dan
  `lb-k6-net` (di-scrape Prometheus). Target ditulis statis di `prometheus.yml`
  (`mysqld-exporter:9104`, job `mariadb`) karena alamatnya tetap; backend tetap memakai
  `docker_sd` seperti sebelumnya.
- **User khusus `lb_exporter`** dengan `PROCESS` + `REPLICATION CLIENT`, dibuat oleh
  `scripts/db-grant-exporter.js` yang dipanggil `db:up`/`db:reset`. Bukan lewat
  `db/init`, supaya volume lama ikut dan `db:reset` tidak diperlukan.
- **Metrik tingkat aplikasi** `lb_db_*` ditambahkan ke `/metrics` backend, karena saat DB
  mati exporter juga ikut buta. Ini juga memberi latensi CRUD dan kode error driver.
- **Alert dikelola Grafana** (provisioning YAML), tanpa Alertmanager. Status firing cukup
  dilihat di Grafana; contact point bisa ditambahkan nanti tanpa mengubah arsitektur.
- **Loki + Alloy** untuk log. Alloy membaca Docker API lewat socket read-only dan hanya
  mengambil container berlabel `lb.logs=true` (MariaDB + backend). Loki tanpa auth dan
  tanpa port host; retensi 7 hari.
- **Dashboard `db-monitoring`** (uid sama) berisi 13 panel: status, koneksi, query,
  slow query, buffer pool, latensi CRUD, error per kode, log, dan alert list.

## Konsekuensi

**Positif**

- Gangguan database terlihat dari tiga sudut: Prometheus (`up`, `mysql_up`), aplikasi
  (`lb_db_errors_total`, histogram), dan log (Loki).
- `lb-db` tetap data-only; `db:down` tidak mematikan alat pantau dan sebaliknya.
- Volume lama tidak perlu dihapus; cukup `db:grant-exporter`.
- Semua perubahan aditif: label `lb.logs` dan metrik baru tidak mengubah rotasi, API,
  atau skema katalog.
- Uji gangguan membuktikan jalur lengkap: 503 di CRUD, demo tetap 200, alert firing,
  log masuk Loki, dan pulih tanpa restart backend.

**Negatif / biaya**

- Tiga container baru (`mysqld-exporter`, `loki`, `alloy`) dan dua volume
  (`loki-data`, `alloy-data`).
- Alloy berjalan sebagai root hanya untuk membaca `docker.sock`; socket read-only.
- Grafana dan Prometheus hanya membaca ulang sebagian konfigurasi saat start, sehingga
  perubahan provisioning/config kadang butuh `restart` container.
- Metrik backend disimpan di memori; angka hilang saat container dibuat ulang.
- Alert tanpa notifikasi keluar: harus dibuka di Grafana. Slow query log MariaDB belum
  diaktifkan, jadi `slow_queries` adalah status server, bukan daftar query.
- Loki menyimpan **semua** baris log container terpilih (bukan hanya error), dengan
  retensi 7 hari. Volume bisa tumbuh; `down -v` menghapusnya.

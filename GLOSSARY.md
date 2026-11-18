# Glossary

Istilah yang dipakai di project ini beserta makna yang disepakati.

**Load Balancer (LB)** — Pintu masuk tunggal yang membagi request klien ke beberapa Backend. Klien tidak pernah memilih Backend sendiri.

**Backend** — Satu instance aplikasi yang melayani request. Di project ini ada lima Backend, masing-masing satu container dengan identitas sendiri (`server-1` … `server-5`).

**Server (dalam konteks project ini)** — Sinonim Backend. Bukan mesin fisik terpisah.

**Sehat (healthy)** — Status Backend yang boleh menerima request. Hanya Backend sehat yang masuk rotasi.

**Mati (unhealthy)** — Status Backend yang dikeluarkan dari rotasi karena tidak lolos Health Check Aktif atau gagal saat meneruskan request.

**Health Check Aktif** — Pemeriksaan berkala yang dilakukan LB sendiri ke tiap Backend, tanpa menunggu ada request klien.

**Asumsi optimistis saat start** — Semua Backend dianggap sehat sampai pemeriksaan pertama membuktikan sebaliknya, supaya layanan langsung bisa dipakai begitu dinyalakan.

**Rotasi** — Kumpulan Backend sehat yang sedang layak menerima request. Backend yang mati keluar dari rotasi; yang pulih kembali masuk.

**Round Robin** — Algoritma yang memberi request bergiliran ke tiap Backend sehat secara berurutan.

**Failover Pasif** — Perpindahan yang dipicu oleh kegagalan nyata pada saat meneruskan request: request yang gagal dicoba ulang ke Backend lain.

**Failover Aktif** — Perpindahan yang dipicu oleh hasil Health Check Aktif, sebelum ada request klien yang terkena dampak.

**Request terlayani** — Request yang berhasil diteruskan ke salah satu Backend.

**Request ditolak** — Request yang tidak bisa diteruskan karena tidak ada Backend sehat yang tersedia. Klien menerima status 503.

**Pulih (recovery)** — Kembalinya sebuah Backend mati ke status sehat sehingga masuk rotasi lagi, tanpa perlu me-restart Load Balancer.

## Istilah Traefik & Docker

**Provider Docker** — Sumber konfigurasi Traefik yang membaca label container dan otomatis memperbarui rotasi saat container muncul, sehat, atau hilang.

**Router** — Aturan di Traefik yang memutuskan sebuah request masuk ke Service mana (mis. `PathPrefix(/)`).

**Host Matcher** — Bagian aturan Router yang mencocokkan nama host, mis. `Host(`server-2.localhost`). Dipakai untuk memberi tiap Server URL-nya sendiri.

**Router Langsung (direct-N)** — Router berprioritas tinggi yang dipatok ke satu Server saja. Memakai URL ini berarti **melewati** pembagian beban, dan sengaja tanpa Middleware Retry supaya Server yang mati terlihat gagal, bukan dialihkan diam-diam.

**Ambiguous Router** — Router yang tidak bisa ditautkan otomatis karena container pemiliknya mendefinisikan lebih dari satu Service. Traefik membuang router seperti itu (gejalanya 404); obatnya label `routers.<nama>.service`.

**Batas Waktu Backend (responseHeaderTimeout)** — Lama maksimum Traefik menunggu header respons dari sebuah Server. Tanpa batas ini, request ke Server yang baru mati bisa menggantung tanpa akhir.

**Service** — Kumpulan Server yang melayani jenis request yang sama di Traefik; request dibagi ke seluruh Server-nya.

**Server (dalam Traefik)** — Satu container Backend yang terdaftar sebagai tujuan di dalam Service.

**Status UP/DOWN** — Hasil health check Traefik terhadap sebuah Server; Server `DOWN` tidak lagi menerima request.

**Middleware Retry** — Komponen Traefik yang mengulang request ke Server lain bila Server tujuan tidak menjawab; inilah bentuk Failover Pasif di project ini.

**WRR (Weighted Round Robin)** — Algoritma default Traefik: round robin dengan bobot; pada project ini semua Server berbobot sama sehingga hasilnya bergiliran.

**Project Compose** — Satu kesatuan container yang dikelola perintah `docker compose -p <nama>`. Project ini memakai empat: `lb-traefik`, `lb-demo`, `lb-db`, `lb-k6`; masing-masing bisa dinyalakan/dimatikan sendiri.

**Network Bersama** — Network Docker yang dibuat di luar project-project compose dan dipakai sebagai *external*, sehingga container dari project berbeda bisa saling menjangkau tanpa satu project menjadi milik project lain.

**Prioritas Router** — Angka penentu router mana yang dipakai bila beberapa router cocok dengan satu request; angka lebih besar menang, sehingga router spesifik mengalahkan router fallback.

## Istilah pengujian beban

**Virtual User (VU)** — Simulasi satu pengguna yang menjalankan iterasi skrip k6 secara bersamaan dengan VU lain.

**Constant Arrival Rate** — Model beban k6 yang menjaga jumlah request masuk per detik tetap konstan, berapa pun VU yang dibutuhkan.

**Threshold** — Batas kelulusan yang ditetapkan pada skrip k6 (mis. tingkat gagal < 1%); bila dilanggar, k6 keluar dengan status gagal.

**Tag `run`** — Label berisi timestamp yang ditempel ke semua metrik satu eksekusi k6, supaya hasil beberapa run bisa dipisah dan dibandingkan di dashboard.

## Istilah pemantauan

**Metrik** — Angka hasil pengukuran, mis. `http_reqs` dari k6 atau `lb_backend_requests_total` dari backend; disimpan sebagai deret waktu lalu dibaca dashboard.

**Output Metrik** — Tujuan pengiriman metrik k6; di project ini `influxdb=http://influxdb:8086/k6` (statusnya deprecated di k6 v2.4.0, diganti OpenTelemetry di k6 v3).

**Deret Waktu (time series)** — Kumpulan nilai yang diberi timestamp, sehingga bisa digambar sebagai grafik dari waktu ke waktu.

**InfluxDB** — Database deret waktu tempat metrik k6 disimpan; di project ini versi 1.8, database `k6`, tidak dipublikasikan ke host.

**Prometheus** — Database deret waktu berbasis *pull*: ia sendiri yang menembak endpoint `/metrics` secara berkala; di project ini menyimpan trafik nyata Traefik + semua backend, retensi 7 hari, tanpa port publik.

**Metrics Endpoint** — URL yang mengembalikan metrik dalam format teks Prometheus (`# HELP`, `# TYPE`, `nama{label} nilai`); di project ini `http://server-N:3000/metrics` (internal `lb-net`) dan `http://traefik:8080/metrics`.

**Scrape** — Aksi Prometheus mengambil `/metrics` dari satu target secara berkala; di project ini tiap 2 detik (`scrape_interval: 2s`).

**Target** — Satu alamat yang di-scrape Prometheus; di project ini 1 target Traefik, satu target per backend (ditemukan otomatis, bukan didaftar manual), dan 1 target statis `mysqld-exporter` untuk MariaDB, terlihat dari metrik `up` (1 = hidup, 0 = mati).

**Service Discovery (`docker_sd`)** — Cara Prometheus menemukan target sendiri dengan menanyakan Docker API, bukan dari daftar di `prometheus.yml`; dipakai untuk backend di project ini lewat socket read-only.

**Label Monitoring (`lb.monitor=true`)** — Label Docker pada container backend yang menandakan "ikut dipantau Prometheus"; tanpa label ini container tidak akan ditemukan walaupun ada di network yang sama.

**Tag Metrik** — Pasangan key/value yang menempel pada satu sampel metrik (di project ini `server` pada metric `served` milik k6), sehingga satu metric bisa dipecah per server dengan `GROUP BY` tanpa membuat metric baru tiap server.

**Counter** — Metrik yang hanya bisa naik (mis. `lb_backend_requests_total`); yang dibaca dashboard bukan nilainya, tapi laju kenaikannya (`rate(...)`).

**Histogram** — Metrik yang mengelompokkan pengamatan ke bucket nilai (mis. `lb_backend_request_duration_seconds_bucket`), dipakai untuk menghitung kuantil tanpa menyimpan tiap sampel.

**Kuantil (p95)** — Nilai yang memisahkan 95% pengamatan tercepat dari 5% terlambat; di project ini dihitung dengan `histogram_quantile(0.95, ...)`.

**Dashboard Realtime** — Dashboard yang angkanya berasal dari trafik nyata (bukan hasil test), jadi tetap bergerak walau k6 tidak jalan; di project ini `lb-realtime` dengan refresh 5 detik.

**Trigger** — Aksi memulai satu Run dari luar (di project ini: klik link di dashboard Grafana yang memanggil `http://trigger.localhost/cgi-bin/trigger`). Trigger bukan Run; satu Trigger menghasilkan satu Run.

**Runner** — Service kecil pemegang binary k6 yang menerima Trigger dan menjalankan Run; di project ini container `k6-runner`. Runner sengaja tidak punya akses ke Docker socket dan hanya melayani satu Run pada satu waktu (single-flight).

**Grafana** — Aplikasi dashboard yang membaca InfluxDB dan Prometheus lalu menggambar panel; di project ini port 3000 dan `http://grafana.localhost`.

**Label Log (`lb.logs=true`)** — Label Docker pada container yang log-nya dikirim Alloy ke Loki; di project ini MariaDB dan semua backend. Container tanpa label ini tidak dikirim.

**Dashboard Terprovisi (provisioned dashboard)** — Dashboard yang dibaca Grafana dari file saat start, bukan dibuat manual lewat UI; perubahan lewat UI tidak disimpan karena `allowUiUpdates: false`. Tiga folder: `monitoring/grafana/dashboards/k6/k6.json`, `.../lb/lb-realtime.json`, dan `.../db/database.json`.

**Datasource** — Koneksi Grafana ke sumber data; di project ini tiga: `k6-influxdb` (uid `k6-influxdb`, default), `prometheus` (uid `prometheus`), dan `loki` (uid `loki`).

**Web Dashboard k6** — Dashboard bawaan binary k6 yang tampil real-time selama test di port 5665 dan bisa diekspor jadi `report.html`; datanya hilang setelah test selesai, berbeda dari Grafana.

**Network Eksternal (external network)** — Network yang sudah ada dan dibuat project lain; `lb-net` dipakai stack monitoring sebagai external supaya k6 bisa menembak Traefik tanpa menggabungkan kedua project.

## Istilah database & CRUD

**Server Terdaftar** — Satu baris katalog di MariaDB: nama, host, port, bobot, status aktif, dan catatan. Berbeda dari **Server (Backend)**, yang berarti container yang benar-benar melayani request. Menambah atau menghapus Server Terdaftar tidak mengubah rotasi Traefik.

**Katalog Server** — Kumpulan Server Terdaftar yang ditampilkan dan diubah lewat UI `/ui` atau API `/api/servers`. Isinya data demo untuk memperlihatkan CRUD, bukan konfigurasi yang dibaca Traefik, Prometheus, atau k6.

**CRUD** — Empat operasi dasar terhadap katalog: membuat, membaca, mengganti, dan menghapus satu Server Terdaftar.

**Database Compose (`lb-db`)** — Project compose terpisah berisi MariaDB dan Adminer. MariaDB tidak dipublikasikan lewat Traefik (hanya dijangkau backend lewat `lb-net`); satu-satunya rute Traefik di stack ini adalah `adminer.localhost` untuk Adminer.

**Pembaca Database (Adminer)** — Halaman web untuk membuka tabel dan isi MariaDB tanpa menulis query. Punya dua pintu: `adminer.localhost` lewat Traefik (router prioritas 200) dan `127.0.0.1:8081` sebagai cadangan loopback. Tanpa auth tambahan; hanya untuk lokal.

**SQL Init** — Skrip SQL yang dijalankan MariaDB sekali saat volume database masih kosong. Perubahan pada skrip itu tidak berlaku pada volume yang sudah berisi data; karena itu ada `db-reset`.

**Pool Koneksi** — Kumpulan koneksi database yang dipakai ulang backend, bukan satu koneksi baru per request. Pool dibuat malas: backend tetap start dan tetap sehat walau MariaDB belum hidup.

**Database Tidak Tersedia (503)** — Keadaan saat endpoint CRUD tidak bisa menjangkau MariaDB. Backend tetap sehat dan endpoint demo tetap bekerja; hanya operasi katalog yang gagal.

## Istilah monitoring database

**Exporter (`mysqld-exporter`)** — Service kecil yang login ke MariaDB lalu menerjemahkan `SHOW GLOBAL STATUS` dan `SHOW GLOBAL VARIABLES` menjadi metrik Prometheus (`mysql_*`). Di project ini hidup di `lb-k6`, tanpa port host.

**User Exporter (`lb_exporter`)** — User MariaDB khusus untuk exporter, dengan hak `PROCESS` dan `REPLICATION CLIENT`. Dibuat idempotent oleh `make db-grant-exporter`; bukan user aplikasi (`lb_app`) dan tidak dipakai backend.

**Metrik DB Aplikasi (`lb_db_*`)** — Metrik query database yang dihitung backend sendiri dan diekspor di `/metrics`: jumlah query per operasi, jumlah error per kode driver, dan histogram durasi. Tetap ada saat exporter ikut buta karena database mati.

**Metrik `mysql_up`** — 1 bila exporter berhasil login dan membaca status MariaDB, 0 bila gagal. Berbeda dari `up{job="mariadb"}` yang menunjukkan apakah Prometheus berhasil menembak exporter.

**Loki** — Penyimpanan log terpusat bergaya Prometheus: log diberi label, dibaca dengan LogQL, dan disimpan 7 hari. Di project ini tanpa auth dan tanpa port host.

**Alloy** — Agen pengumpul log Grafana. Di project ini membaca log container lewat Docker API (socket read-only) dan hanya mengirim container berlabel `lb.logs=true` ke Loki.

**LogQL** — Bahasa query Loki, mis. `{project="lb-db"} |= "error"`. Mirip PromQL, tetapi untuk baris log.

**Alert Rule** — Aturan di Grafana yang mengevaluasi query Prometheus secara berkala dan berpindah keadaan `inactive → pending → firing`. Empat rule database ada di `monitoring/grafana/provisioning/alerting/rules.yml`.

**Contact Point** — Tujuan notifikasi alert (email, Telegram, webhook). Di project ini belum ada, jadi alert hanya terlihat di Grafana; menambahkannya tidak mengubah arsitektur.

**Retensi** — Lama data disimpan sebelum dibuang: 7 hari untuk Prometheus dan Loki di project ini.

## Istilah operasional

**Makefile** — Satu-satunya sumber perintah operasional project (stack, database, Traefik, backend, monitoring, test, k6). Menggantikan blok `"scripts"` di `package.json`; `make` tanpa argumen menampilkan daftar target. Keputusan dan konsekuensinya ada di [`docs/adr/0011-perintah-pindah-ke-makefile.md`](docs/adr/0011-perintah-pindah-ke-makefile.md).

**Target** — Satu pekerjaan bernama di Makefile, mis. `make db-up`. Nama memakai hyphen, bukan titik dua, karena `:` adalah pemisah target:prerequisite di Make.

**Prasyarat (prerequisite)** — Target lain yang harus selesai lebih dulu; dipakai `stack-up` agar urutan `net-up → db-up → traefik-up → docker-up → k6-up` eksplisit dan berhenti saat satu langkah gagal.

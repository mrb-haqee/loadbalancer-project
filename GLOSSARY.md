# Glossary

Istilah yang dipakai di project ini beserta makna yang disepakati.

**Load Balancer (LB)** — Pintu masuk tunggal yang membagi request klien ke beberapa Backend. Klien tidak pernah memilih Backend sendiri.

**Backend** — Satu instance aplikasi yang melayani request. Di project ini ada tiga Backend, masing-masing satu container dengan identitas sendiri (`server-1`, `server-2`, `server-3`).

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

**Project Compose** — Satu kesatuan container yang dikelola perintah `docker compose -p <nama>`. Project ini memakai tiga: `lb-traefik`, `lb-demo`, `lb-k6`; masing-masing bisa dinyalakan/dimatikan sendiri.

**Network Bersama** — Network Docker yang dibuat di luar project-project compose dan dipakai sebagai *external*, sehingga container dari project berbeda bisa saling menjangkau tanpa satu project menjadi milik project lain.

**Prioritas Router** — Angka penentu router mana yang dipakai bila beberapa router cocok dengan satu request; angka lebih besar menang, sehingga router spesifik mengalahkan router fallback.

## Istilah pengujian beban

**Virtual User (VU)** — Simulasi satu pengguna yang menjalankan iterasi skrip k6 secara bersamaan dengan VU lain.

**Constant Arrival Rate** — Model beban k6 yang menjaga jumlah request masuk per detik tetap konstan, berapa pun VU yang dibutuhkan.

**Threshold** — Batas kelulusan yang ditetapkan pada skrip k6 (mis. tingkat gagal < 1%); bila dilanggar, k6 keluar dengan status gagal.

**Tag `run`** — Label berisi timestamp yang ditempel ke semua metrik satu eksekusi k6, supaya hasil beberapa run bisa dipisah dan dibandingkan di dashboard.

## Istilah pemantauan

**Metrik** — Angka hasil pengukuran k6 (mis. `http_reqs`, `http_req_duration`), dikirim ke penyimpanan deret waktu setelah test.

**Output Metrik** — Tujuan pengiriman metrik k6; di project ini `influxdb=http://influxdb:8086/k6` (statusnya deprecated di k6 v2.4.0, diganti OpenTelemetry di k6 v3).

**Deret Waktu (time series)** — Kumpulan nilai yang diberi timestamp, sehingga bisa digambar sebagai grafik dari waktu ke waktu.

**InfluxDB** — Database deret waktu tempat metrik k6 disimpan; di project ini versi 1.8, database `k6`, tidak dipublikasikan ke host.

**Grafana** — Aplikasi dashboard yang membaca InfluxDB dan menggambar panel; di project ini port 3000.

**Dashboard Terprovisi (provisioned dashboard)** — Dashboard yang dibaca Grafana dari file (`monitoring/grafana/dashboards/k6.json`) saat start, bukan dibuat manual lewat UI; perubahan lewat UI tidak disimpan karena `allowUiUpdates: false`.

**Datasource** — Koneksi Grafana ke sumber data; di project ini `k6-influxdb` dengan uid `k6-influxdb`.

**Web Dashboard k6** — Dashboard bawaan binary k6 yang tampil real-time selama test di port 5665 dan bisa diekspor jadi `report.html`; datanya hilang setelah test selesai, berbeda dari Grafana.

**Network Eksternal (external network)** — Network yang sudah ada dan dibuat project lain; `lb-net` dipakai stack monitoring sebagai external supaya k6 bisa menembak Traefik tanpa menggabungkan kedua project.

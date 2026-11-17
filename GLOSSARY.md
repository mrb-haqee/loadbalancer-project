# Glossary

Istilah yang dipakai di project ini beserta makna yang disepakati.

**Load Balancer (LB)** — Pintu masuk tunggal yang membagi request klien ke beberapa Backend. Klien tidak pernah memilih Backend sendiri.

**Backend** — Satu instance aplikasi yang melayani request. Di project ini ada tiga Backend, masing-masing satu proses Node.js dengan identitas sendiri (`server-1`, `server-2`, `server-3`).

**Server (dalam konteks project ini)** — Sinonim Backend. Bukan mesin fisik terpisah.

**Sehat (healthy)** — Status Backend yang boleh menerima request. Hanya Backend sehat yang masuk rotasi.

**Mati (unhealthy)** — Status Backend yang dikeluarkan dari rotasi karena tidak lolos Health Check Aktif atau gagal saat meneruskan request.

**Health Check Aktif** — Pemeriksaan berkala yang dilakukan LB sendiri ke tiap Backend, tanpa menunggu ada request klien.

**Asumsi optimistis saat start** — Semua Backend dianggap sehat sampai pemeriksaan pertama membuktikan sebaliknya, supaya layanan langsung bisa dipakai begitu dinyalakan.

**Rotasi** — Kumpulan Backend sehat yang sedang layak menerima request. Backend yang mati keluar dari rotasi; yang pulih kembali masuk.

**Round Robin** — Algoritma yang memberi request bergiliran ke tiap Backend sehat secara berurutan.

**Least Connections** — Algoritma yang memilih Backend dengan jumlah koneksi aktif paling sedikit.

**Koneksi aktif** — Request yang sudah dikirim ke sebuah Backend tetapi responsnya belum selesai dikirim balik ke klien.

**Tie-break round robin** — Aturan penentu ketika beberapa Backend punya jumlah koneksi aktif yang sama: pilihannya diputar bergiliran, bukan selalu yang pertama.

**Failover Pasif** — Perpindahan yang dipicu oleh kegagalan nyata pada saat meneruskan request: request yang gagal dicoba ulang ke Backend lain.

**Failover Aktif** — Perpindahan yang dipicu oleh hasil Health Check Aktif, sebelum ada request klien yang terkena dampak.

**Request terlayani** — Request yang berhasil diteruskan ke salah satu Backend.

**Request ditolak** — Request yang tidak bisa diteruskan karena tidak ada Backend sehat yang tersedia. Klien menerima status 503.

**Pulih (recovery)** — Kembalinya sebuah Backend mati ke status sehat sehingga masuk rotasi lagi, tanpa perlu me-restart Load Balancer.

## Istilah varian container

**Varian Node** — Load balancer yang ditulis sendiri di Node.js (`src/load-balancer`), status backend dan statistiknya dipegang kode sendiri.

**Varian Container** — Load balancer Traefik yang berjalan sebagai container, menemukan Backend lewat label Docker.

**Provider Docker** — Sumber konfigurasi Traefik yang membaca label container dan otomatis memperbarui rotasi saat container muncul, sehat, atau hilang.

**Router** — Aturan di Traefik yang memutuskan sebuah request masuk ke Service mana (mis. `PathPrefix(/)`).

**Host Matcher** — Bagian aturan Router yang mencocokkan nama host, mis. `Host(`server-2.localhost`). Dipakai untuk memberi tiap Server URL-nya sendiri.

**Router Langsung (direct-N)** — Router berprioritas tinggi yang dipatok ke satu Server saja. Memakai URL ini berarti **melewati** pembagian beban, dan sengaja tanpa Middleware Retry supaya Server yang mati terlihat gagal, bukan dialihkan diam-diam.

**Ambiguous Router** — Router yang tidak bisa ditautkan otomatis karena container pemiliknya mendefinisikan lebih dari satu Service. Traefik membuang router seperti itu (gejalanya 404); obatnya label `routers.<nama>.service`.

**Batas Waktu Backend (responseHeaderTimeout)** — Lama maksimum Traefik menunggu header respons dari sebuah Server. Tanpa batas ini, request ke Server yang baru mati bisa menggantung tanpa akhir.

**Service** — Kumpulan Server yang melayani jenis request yang sama di Traefik; request dibagi ke seluruh Server-nya.

**Server (dalam Traefik)** — Satu container Backend yang terdaftar sebagai tujuan di dalam Service.

**Status UP/DOWN** — Hasil health check Traefik terhadap sebuah Server; Server `DOWN` tidak lagi menerima request.

**Middleware Retry** — Komponen Traefik yang mengulang request ke Server lain bila Server tujuan tidak menjawab; inilah bentuk Failover Pasif pada varian container.

**WRR (Weighted Round Robin)** — Algoritma default Traefik: round robin dengan bobot; pada project ini semua Server berbobot sama sehingga hasilnya bergiliran.

## Istilah pengujian beban

**Virtual User (VU)** — Simulasi satu pengguna yang menjalankan iterasi skrip k6 secara bersamaan dengan VU lain.

**Constant Arrival Rate** — Model beban k6 yang menjaga jumlah request masuk per detik tetap konstan, berapa pun VU yang dibutuhkan.

**Threshold** — Batas kelulusan yang ditetapkan pada skrip k6 (mis. tingkat gagal < 1%); bila dilanggar, k6 keluar dengan status gagal.

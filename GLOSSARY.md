# Load Balancer & Observabilitas

Konteks latihan pembagian trafik HTTP lintas beberapa instance aplikasi dengan pemantauan metrik, log terpusat, pengujian beban, serta katalog administrasi terpisah.

## Pembagian Beban & Failover

**Load Balancer**:
Pintu masuk tunggal yang menerima request klien dan meneruskannya ke salah satu Backend di dalam Rotasi.
_Avoid_: Proxy, gateway

**Backend**:
Satu instance aplikasi mandiri yang memproses request dan mengembalikan identitas dirinya pada setiap respons.
_Avoid_: Mesin fisik, node, worker

**Rotasi**:
Himpunan Backend berstatus Sehat yang saat ini berhak menerima pembagian request dari Load Balancer.
_Avoid_: Cluster, grup aktif

**Sehat (Healthy)**:
Status Backend yang lolos Health Check Aktif sehingga masuk ke dalam Rotasi.
_Avoid_: Online, aktif

**Mati (Unhealthy)**:
Status Backend yang dikeluarkan dari Rotasi karena gagal lolos Health Check Aktif. Kegagalan sesaat ketika meneruskan satu request ditangani oleh Failover Pasif tanpa mengeluarkan Backend dari Rotasi.
_Avoid_: Crash, offline

**Pulih (Recovery)**:
Kembalinya Backend yang sebelumnya Mati ke dalam Rotasi secara otomatis setelah kembali lolos Health Check Aktif.

**Health Check Aktif**:
Pemeriksaan berkala oleh Load Balancer ke setiap Backend untuk menentukan kelayakan berada di dalam Rotasi tanpa menunggu trafik klien.

**Failover Aktif**:
Pengalihan trafik secara preventif dengan mengeluarkan Backend Mati dari Rotasi berdasarkan hasil Health Check Aktif sebelum request klien terdampak.

**Failover Pasif**:
Pengulangan otomatis satu request yang gagal ke Backend sehat lain di dalam Rotasi pada saat penerusan gagal atau melewati batas waktu.

**Router Langsung**:
Jalur akses khusus yang mematok request langsung ke satu Backend tertentu tanpa melewati pembagian beban maupun Failover Pasif, sehingga kegagalan Backend tersebut tampak apa adanya.
_Avoid_: Bypass URL, backdoor

**Request Terlayani**:
Request klien yang berhasil diteruskan dan dijawab oleh salah satu Backend.

**Request Ditolak**:
Request klien yang tidak dapat dilayani karena seluruh Backend keluar dari Rotasi sehingga tidak ada tujuan aktif yang tersisa pada Load Balancer.

## Katalog Server (CRUD)

**Katalog Server**:
Daftar administratif berisi data Server Terdaftar untuk mendemonstrasikan penyimpanan bersama lintas Backend, terpisah sepenuhnya dari konfigurasi Rotasi Load Balancer.
_Avoid_: Konfigurasi rotasi, daftar target

**Server Terdaftar**:
Satu entri data di dalam Katalog Server (nama, alamat, bobot, status, catatan). Menambah atau menghapus Server Terdaftar tidak mengubah Backend di dalam Rotasi.
_Avoid_: Backend, Server

## Pengujian Beban & Pemantauan

**Run**:
Satu eksekusi pengujian beban berdurasi terbatas yang diberi penanda unik agar hasilnya dapat dipisahkan dan dibandingkan antar pengujian.
_Avoid_: Sesi test, job

**Trigger**:
Tindakan eksplisit dari operator untuk memulai tepat satu Run pengujian beban melalui Runner.
_Avoid_: Run, webhook

**Runner**:
Layanan terisolasi yang menerima Trigger dan mengeksekusi paling banyak satu Run pada satu waktu (single-flight).

**Dashboard Realtime**:
Tampilan pemantauan yang menyajikan trafik nyata Load Balancer dan Backend secara berkelanjutan, terpisah dari metrik hasil Run pengujian beban.

**Exporter Database**:
Jembatan pemantauan yang membaca status internal database dan menyajikannya sebagai target pengambilan metrik tanpa membuka akses database ke jaringan luar. Di cluster, satu Exporter Database dipasang per node supaya kegagalan dapat diatribusikan ke node tertentu.
_Avoid_: Agent database, sidecar

## Cluster Database

**Primary**:
Node database yang menerima penulisan. Peran ini melekat pada node, bukan pada nama container: setelah failover, Primary bisa bernama `mariadb-replica-1`.
_Avoid_: Master, server utama

**Replika**:
Node database yang menyalin event dari Primary secara Asinkron dan menolak penulisan dari user aplikasi. Replika tidak melayani pembacaan klien.
_Avoid_: Slave, secondary, read replica (karena tidak melayani baca)

**Replikasi Asinkron**:
Penyalinan event dari Primary ke Replika yang tidak menunggu konfirmasi Replika sebelum transaksi dianggap selesai. Konsekuensinya RPO selalu lebih besar dari nol.
_Avoid_: Sinkronisasi, mirroring

**GTID**:
Identitas global untuk setiap transaksi (`domain-server-seq`) sehingga Replika dapat melanjutkan dari posisi yang benar tanpa bergantung pada nama file binlog.

**Lag**:
Selisih waktu antara event terakhir di Primary dan event terakhir yang sudah diterapkan Replika (`Seconds_Behind_Master`). Lag adalah batas atas data yang hilang bila Primary mati saat itu juga.
_Avoid_: Delay, keterlambatan

**RPO (Recovery Point Objective)**:
Jumlah penulisan yang sudah dijawab sukses ke aplikasi tetapi hilang saat failover. Diukur, bukan diasumsikan.

**Failover Database**:
Pemindahan peran Primary ke salah satu Replika secara otomatis ketika Primary tidak lagi menjawab, dilakukan oleh monitor MaxScale. Koneksi aplikasi ikut dialihkan karena aplikasi hanya mengenal satu alamat `maxscale:4006`.
_Avoid_: Switchover (itu perpindahan yang direncanakan)

**Rejoin**:
Pengembalian node yang sebelumnya mati ke cluster secara manual: datanya dibuang, lalu di-clone ulang dari Primary yang sah. Sengaja tidak otomatis supaya dua riwayat yang bercabang tidak digabung diam-diam.
_Avoid_: Recovery, repair

**Split Brain**:
Keadaan ketika lebih dari satu node menerima penulisan. Di topologi ini dicegah dengan memaksa `read_only=ON` pada semua node non-Primary, dan diperingatkan lewat alert `db-multiple-writable`.
_Avoid_: Dual master

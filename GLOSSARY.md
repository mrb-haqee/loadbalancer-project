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
Jembatan pemantauan yang membaca status internal database dan menyajikannya sebagai target pengambilan metrik tanpa membuka akses database ke jaringan luar.

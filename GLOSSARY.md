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

**Gerbang Database**:
Pintu masuk tunggal bagi aplikasi menuju cluster database yang meneruskan setiap koneksi ke Primary aktif dan mengalihkannya saat terjadi Failover Database.
_Avoid_: Proxy database, router database

**Primary**:
Satu-satunya node database di dalam cluster yang berhak menerima penulisan dan pembacaan dari aplikasi. Peran ini melekat pada node yang sedang menjabat, bukan pada nama awalnya.
_Avoid_: Master, server utama

**Replika**:
Node database yang menyalin perubahan dari Primary melalui Replikasi Asinkron dan menolak penulisan dari aplikasi. Replika hanya menjadi kandidat pengganti dan tidak melayani pembacaan klien.
_Avoid_: Slave, secondary, read replica

**Replikasi Asinkron**:
Penyalinan perubahan dari Primary ke Replika tanpa menunggu konfirmasi Replika sebelum transaksi dianggap selesai oleh aplikasi. Konsekuensinya perubahan terakhir dapat hilang bila Primary mati sebelum tersalin.
_Avoid_: Sinkronisasi, mirroring

**Lag**:
Selisih waktu antara perubahan terakhir di Primary dan perubahan terakhir yang sudah diterapkan oleh Replika, yang menjadi batas atas kehilangan data bila Primary mati saat itu juga.
_Avoid_: Delay, keterlambatan

**Failover Database**:
Pemindahan peran Primary ke Replika yang paling mutakhir secara otomatis ketika Primary berhenti menjawab, sehingga koneksi baru lewat Gerbang Database langsung dilayani Primary baru.
_Avoid_: Switchover

**Rejoin**:
Pengembalian node yang sebelumnya keluar dari cluster secara manual dengan membuang riwayat lokalnya dan menyalin ulang isi Primary yang sah. Sengaja tidak otomatis agar riwayat yang bercabang tidak digabung diam-diam.
_Avoid_: Recovery, repair

**Split Brain**:
Keadaan terlarang ketika lebih dari satu node di dalam cluster sama-sama menerima penulisan sehingga membentuk dua riwayat data yang saling bertentangan.
_Avoid_: Dual master

## Orkestrasi (Jalur Kubernetes)

**Orkestrasi**:
Pengelolaan otomatis siklus hidup banyak instance aplikasi — penjadwalan, penggantian, penambahan, dan pengurangan — berdasarkan keadaan yang diinginkan, bukan perintah manual per container.
_Avoid_: Automasi Docker, clusterisasi

**Cluster**:
Kumpulan Node yang dikelola satu control plane dan menerima manifest yang sama.
_Avoid_: Server, host

**Node**:
Mesin yang menjalankan Pod. Di jalur belajar ini satu Node adalah satu container Docker yang dibuat k3d, bukan mesin fisik terpisah.
_Avoid_: Server, VM

**Pod**:
Unit terkecil yang dijadwalkan Kubernetes: satu atau lebih container yang berbagi network dan lifecycle. Pada project ini satu Pod = satu Backend.
_Avoid_: Container, instance

**Deployment**:
Controller yang menjaga jumlah Pod sesuai `replicas` dan mengganti Pod yang mati atau saat rollout. Di sini satu Deployment berisi lima replika, menggantikan lima service Compose.
_Avoid_: Service, replica set

**Service**:
Nama DNS stabil dan pembagi trafik layer-4 ke sekumpulan Pod yang cocok dengan selector-nya, meskipun IP Pod terus berubah.
_Avoid_: Load balancer, ingress

**IngressRoute**:
Aturan routing HTTP milik Traefik (CRD) yang memetakan host/path ke Service, termasuk middleware dan transport.
_Avoid_: Ingress, router

**Readiness**:
Status apakah sebuah Pod siap menerima trafik. Pod yang gagal readiness dikeluarkan dari Service tanpa di-restart. Di sini readiness mengecek database lewat `/ready`.
_Avoid_: Health check, liveness

**Liveness**:
Status apakah proses di dalam Pod masih hidup. Kegagalan liveness menyebabkan Pod di-restart. Di sini liveness sengaja hanya memeriksa `/health`, bukan database.
_Avoid_: Readiness, health check

**HPA (Horizontal Pod Autoscaler)**:
Controller yang menambah atau mengurangi jumlah Pod berdasarkan metrik (di sini CPU) dibandingkan dengan request resource.
_Avoid_: Auto-scaling, scale-up

**Job**:
Workload yang berjalan sampai selesai lalu berhenti, berbeda dari Deployment yang terus menjaga Pod hidup. k6 dijalankan sebagai Job.
_Avoid_: CronJob, runner

**Kustomize**:
Alat perakitan manifest: satu `base` generik dengan `overlay` per lingkungan, tanpa templating.
_Avoid_: Helm, template

**k3d**:
Pembungkus yang menjalankan cluster k3s (Kubernetes ringan) di dalam container Docker, dipakai agar latihan orkestrasi tidak butuh mesin atau cloud terpisah.
_Avoid_: Minikube, kind

# 0013 — MariaDB: satu primary, dua replika asinkron, failover lewat MaxScale

- **Status:** Diterima
- **Tanggal:** 18 November 2026

## Konteks

Sampai ADR 0010, `lb-db` hanya berisi satu MariaDB. Kalau container itu mati, seluruh CRUD
mati sampai container dinyalakan manual: tidak ada node lain yang bisa mengambil alih,
dan aplikasi hanya mengenal satu alamat `mariadb:3306`.

Kebutuhannya: **high availability untuk database tanpa mengubah aplikasi**. Artinya
aplikasi tetap tidak tahu ada berapa node, dan tetap tidak melakukan reconnect manual.

Batas yang disepakati sebelum memilih solusi:

1. **Failover otomatis** untuk kegagalan proses/container database.
2. **Host failure di luar scope.** Ketiga node dan MaxScale ada di satu mesin Docker;
   kalau mesinnya mati, tidak ada yang bisa menyelamatkan.
3. **Read-your-writes harus tetap benar.** `POST` lalu `GET` tidak boleh melihat data
   lama atau 404.
4. **RPO > 0 diterima, asal diukur.** Tidak boleh diklaim nol.
5. **Rejoin manual.** Node yang hidup lagi tidak masuk sendiri.

## Pilihan yang dipertimbangkan

1. **Primary–replika asinkron (1 primary + 2 replika) di belakang MaxScale.**
   MaxScale `mariadbmon` mempromosikan replika, router `readconnroute` dengan
   `router_options=master` mengarahkan **semua** koneksi ke node yang sedang menjadi
   primary.
2. **Galera (multi-primary sinkron).** RPO mendekati nol, tetapi butuh minimal 3 node
   dengan kuorum, konflik tulis harus ditangani aplikasi, dan setiap commit membayar
   latensi sinkron. Untuk demo yang mengukur jendela failover, biayanya tidak sepadan.
3. **Semi-sync replication.** RPO mendekati nol dengan perubahan kecil, tetapi commit
   menunggu ACK replika; latency tulis naik dan tetap ada jendela saat replika tidak
   menjawab. Ditunda, bukan ditolak prinsipnya.
4. **Tanpa MaxScale, failover di aplikasi.** `mysql2` 3.24.6 tidak punya dukungan
   multi-host/failover. Artinya harus menulis logika pemilihan node sendiri di backend,
   dan setiap perubahan topologi jadi perubahan kode aplikasi.
5. **MaxScale dengan `readwritesplit` (baca ke replika).** Menambah kapasitas baca,
   tetapi merusak read-your-writes pada replikasi asinkron: `POST` ke primary lalu `GET`
   ke replika bisa mengembalikan data lama.
6. **`auto_rejoin=true`.** Lebih sedikit perintah manual, tetapi node lama yang kembali
   sudah punya tulisan yang tidak pernah sampai ke replika. Memasukkannya otomatis
   menggabungkan dua riwayat tanpa bisa didamaikan.

## Keputusan

Memilih **(1)**, dengan penegasan:

- **Tiga node, satu pintu.** `mariadb-primary`, `mariadb-replica-1`, `mariadb-replica-2`
  (server-id 1/2/3), semuanya `log-bin` + `sync-binlog=1` + `gtid-strict-mode=ON`,
  `log-slave-updates=ON` supaya node yang dipromosikan bisa menjadi sumber replikasi.
  Aplikasi memakai `DB_HOST=maxscale`, `DB_PORT=4006`.
- **Nama bukan peran.** `mariadb-primary` hanya peran awal. Skrip mencari primary dari
  `@@read_only` lewat `maxscale:4006` (fallback: pemindaian `read_only` saat bootstrap),
  bukan dari nama service.
- **Replika `read_only=ON`, tanpa `SUPER` untuk `lb_app`.** MariaDB 11.4 tidak mengenal
  `super_read_only`; `read_only` cukup karena user aplikasi bukan superuser.
- **Failover otomatis, rejoin manual.** Monitor: interval 1 detik,
  `master_failure_timeout=3s`, `auto_failover=true`, `auto_rejoin=false`,
  `verify_master_failure=true`, `enforce_read_only_slaves=true`,
  `enforce_writable_master=true` (agar replika yang sudah dipromosikan tetap writable
  bila container-nya ikut restart).
- **Clone lewat `mariadb-dump` + restore**, bukan `xtrabackup`/`rsync`: cukup untuk
  ukuran data demo dan tidak butuh privilege filesystem. `scripts/db-replica-clone.js`
  membaca GTID dari dump, `RESET MASTER` sebelum/sesudah restore, `MASTER_SSL=0` (11.4
  mengaktifkan TLS default), dan menutup dengan `read_only=ON`.
- **Grant per node dengan `sql_log_bin=0`.** User (`lb_app`, `lb_repl`, `lb_monitor`,
  `lb_exporter`) dibuat di setiap node tanpa masuk binlog, supaya tidak terjadi konflik
  `seq_no` GTID saat clone.
- **MaxScale butuh grant admin granular.** `SUPER` tidak cukup; `lb_monitor` mendapat
  daftar `*_ADMIN` eksplisit. Password `lb_monitor` dan `lb_app` ditulis dua kali
  (`.env` dan `docker/maxscale/maxscale.cnf`) karena MaxScale tidak membaca env.
- **Satu exporter per node.** Satu exporter hanya bisa menembak satu alamat; digabung,
  `mysql_up` tidak bisa menunjukkan node mana yang mati.

## Konsekuensi

**Positif**

- Aplikasi tidak berubah selain `DB_HOST`/`DB_PORT`; tidak ada reconnect manual, tidak
  ada daftar node di kode.
- Failover terbukti bekerja: `make test-db` mematikan container primary sungguhan.
  Terukur pada mesin ini (Windows + Docker Desktop): tulis lewat `maxscale:4006` gagal
  **~32 detik** (deteksi `master_down` ~23 s, promosi + konfirmasi replika ~6 s), lalu
  sukses lagi tanpa restart backend. Rejoin primary lama **6,0 detik**.
- RPO tidak diklaim nol: saat pengujian, **6 tulis sudah di-ACK, 0 hilang**, dengan lag
  replika 0 detik. Angka ini kebetulan bagus, bukan jaminan.
- Read-your-writes aman karena tidak ada pembacaan dari replika.
- Peran node bisa dibaca dari metrik (`mysql_global_variables_read_only`), jadi dashboard
  menyebut `mariadb-replica-1` sebagai primary kalau memang itu yang terjadi.

**Negatif / biaya**

- **RPO > 0.** Tulisan yang sudah di-ACK bisa hilang bila primary mati sebelum event
  sampai ke replika.
- **MaxScale jadi titik tunggal baru.** Kalau container MaxScale mati, aplikasi kehilangan
  database walau ketiga node sehat.
- **Host tetap titik tunggal.** Semua node dan MaxScale ada di satu mesin Docker.
- **Replika tidak menambah kapasitas baca** — semua SELECT tetap ke primary.
- **Data yang bercabang dibuang saat rejoin**, dan itu tidak bisa diotomatiskan dengan
  benar. `auto_rejoin=false` adalah keputusan, bukan kekurangan.
- **Dua volume tambahan** (`lb-db-replica-1-data`, `lb-db-replica-2-data`) dan
  `db-reset` sekarang menghapus ketiganya.
- **Bootstrap lebih panjang**: `db-up` harus grant user lalu clone replika sebelum
  MaxScale dinyalakan. Kalau MaxScale lebih dulu, ia melihat replika kosong.
- **Konfigurasi monitor duplikat** antara `.env` dan `maxscale.cnf`; mengganti password
  harus di dua tempat.
- Kalau nanti butuh RPO 0, keputusan ini harus diganti ke semi-sync (pilihan 3) atau
  Galera (pilihan 2), dengan biaya tulis yang tidak dibahas di demo ini.

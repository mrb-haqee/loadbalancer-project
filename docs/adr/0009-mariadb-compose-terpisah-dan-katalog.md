# 0009 — MariaDB di compose sendiri, katalog server bukan pengatur rotasi

- **Status:** Diterima
- **Tanggal:** 17 November 2026

## Konteks

Backend demo sebelumnya tanpa state: setiap container hanya membalas echo dari memori,
dan rotasi ditentukan label Docker yang dibaca Traefik. Kebutuhan baru: "server bisa
CRUD" dengan UI sederhana, database MariaDB, dan alat untuk membaca isinya.

Ada dua hal yang mudah tercampur dan berbahaya kalau tidak dipisahkan:

1. **Katalog data** — daftar server sebagai isi database, bisa ditambah/diedit/dihapus.
2. **Konfigurasi rotasi** — server mana yang benar-benar menerima request Traefik.

Kalau keduanya dianggap sama, UI CRUD terlihat seolah bisa menambah backend hidup padahal
Traefik tidak membacanya. Sebaliknya, menghapus baris di katalog tidak boleh membuat
backend yang sedang melayani request ikut mati.

Batasan lain:

- Menambah dependency database ke backend tidak boleh membuat `/health` bergantung pada
  DB; kalau tidak, satu DB mati akan mengeluarkan **semua** backend dari rotasi dan demo
  failover kehilangan makna.
- Database harus bisa dinyalakan/dimatikan tanpa mengubah project `lb-demo`, `lb-traefik`,
  atau `lb-k6`.
- Repo ini sebelumnya nol dependency runtime.

## Pilihan yang dipertimbangkan

1. **MariaDB di project compose `lb-db` terpisah, CRUD di backend yang ada, katalog tidak
   mengubah rotasi.** Driver `mysql2`, skema lewat SQL init, Adminer sebagai pembaca.
2. MariaDB di `docker-compose.yml` yang sama dengan backend. Lebih sedikit perintah, tapi
   `docker:down` ikut mematikan DB dan batas antar-stack kabur.
3. Service CRUD baru (`crud-api`) dengan router sendiri. Backend demo tetap bersih, tetapi
   menambah container, image, dan router untuk kebutuhan yang bisa ditumpangkan.
4. Katalog menjadi sumber konfigurasi Traefik (file provider dinamis). CRUD benar-benar
   mengubah rotasi, tetapi jauh lebih besar: menulis config, reload Traefik, menangani
   kegagalan, dan mengubah cara kerja seluruh demo.
5. Entitas netral (`items`) supaya tidak bentrok dengan istilah "Server". Aman secara
   istilah, tetapi tidak nyambung dengan domain project.

## Keputusan

Memilih **(1)**, dengan penegasan istilah:

- **Server Terdaftar** = satu baris katalog di MariaDB. **Server (Backend)** tetap berarti
  container yang melayani request. Keduanya tidak saling menggantikan.
- CRUD hidup di `src/backend/server.js` dan dilayani semua replika. Satu database dipakai
  bersama, jadi menulis lewat `server.localhost` lalu membaca lewat `server-3.localhost`
  memperlihatkan state yang sama — ini justru memperkuat demo load balancer.
- Database ada di `docker-compose.db.yml` (project `lb-db`), network `lb-net` external,
  volume `lb-db-data`, tanpa port 3306 ke host. Adminer punya dua pintu:
  `http://adminer.localhost` lewat router Traefik `adminer` (prioritas 200, pola yang
  sama dengan `grafana.localhost`, karena router `demo` menangkap semua host) dan
  `http://127.0.0.1:8081` sebagai cadangan loopback. Tanpa Traefik, stack DB tetap
  bisa dipakai lewat port itu.
- Skema dan seed deklaratif di `db/init/001-schema.sql`; init hanya jalan saat volume
  kosong, sehingga ada `db:reset`.
- `mysql2` menjadi satu-satunya dependency runtime. Dockerfile memakai
  `npm ci --omit=dev` dengan lockfile.
- `/health` tetap murni status proses. Endpoint CRUD yang membalas 503 saat DB tidak
  tersedia, dengan `connectTimeout` 1 detik agar tidak dipotong Traefik (2 detik) menjadi
  504.
- UI statis di `/ui`, API di `/api/servers`; path `/` tidak diubah supaya test load
  balancing tetap sah.

## Konsekuensi

**Positif**

- Database bisa naik/turun sendiri; `npm run docker:up` dan `npm test` tidak bergantung
  pada DB.
- Satu DB bersama membuat CRUD terasa nyata di belakang load balancer: tulis di satu
  server, baca di server lain, `x-served-by` menunjukkan pelayan request.
- Batas "katalog vs rotasi" eksplisit di UI, GLOSSARY, README, dan ADR ini.
- Skema dan seed bisa dibaca/diulang (`db:reset`), tidak tersembunyi di kode migrasi.
- Adminer memberi cara membaca isi DB tanpa menambah query khusus ke aplikasi.

**Negatif / biaya**

- Empat project compose sekarang, dan `stack:up` harus menyalakan `lb-db` lebih dulu.
- Backend tidak lagi dependency-free; image bertambah `mysql2`.
- Katalog bisa membingungkan kalau dibaca tanpa catatan: menambah baris **tidak**
  menambah backend Traefik. Ini sengaja diterima demi scope demo.
- Database tanpa autentikasi aplikasi tambahan, kredensial demo di repo, dan Adminer
  tanpa auth. Lewat `adminer.localhost` ia terbuka di port 80 dan bisa dijangkau mesin
  lain di LAN bila nama itu resolve; `127.0.0.1:8081` tetap loopback. Hanya cocok untuk
  lokal.
- Perubahan `001-schema.sql` tidak otomatis berlaku pada volume lama; butuh `db:reset`.
- Kalau nanti katalog harus benar-benar mengatur rotasi, keputusan ini harus diganti
  dengan pendekatan (4) dan scope-nya jauh lebih besar.

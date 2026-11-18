# 0011 — Perintah operasional pindah dari package.json ke Makefile

- **Status:** Diterima
- **Tanggal:** 18 November 2026

## Konteks

Seluruh perintah operasional project (29 entri) tinggal di `package.json`
`"scripts"`: menyalakan network, database, Traefik, backend, monitoring, test,
dan pembungkus k6. `package.json` sendiri tetap diperlukan karena `mysql2`
adalah dependency runtime backend dan `"type": "module"` menentukan cara Node
membaca `src/`. Jadi yang bisa dipindah hanyalah blok `"scripts"`.

Masalah yang terasa:

- Nama perintah memakai `:` (`db:up`, `stack:up`) dan hanya bisa dipanggil lewat
  `npm run`, padahal isinya bukan urusan Node — hampir semuanya `docker compose`,
  `node`, dan `bun`. Menjalankan stack Docker menjadi bergantung pada npm.
- Urutan `stack:up` ditulis sebagai satu rantai `&&` panjang, sehingga urutan
  tidak terlihat sebagai struktur dan setiap perintah harus mengulang nama
  project/file compose.
- Tidak ada penemuan perintah: orang harus membuka `package.json` untuk tahu apa
  yang tersedia.
- Referensi `npm run ...` tersebar di README, enam dokumen panduan, GLOSSARY,
  `.env.example`, komentar compose, alert rule Grafana, dan pesan error script.

Batasan:

- Harus tetap nyaman di Windows (mesin pengembangan memakai GNU Make 3.81 dari
  GnuWin32, recipe default-nya cmd.exe, tanpa `.ONESHELL`, dan `echo.` tidak
  dikenali sebagai builtin sehingga gagal dieksekusi).
- `make` di Linux/macOS memakai `/bin/sh`, jadi recipe tidak boleh bergantung
  pada sintaks khusus PowerShell atau cmd.
- Perilaku operasional tidak boleh berubah: `db-up` tetap otomatis menyegarkan
  user `lb_exporter`, urutan shutdown tetap terbalik, dan test tetap sama.

## Pilihan yang dipertimbangkan

1. **Makefile sebagai satu-satunya sumber perintah; blok `"scripts"` dihapus.**
2. Biarkan `package.json` apa adanya. Tidak ada perubahan, tetapi ketergantungan
   pada npm dan nama ber-`:` tetap ada.
3. Makefile plus alias `npm run ...` yang memanggil `make`. Kompatibel, tetapi
   ada dua sumber kebenaran yang pasti menyimpang.
4. Skrip `*.ps1`/`*.sh` buatan sendiri. Tidak menambah prasyarat baru, tetapi
   menulis ulang dispatcher, help, dan dependency ordering yang sudah diberikan
   Make.

## Keputusan

Memilih **(1)**:

- **`Makefile` di root** memuat semua target; `package.json` tinggal metadata,
  `engines`, dan dependency `mysql2`.
- **Nama target memakai hyphen** (`db-up`, `stack-down`, `test-backend`) karena
  `:` adalah pemisah target:prerequisite di Make dan tidak bisa dipakai apa
  adanya. Nama lama tidak dipertahankan sebagai alias.
- **Recipe satu baris** dan tidak memakai fitur shell lanjutan. Di Windows,
  Makefile menetapkan `SHELL := cmd.exe` supaya tidak bergantung pada shell Unix
  yang kebetulan ada di PATH; di Linux/macOS dipakai `/bin/sh` bawaan. Rantai
  `&&` yang sudah ada dipertahankan, termasuk `db-up` yang memanggil
  `scripts/db-grant-exporter.js`.
- **Nama project/file compose menjadi variabel** `COMPOSE_DB`,
  `COMPOSE_TRAEFIK`, `COMPOSE_DEMO`, `COMPOSE_K6`, sehingga tidak diulang di
  setiap recipe.
- **`stack-up`/`stack-down` memakai prerequisite**, bukan rekursi `$(MAKE)` atau
  rantai `&&`: `stack-up: net-up db-up traefik-up docker-up k6-up`, dengan
  `.NOTPARALLEL` supaya urutannya tetap terjaga. Rekursi `$(MAKE)` dihindari
  karena path `make.exe` di Windows mengandung spasi dan gagal dieksekusi
  langsung oleh Make 3.81.
- **`help` menjadi target default**, mencetak daftar target per kelompok.
  Karena Make 3.81 tidak bisa menjalankan `echo.` sebagai baris kosong, bantuan
  memakai baris judul kelompok, bukan baris kosong.
- **Dokumentasi pemakaian diperbarui** (README, `docs/*.md`, GLOSSARY,
  `.env.example`, komentar compose, alert rule, pesan error script). ADR
  0001–0010 **tidak** diubah karena merupakan catatan historis; keputusan ini
  dicatat sebagai ADR 0011.
- **Bun tetap dipakai untuk k6** (`k6-install`, `k6`, `k6-load`,
  `k6-failover`). Memindahkan runner ke Node adalah perubahan terpisah dan
  tidak dilakukan di sini.

## Konsekuensi

**Positif**

- Satu tempat untuk semua perintah, dengan `make help` sebagai penemuan.
- Stack Docker tidak lagi membutuhkan npm; npm hanya untuk `mysql2`/unit test.
- Urutan `stack-up`/`stack-down` terlihat sebagai dependency, bukan rantai teks.
- Nama project dan file compose hanya ditulis sekali sebagai variabel.
- `make db-up` dan `make db-reset` tetap idempotent dan tetap menyegarkan user
  exporter.

**Negatif / biaya**

- **GNU Make menjadi prasyarat baru** (Windows: `choco install make` atau
  GnuWin32; Linux: paket `make`; macOS: Xcode Command Line Tools).
- Perintah lama `npm run ...` dan `npm test` tidak berlaku lagi; siapa pun yang
  menghafalnya harus pindah ke `make ...`. ADR lama masih menyebut `npm test`
  sebagai konteks sejarah.
- Namanya berubah dari `db:up` menjadi `db-up`, jadi tidak bisa disalin mentah
  dari dokumentasi lama di luar repo.
- Make 3.81 di Windows membatasi gaya recipe: tanpa `.ONESHELL`, `echo.` tidak
  bisa dipakai, dan path berspasi tidak boleh dieksekusi langsung. Makefile
  sengaja menghindari semuanya.
- K6 lokal masih membutuhkan Bun; Makefile tidak menghapus prasyarat itu.

## Verifikasi

- `make help` mencetak seluruh target tanpa error.
- `make test-backend` → **13/13 lulus** lewat cmd.exe, termasuk pola glob
  `"test/backend/*.test.js"`.
- `make -n stack-up` → urutan `network → db → traefik → backend → monitoring`;
  `make -n stack-down` → urutan kebalikannya.
- `make k6` → binary k6 terpasang dijalankan lewat `bun scripts/k6.js`.
- `package.json` tidak lagi memuat blok `"scripts"`; `mysql2` dan
  `"type": "module"` tetap ada.

# 0015 — Backend: Bun + Elysia + Drizzle ORM di atas Bun SQL

- **Status:** Diterima
- **Tanggal:** 18 November 2026

## Konteks

Backend demo ditulis dengan `node:http` tanpa framework dan `mysql2` sebagai satu-satunya
dependency. Pola itu jujur untuk belajar, tetapi semua yang rutin harus ditulis sendiri:
routing, pembacaan body berbatas ukuran, pemetaan error driver ke status HTTP, dan
perakitan query SQL manual.

Kebutuhannya bukan menambah fitur, melainkan **mengganti fondasi** tanpa mengubah
kontrak yang sudah diukur test:

1. Status code, header (`x-served-by`, `location`, `allow`), bentuk JSON, dan nama metrik
   Prometheus tetap sama.
2. `/health` dan `/metrics` tetap tidak dihitung sebagai trafik aplikasi.
3. Error driver tetap dipetakan ke `409 DUPLICATE_NAME`, `503 DATABASE_NOT_INITIALIZED`,
   `503 DATABASE_UNAVAILABLE`.
4. Database tetap satu pintu `maxscale:4006`; backend tetap tidak tahu node mana yang
   sedang primary.
5. `db/init/001-schema.sql` tetap sumber kebenaran skema.

## Pilihan yang dipertimbangkan

1. **Tetap `node:http` + `mysql2`, hanya pindah ke TypeScript.** Perubahan paling kecil,
   tetapi tidak menjawab alasan migrasi: query SQL tetap dirangkai manual dan tipe baris
   tetap tidak terhubung ke skema.
2. **Bun + Elysia 2 RC.** Elysia 2 masih `rc`/`beta` saat keputusan diambil; kontrak HTTP
   yang sudah stabil tidak layak dipertaruhkan pada rilis yang belum final.
3. **Bun + Elysia 1.4 stabil + Drizzle 0.45 + `mysql2`.** Drizzle stabil belum punya
   adapter MySQL untuk `Bun.SQL`, jadi harus membawa `mysql2` hanya untuk Drizzle.
   Dua driver untuk satu koneksi.
4. **Bun + Elysia 1.4 stabil + Drizzle 1.0 RC + `Bun.SQL`.** Satu driver bawaan runtime,
   tipe query dari schema, tanpa `mysql2`. Risikonya: Drizzle masih RC.
5. **Drizzle Kit + folder `drizzle/` sebagai sumber migrasi.** Menambah satu sumber skema
   kedua di samping `db/init/001-schema.sql` yang sudah dipakai bootstrap cluster.

## Keputusan

Memilih **(4)**, dengan penegasan:

- **Elysia 1.4.32** (stabil), **bukan** 2.0 RC.
- **Drizzle ORM `1.0.0-rc.5`** lewat `drizzle-orm/bun-sql` (`drizzle.mysql`).
  `mysql2` dihapus dari dependency. Kalau RC ini gagal di test, jalan mundur yang sudah
  disiapkan: Drizzle `0.45.4` + `mysql2`.
- **`Bun.SQL` sebagai driver tunggal** ke `maxscale:4006`, pool `max` dari
  `DB_CONNECTION_LIMIT` (default 10), `connectionTimeout` 1 detik (di bawah
  `responseHeaderTimeout` Traefik 2 detik). `DB_QUEUE_LIMIT` dihapus: Bun SQL tidak
  punya antrean terpisah, `max` sudah menjadi batasnya.
- **SQL init tetap sumber kebenaran.** `src/backend/schema.ts` hanya cermin bertipe untuk
  query; tidak ada `drizzle-kit`, tidak ada folder migrasi. Perubahan skema tetap lewat
  `db/init/001-schema.sql` + `make db-reset`.
- **Validasi tetap manual.** `servers/validation.ts` dipertahankan supaya body error tetap
  `400 VALIDATION_ERROR` dengan `details: [{field,message}]`, plus `413 BODY_TOO_LARGE`
  dan `400 INVALID_JSON`. Validator Elysia tidak dipakai untuk tiga kasus itu.
- **Tulis pakai `Bun.SQL` langsung.** Drizzle RC belum meneruskan metadata tulis dari
  driver Bun (`db.insert()` mengembalikan hasil kosong), sedangkan kontrak butuh id baris
  baru untuk `Location` dan `affectedRows` untuk membedakan 200/204 dari 404. Karena itu
  `createServer`/`updateServer`/`deleteServer` memanggil `db.$client.unsafe(...)` dan
  membaca `lastInsertRowid`/`affectedRows`; baca tetap memakai query builder Drizzle.
- **Tanpa tahap build.** Image `oven/bun:1.3-alpine`, `bun install --production
  --frozen-lockfile`, `CMD ["bun", "src/backend/server.ts"]`. `bunx tsc --noEmit` hanya
  untuk typecheck.
- **Test dipisah per runtime.** `test/backend/*.test.ts` memakai `bun:test`
  (`make test-backend` → `bun test test/backend`); `test/docker/*` tetap `node:test`
  karena menguji Docker/Traefik/MariaDB, bukan kode backend.
- **Migrasi big-bang di satu branch.** Kelima backend memakai image yang sama; rollback =
  kembali ke image/tag sebelumnya.

## Konsekuensi

**Positif**

- Satu driver (`Bun.SQL`), bukan dua. Dependency runtime tinggal `elysia` + `drizzle-orm`.
- Baris hasil query bertipe dari `schema.ts`, jadi salah nama kolom ketahuan saat
  `tsc --noEmit`, bukan saat request.
- Kontrak HTTP tidak berubah: `make test` (6/6) dan `make test-db` (7/7) lulus, dan
  smoke CRUD manual menghasilkan 201 + `Location`, 409 duplikat, 200 PUT, 204 DELETE,
  404 DELETE ulang.
- Image lebih kecil dan tanpa `npm ci`; runtime tidak perlu Node.

**Negatif / biaya**

- **Drizzle masih RC.** API bisa berubah antar rilis; karena itu adapter dan metadata
  tulis diisolasi di `db.ts` dan `servers/repository.ts`.
- **Dua gaya akses database.** Baca lewat Drizzle, tulis lewat `Bun.SQL` mentah. Ini
  kompensasi sementara atas keterbatasan RC, bukan pola yang ingin dipertahankan.
- **`bun:test` dan `node:test` hidup berdampingan.** Dua runner berarti dua cara membaca
  output test; dipisah menurut apa yang diuji.
- **Typecheck bukan bagian dari image.** `tsc` bisa lupa dijalankan kalau tidak disiplin;
  Bun tetap menjalankan `.ts` walau tipenya salah.
- Kalau proyek butuh migrasi skema berversi, keputusan "SQL init sebagai sumber tunggal"
  harus ditinjau ulang bersama `drizzle-kit`.
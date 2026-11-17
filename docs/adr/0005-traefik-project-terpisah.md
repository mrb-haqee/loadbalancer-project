# 0005 — Traefik dipisah menjadi project compose sendiri, semua dashboard lewat Traefik

- **Status:** Diterima
- **Tanggal:** 17 November 2026

## Konteks

Sebelumnya Traefik tinggal di dalam `docker-compose.yml` project `lb-demo`, bercampur dengan 3 backend. Monitoring (`lb-k6`) berada di file lain tetapi Grafana hanya bisa dibuka lewat port host `3000`; web dashboard k6 lewat port `5665`.

Pemilik project meminta Traefik **juga terpisah**, supaya Grafana, k6, dan apa pun yang ditambahkan nanti bisa berjalan **lewat Traefik**, bukan hanya lewat port.

Yang membuat ini tidak sepele:

- Router `demo` sengaja menangkap semua host (`PathPrefix(/)`) agar `http://127.0.0.1:8088` tetap berfungsi. Tanpa penanganan, `grafana.localhost` akan ikut dilempar ke backend.
- Network `lb-net` sebelumnya dibuat oleh project `lb-demo`. Kalau Traefik dipisah tetapi tetap "menumpang" network milik project lain, akan ada project induk tersembunyi.
- Test suite mematok project `lb-demo` dan mematikan seluruh stack di akhir; dengan Traefik di project lain, test bisa mematikan Traefik yang sedang dipakai Grafana.

## Pilihan yang dipertimbangkan

1. **Traefik sendiri di project `lb-traefik`**, network bersama dibuat di luar compose, tiga project setara.
2. **Traefik digabung ke file monitoring** (`lb-k6`), backend tetap terpisah — lebih sedikit file, tetapi Traefik jadi milik monitoring dan mati bersama Grafana.
3. **Tetap seperti sekarang**, hanya menambah route — paling murah, tetapi tidak menjawab permintaan pemisahan.

## Keputusan

Memilih **(1)**.

Detail yang ikut diputuskan:

- Tiga file, tiga project: `docker-compose.traefik.yml` (`lb-traefik`), `docker-compose.yml` (`lb-demo`), `docker-compose.monitoring.yml` (`lb-k6`).
- Network `lb-net` dibuat **di luar compose** lewat `scripts/network.js` (`npm run net:up`, idempotent); ketiga project mendeklarasikannya `external`. Tidak ada project yang menjadi induk.
- Grafana dan k6 ikut menempel di `lb-net` dan diberi label router; InfluxDB **tidak** diekspos.
- Host baru: `grafana.localhost`, `traefik.localhost` (service `api@internal`), `k6.localhost` (hanya hidup saat `k6:watch`).
- Router baru memakai **prioritas 200** (di atas `demo` = 1), bukan mengubah rule `demo`. Jadi fallback `127.0.0.1:8088` tetap jalan dan menambah host baru tidak perlu menyunting daftar pengecualian.
- Port host 3000/5665/8089 **tetap dipublikasikan** sebagai cadangan dan karena test suite memakai API di 8089.
- `npm run stack:up` / `stack:down` menjadi orkestrator dengan urutan yang benar; perintah per project tetap ada.
- Test suite: helper memastikan network + Traefik hidup (idempotent) sebelum backend, dan di akhir **hanya mematikan `lb-demo`**. Traefik dibiarkan hidup agar tidak merusak stack yang sedang dipakai.

## Konsekuensi

**Positif**
- Satu pintu masuk untuk semua: `server.localhost`, `grafana.localhost`, `traefik.localhost`, `k6.localhost` — tidak perlu menghafal port.
- Batas project jelas; Traefik bisa dipakai app keempat hanya dengan label + network.
- Tidak ada lagi "Traefik milik lb-demo": mematikan backend tidak mematikan pintu masuk.
- Terverifikasi: `grafana.localhost` 200 dan **tidak** nyasar ke backend; `traefik.localhost/api/http/services` 200; `k6.localhost` 200 selama watch dan router hilang setelahnya; `npm test` 6/6; `stack:up` idempotent.

**Negatif / biaya**
- Satu file compose tambahan dan satu script network yang harus dijalankan sebelum project lain.
- Urutan naik/turun menjadi penting; salah urutan memunculkan error "network external not found" atau network tidak bisa dihapus.
- `npm test` tidak lagi mengembalikan mesin ke kondisi kosong — Traefik tetap hidup setelahnya. Ini disengaja, tetapi harus diketahui.
- Dashboard Grafana dan Traefik kini dapat diakses tanpa autentikasi lewat nama host, bukan hanya port. Untuk lokal tidak masalah; sebelum diekspos, wajib ditambah auth.
- `docker network prune` bisa menghapus `lb-net` saat semua container mati; pulihkan dengan `npm run net:up`.

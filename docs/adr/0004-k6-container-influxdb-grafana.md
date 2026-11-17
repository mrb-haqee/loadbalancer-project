# 0004 — k6 dijalankan di container, hasilnya disimpan di InfluxDB 1.8 dan dibaca Grafana

- **Status:** Diterima
- **Tanggal:** 17 November 2026
- **Revisi 17 November 2026:** Traefik dipindah ke project sendiri (`lb-traefik`), jadi alias network `server.localhost` kini ada di `docker-compose.traefik.yml`, dan Grafana/k6 mendapat URL `grafana.localhost` / `k6.localhost`. Lihat [ADR 0005](0005-traefik-project-terpisah.md).

## Konteks

Project sudah berisi stack container: Traefik + 3 backend (`lb-demo`) dan skrip k6 yang dijalankan dari binary lokal (`tools/k6/k6.exe`). Permintaan pemilik project: **k6 juga dijalankan dari container, ada dashboard, dan hasil pemantauannya bisa dilihat**.

Kebutuhan nyata di balik permintaan itu:

- Hasil test harus **bisa dibaca setelah test selesai**, bukan hanya saat test berjalan.
- Harus ada satu tempat untuk melihat pembagian beban per server, tingkat gagal, dan latensi.
- Jangan mengganggu stack load balancer maupun `npm test` yang sudah lulus 6/6.

Fakta lingkungan yang membatasi pilihan:

- k6 v2.4.0 (image `grafana/k6:2.4.0`) punya **web dashboard bawaan** (`K6_WEB_DASHBOARD=true`, port 5665) dan bisa mengekspor `report.html`.
- k6 v2.4.0 menandai output `influxdb` **dan** `experimental-prometheus-rw` sebagai **deprecated**, dengan rekomendasi OpenTelemetry untuk k6 v3.
- Di dalam network Docker, `server.localhost` **tidak** resolve otomatis (itu fitur OS host), sedangkan skrip k6 memakai URL itu.
- Image Grafana/InfluxDB belum ada di mesin; port 3000, 5665, 8086 semuanya bebas.

## Pilihan yang dipertimbangkan

1. **Web dashboard k6 saja** — nol container tambahan, tapi data hilang begitu test selesai; tidak bisa membandingkan run.
2. **Grafana + InfluxDB 1.8** — penyimpanan permanen, dashboard bisa dibuka kapan saja, `--out influxdb` paling matang walau deprecated.
3. **Grafana + Prometheus (remote write)** — jalur yang dianjurkan k6 jangka panjang, tapi `experimental-prometheus-rw` masih experimental di v2.4.0 dan butuh Prometheus + konfigurasi remote-write receiver.
4. **TimescaleDB** — output khusus, butuh ekstensi dan skema tambahan; paling berat untuk demo.

## Keputusan

**Keduanya (1 + 2)**: web dashboard k6 untuk melihat **live**, Grafana + InfluxDB 1.8 untuk **riwayat**.

Detail yang ikut diputuskan:

- Monitoring adalah **file compose terpisah** (`docker-compose.monitoring.yml`) dengan project sendiri (`lb-k6`), bukan profil di `docker-compose.yml`. `npm test` tidak ikut menyalakannya.
- `lb-net` dipakai sebagai **network external**, jadi k6 bisa menembak Traefik tanpa menggabungkan kedua project.
- Service `traefik` diberi **alias network `server.localhost`**, supaya skrip k6 tetap memakai URL yang sama dengan browser dan angka di dashboard tidak menyebut `http://traefik/`.
- InfluxDB **1.8** (bukan 2.x): `--out influxdb=http://influxdb:8086/k6` langsung jalan tanpa bucket/token/org, dan database `k6` dibuat otomatis lewat `INFLUXDB_DB`.
- Grafana memakai datasource terprovisi (`k6-influxdb`) dan dashboard terprovisi (`monitoring/grafana/dashboards/k6.json`, uid `k6-lb`), jadi tidak ada langkah klik manual.
- Tiap eksekusi diberi **tag `run`** (timestamp) sehingga run lama tetap bisa difilter/dibandingkan lewat variabel dashboard.
- Web dashboard k6 **opt-in** (`npm run k6:watch`) karena k6 menahan proses selama tab browser masih terbuka; `npm run k6:run` tetap one-shot.
- `K6_WEB_DASHBOARD_PERIOD=2s` supaya run pendek (≥ ~6 detik) tetap menghasilkan `report.html`.
- Monitoring **tidak** ikut `npm test`; pembuktiannya manual sekali (lihat konsekuensi).

## Konsekuensi

**Positif**
- Riwayat test permanen di volume `influxdb-data`; dashboard bisa dibuka kapan saja di `http://127.0.0.1:3000`.
- Dashboard terbukti berisi data (diuji lewat API Grafana `/api/ds/query`, bukan hanya "container hijau"): total request, gagal, check, VU, RPS, p50/p95/p99, sebaran per server, status code.
- Isolasi terjaga: `docker compose -p lb-demo down` tidak mematikan monitoring, dan sebaliknya.
- k6 di container menghapus ketergantungan pada binary lokal saat ingin mengukur.

**Negatif / biaya**
- Dua container tambahan (InfluxDB + Grafana) dan unduhan image ±500 MB; Grafana butuh ±10 detik sebelum siap.
- Output `influxdb` **deprecated** di k6 v2.4.0 (dihapus di v3). Migrasi nanti: output OpenTelemetry + datasource Prometheus/Tempo, dan dashboard harus disesuaikan.
- Urutan shutdown tetap penting (`k6:down` → `docker:down` → `traefik:down`); sejak [ADR 0005](0005-traefik-project-terpisah.md) urutan itu diurus `npm run stack:down` dan network `lb-net` dibuat di luar compose sehingga tidak ikut terhapus.
- Alias `server.localhost` menambah satu detail yang harus diingat: kalau `docker-compose.yml` berubah, traefik harus dibuat ulang agar alias aktif.
- Dashboard terprovisi `allowUiUpdates: false` — mengubah panel lewat UI tidak tersimpan; harus edit `k6.json` lalu restart Grafana.
- Tanpa autentikasi yang layak (admin/admin, viewer anonim, InfluxDB tanpa auth) — hanya untuk lokal.

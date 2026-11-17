# 0006 — Dashboard realtime memakai Prometheus, terpisah dari dashboard k6

- **Status:** Diterima
- **Tanggal:** 17 November 2026

## Konteks

Permintaan terbaru: dashboard pemantauan **penerimaan request per server secara realtime**, bukan hanya hasil test.

Dashboard yang ada (`k6-lb`) membaca InfluxDB, dan InfluxDB hanya terisi saat k6 berjalan. Artinya di luar `k6:run` dashboard kosong — tidak bisa dipakai memantau trafik nyata, dan tidak bisa menjawab "request masuk ke server mana".

Data yang dibutuhkan sudah tersedia di dua tempat:

- Traefik punya `metrics.prometheus` (request masuk, status code, per service), tetapi hanya membedakan service (`demo@docker`), **bukan** server individual.
- Backend tahu persis request yang ia terima, tetapi belum mengekspos apa pun.

Yang membuat ini tidak sepele:

- Traefik 3.6 tidak punya `metrics.influxdb` v1 — hanya `prometheus`, `influxdb2`, `otlp`, `statsd`. Jadi InfluxDB yang sudah dipakai k6 tidak bisa langsung menampung metrik Traefik.
- k6 v2.4.0 sudah menandai output `influxdb` deprecated (dihapus di v3). Menambah beban ke jalur itu memperbesar utang migrasi.
- Label `server` tidak bisa diambil dari nama container backend oleh Prometheus statis; harus dipasang eksplisit di config scrape.
- Backend sengaja tanpa dependency. Menambah `prom-client` hanya untuk 4 metrik melanggar prinsip project ini.

## Pilihan yang dipertimbangkan

1. **Prometheus sebagai sumber kedua**, backend mengekspos `/metrics` teks polos buatan sendiri; dashboard baru `lb-realtime`; dashboard k6 tidak disentuh.
2. **Semua lewat InfluxDB** — butuh Traefik `influxdb2` (versi lain) atau jembatan tambahan, dan tetap menumpang output yang deprecated.
3. **Hanya metrik Traefik** — paling murah, tetapi tidak bisa memisahkan request per server; pertanyaan utama tidak terjawab.
4. **Push gateway / OpenTelemetry** — arah masa depan yang benar, tetapi butuh collector dan mengubah sisi backend lebih banyak daripada nilai yang didapat untuk demo.

## Keputusan

Memilih **(1)**.

Detail yang ikut diputuskan:

- Prometheus ditambahkan ke `docker-compose.monitoring.yml` (project `lb-k6`), image resmi, `scrape_interval: 2s`, retensi 7 hari, volume `prometheus-data`.
- Prometheus menempel di `lb-net` (target) **dan** `lb-k6-net` (Grafana). Tidak dipublikasikan ke host dan tidak dirutekan lewat Traefik: satu-satunya konsumennya Grafana.
- Backend mengekspos `/metrics` teks polos: counter `lb_backend_requests_total`, counter `lb_backend_slow_requests_total`, histogram `lb_backend_request_duration_seconds` (bucket rapat `0.005`–`2.5` detik). Tanpa dependency.
- `/health` dan `/metrics` **tidak** dihitung sebagai trafik aplikasi, supaya probe 2 detik Traefik tidak menggelembungkan angka.
- Traefik diaktifkan `metrics.prometheus` (entrypoint `traefik`:8080) dengan bucket yang sama rapatnya; config statis, jadi butuh restart.
- Dua dashboard, dua folder, dua datasource: `k6`/`k6-lb` (InfluxDB) dan `load-balancer`/`lb-realtime` (Prometheus, uid `prometheus`, refresh 5 detik).
- `npm run k6:up` ikut menyalakan Prometheus; nama project tetap `lb-k6` (rename ditolak: risiko volume data dan seluruh perintah).

## Konsekuensi

**Positif**
- Dashboard hidup tanpa k6: 10 panel berisi data saat stack hanya melayani request biasa.
- Pertanyaan "request diterima server mana" terjawab langsung (`lb_backend_requests_total{server}`), lengkap dengan p95 per server.
- Jalur k6 tidak berubah, jadi dashboard lama dan `report.html` tetap jalan.
- Terverifikasi: 4 target `up=1`; 30 request manual → masuk 14,48 req/detik, diterima 13,89 req/detik, per server 4,3/4,7/4,9, p95 ±4,7 ms; `npm test` 6/6.

**Negatif / biaya**
- Container dan volume baru (`prometheus`, `prometheus-data`), plus satu port internal.
- `/metrics` Traefik ikut terbuka di `127.0.0.1:8089/metrics` karena `api.insecure=true`; tanpa auth, hanya untuk lokal.
- Metrik backend disimpan di memori: container dibuat ulang → counter reset. `rate()` tetap benar, angka total tidak bisa dijumlahkan lintas restart.
- Scrape 2 detik melewatkan lonjakan yang lebih pendek dari 2 detik. Cukup untuk demo, bukan untuk audit.
- Dua sumber data berarti dua tempat troubleshooting; "No data" bisa berarti k6 belum jalan (InfluxDB) atau target DOWN (Prometheus).
- Arah jangka panjang tetap OpenTelemetry; Prometheus di sini tidak menghapus utang migrasi k6 v3.

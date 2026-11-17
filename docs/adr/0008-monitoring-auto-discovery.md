# 0008 — Monitoring menemukan server sendiri, bukan menyimpan daftar server

- **Status:** Diterima
- **Tanggal:** 17 November 2026

## Konteks

Menambah `server-4` harus menyunting empat tempat:

1. `docker-compose.yml` — anchor + service.
2. `monitoring/prometheus/prometheus.yml` — satu target + label `server`.
3. `k6/lib/backend-counters.js` — daftar `BACKENDS`.
4. `monitoring/grafana/dashboards/k6/k6.json` — satu target query per server (`served_server_N`).

Dua yang terakhir bukan pilihan gaya, melainkan batasan alat: k6 hanya boleh membuat metric di init context, jadi metric per server tidak bisa muncul sendiri; panel Grafana lalu perlu satu query per metric.

Akibatnya server baru "hidup" di load balancer tetapi tidak terpantau sampai tiga file monitoring disunting — persis yang terjadi pada `server-4` (target Prometheus belum dimuat, lalu counter k6 belum dibuat).

Pertanyaan: bisakah pengaturan server dipusatkan di monitoring?

## Pilihan yang dipertimbangkan

1. **Auto-discovery, hapus daftar**: Prometheus `docker_sd_configs` + label `lb.monitor=true`; k6 satu metric `served` dengan tag `server`; panel Grafana satu query `GROUP BY "server"`.
2. **Manifest terpusat** `servers.json` + generator yang menulis `prometheus.yml` dan target dashboard; harus dijalankan setiap tambah server.
3. **Env var** `SERVERS=...` dipakai Prometheus (file_sd) dan k6; panel dashboard tetap per server.
4. **Biarkan manual** seperti sekarang.

## Keputusan

Memilih **(1)**, hanya untuk monitoring. `docker-compose.yml` tetap eksplisit per server karena `BACKEND_ID` dan hostname `server-N.localhost` memang identitas, bukan konfigurasi monitoring.

Detail:

- `x-demo-labels` mendapat `lb.monitor: "true"`, jadi semua backend (termasuk yang ditambah nanti) otomatis ikut dipantau.
- Job `backend` Prometheus memakai `docker_sd_configs` (socket Docker read-only), filter label + network `lb-net`, alamat `IP:3000`, label `server` dari `com.docker.compose.service`.
- `k6/lib/backend-counters.js` menjadi satu `Counter('served')`; `recordServedBy` menambahkan tag `server`.
- Panel "Sebaran request per server" menjadi satu query: `SELECT sum("value") FROM "served" ... GROUP BY "server"`.
- Query panel "Backend sehat" dan "Status target scrape" memakai `max by (server)` agar tidak menghitung dua kali saat target lama dan baru sempat hidup bersamaan.
- Prometheus dijalankan `user: "0:0"` karena image resminya `nobody` tidak bisa membaca socket; socket tetap read-only.

## Konsekuensi

**Positif**
- Tambah server → nol edit di monitoring. Terverifikasi dengan `server-4`: target `server-4` muncul sendiri (`up=1`), panel `lb-realtime` 4 garis, sebaran k6 4 server (375 tiap server).
- Satu tempat lebih sedikit untuk lupa: tidak ada daftar target yang bisa basi.
- Riwayat k6 memakai satu metric, jadi query dashboard tidak tumbuh seiring jumlah server.

**Negatif / biaya**
- Prometheus memegang `docker.sock` read-only dan berjalan sebagai root; blast radius lebih besar daripada tanpa socket. Hanya untuk lokal.
- Container tanpa label `lb.monitor=true` tidak terpantau — kegagalan yang "diam", tidak ada error di dashboard.
- Riwayat sebaran k6 terputus sekali: run sebelum perubahan memakai `served_server_N` dan tidak tampil lagi di panel.
- Ringkasan konsol k6 kehilangan baris per server; rincian hanya ada di Grafana.
- Kalau nanti monitoring perlu jalan tanpa akses Docker API (mis. host tanpa socket), pendekatan ini harus diganti file_sd/generator (pilihan 2).
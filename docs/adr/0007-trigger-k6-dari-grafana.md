# 0007 — Trigger k6 dari Grafana lewat runner HTTP, bukan Docker socket atau SaaS

- **Status:** Diterima
- **Tanggal:** 17 November 2026

## Konteks

Permintaan: "bisa langsung testing k6 dari Grafana" — satu klik di UI, tanpa pindah ke terminal.

Batasan yang ditemukan saat memeriksa lingkungan:

- Grafana 13.3.1 **tidak** punya tombol untuk menjalankan perintah atau container; tidak ada plugin self-hosted yang melakukannya, dan endpoint `Actions` tidak tersedia (404).
- Grafana tetap bisa memanggil HTTP: link dashboard, data link, atau webhook alerting. Jadi yang dibutuhkan adalah **endpoint pemicu**.
- Image `grafana/k6:2.4.0` tidak punya server HTTP (applet `httpd` dicopot dari busybox-nya) dan tidak punya Docker CLI. Membuat server sendiri butuh image kecil tambahan.
- Opsi orchestrasi lewat Docker socket berarti container yang bisa dipanggil HTTP memegang kendali penuh atas Docker daemon.

## Pilihan yang dipertimbangkan

1. **Runner HTTP kecil** (`k6-runner`): link dashboard → `GET /cgi-bin/trigger` → k6 dijalankan di container itu sendiri. Image alpine + binary k6, server `busybox-extras httpd` + CGI.
2. **Orchestrator Docker socket**: runner memanggil Docker API untuk membuat container k6 baru.
3. **Grafana Cloud k6 / Synthetic Monitoring** (SaaS): tombol "Run" resmi, tapi butuh akun, token, internet, dan data keluar dari mesin lokal.
4. **Tidak ada pemicu**: tetap `npm run k6:run`.

## Keputusan

Memilih **(1)**.

Detail:

- Service `k6-runner` di `docker-compose.monitoring.yml`, image dibangun dari `docker/k6-runner.Dockerfile` (alpine 3.24 + `busybox-extras`, binary k6 di-copy dari image k6 supaya ABI musl cocok).
- Skrip CGI `docker/k6-runner/trigger`: `mkdir /tmp/k6.lock` sebagai lock atomik (single-flight), jalankan `k6 run load-test.js` di background dengan `K6_OUT` ke InfluxDB, redirect halaman ke dashboard `k6-lb` setelah 2 detik.
- Hanya lewat Traefik: host `trigger.localhost`, prioritas 200, port 8080 tidak dipublikasikan. Runner menempel di `lb-k6-net` (InfluxDB) dan `lb-net` (`server.localhost`).
- **Tanpa** Docker socket, tanpa dependency baru, tanpa build k6 dari source.
- Parameter Run tetap (100 req/detik, 15 detik, `load-test.js`); diubah lewat env `RATE`/`DURATION` di compose.
- UI: satu entri di array `links` dashboard `k6.json` ("Run k6 (15 detik)"), bukan panel baru — tidak menambah query atau plugin.

## Konsekuensi

**Positif**
- Satu klik dari Grafana benar-benar memulai Run; hasil muncul di dashboard yang sama dengan tag `run` baru.
- Blast radius kecil: runner tidak bisa menyentuh container lain; kalau disalahgunakan, paling parah satu Run k6.
- Terverifikasi: trigger 200, Run selesai 15 detik (1500 request), tag `run` masuk InfluxDB, klik kedua dibalas "Run masih berjalan".
- Tidak menambah image pihak ketiga; satu image build kecil (~70 MB karena binary k6).

**Negatif / biaya**
- Endpoint tanpa autentikasi — siapa pun yang bisa membuka `trigger.localhost` bisa memulai Run. Guard hanya single-flight.
- Tidak ada antrean, tidak ada parameter dari UI, tidak ada status run selain log di dalam container dan tag `run`.
- Link dashboard adalah navigasi, bukan tombol panel: membuka tab baru lalu redirect balik.
- Lock bisa tertinggal kalau container mati di tengah Run; dibersihkan manual atau dengan restart.
- Kalau nanti butuh parameter dari UI, keputusan ini perlu ditinjau (form + validasi = permukaan serangan baru).
# 0002 — Failover pasif dengan retry, dan konsekuensinya: response di-buffer

- **Status:** Diterima
- **Tanggal:** 17 November 2026

## Konteks

Backend bisa mati kapan saja. Ada dua momen kegagalan yang berbeda:

1. **Sebelum request dikirim** — Health Check Aktif sudah menandai backend mati, jadi rotasi tidak memilihnya.
2. **Tengah request** — backend mati setelah dipilih, misalnya prosesnya baru dimatikan beberapa milidetik lalu.

Kasus kedua tidak bisa ditutup oleh health check saja: periodenya 2 detik, sedangkan backend bisa mati di sela periode itu. Tanpa penanganan, klien akan menerima error koneksi padahal dua backend lain masih sehat.

## Pilihan yang dipertimbangkan

1. **Tanpa retry** — klien menerima error bila kebetulan kena backend yang mati. Sederhana, tapi pengalaman pengguna buruk dan test failover jadi bergantung pada keberuntungan.
2. **Retry dengan streaming** — teruskan body langsung ke backend. Kalau gagal di tengah streaming, body request sudah habis terpakai dan tidak bisa dikirim ulang.
3. **Retry dengan buffer** — baca body request lebih dulu, buffer response backend, baru kirim ke klien. Bisa di-retry utuh, dengan biaya memori.

## Keputusan

Memilih **retry + buffer** (opsi 3), dengan batas body request 1 MB dan waktu tunggu backend 10 detik. Backend yang gagal langsung ditandai mati (failover pasif) sehingga request berikutnya tidak ikut terkena, lalu request yang gagal diulang ke backend lain (maksimal 2 percobaan).

## Konsekuensi

**Positif**
- Klien tidak melihat error saat backend mati di tengah jalan; test failover menjadi deterministik.
- Kegagalan langsung memperbarui status backend, jadi jendela "masih dianggap sehat" tertutup tanpa menunggu health check berikutnya.
- Response bisa diberi header `x-served-by` yang akurat karena ukurannya sudah diketahui.

**Negatif / biaya**
- Memori sebanding dengan ukuran response yang sedang diproses; tidak cocok untuk unduhan/file besar.
- Streaming (SSE, upload besar, chunked) tidak didukung sebagai streaming sungguhan.
- Retry mengirim ulang request ke backend lain, sehingga request non-idempoten berisiko dieksekusi dua kali bila kegagalan terjadi setelah backend sempat memproses. Untuk aplikasi demo ini dapat diterima; untuk sistem nyata perlu idempotency key.

**Kapan ditinjau ulang**
- Jika muncul kebutuhan upload/unduhan besar atau streaming, ganti ke streaming tanpa retry dan andalkan Health Check Aktif + circuit breaker, atau pindahkan tugas ini ke reverse proxy yang memang dirancang untuk itu.

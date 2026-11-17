# 0001 — Load balancer ditulis sendiri di Node.js, bukan Nginx atau Docker

- **Status:** **Digantikan (superseded)** oleh [ADR 0003](0003-traefik-container-variant.md). Kode varian Node (`src/load-balancer`, dashboard, 5 test Node, `scripts/run-all.js`, `scripts/request.js`) dan semua script `npm start` telah **dihapus** pada 17 November 2026; project sekarang hanya berisi varian container. Dokumen ini disimpan sebagai catatan sejarah keputusan.
- **Tanggal:** 17 November 2026

## Konteks

Project ini dibuat untuk memperlihatkan cara kerja load balancing ke 3 server, sekaligus membuktikan lewat test bahwa semuanya berjalan. Lingkungan pengembangan: Windows + Laragon, Node.js v22 tersedia, PHP tersedia, sedangkan daemon Docker Desktop tidak berjalan dan Go tidak terpasang.

Kebutuhan utama bukan performa tingkat produksi, melainkan **perilaku algoritma yang bisa diamati dan diuji** (pembagian request, deteksi backend mati, failover, pemulihan).

## Pilihan yang dipertimbangkan

1. **Node.js dari nol** — LB sebagai proses Node.js biasa yang mem-proxy request sendiri, algoritma ditulis eksplisit.
2. **Nginx** — `upstream` block, paling realistis untuk produksi, tapi algoritma jadi kotak hitam dan status internal sulit dibuktikan lewat test otomatis.
3. **Docker Compose + Nginx** — paling mendekati produksi, tetapi menambah ketergantungan pada daemon Docker yang saat ini tidak berjalan, plus satu lapisan yang harus dipelajari sebelum project bisa dijalankan.
4. **Node.js LB + backend dalam container** — campuran; tetap butuh Docker untuk sebagian komponen.

## Keputusan

Memilih **Node.js dari nol**, tanpa dependency eksternal.

## Konsekuensi

**Positif**
- Algoritma (round robin, least connections), health check, dan failover sepenuhnya terlihat dan bisa diubah.
- Test suite bisa menyalakan dan mematikan proses backend sungguhan untuk menguji failover, karena semuanya proses lokal.
- `npm start` dan `npm test` jalan tanpa instalasi tambahan, tanpa Docker.
- Statistik internal (koneksi aktif, jumlah request per backend) tersedia langsung untuk dashboard.

**Negatif / biaya**
- Bukan pengganti Nginx untuk produksi: tidak ada TLS, HTTP/2, caching, kompresi, atau tuning kernel.
- Body request/response di-buffer di memori agar bisa di-retry; tidak cocok untuk transfer file besar.
- Kode LB harus dirawat sendiri.

**Kapan keputusan ini sebaiknya ditinjau ulang**
- Jika tujuan berubah menjadi deployment nyata, atau muncul kebutuhan TLS/HTTP/2/streaming besar, pindah ke Nginx (atau container) lebih masuk akal, dan algoritma yang sudah terbukti di sini bisa dipakai sebagai acuan perilaku.

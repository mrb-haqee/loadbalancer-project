# 0014 — Urutan baca dashboard dan default Run k6

**Status**: diterima
**Tanggal**: 2026-11-18

## Konteks

Tiga dashboard sudah menampilkan angka yang benar, tetapi sulit dibaca:

- Hanya 3 dari 36 panel punya `description`; sisanya angka tanpa arti, nilai normal,
  atau tindakan.
- Tidak ada baris sekat maupun tautan antar-dashboard, jadi pembaca harus menebak
  urutan dan berpindah lewat daftar dashboard.
- `lb-realtime` mencampur trafik aplikasi dengan trafik Grafana/Adminer/trigger,
  sehingga panel "masuk" tidak bisa dibandingkan langsung dengan "diterima".
- `db-monitoring` menaruh topologi cluster (peran node, replikasi, lag) di bawah panel
  log, dan panel koneksi menampilkan tiga garis dengan legenda identik
  (`mariadb-primary` tiga kali).
- `k6-lb` memakai default variabel **Run = All**, sehingga beberapa Run dalam rentang
  waktu dijumlahkan menjadi satu angka yang menyesatkan.

## Keputusan

1. Tetap **tiga dashboard**. Tidak menambah dashboard ringkasan keempat yang akan
   menduplikasi query dan perawatan.
2. Urutan baca seragam di ketiganya: **kartu kesimpulan → trafik/latensi → detail per
   Backend/node → penyebab (alert + log)**.
3. Setiap dashboard diawali panel teks "Cara baca" dan memakai tautan silang di bar atas
   (`LB Realtime`, `Database`, `Pengujian k6`, pemicu Run, aplikasi).
4. Setiap panel punya `description` dengan pola **Arti · Normal · Jika merah** dan memakai
   istilah baku `GLOSSARY.md`.
5. Trafik internal (Grafana, Adminer, pemicu k6) dipisah dari trafik aplikasi.
6. Topologi cluster dinaikkan ke atas; tabel `Status per node` menggantikan tabel mentah
   Prometheus dan disusun setara `make db-status`.
7. Legenda dibuat unik per seri (`{{node}} · terbuka`, `{{node}} · jalan`,
   `{{node}} · batas`) agar tidak ada nama ganda.
8. Grafik status dipisah per kelompok (2xx/4xx/5xx) dan daftar Backend menampilkan jumlah
   sekaligus porsi persen.
9. Variabel **Run** k6 tidak lagi punya opsi `All`; default = Run terbaru (urut menurun),
   multi-pilih tetap tersedia untuk membandingkan.

## Konsekuensi

- Panel data bertambah: `lb-realtime` 14, `db-monitoring` 18, `k6-lb` 10. Tidak ada query
  baru yang mahal; semuanya turunan metrik yang sudah dikumpulkan.
- Tabel gabungan memakai transformasi `labelsToFields` → `joinByField` →
  `filterFieldsByName` → `organize`. Kalau label `node`/`server` dihapus dari query,
  tabel kehilangan baris; ini tercatat di bagian Troubleshooting.
- Dashboard tetap diprovisi dari file (`allowUiUpdates: false`). Perubahan harus lewat
  JSON di repo, bukan UI, supaya bisa diulang.
- Dokumentasi panel di `README.md` dan `docs/database-monitoring.md` wajib ikut diperbarui
  saat panel berubah.

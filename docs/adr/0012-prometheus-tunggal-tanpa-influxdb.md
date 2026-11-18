# Prometheus tunggal untuk metrik k6 dan trafik nyata (hapus InfluxDB)

- **Status:** accepted (menggantikan bagian penyimpanan [ADR 0004](0004-k6-container-influxdb-grafana.md))

Sejak Prometheus ditambahkan untuk memantau trafik nyata Traefik, backend, dan MariaDB, menyimpan hasil k6 di InfluxDB 1.8 membuat stack menjalankan dua database deret waktu sekaligus untuk volume data demo yang kecil. Kami menghapus container, volume, dan datasource InfluxDB 1.8, mengaktifkan `--web.enable-remote-write-receiver` pada Prometheus yang sudah berjalan, serta mengubah dashboard `k6-lb` ke PromQL dengan filter label `run`. Hasilnya: satu container lebih sedikit, satu bahasa query metrik di seluruh dashboard, tanpa kehilangan pemisahan riwayat per Run.

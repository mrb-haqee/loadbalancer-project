# Menambah server ke load balancer

Panduan menambah `server-6` (berlaku sama untuk server berikutnya). Baseline saat ini:
lima backend, `server-1` sampai `server-5`.

## Ringkas: yang wajib diubah

| File | Perubahan | Kenapa |
|---|---|---|
| `docker-compose.yml` | tambah anchor `x-direct-6` + service `server-6` | container baru + router langsungnya |
| `test/docker/lb-docker.test.js` | `SERVERS`, jumlah server, batas round robin, ekspektasi failover | test mematok jumlah server |
| `test/docker/helpers/docker-stack.js` | `servers.length === 5` → `=== 6` (dua tempat) | test menunggu semua server UP |
| `README.md`, `GLOSSARY.md`, `package.json` | sebutan "5 server" (opsional tapi disarankan) | dokumentasi tidak bohong |
| `db/init/001-schema.sql` **atau** UI `/ui` | baris katalog `server-6` (opsional) | hanya katalog; tidak mengubah rotasi |

Yang **tidak** perlu diubah: `docker-compose.traefik.yml`, `docker/traefik/traefik.yml`,
`monitoring/prometheus/prometheus.yml`, dashboard `lb-realtime`, dashboard k6,
`k6/lib/backend-counters.js`, dan seluruh stack database.

Monitoring **tidak punya daftar server**:

- Prometheus menemukan backend lewat `docker_sd_configs` (label `lb.monitor=true`,
  network `lb-net`), label `server` diambil dari nama service compose.
- k6 mencatat sebaran di satu metric `served` dengan tag `server`; panel Grafana-nya satu
  query `GROUP BY "server"`.
- Log backend baru otomatis ikut Loki karena label `lb.logs=true` ada di `x-main-labels`;
  metrik `lb_db_*` juga otomatis muncul di `/metrics` tanpa konfigurasi tambahan.

## 1. `docker-compose.yml`

Tambah anchor setelah `x-direct-5`:

```yaml
x-direct-6: &direct-6
  traefik.http.routers.direct-6.entrypoints: "web"
  traefik.http.routers.direct-6.rule: "Host(`server-6.localhost`)"
  traefik.http.routers.direct-6.priority: "100"
  traefik.http.routers.direct-6.service: "direct-6"
  traefik.http.services.direct-6.loadbalancer.server.port: "3000"
```

Tambah service setelah `server-5`:

```yaml
  server-6:
    image: lb-demo-backend:latest
    environment:
      BACKEND_ID: server-6
      <<: *db-env
    networks:
      - lb-net
    labels:
      <<: [*main-labels, *direct-6]
    restart: unless-stopped
```

Kenapa cuma ini:

- `*main-labels` sudah memuat router `demo` + service `demo`. Semua container yang
  mendeklarasikan service `demo` otomatis digabung Traefik jadi satu pool — server baru
  langsung ikut round robin tanpa menyentuh router.
- Rule `demo` sudah mengecualikan `server-[0-9]+[.]localhost`, jadi `server-6.localhost`
  tidak akan tertelan catch-all. Tanpa `direct-6`, host itu justru **404**.
- `priority: 100` (di atas `demo` = 1) membuat URL langsung selalu menunjuk server itu.
- `*db-env` wajib ikut supaya `/ui` dan `/api/servers` di container baru bisa membaca
  MariaDB. Tanpa itu, CRUD di server-6 membalas 503.

Tidak perlu `build:` — image `lb-demo-backend:latest` sudah ada. Kalau ingin build ulang:
`make docker-up`.

Opsional, tambahkan baris katalog supaya UI ikut menampilkan server-6:

```bash
curl -s -X POST http://server.localhost/api/servers \
  -H "content-type: application/json" \
  -d '{"name":"server-6","host":"server-6","port":3000,"weight":1,"enabled":true,"note":"backend keenam"}'
```

Atau edit `db/init/001-schema.sql` lalu `make db-reset`. Ingat: baris katalog **tidak**
membuat Traefik mengarahkan trafik ke container; label compose yang melakukannya.

## 2. Monitoring: tidak ada yang perlu diubah

Begitu service baru jalan, keduanya otomatis:

| Komponen | Mekanisme |
|---|---|
| Prometheus | `docker_sd_configs` menemukan container berlabel `lb.monitor=true` (label ada di `x-main-labels`), filter network `lb-net`, alamat `IP:3000`, label `server` dari nama service compose |
| Dashboard `lb-realtime` | query `sum by (server)`, garis baru muncul sendiri |
| k6 + panel sebaran | satu metric `served` dengan tag `server`; panel `GROUP BY "server"` |

Verifikasi target tanpa menyentuh config:

```bash
curl -s "http://grafana.localhost/api/datasources/proxy/uid/prometheus/api/v1/query?query=up%7Bjob%3D%22backend%22%7D"
```

Kalau `server-6` tidak muncul: pastikan label `lb.monitor=true`, container ada di
`lb-net`, dan Prometheus tidak kehilangan akses `docker.sock` (lihat README bagian
Troubleshooting).

## 3. Test suite

`test/docker/lb-docker.test.js`:

```js
const SERVERS = ['server-1', 'server-2', 'server-3', 'server-4', 'server-5', 'server-6'];
```

Angka yang masih mematok jumlah server (sesuaikan semua):

| Lokasi | Sekarang | Jadi |
|---|---|---|
| smoke, `demo.loadBalancer.servers.length` | `5` | `6` |
| round robin, `Object.keys(counts).length` | `5` | `6` |
| round robin, batas per server (30 request / 6) | `3`–`12` | `2`–`10` |
| beban, `Object.keys(countBy(results)).length` | `5` | `6` |
| failover, jumlah saat server-2 mati | `4` | `5` |
| failover, daftar server yang tersisa | `server-1,3,4,5` | `server-1,3,4,5,6` |
| failover, jumlah setelah pulih | `5` | `6` |

`test/docker/helpers/docker-stack.js` (dua tempat di fungsi `up`):

```js
return servers.length === 6 && statuses.filter((status) => status === 'UP').length === 6;
```

dan label `waitFor`-nya ikut diubah menjadi `'6 server terdaftar dan berstatus UP di Traefik'`.

## 4. Verifikasi

```bash
make docker-up
curl http://server-6.localhost/siapa-kamu          # harus servedBy server-6
curl -s http://127.0.0.1:8089/api/http/services     # demo@docker harus 6 server
make test-backend                                    # unit test validasi CRUD
make test                                            # harus lulus semua
```

Cek UI: `http://server-6.localhost/ui` harus terbuka dan menampilkan katalog yang sama
(header "Dilayani oleh" menunjukkan `server-6`).

Cek dashboard: `http://grafana.localhost/d/lb-realtime` — panel "Request diterima per
server" harus punya 6 garis, "Backend sehat" = 6.

## Jebakan

- **Label `lb.monitor` hilang** → Prometheus tidak menemukan container itu: panel
  `lb-realtime` tetap 5 server walau container hidup. Label ada di `x-main-labels`.
- **Lupa `x-direct-6`** → `server-6.localhost` 404, padahal pool sudah berisi 6 server.
- **Lupa `*db-env`** → UI/CRUD di server-6 balas 503 `DATABASE_UNAVAILABLE`, padahal
  endpoint demo tetap jalan.
- **Lupa menaikkan angka di test** → `make test` timeout menunggu "5 server" padahal
  Traefik punya 6, atau failover gagal karena daftar server tersisa masih 4.
- **DNS `*.localhost`** tidak selalu resolve untuk nama baru di Windows. Test otomatis
  aman (memakai header `Host`); untuk browser, tambahkan entri hosts bila perlu.
- **Port beda** → ubah `loadbalancer.server.port` dan target scrape; health check
  Docker/Traefik tetap `/health`.
- **Health check** di `docker/backend.Dockerfile` dan `*main-labels` sudah generik,
  tidak perlu disentuh selama server tetap melayani `/health` di port 3000.
- **Traefik butuh ±2 detik** untuk mendaftarkan container baru; kalau langsung ditembak
  bisa 404 sebentar.
- **Jangan** menambah container dengan nama service lain (mis. `server-6-extra`) tanpa
  label `demo` — ia tidak akan masuk pool.

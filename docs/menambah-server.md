# Menambah server ke load balancer

Panduan menambah `server-4` (berlaku sama untuk server-5, server-6, dst).

## Ringkas: yang wajib diubah

| File | Perubahan | Kenapa |
|---|---|---|
| `docker-compose.yml` | tambah anchor `x-direct-N` + service `server-N` | container baru + router langsungnya |
| `monitoring/prometheus/prometheus.yml` | tambah satu target `server-N:3000` | agar metrik server baru masuk dashboard |
| `test/docker/lb-docker.test.js` | `SERVERS`, jumlah server, batas round robin | test mematok angka 3 |
| `test/docker/helpers/docker-stack.js` | `servers.length === 3` → `=== 4` | test menunggu 3 server UP |
| `README.md`, `GLOSSARY.md`, `package.json` | sebutan "3 server" (opsional tapi disarankan) | dokumentasi tidak bohong |

Yang **tidak** perlu diubah: `docker-compose.traefik.yml`, `docker/traefik/traefik.yml`, dashboard Grafana, skrip k6.

## 1. `docker-compose.yml`

Tambah anchor setelah `x-direct-3`:

```yaml
x-direct-4: &direct-4
  traefik.http.routers.direct-4.entrypoints: "web"
  traefik.http.routers.direct-4.rule: "Host(`server-4.localhost`)"
  traefik.http.routers.direct-4.priority: "100"
  traefik.http.routers.direct-4.service: "direct-4"
  traefik.http.services.direct-4.loadbalancer.server.port: "3000"
```

Tambah service setelah `server-3`:

```yaml
  server-4:
    image: lb-demo-backend:latest
    environment:
      BACKEND_ID: server-4
    networks:
      - lb-net
    labels:
      <<: [*demo-labels, *direct-4]
    restart: unless-stopped
```

Kenapa cuma ini:

- `*demo-labels` sudah memuat router `demo` + service `demo`. Semua container yang mendeklarasikan service `demo` otomatis digabung Traefik jadi satu pool — server baru langsung ikut round robin tanpa menyentuh router.
- Rule `demo` sudah mengecualikan `server-[0-9]+[.]localhost`, jadi `server-4.localhost` tidak akan tertelan catch-all. Tanpa `direct-4`, host itu justru **404** (bukan jatuh ke pool).
- `priority: 100` (di atas `demo` = 1) membuat URL langsung selalu menunjuk server itu.

Tidak perlu `build:` — image `lb-demo-backend:latest` sudah ada. Kalau ingin build ulang: `npm run docker:up`.

## 2. `monitoring/prometheus/prometheus.yml`

```yaml
      - targets: ["server-4:3000"]
        labels:
          server: server-4
```

Lalu muat ulang config (container restart membaca ulang file yang di-mount):

```bash
docker compose -p lb-k6 -f docker-compose.monitoring.yml restart prometheus
```

Dashboard `lb-realtime` tidak perlu diubah: semua query memakai `sum by (server)`, jadi garis keempat muncul sendiri. Panel "Backend sehat" juga ikut naik (target 4), tapi ambang hijaunya masih 3 — cukup, tidak wajib diubah.

## 3. Test suite

`test/docker/lb-docker.test.js`:

```js
const SERVERS = ['server-1', 'server-2', 'server-3', 'server-4'];
```

Angka yang masih patok 3 (semua harus disesuaikan):

| Baris | Sekarang | Jadi |
|---|---|---|
| 66 | `demo.loadBalancer.servers.length, 3` | `4` |
| 92 | `Object.keys(counts).length, 3` | `4` |
| 94 | `counts[name] >= 5 && counts[name] <= 15` (30 req / 3) | `>= 3 && <= 12` (30 req / 4) |
| 132 | `Object.keys(countBy(results)).length, 3` | `4` |
| 187 | `demo.loadBalancer.servers.length, 3` | `4` |

`test/docker/helpers/docker-stack.js` baris 156:

```js
return servers.length === 4 && statuses.filter((status) => status === 'UP').length === 4;
```

Failover test (baris 136–188) tidak perlu diubah: ia mematikan `server-2`, jadi angka 2 (`length === 2`) dan `['server-1','server-3']` tetap benar.

## 4. Verifikasi

```bash
npm run docker:up
curl http://server-4.localhost/siapa-kamu          # harus servedBy server-4
curl -s http://127.0.0.1:8089/api/http/services     # demo@docker harus 4 server
npm test                                            # harus lulus semua
```

Cek dashboard: `http://grafana.localhost/d/lb-realtime` — panel "Request diterima per server" harus punya 4 garis, "Backend sehat" = 4.

Cek scrape:

```bash
curl -s "http://grafana.localhost/api/datasources/proxy/uid/prometheus/api/v1/query?query=up%7Bjob%3D%22backend%22%7D"
```

## Jebakan

- **Lupa `x-direct-4`** → `server-4.localhost` 404, padahal pool sudah berisi 4 server. Gejala: LB jalan, URL langsung tidak.
- **Lupa label `server: server-4`** di Prometheus → grafik bertambah tapi legend jadi `server-4:3000` (IP/instance), bukan `server-4`.
- **Tidak restart Prometheus** → target baru tidak pernah muncul walau file sudah diubah.
- **Port beda** → ubah `loadbalancer.server.port` dan target scrape; health check Docker/Traefik tetap `/health`.
- **Health check** di `docker/backend.Dockerfile` dan `*demo-labels` sudah generik, tidak perlu disentuh selama server tetap melayani `/health` di port 3000.
- **Traefik butuh ±2 detik** untuk mendaftarkan container baru; kalau langsung ditembak bisa 404 sebentar.
- **Jangan** menambah container dengan nama service lain (mis. `server-4-extra`) tanpa label `demo` — ia tidak akan masuk pool.
- Batas praktis: semua backend memakai satu image dan satu network `lb-net`; menambah puluhan server hanya menambah beban CPU Docker di laptop, bukan masalah konfigurasi.

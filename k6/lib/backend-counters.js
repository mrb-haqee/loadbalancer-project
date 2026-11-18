import { Counter } from 'k6/metrics';

/**
 * Satu counter untuk semua backend, dibedakan lewat tag `server`.
 *
 * Dulu dibuat satu Counter per server (`served_server_1`, ...), sehingga
 * menambah server berarti menyunting file ini DAN dashboard Grafana.
 * Dengan tag, k6 tidak perlu tahu ada berapa server: apa pun yang muncul di
 * header `X-Served-By` otomatis tercatat sebagai label metrik Prometheus (`k6_served_total`).
 *
 * Catatan: tag tidak muncul sebagai baris terpisah di ringkasan konsol k6,
 * tetapi tersimpan sebagai label di Prometheus dan bisa dipecah per `server` di dashboard.
 */
const served = new Counter('served');

export function recordServedBy(server) {
  if (!server) return false;
  served.add(1, { server });
  return true;
}
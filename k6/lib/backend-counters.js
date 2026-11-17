import { Counter } from 'k6/metrics';

/**
 * Satu counter untuk semua backend, dibedakan lewat tag `server`.
 *
 * Dulu dibuat satu Counter per server (`served_server_1`, ...), sehingga
 * menambah server berarti menyunting file ini DAN dashboard Grafana.
 * Dengan tag, k6 tidak perlu tahu ada berapa server: apa pun yang muncul di
 * header `X-Served-By` otomatis tercatat sebagai tag InfluxDB.
 *
 * Catatan: tag tidak muncul sebagai baris terpisah di ringkasan konsol k6,
 * tetapi tersimpan sebagai tag InfluxDB dan bisa di-GROUP BY di dashboard.
 */
const served = new Counter('served');

export function recordServedBy(server) {
  if (!server) return false;
  served.add(1, { server });
  return true;
}
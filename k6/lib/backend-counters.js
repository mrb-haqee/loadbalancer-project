import { Counter } from 'k6/metrics';

/**
 * Counter eksplisit per backend, dipakai bersama oleh semua skrip k6.
 *
 * Catatan: di k6 v2.4 tag pada custom metric tidak muncul sebagai sub-metric
 * di ringkasan, jadi tiap backend dibuatkan metric sendiri agar sebarannya
 * terlihat jelas di output.
 *
 * Mendukung dua varian:
 *   - Node      : server-1, server-2, server-3
 *   - Container : backend-1, backend-2, backend-3
 */
const BACKENDS = [
  'server-1',
  'server-2',
  'server-3',
  'backend-1',
  'backend-2',
  'backend-3',
];

const counters = Object.fromEntries(
  BACKENDS.map((name) => [name, new Counter(`served_${name.replace(/-/g, '_')}`)]),
);

export function recordServedBy(server) {
  const counter = counters[server];
  if (counter) counter.add(1);
  return Boolean(counter);
}

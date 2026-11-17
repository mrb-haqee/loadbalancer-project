import http from 'k6/http';
import { check } from 'k6';
import { recordServedBy } from './lib/backend-counters.js';

/**
 * Skenario failover: jalankan skrip ini, lalu matikan satu container di tengah jalan
 * (`docker compose -p lb-demo stop server-2`). Threshold http_req_failed < 1%
 * membuktikan klien hampir tidak terkena dampak.
 *
 *   bun scripts/k6.js run k6/failover.js                          # http://server.localhost (port 80)
 *   bun scripts/k6.js run k6/failover.js -e BASE_URL=http://127.0.0.1:8088
 */
const BASE_URL = __ENV.BASE_URL || 'http://server.localhost';
// Tag `run` membedakan tiap eksekusi di dashboard Grafana (bisa difilter).
const RUN_ID = __ENV.RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');

export const options = {
  tags: { run: RUN_ID },
  scenarios: {
    terus_menerus: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 50),
      timeUnit: '1s',
      duration: __ENV.DURATION || '40s',
      preAllocatedVUs: 30,
      maxVUs: 200,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/saat-failover?dari=k6`);
  const server = res.headers['X-Served-By'] || res.headers['x-served-by'] || '';
  recordServedBy(server);

  check(res, {
    'status 200': (r) => r.status === 200,
    'ada x-served-by': () => server !== '',
  });
}

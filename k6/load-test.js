import http from 'k6/http';
import { check } from 'k6';
import { recordServedBy } from './lib/backend-counters.js';

// Default: URL load balancer tanpa port (port 80).
//   bun scripts/k6.js run k6/load-test.js -e BASE_URL=http://127.0.0.1:8088
//   bun scripts/k6.js run k6/load-test.js -e BASE_URL=http://server-1.localhost   # satu server saja
const BASE_URL = __ENV.BASE_URL || 'http://server.localhost';
const PATH = __ENV.PATH || '/halo';

export const options = {
  scenarios: {
    tetap: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 100),
      timeUnit: '1s',
      duration: __ENV.DURATION || '15s',
      preAllocatedVUs: 20,
      maxVUs: 150,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}${PATH}?dari=k6`);
  const server = res.headers['X-Served-By'] || res.headers['x-served-by'] || '';

  recordServedBy(server);

  check(res, {
    'status 200': (r) => r.status === 200,
    'ada header x-served-by': () => server !== '',
    'identitas backend valid': () => /^(server|backend)-\d+$/.test(server),
    'body berisi servedBy': (r) => {
      try {
        return r.json('servedBy') === server;
      } catch {
        return false;
      }
    },
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DASHBOARD_URL,
  LB_URL,
  dockerAvailable,
  down,
  request,
  services,
  startService,
  stopService,
  up,
  waitFor,
} from './helpers/docker-stack.js';

const BACKENDS = ['backend-1', 'backend-2', 'backend-3'];

function countBy(results) {
  const counts = {};
  for (const res of results) counts[res.servedBy] = (counts[res.servedBy] ?? 0) + 1;
  return counts;
}

test(
  'varian container: Traefik 3 backend',
  {
    timeout: 600000,
    skip: dockerAvailable() ? false : 'Docker daemon tidak berjalan (nyalakan Docker Desktop)',
  },
  async (t) => {
    await up({ rebuild: true });
    t.after(() => down());

    await t.test('smoke: 3 container sehat, Traefik mendaftarkan 3 server, dashboard hidup', async () => {
      const list = services();
      for (const name of BACKENDS) {
        const svc = list.find((entry) => entry.Service === name);
        assert.ok(svc, `${name} harus ada di compose ps`);
        assert.equal(svc.State, 'running', `${name} harus running`);
        assert.equal(svc.Health, 'healthy', `${name} harus healthy`);
      }

      const lb = await request('/halo?dari=test');
      assert.equal(lb.status, 200);
      assert.ok(BACKENDS.includes(lb.servedBy), `x-served-by tidak valid: ${lb.servedBy}`);
      assert.equal(lb.body.servedBy, lb.servedBy);
      assert.equal(lb.body.query.dari, 'test');

      // API Traefik: bukti ketiga server benar-benar terdaftar di satu service.
      const api = await request('/api/http/services', { base: DASHBOARD_URL });
      assert.equal(api.status, 200);
      const demo = api.body.find((svc) => String(svc.name).startsWith('demo@'));
      assert.ok(demo, 'service demo@docker harus ada');
      assert.equal(demo.loadBalancer.servers.length, 3, 'service harus berisi 3 server');

      const routers = await request('/api/http/routers', { base: DASHBOARD_URL });
      assert.ok(
        routers.body.some((router) => String(router.name).startsWith('demo@') && router.status === 'enabled'),
        'router demo harus enabled',
      );

      const dashboard = await request('/dashboard/', { base: DASHBOARD_URL });
      assert.equal(dashboard.status, 200);
      assert.match(dashboard.text, /traefik/i);
    });

    await t.test('round robin: 30 request terbagi rata ke 3 container', async () => {
      const results = [];
      for (let i = 0; i < 30; i += 1) {
        const res = await request(`/pilih?i=${i}`);
        assert.equal(res.status, 200);
        assert.ok(res.servedBy, 'setiap response harus punya x-served-by');
        results.push(res);
      }

      const counts = countBy(results);
      assert.equal(Object.keys(counts).length, 3, `harus dilayani 3 backend, dapat: ${JSON.stringify(counts)}`);
      for (const name of BACKENDS) {
        assert.ok(counts[name] >= 5 && counts[name] <= 15, `porsi ${name} tidak wajar: ${JSON.stringify(counts)}`);
      }
      t.diagnostic(`sebaran 30 request: ${JSON.stringify(counts)}`);
    });

    await t.test('beban: 300 request / 20 konkuren, nol gagal', async () => {
      const total = 300;
      const concurrency = 20;
      let next = 0;
      const results = [];

      const worker = async () => {
        while (true) {
          const index = next;
          next += 1;
          if (index >= total) return;
          results.push(await request(`/beban?i=${index}`));
        }
      };

      const startedAt = Date.now();
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      const durationMs = Date.now() - startedAt;

      const failed = results.filter((res) => res.status !== 200);
      assert.equal(failed.length, 0, `${failed.length} request gagal`);
      const counts = countBy(results);
      assert.equal(Object.keys(counts).length, 3, `semua backend harus kebagian: ${JSON.stringify(counts)}`);
      t.diagnostic(`300 request dalam ${durationMs}ms (±${Math.round((total / durationMs) * 1000)} req/detik)`);
    });

    await t.test('failover: container dimatikan → request tetap 200, keluar rotasi, pulih saat dihidupkan', async () => {
      let stopError = null;
      try {
        stopService('backend-2');
      } catch (error) {
        stopError = error;
      }
      assert.equal(stopError, null, `gagal stop backend-2: ${stopError?.message ?? ''}`);

      // Jendela sebelum Traefik menyadari: retry middleware harus menyelamatkan request.
      const duringWindow = [];
      for (let i = 0; i < 12; i += 1) duringWindow.push(await request(`/saat-mati?i=${i}`));
      assert.ok(
        duringWindow.every((res) => res.status === 200),
        `harus tetap 200, dapat: ${duringWindow.map((res) => res.status).join(',')}`,
      );

      await waitFor(
        async () => {
          const api = await request('/api/http/services', { base: DASHBOARD_URL });
          const demo = api.body.find((svc) => String(svc.name).startsWith('demo@'));
          return demo?.loadBalancer?.servers?.length === 2;
        },
        { label: 'Traefik menurunkan backend-2 menjadi 2 server', timeoutMs: 40000 },
      );

      const afterDown = [];
      for (let i = 0; i < 20; i += 1) afterDown.push(await request(`/setelah-mati?i=${i}`));
      assert.ok(afterDown.every((res) => res.status === 200));
      assert.ok(afterDown.every((res) => res.servedBy !== 'backend-2'));

      const countsDown = countBy(afterDown);
      assert.deepEqual(Object.keys(countsDown).sort(), ['backend-1', 'backend-3']);

      startService('backend-2');
      await waitFor(
        async () => {
          const res = await request('/pulih');
          return res.status === 200 && res.servedBy === 'backend-2';
        },
        { label: 'backend-2 kembali masuk rotasi', timeoutMs: 40000 },
      );

      const api = await request('/api/http/services', { base: DASHBOARD_URL });
      const demo = api.body.find((svc) => String(svc.name).startsWith('demo@'));
      assert.equal(demo.loadBalancer.servers.length, 3, 'server harus kembali berjumlah 3');
    });

    t.diagnostic(`stack: ${LB_URL} (dashboard ${DASHBOARD_URL})`);
  },
);

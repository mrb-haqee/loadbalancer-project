import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DASHBOARD_URL,
  LB_HOST_URL,
  LB_URL,
  directUrl,
  dockerAvailable,
  down,
  request,
  services,
  startService,
  stopService,
  up,
  waitFor,
} from './helpers/docker-stack.js';

const SERVERS = ['server-1', 'server-2', 'server-3', 'server-4', 'server-5'];

function countBy(results) {
  const counts = {};
  for (const res of results) counts[res.servedBy] = (counts[res.servedBy] ?? 0) + 1;
  return counts;
}

test(
  'varian container: Traefik 5 server + URL sendiri per server',
  {
    timeout: 600000,
    skip: dockerAvailable() ? false : 'Docker daemon tidak berjalan (nyalakan Docker Desktop)',
  },
  async (t) => {
    await up({ rebuild: true });
    t.after(() => down());

    await t.test('smoke: 5 container sehat, dashboard hidup, semua URL menjawab', async () => {
      const list = services();
      for (const name of SERVERS) {
        const svc = list.find((entry) => entry.Service === name);
        assert.ok(svc, `${name} harus ada di compose ps`);
        assert.equal(svc.State, 'running', `${name} harus running`);
        assert.equal(svc.Health, 'healthy', `${name} harus healthy`);
      }

      // URL load balancer tanpa port.
      const viaHost = await request('/halo?dari=host');
      assert.equal(viaHost.status, 200);
      assert.ok(SERVERS.includes(viaHost.servedBy), `x-served-by tidak valid: ${viaHost.servedBy}`);
      assert.equal(viaHost.body.query.dari, 'host');

      // Cadangan lewat port 8088.
      const viaPort = await request('/halo', { base: LB_URL });
      assert.equal(viaPort.status, 200);

      // URL masing-masing server: harus selalu server itu, bukan hasil load balancing.
      for (const name of SERVERS) {
        const res = await request('/siapa-kamu', { base: directUrl(name) });
        assert.equal(res.status, 200, `${directUrl(name)} harus 200`);
        assert.equal(res.body.servedBy, name, `${directUrl(name)} harus dilayani ${name}`);
        assert.equal(res.servedBy, name);
      }

      // Traefik: 1 service load balance (5 server) + 5 service langsung (1 server).
      const api = await request('/api/http/services', { base: DASHBOARD_URL });
      const demo = api.body.find((svc) => String(svc.name).startsWith('demo@'));
      assert.equal(demo.loadBalancer.servers.length, 5, 'service demo harus berisi 5 server');

      const routers = await request('/api/http/routers', { base: DASHBOARD_URL });
      for (const name of SERVERS) {
        const routeName = `direct-${name.split('-')[1]}`;
        const router = routers.body.find((entry) => String(entry.name).startsWith(`${routeName}@`));
        assert.ok(router, `router ${routeName} harus ada`);
        assert.equal(router.status, 'enabled');
        const svc = api.body.find((entry) => String(entry.name).startsWith(`${routeName}@`));
        assert.equal(svc.loadBalancer.servers.length, 1, `${routeName} harus dipatok ke 1 server`);
      }

      const dashboard = await request('/dashboard/', { base: DASHBOARD_URL });
      assert.equal(dashboard.status, 200);
      assert.match(dashboard.text, /traefik/i);
    });

    await t.test('round robin: 30 request ke server.localhost terbagi rata', async () => {
      const results = [];
      for (let i = 0; i < 30; i += 1) {
        const res = await request(`/pilih?i=${i}`);
        assert.equal(res.status, 200);
        results.push(res);
      }

      const counts = countBy(results);
      assert.equal(Object.keys(counts).length, 5, `harus dilayani 5 server, dapat: ${JSON.stringify(counts)}`);
      for (const name of SERVERS) {
        assert.ok(counts[name] >= 3 && counts[name] <= 12, `porsi ${name} tidak wajar: ${JSON.stringify(counts)}`);
      }
      t.diagnostic(`sebaran 30 request via ${LB_HOST_URL}: ${JSON.stringify(counts)}`);
    });

    await t.test('URL per server tidak ikut load balancing (6x tetap server yang sama)', async () => {
      for (const name of SERVERS) {
        const seen = [];
        for (let i = 0; i < 6; i += 1) {
          const res = await request(`/pinned?i=${i}`, { base: directUrl(name) });
          assert.equal(res.status, 200);
          seen.push(res.servedBy);
        }
        assert.deepEqual(seen, Array(6).fill(name), `${directUrl(name)} tidak konsisten: ${seen.join(',')}`);
      }
    });

    await t.test('beban: 300 request / 20 konkuren ke server.localhost, nol gagal', async () => {
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
      assert.equal(Object.keys(countBy(results)).length, 5);
      t.diagnostic(`300 request dalam ${durationMs}ms (±${Math.round((total / durationMs) * 1000)} req/detik)`);
    });

    await t.test('failover: server-2 mati → LB tetap 200, URL server-2 tidak menipu', async () => {
      stopService('server-2');

      // Jendela sebelum Traefik menyadari: retry middleware menyelamatkan request.
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
          return demo?.loadBalancer?.servers?.length === 4;
        },
        { label: 'Traefik menurunkan server-2 (tinggal 4 server)', timeoutMs: 40000 },
      );

      // URL LB tetap jalan, hanya 4 server.
      const afterDown = [];
      for (let i = 0; i < 20; i += 1) afterDown.push(await request(`/setelah-mati?i=${i}`));
      assert.ok(afterDown.every((res) => res.status === 200));
      assert.deepEqual(Object.keys(countBy(afterDown)).sort(), ['server-1', 'server-3', 'server-4', 'server-5']);

      // URL server-2 harus gagal (tidak jatuh ke load balancer / server lain).
      await waitFor(
        async () => {
          const res = await request('/masih-hidup?', { base: directUrl('server-2') });
          return res.status >= 400;
        },
        { label: 'URL server-2 menolak saat server-nya mati', timeoutMs: 40000 },
      );

      // URL server-1 tetap menunjuk server-1.
      const pinnedStillOk = await request('/cek', { base: directUrl('server-1') });
      assert.equal(pinnedStillOk.status, 200);
      assert.equal(pinnedStillOk.servedBy, 'server-1');

      startService('server-2');
      await waitFor(
        async () => {
          const res = await request('/pulih', { base: directUrl('server-2') });
          return res.status === 200 && res.servedBy === 'server-2';
        },
        { label: 'URL server-2 hidup lagi', timeoutMs: 40000 },
      );

      const api = await request('/api/http/services', { base: DASHBOARD_URL });
      const demo = api.body.find((svc) => String(svc.name).startsWith('demo@'));
      assert.equal(demo.loadBalancer.servers.length, 5, 'server harus kembali berjumlah 5');
    });

    t.diagnostic(`URL: ${LB_HOST_URL} · ${LB_URL} · dashboard ${DASHBOARD_URL}`);
  },
);

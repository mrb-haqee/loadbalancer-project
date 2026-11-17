import test from 'node:test';
import assert from 'node:assert/strict';
import { startCluster, waitFor } from './helpers/cluster.js';

test('failover: backend dimatikan → request tetap 200, lalu dikeluarkan dari rotasi, dan pulih otomatis', { timeout: 60000 }, async (t) => {
  const cluster = await startCluster({
    algorithm: 'round-robin',
    healthCheck: { intervalMs: 200, timeoutMs: 200 },
  });
  t.after(() => cluster.stop());

  const initial = (await cluster.stats()).body;
  assert.equal(initial.healthyCount, 3);

  await cluster.killBackend('server-2');

  // Failover pasif: sesaat setelah mati, request masih sukses karena di-retry ke backend lain.
  const immediate = [];
  for (let i = 0; i < 6; i += 1) {
    const res = await cluster.request(`/saat-mati?i=${i}`);
    immediate.push(res);
  }
  assert.ok(
    immediate.every((res) => res.status === 200),
    `harus tetap 200, dapat: ${immediate.map((res) => res.status).join(',')}`,
  );
  assert.ok(
    immediate.every((res) => res.servedBy !== 'server-2'),
    'tidak boleh ada response dari backend yang sudah mati',
  );

  // Failover aktif: health check menurunkan server-2 dari daftar sehat.
  await waitFor(
    async () => {
      const { body } = await cluster.stats();
      const entry = body.backends.find((b) => b.id === 'server-2');
      return entry.healthy === false && entry.lastError !== null;
    },
    { label: 'server-2 ditandai mati oleh health check', timeoutMs: 10000 },
  );

  const lbHealth = await cluster.request('/health');
  assert.equal(lbHealth.status, 200, 'LB masih sehat karena 2 backend lain hidup');
  assert.equal(lbHealth.body.healthyBackends, 2);

  const afterDown = [];
  for (let i = 0; i < 6; i += 1) {
    const res = await cluster.request(`/setelah-mati?i=${i}`);
    assert.equal(res.status, 200);
    afterDown.push(res.servedBy);
  }
  assert.ok(afterDown.every((id) => id === 'server-1' || id === 'server-3'));
  assert.deepEqual([...new Set(afterDown)].sort(), ['server-1', 'server-3']);
  for (let i = 1; i < afterDown.length; i += 1) {
    assert.notEqual(
      afterDown[i],
      afterDown[i - 1],
      `round robin harus bergantian, dapat: ${afterDown.join(',')}`,
    );
  }

  // Recovery: backend dihidupkan lagi → otomatis masuk rotasi.
  await cluster.startBackend('server-2');
  await waitFor(
    async () => {
      const { body } = await cluster.stats();
      return body.backends.find((b) => b.id === 'server-2').healthy === true;
    },
    { label: 'server-2 kembali sehat', timeoutMs: 10000 },
  );

  const afterUp = [];
  for (let i = 0; i < 3; i += 1) {
    afterUp.push((await cluster.request(`/setelah-pulih?i=${i}`)).servedBy);
  }
  assert.ok(afterUp.includes('server-2'), `server-2 harus ikut rotasi lagi, dapat: ${afterUp.join(',')}`);
});

test('failover: semua backend mati → load balancer membalas 503 dengan jelas', { timeout: 60000 }, async (t) => {
  const cluster = await startCluster({
    algorithm: 'round-robin',
    healthCheck: { intervalMs: 150, timeoutMs: 150 },
  });
  t.after(() => cluster.stop());

  for (const backend of cluster.config.backends) {
    await cluster.killBackend(backend.id);
  }

  await waitFor(
    async () => {
      const { body } = await cluster.stats();
      return body.healthyCount === 0;
    },
    { label: 'semua backend ditandai mati', timeoutMs: 10000 },
  );

  const res = await cluster.request('/tidak-ada-backend');
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'tidak ada backend sehat yang tersedia');
  assert.deepEqual(res.body.tried, []);

  const lbHealth = await cluster.request('/health');
  assert.equal(lbHealth.status, 503);
  assert.equal(lbHealth.body.status, 'degraded');

  const { body } = await cluster.stats();
  assert.equal(body.totals.rejected, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { startCluster, waitFor } from './helpers/cluster.js';

test('least-connections: backend yang sedang sibuk tidak dikirimi request baru', { timeout: 40000 }, async (t) => {
  const cluster = await startCluster({ algorithm: 'least-connections' });
  t.after(() => cluster.stop());

  // Request lambat pertama pasti jatuh ke server-1 (semua masih idle).
  const slow = cluster.request('/slow?ms=1500');

  await waitFor(
    async () => {
      const { body } = await cluster.stats();
      const busy = body.backends.find((b) => b.id === 'server-1');
      return busy?.activeConnections === 1;
    },
    { label: 'server-1 sedang menahan satu koneksi lambat' },
  );

  // Selama server-1 sibuk, request berikutnya harus memilih server-2/server-3.
  const during = [];
  for (let i = 0; i < 3; i += 1) {
    const res = await cluster.request(`/selama-sibuk?i=${i}`);
    assert.equal(res.status, 200);
    during.push(res.servedBy);
  }
  assert.ok(!during.includes('server-1'), `server-1 sibuk tapi tetap dikirimi: ${during.join(',')}`);
  assert.ok(during.every((id) => id === 'server-2' || id === 'server-3'));

  const slowResult = await slow;
  assert.equal(slowResult.status, 200);
  assert.equal(slowResult.servedBy, 'server-1');

  const { body } = await cluster.stats();
  assert.equal(body.backends.find((b) => b.id === 'server-1').requests, 1);
  assert.equal(body.backends.find((b) => b.id === 'server-1').activeConnections, 0);
  assert.equal(body.totals.proxied, 4);
});

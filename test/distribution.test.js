import test from 'node:test';
import assert from 'node:assert/strict';
import { startCluster } from './helpers/cluster.js';

test('round-robin: 9 request dibagi bergiliran 3-3-3', { timeout: 40000 }, async (t) => {
  const cluster = await startCluster({ algorithm: 'round-robin' });
  t.after(() => cluster.stop());

  const order = [];
  for (let i = 0; i < 9; i += 1) {
    const res = await cluster.request(`/rute?i=${i}`);
    assert.equal(res.status, 200);
    order.push(res.servedBy);
  }

  assert.deepEqual(order, [
    'server-1',
    'server-2',
    'server-3',
    'server-1',
    'server-2',
    'server-3',
    'server-1',
    'server-2',
    'server-3',
  ]);

  const { body } = await cluster.stats();
  assert.equal(body.loadBalancer.algorithm, 'round-robin');
  assert.equal(body.totals.proxied, 9);
  assert.deepEqual(
    body.backends.map((b) => b.requests),
    [3, 3, 3],
  );
});

test('least-connections: 6 request bergiliran karena semua idle (tie-break round robin)', { timeout: 40000 }, async (t) => {
  const cluster = await startCluster({ algorithm: 'least-connections' });
  t.after(() => cluster.stop());

  for (let i = 0; i < 6; i += 1) {
    await cluster.request(`/rute?i=${i}`);
  }

  const { body } = await cluster.stats();
  assert.equal(body.loadBalancer.algorithm, 'least-connections');
  assert.deepEqual(
    body.backends.map((b) => b.requests),
    [2, 2, 2],
  );
});

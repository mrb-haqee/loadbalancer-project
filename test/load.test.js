import test from 'node:test';
import assert from 'node:assert/strict';
import { startCluster } from './helpers/cluster.js';

const TOTAL_REQUESTS = 600;
const CONCURRENCY = 50;

test(`beban: ${TOTAL_REQUESTS} request / ${CONCURRENCY} konkuren, semua sukses dan terbagi rata`, { timeout: 90000 }, async (t) => {
  const cluster = await startCluster({ algorithm: 'round-robin' });
  t.after(() => cluster.stop());

  let nextIndex = 0;
  const results = [];

  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= TOTAL_REQUESTS) return;
      results.push(await cluster.request(`/beban?i=${index}`));
    }
  };

  const startedAt = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  const durationMs = Date.now() - startedAt;

  assert.equal(results.length, TOTAL_REQUESTS);

  const failures = results.filter((res) => res.status !== 200);
  assert.equal(
    failures.length,
    0,
    `ada ${failures.length} request gagal: ${failures.slice(0, 3).map((r) => r.status).join(',')}`,
  );

  const perBackend = {};
  for (const res of results) {
    perBackend[res.servedBy] = (perBackend[res.servedBy] ?? 0) + 1;
  }
  assert.deepEqual(perBackend, {
    'server-1': TOTAL_REQUESTS / 3,
    'server-2': TOTAL_REQUESTS / 3,
    'server-3': TOTAL_REQUESTS / 3,
  });

  const { body } = await cluster.stats();
  assert.equal(body.totals.proxied, TOTAL_REQUESTS);
  assert.equal(body.totals.rejected, 0);
  assert.equal(body.healthyCount, 3);
  assert.ok(
    body.backends.every((b) => b.activeConnections === 0),
    'semua koneksi harus sudah dilepas setelah selesai',
  );

  const rps = Math.round((TOTAL_REQUESTS / durationMs) * 1000);
  t.diagnostic(`durasi ${durationMs}ms (±${rps} request/detik) untuk ${TOTAL_REQUESTS} request`);
});

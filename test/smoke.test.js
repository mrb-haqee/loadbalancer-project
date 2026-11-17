import test from 'node:test';
import assert from 'node:assert/strict';
import { startCluster } from './helpers/cluster.js';

test('smoke: 3 backend + load balancer hidup, dashboard & proxy berfungsi', { timeout: 40000 }, async (t) => {
  const cluster = await startCluster();
  t.after(() => cluster.stop());

  // 1. Load balancer hidup dan melihat 3 backend sehat.
  const lbHealth = await cluster.request('/health');
  assert.equal(lbHealth.status, 200);
  assert.equal(lbHealth.body.healthyBackends, 3);
  assert.equal(lbHealth.body.totalBackends, 3);

  // 2. Tiap backend benar-benar hidup (dicek langsung, tanpa lewat LB).
  for (const backend of cluster.config.backends) {
    const res = await cluster.requestDirect(backend.id, '/health');
    assert.equal(res.status, 200, `${backend.id} harus hidup`);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.serverId, backend.id);
    assert.equal(res.body.port, backend.port);
  }

  // 3. Request lewat LB sampai ke backend dan identitasnya terbaca.
  const proxied = await cluster.request('/halo?nama=andi');
  assert.equal(proxied.status, 200);
  assert.ok(proxied.servedBy, 'response harus punya header x-served-by');
  assert.equal(proxied.body.servedBy, proxied.servedBy);
  assert.equal(proxied.body.query.nama, 'andi');
  assert.equal(proxied.headers.get('x-load-balancer'), 'node-lb');

  // 4. Dashboard bisa diakses.
  const dashboard = await cluster.request('/');
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.text, /Load Balancer Dashboard/);

  // 5. POST dengan body diteruskan utuh.
  const posted = await cluster.request('/kirim-data', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pesan: 'halo dari test' }),
  });
  assert.equal(posted.status, 200);
  assert.equal(posted.body.method, 'POST');
  assert.ok(posted.body.bodyBytes > 0, 'body harus sampai ke backend');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { renderDbMetrics, resetDbMetrics } from '../../src/backend/db-metrics.js';
import { createServer, updateServer } from '../../src/backend/servers/repository.js';

test('updateServer mengembalikan null tanpa SELECT tambahan saat affectedRows = 0', async () => {
  resetDbMetrics();
  const calls = [];
  const fakeDb = {
    execute: async (sql) => {
      calls.push(sql.trim().split(/\s+/)[0]);
      return [{ affectedRows: 0 }];
    },
  };

  const updated = await updateServer(
    999,
    { name: 'server-x', host: 'server-x', port: 3000, weight: 1, enabled: true, note: null },
    fakeDb,
  );

  assert.equal(updated, null);
  assert.deepEqual(calls, ['UPDATE']);
  const metrics = renderDbMetrics('server-1');
  assert.match(metrics, /lb_db_queries_total\{server="server-1",operation="update",result="success"\} 1/);
  assert.doesNotMatch(metrics, /operation="get"/);
});

test('createServer hanya mencatat metrik insert tanpa menggelembungkan counter get', async () => {
  resetDbMetrics();
  const fakeDb = {
    execute: async (sql) => {
      if (sql.trim().startsWith('INSERT')) return [{ insertId: 7 }];
      return [[{ id: 7, name: 'server-7', host: 'server-7', port: 3000, weight: 1, enabled: 1, note: null, created_at: '2026-11-18T00:00:00Z', updated_at: '2026-11-18T00:00:00Z' }]];
    },
  };

  const created = await createServer(
    { name: 'server-7', host: 'server-7', port: 3000, weight: 1, enabled: true, note: null },
    fakeDb,
  );

  assert.equal(created.id, 7);
  const metrics = renderDbMetrics('server-1');
  assert.match(metrics, /lb_db_queries_total\{server="server-1",operation="insert",result="success"\} 1/);
  assert.doesNotMatch(metrics, /operation="get"/);
});

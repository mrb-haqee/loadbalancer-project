import assert from 'node:assert/strict';
import { test } from 'bun:test';
import type { ServerRecord } from '../../src/backend/servers/repository';
import type { ServerRepository } from '../../src/backend/app';

process.env.BACKEND_ID = 'server-1';
process.env.BACKEND_HOST = '127.0.0.1';
process.env.BACKEND_PORT = '3999';
process.env.LOG_LEVEL = 'silent';

const { createApp } = await import('../../src/backend/app');

const sample: ServerRecord = {
  id: 1,
  name: 'server-1',
  host: 'server-1',
  port: 3000,
  weight: 1,
  enabled: true,
  note: null,
  createdAt: '2026-11-18T00:00:00.000Z',
  updatedAt: '2026-11-18T00:00:00.000Z',
};

function fakeRepository(overrides: Partial<ServerRepository> = {}): ServerRepository {
  return {
    listServers: async () => [sample],
    getServer: async (id) => (id === 1 ? sample : null),
    createServer: async (input) => ({ ...sample, id: 9, name: input.name, host: input.host, port: input.port }),
    updateServer: async (id, input) => (id === 1 ? { ...sample, ...input } : null),
    deleteServer: async (id) => id === 1,
    ...overrides,
  };
}

function appWith(overrides: Partial<ServerRepository> = {}) {
  return createApp(fakeRepository(overrides));
}

type AnyJson = any;

async function get(app: ReturnType<typeof appWith>, path: string, init?: RequestInit): Promise<Response> {
  return app.handle(new Request(`http://127.0.0.1${path}`, init));
}

async function readJson(response: Response): Promise<AnyJson> {
  return response.json();
}

function postJson(app: ReturnType<typeof appWith>, path: string, body: string): Promise<Response> {
  return get(app, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
}

test('health menjawab 200, membawa x-served-by, dan tidak dihitung sebagai trafik', async () => {
  const app = appWith();
  const response = await get(app, '/health');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-served-by'), 'server-1');
  const body = await readJson(response);
  assert.equal(body.status, 'ok');
  assert.equal(body.serverId, 'server-1');
  assert.equal(body.requestCount, 0);
});

test('echo /halo mengembalikan query dan menambah requestCount', async () => {
  const app = appWith();
  const echo = await get(app, '/halo?dari=test');
  assert.equal(echo.status, 200);
  const body = await readJson(echo);
  assert.equal(body.path, '/halo');
  assert.equal(body.query.dari, 'test');
  assert.equal(body.bodyBytes, 0);

  const health = await readJson(await get(app, '/health'));
  assert.equal(health.requestCount, 1);
});

test('koleksi /api/servers memakai repository dan membawa x-served-by', async () => {
  const app = appWith();
  const response = await get(app, '/api/servers');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-served-by'), 'server-1');
  assert.deepEqual(await readJson(response), [sample]);
});

test('satu server: id tidak ada atau bukan angka dibalas 404 JSON', async () => {
  const app = appWith();
  const missing = await get(app, '/api/servers/2');
  assert.equal(missing.status, 404);
  assert.equal((await readJson(missing)).error.code, 'NOT_FOUND');

  const invalid = await get(app, '/api/servers/abc');
  assert.equal(invalid.status, 404);
  assert.match((await readJson(invalid)).error.message, /tidak dikenal/);
});

test('POST valid membalas 201 dengan header location', async () => {
  const app = appWith();
  const response = await postJson(
    app,
    '/api/servers',
    JSON.stringify({ name: 'server-9', host: 'server-9', port: 3000 }),
  );
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('location'), '/api/servers/9');
  assert.equal((await readJson(response)).name, 'server-9');
});

test('POST tidak valid membalas 400 VALIDATION_ERROR dengan details', async () => {
  const app = appWith();
  const response = await postJson(app, '/api/servers', JSON.stringify({ name: 'server 9' }));
  assert.equal(response.status, 400);
  const body = await readJson(response);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.ok(body.error.details.some((detail: { field: string }) => detail.field === 'port'));
});

test('JSON rusak dibalas 400 INVALID_JSON, body kebesaran dibalas 413', async () => {
  const app = appWith();
  const badJson = await postJson(app, '/api/servers', '{bukan json');
  assert.equal(badJson.status, 400);
  assert.equal((await readJson(badJson)).error.code, 'INVALID_JSON');

  const bigJson = await postJson(app, '/api/servers', JSON.stringify({ note: 'x'.repeat(70 * 1024) }));
  assert.equal(bigJson.status, 413);
  assert.equal((await readJson(bigJson)).error.code, 'BODY_TOO_LARGE');
});

test('metode yang tidak didukung dibalas 405 dengan header allow', async () => {
  const app = appWith();
  const response = await get(app, '/api/servers', { method: 'PATCH' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, POST');
  assert.equal((await readJson(response)).error.code, 'METHOD_NOT_ALLOWED');
});

test('path /api yang tidak dikenal tetap JSON 404, bukan echo', async () => {
  const app = appWith();
  const response = await get(app, '/api/tidak-ada');
  assert.equal(response.status, 404);
  assert.equal((await readJson(response)).error.code, 'NOT_FOUND');
});

test('DELETE membalas 204 tanpa body, id asing 404', async () => {
  const app = appWith();
  const removed = await get(app, '/api/servers/1', { method: 'DELETE' });
  assert.equal(removed.status, 204);
  assert.equal(await removed.text(), '');

  const missing = await get(app, '/api/servers/2', { method: 'DELETE' });
  assert.equal(missing.status, 404);
});

test('metrics memakai format Prometheus dan memuat metrik backend + DB', async () => {
  const app = appWith();
  await get(app, '/halo');
  const response = await get(app, '/metrics');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/plain; version=0\.0\.4/);
  const text = await response.text();
  assert.match(text, /lb_backend_requests_total\{server="server-1"\} 1/);
  assert.match(text, /lb_db_query_duration_seconds_count\{server="server-1"\}/);
});

test('error database dipetakan ke 409 dan 503, bukan 500', async () => {
  const duplicate = appWith({
    createServer: async () => {
      throw Object.assign(new Error('Failed query'), { cause: Object.assign(new Error('dup'), { errno: 1062 }) });
    },
  });
  const conflict = await postJson(duplicate, '/api/servers', JSON.stringify({ name: 'server-9', host: 'server-9', port: 3000 }));
  assert.equal(conflict.status, 409);
  assert.equal((await readJson(conflict)).error.code, 'DUPLICATE_NAME');

  const missingTable = appWith({
    listServers: async () => {
      throw Object.assign(new Error('Failed query'), { cause: Object.assign(new Error('no table'), { errno: 1146 }) });
    },
  });
  const unavailable = await get(missingTable, '/api/servers');
  assert.equal(unavailable.status, 503);
  assert.equal((await readJson(unavailable)).error.code, 'DATABASE_NOT_INITIALIZED');
});

test('UI katalog dilayani sebagai HTML', async () => {
  const app = appWith();
  const response = await get(app, '/ui');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await response.text(), /<html/i);
});
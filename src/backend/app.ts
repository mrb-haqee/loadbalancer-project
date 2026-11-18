import { readFileSync } from 'node:fs';
import { Elysia } from 'elysia';
import { createLogger } from '../shared/logger';
import { closeDb, databaseTarget } from './db';
import { renderDbMetrics } from './db-metrics';
import { driverErrorCode, isConnectionFailure } from './db-errors';
import {
  apiError,
  BodyTooLargeError,
  emptyResponse,
  htmlResponse,
  InvalidJsonError,
  jsonResponse,
  readBody,
  readJsonBody,
} from './http';
import { self } from './identity';
import { recordRequestDuration, renderRequestMetrics } from './metrics';
import {
  createServer as createServerRecord,
  deleteServer as deleteServerRecord,
  getServer as getServerRecord,
  listServers as listServerRecords,
  updateServer as updateServerRecord,
} from './servers/repository';
import { validateServerInput, type ServerInput } from './servers/validation';

const log = createLogger('api');
const ITEM_PATH = /^\/api\/servers\/([1-9]\d*)$/;
const COLLECTION_PATHS = new Set(['/api/servers', '/api/servers/']);

// Halaman CRUD katalog server. Dibaca sekali saat start; ubah file lalu restart container.
const uiHtml = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');

export type ServerRepository = {
  listServers: typeof listServerRecords;
  getServer: typeof getServerRecord;
  createServer: typeof createServerRecord;
  updateServer: typeof updateServerRecord;
  deleteServer: typeof deleteServerRecord;
};

const defaultRepository: ServerRepository = {
  listServers: listServerRecords,
  getServer: getServerRecord,
  createServer: createServerRecord,
  updateServer: updateServerRecord,
  deleteServer: deleteServerRecord,
};

function bodyTooLargeOrInvalidJson(error: unknown): Response | undefined {
  if (error instanceof BodyTooLargeError) return apiError(self.id, 413, error.code, error.message);
  if (error instanceof InvalidJsonError) return apiError(self.id, 400, error.code, error.message);
  return undefined;
}

function notFoundResponse(path: string, method: string): Response {
  if (COLLECTION_PATHS.has(path)) {
    return apiError(self.id, 405, 'METHOD_NOT_ALLOWED', `Metode ${method} tidak didukung di koleksi ini.`, undefined, {
      allow: 'GET, POST',
    });
  }
  if (ITEM_PATH.test(path)) {
    return apiError(self.id, 405, 'METHOD_NOT_ALLOWED', `Metode ${method} tidak didukung untuk satu server.`, undefined, {
      allow: 'GET, PUT, DELETE',
    });
  }
  return apiError(self.id, 404, 'NOT_FOUND', `Endpoint ${path} tidak dikenal.`);
}

function databaseErrorResponse(error: unknown): Response | undefined {
  const code = driverErrorCode(error);
  if (code === 'ER_DUP_ENTRY') {
    log.warn('CRUD ditolak: nama server duplikat (ER_DUP_ENTRY).');
    return apiError(self.id, 409, 'DUPLICATE_NAME', 'Nama server sudah ada di katalog.');
  }
  if (code === 'ER_NO_SUCH_TABLE') {
    log.warn('Tabel registered_servers belum ada (ER_NO_SUCH_TABLE).');
    return apiError(
      self.id,
      503,
      'DATABASE_NOT_INITIALIZED',
      'Tabel registered_servers belum ada. Jalankan SQL init lewat `make db-reset`.',
    );
  }
  if (isConnectionFailure(code)) {
    log.warn(`database tidak tersedia (${code}): ${(error as Error).message}`);
    return apiError(
      self.id,
      503,
      'DATABASE_UNAVAILABLE',
      'Database tidak bisa dihubungi. Pastikan `make db-up` sudah jalan dan kredensial DB benar.',
    );
  }
  return undefined;
}

async function readValidatedBody(request: Request): Promise<ServerInput | Response> {
  const payload = await readJsonBody(request);
  const result = validateServerInput(payload);
  if (!result.ok) {
    return apiError(self.id, 400, 'VALIDATION_ERROR', 'Data server tidak valid.', result.errors);
  }
  return result.value;
}

function parseId(value: string): number | null {
  return /^[1-9]\d*$/.test(value) ? Number(value) : null;
}

function idNotFound(id: number): Response {
  return apiError(self.id, 404, 'NOT_FOUND', `Server Terdaftar id ${id} tidak ditemukan.`);
}

/**
 * Aplikasi Elysia. `servers` bisa diganti di test supaya kontrak HTTP diuji
 * tanpa database; di produksi selalu memakai repository Drizzle.
 */
export function createApp(servers: ServerRepository = defaultRepository) {
  const startedAt = Date.now();
  let requestCount = 0;
  let slowRequestCount = 0;
  const requestStartedAt = new WeakMap<Request, number>();

  async function echoHandler({ request }: { request: Request }): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      // Path /api yang dikenal tapi metodenya salah tetap dibalas 405 + allow,
      // sama seperti versi Node. Sisanya 404 JSON, bukan echo.
      return notFoundResponse(url.pathname, request.method);
    }
    const body = await readBody(request);
    return jsonResponse(self.id, 200, {
      servedBy: self.id,
      port: self.port,
      pid: process.pid,
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      requestCount,
      bodyBytes: body.byteLength,
      servedAt: new Date().toISOString(),
    });
  }

  async function createHandler(request: Request): Promise<Response> {
    const input = await readValidatedBody(request);
    if (input instanceof Response) return input;
    const created = await servers.createServer(input);
    return jsonResponse(self.id, 201, created, { location: `/api/servers/${created.id}` });
  }

  return new Elysia()
    .onRequest(({ request, set }) => {
      set.headers['x-served-by'] = self.id;
      const path = new URL(request.url).pathname;
      if (path === '/health' || path === '/metrics') return;
      requestCount += 1;
      requestStartedAt.set(request, performance.now());
    })
    .onAfterResponse(({ request }) => {
      const started = requestStartedAt.get(request);
      if (started === undefined) return;
      requestStartedAt.delete(request);
      recordRequestDuration((performance.now() - started) / 1000);
    })
    .onError(({ code, error, request }) => {
      const badBody = bodyTooLargeOrInvalidJson(error);
      if (badBody) return badBody;
      if (code === 'NOT_FOUND') return notFoundResponse(new URL(request.url).pathname, request.method);
      const databaseError = databaseErrorResponse(error);
      if (databaseError) return databaseError;
      log.error(`request gagal: ${(error as Error)?.stack ?? String(error)}`);
      return apiError(self.id, 500, 'INTERNAL_ERROR', 'Terjadi kesalahan internal di backend.');
    })
    // Health endpoint: sengaja tidak mengecek database dan tidak dihitung sebagai
    // trafik aplikasi. Kalau DB mati, Traefik tetap menganggap backend sehat.
    .get('/health', () =>
      jsonResponse(self.id, 200, {
        status: 'ok',
        serverId: self.id,
        port: self.port,
        pid: process.pid,
        uptimeMs: Date.now() - startedAt,
        requestCount,
      }),
    )
    // Endpoint metrics Prometheus: juga tidak dihitung sebagai trafik aplikasi.
    .get(
      '/metrics',
      () =>
        new Response(
          [renderRequestMetrics(self.id, requestCount, slowRequestCount), renderDbMetrics(self.id), ''].join('\n'),
          { status: 200, headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' } },
        ),
    )
    // UI katalog server: satu halaman statis, datanya dari /api/servers.
    .get('/ui', () => htmlResponse(self.id, uiHtml))
    .get('/ui/', () => htmlResponse(self.id, uiHtml))
    .get('/api/servers', async () => jsonResponse(self.id, 200, await servers.listServers()))
    .get('/api/servers/', async () => jsonResponse(self.id, 200, await servers.listServers()))
    .post('/api/servers', ({ request }) => createHandler(request), { parse: 'none' })
    .post('/api/servers/', ({ request }) => createHandler(request), { parse: 'none' })
    .get('/api/servers/:id', async ({ params }) => {
      const id = parseId(params.id);
      if (id === null) return apiError(self.id, 404, 'NOT_FOUND', `Endpoint /api/servers/${params.id} tidak dikenal.`);
      const server = await servers.getServer(id);
      return server ? jsonResponse(self.id, 200, server) : idNotFound(id);
    })
    .put(
      '/api/servers/:id',
      async ({ params, request }) => {
        const id = parseId(params.id);
        if (id === null) {
          return apiError(self.id, 404, 'NOT_FOUND', `Endpoint /api/servers/${params.id} tidak dikenal.`);
        }
        const input = await readValidatedBody(request);
        if (input instanceof Response) return input;
        const updated = await servers.updateServer(id, input);
        return updated ? jsonResponse(self.id, 200, updated) : idNotFound(id);
      },
      { parse: 'none' },
    )
    .delete('/api/servers/:id', async ({ params }) => {
      const id = parseId(params.id);
      if (id === null) return apiError(self.id, 404, 'NOT_FOUND', `Endpoint /api/servers/${params.id} tidak dikenal.`);
      const removed = await servers.deleteServer(id);
      return removed ? emptyResponse(self.id, 204) : idNotFound(id);
    })
    // Endpoint bantu demo: menahan respons selama N ms (default 250, maks 10000).
    // Catatan: lewat Traefik, responseHeaderTimeout 2s memotong yang di atas 2 detik.
    .all('/slow', async ({ request }) => {
      slowRequestCount += 1;
      const requested = Number(new URL(request.url).searchParams.get('ms') ?? 250);
      const delayMs = Math.min(Math.max(Number.isFinite(requested) ? requested : 250, 0), 10000);
      await Bun.sleep(delayMs);
      return jsonResponse(self.id, 200, {
        servedBy: self.id,
        port: self.port,
        pid: process.pid,
        delayMs,
        requestCount,
        slowRequestCount,
        servedAt: new Date().toISOString(),
      });
    })
    // Semua path lain: echo demo load balancing, termasuk 404 JSON untuk /api/*.
    .all('/api', echoHandler, { parse: 'none' })
    .all('/api/*', echoHandler, { parse: 'none' })
    .all('/*', echoHandler, { parse: 'none' })
    .all('/', echoHandler, { parse: 'none' });
}

export const app = createApp();

export async function shutdown(signal: string): Promise<void> {
  log.info(`${signal} diterima, menutup server`);
  await app.stop();
  await closeDb().catch((error: Error) => log.warn(`gagal menutup pool DB: ${error.message}`));
}

export function startupMessage(): string {
  return `siap di http://${self.host}:${self.port} (pid ${process.pid}) · UI katalog: http://${self.host}:${self.port}/ui · DB ${databaseTarget()}`;
}
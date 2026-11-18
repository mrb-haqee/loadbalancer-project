import { createLogger } from '../../shared/logger.js';
import {
  BodyTooLargeError,
  InvalidJsonError,
  readJsonBody,
  sendApiError,
  sendEmpty,
  sendJson,
} from '../http.js';
import { validateServerInput } from './validation.js';
import { createServer, deleteServer, getServer, listServers, updateServer } from './repository.js';

const log = createLogger('api');
const ITEM_PATH = /^\/api\/servers\/([1-9]\d*)$/;

const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ECONNRESET',
  'EPIPE',
  'PROTOCOL_CONNECTION_LOST',
  'ER_ACCESS_DENIED_ERROR',
  'ER_BAD_DB_ERROR',
]);

function handleDatabaseError(res, headers, error) {
  if (error instanceof BodyTooLargeError) {
    return sendApiError(res, 413, error.code, error.message, undefined, headers);
  }
  if (error instanceof InvalidJsonError) {
    return sendApiError(res, 400, error.code, error.message, undefined, headers);
  }
  if (error?.code === 'ER_DUP_ENTRY') {
    log.warn('CRUD ditolak: nama server duplikat (ER_DUP_ENTRY).');
    return sendApiError(res, 409, 'DUPLICATE_NAME', 'Nama server sudah ada di katalog.', undefined, headers);
  }
  if (error?.code === 'ER_NO_SUCH_TABLE') {
    log.warn('Tabel registered_servers belum ada (ER_NO_SUCH_TABLE).');
    return sendApiError(
      res,
      503,
      'DATABASE_NOT_INITIALIZED',
      'Tabel registered_servers belum ada. Jalankan SQL init lewat `make db-reset`.',
      undefined,
      headers,
    );
  }
  if (CONNECTION_CODES.has(error?.code)) {
    log.warn(`database tidak tersedia (${error.code}): ${error.message}`);
    return sendApiError(
      res,
      503,
      'DATABASE_UNAVAILABLE',
      'Database tidak bisa dihubungi. Pastikan `make db-up` sudah jalan dan kredensial DB benar.',
      undefined,
      headers,
    );
  }

  log.error(`gagal memproses CRUD: ${error?.stack ?? error?.message ?? error}`);
  return sendApiError(res, 500, 'INTERNAL_ERROR', 'Terjadi kesalahan internal di backend.', undefined, headers);
}

async function readValidatedBody(req, res, headers) {
  const payload = await readJsonBody(req);
  const result = validateServerInput(payload);
  if (!result.ok) {
    sendApiError(res, 400, 'VALIDATION_ERROR', 'Data server tidak valid.', result.errors, headers);
    return null;
  }
  return result.value;
}

async function handleCollection(req, res, headers) {
  if (req.method === 'GET') {
    return sendJson(res, 200, await listServers(), headers);
  }

  if (req.method === 'POST') {
    const input = await readValidatedBody(req, res, headers);
    if (!input) return undefined;
    const created = await createServer(input);
    return sendJson(res, 201, created, { ...headers, location: `/api/servers/${created.id}` });
  }

  return sendApiError(res, 405, 'METHOD_NOT_ALLOWED', `Metode ${req.method} tidak didukung di koleksi ini.`, undefined, {
    ...headers,
    allow: 'GET, POST',
  });
}

async function handleItem(req, res, headers, id) {
  if (req.method === 'GET') {
    const server = await getServer(id);
    if (!server) return sendApiError(res, 404, 'NOT_FOUND', `Server Terdaftar id ${id} tidak ditemukan.`, undefined, headers);
    return sendJson(res, 200, server, headers);
  }

  if (req.method === 'PUT') {
    const input = await readValidatedBody(req, res, headers);
    if (!input) return undefined;
    const updated = await updateServer(id, input);
    if (!updated) return sendApiError(res, 404, 'NOT_FOUND', `Server Terdaftar id ${id} tidak ditemukan.`, undefined, headers);
    return sendJson(res, 200, updated, headers);
  }

  if (req.method === 'DELETE') {
    const removed = await deleteServer(id);
    if (!removed) return sendApiError(res, 404, 'NOT_FOUND', `Server Terdaftar id ${id} tidak ditemukan.`, undefined, headers);
    return sendEmpty(res, 204, headers);
  }

  return sendApiError(res, 405, 'METHOD_NOT_ALLOWED', `Metode ${req.method} tidak didukung untuk satu server.`, undefined, {
    ...headers,
    allow: 'GET, PUT, DELETE',
  });
}

/**
 * Menangani /api/servers dan /api/servers/:id.
 * Mengembalikan true bila request sudah dijawab, false bila path bukan milik API ini.
 */
export async function handleServersApi(req, res, url, headers) {
  const isCollection = url.pathname === '/api/servers' || url.pathname === '/api/servers/';
  const itemMatch = ITEM_PATH.exec(url.pathname);
  if (!isCollection && !itemMatch) return false;

  try {
    if (isCollection) await handleCollection(req, res, headers);
    else await handleItem(req, res, headers, Number(itemMatch[1]));
  } catch (error) {
    handleDatabaseError(res, headers, error);
  }
  return true;
}

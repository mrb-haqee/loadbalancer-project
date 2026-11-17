// Helper HTTP kecil, dipakai server backend dan endpoint CRUD.
// Semua respons API membawa header `x-served-by` agar UI bisa menunjukkan
// backend mana yang melayani request lewat load balancer.

export const JSON_BODY_LIMIT_BYTES = 64 * 1024;

export class BodyTooLargeError extends Error {
  constructor(limitBytes) {
    super(`Body melebihi batas ${limitBytes} byte.`);
    this.name = 'BodyTooLargeError';
    this.code = 'BODY_TOO_LARGE';
  }
}

export class InvalidJsonError extends Error {
  constructor() {
    super('Body bukan JSON yang valid.');
    this.name = 'InvalidJsonError';
    this.code = 'INVALID_JSON';
  }
}

export function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

export function sendHtml(res, statusCode, html, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(html);
}

export function sendEmpty(res, statusCode, extraHeaders = {}) {
  res.writeHead(statusCode, { 'cache-control': 'no-store', ...extraHeaders });
  res.end();
}

export function sendApiError(res, statusCode, code, message, details, extraHeaders = {}) {
  const error = { code, message };
  if (details) error.details = details;
  sendJson(res, statusCode, { error }, extraHeaders);
}

export function readBody(req, { limitBytes = JSON_BODY_LIMIT_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;

    req.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > limitBytes) {
        rejected = true;
        reject(new BodyTooLargeError(limitBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (!rejected) reject(error);
    });
  });
}

export async function readJsonBody(req, options) {
  const raw = await readBody(req, options);
  if (!raw.trim()) throw new InvalidJsonError();
  try {
    return JSON.parse(raw);
  } catch {
    throw new InvalidJsonError();
  }
}

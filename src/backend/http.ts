// Helper respons HTTP. Dipakai semua route supaya status, header, dan bentuk
// body tetap sama seperti versi Node sebelumnya.

export const JSON_BODY_LIMIT_BYTES = 64 * 1024;

export class BodyTooLargeError extends Error {
  code = 'BODY_TOO_LARGE';

  constructor(limitBytes: number) {
    super(`Body melebihi batas ${limitBytes} byte.`);
    this.name = 'BodyTooLargeError';
  }
}

export class InvalidJsonError extends Error {
  code = 'INVALID_JSON';

  constructor() {
    super('Body bukan JSON yang valid.');
    this.name = 'InvalidJsonError';
  }
}

type ExtraHeaders = Record<string, string>;

function baseHeaders(servedBy: string): ExtraHeaders {
  return { 'x-served-by': servedBy, 'cache-control': 'no-store' };
}

export function jsonResponse(
  servedBy: string,
  statusCode: number,
  payload: unknown,
  extraHeaders: ExtraHeaders = {},
): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status: statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...baseHeaders(servedBy),
      ...extraHeaders,
    },
  });
}

export function apiError(
  servedBy: string,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
  extraHeaders: ExtraHeaders = {},
): Response {
  const error: { code: string; message: string; details?: unknown } = { code, message };
  if (details) error.details = details;
  return jsonResponse(servedBy, statusCode, { error }, extraHeaders);
}

export function htmlResponse(servedBy: string, body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
      ...baseHeaders(servedBy),
    },
  });
}

export function emptyResponse(servedBy: string, statusCode: number, extraHeaders: ExtraHeaders = {}): Response {
  return new Response(null, {
    status: statusCode,
    headers: { ...baseHeaders(servedBy), ...extraHeaders },
  });
}

export async function readBody(request: Request, limitBytes = JSON_BODY_LIMIT_BYTES): Promise<Buffer> {
  const declared = request.headers.get('content-length');
  if (declared && Number(declared) > limitBytes) throw new BodyTooLargeError(limitBytes);
  const body = Buffer.from(await request.arrayBuffer());
  if (body.byteLength > limitBytes) throw new BodyTooLargeError(limitBytes);
  return body;
}

export async function readJsonBody(request: Request): Promise<unknown> {
  const raw = (await readBody(request)).toString('utf8');
  if (!raw.trim()) throw new InvalidJsonError();
  try {
    return JSON.parse(raw);
  } catch {
    throw new InvalidJsonError();
  }
}

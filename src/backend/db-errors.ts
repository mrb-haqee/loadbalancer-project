/** Kode error driver yang dipakai untuk metrik dan pemetaan status HTTP. */
const MYSQL_ERRNO_CODES: Record<number, string> = {
  1045: 'ER_ACCESS_DENIED_ERROR',
  1049: 'ER_BAD_DB_ERROR',
  1062: 'ER_DUP_ENTRY',
  1146: 'ER_NO_SUCH_TABLE',
};

export const CONNECTION_CODES = new Set([
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

/** Bun SQL memakai `ERR_MYSQL_CONNECTION_*` untuk timeout, putus, dan handshake gagal. */
export function isConnectionFailure(code: string | undefined): boolean {
  if (!code) return false;
  return CONNECTION_CODES.has(code) || code.startsWith('ERR_MYSQL_CONNECTION_');
}

/**
 * Drizzle membungkus error driver di `cause`. Bun SQL memakai `code`
 * (`ERR_MYSQL_...`) untuk kegagalan koneksi dan `errno` numerik untuk error
 * server, jadi keduanya diterjemahkan ke kode yang stabil.
 */
export function driverErrorCode(error: unknown): string | undefined {
  let current = error as { code?: unknown; errno?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (typeof current.errno === 'number') {
      return MYSQL_ERRNO_CODES[current.errno] ?? `ER_${current.errno}`;
    }
    if (typeof current.code === 'string') return current.code;
    current = current.cause as typeof current;
  }
  return undefined;
}
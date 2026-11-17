import mysql from 'mysql2/promise';

/**
 * Pool koneksi MariaDB.
 * Dibuat lazily supaya backend tetap bisa start (dan tetap sehat untuk Traefik)
 * walau database belum hidup; endpoint CRUD yang akan membalas 503.
 */
let pool;

function poolConfig() {
  return {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    database: process.env.DB_NAME ?? 'lb_demo',
    user: process.env.DB_USER ?? 'lb_app',
    password: process.env.DB_PASSWORD ?? 'lb_app_password',
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT ?? 10),
    queueLimit: 0,
    // Di bawah responseHeaderTimeout Traefik (2 detik), supaya saat DB mati
    // backend sempat membalas 503, bukan dipotong Traefik menjadi 504.
    connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 1000),
    charset: 'utf8mb4',
    timezone: 'Z',
  };
}

export function getPool() {
  pool ??= mysql.createPool(poolConfig());
  return pool;
}

export function databaseTarget() {
  const config = poolConfig();
  return `${config.user}@${config.host}:${config.port}/${config.database}`;
}

export async function closePool() {
  if (!pool) return;
  const current = pool;
  pool = undefined;
  await current.end();
}

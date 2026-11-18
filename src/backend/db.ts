import { SQL } from 'bun';
import { drizzle } from 'drizzle-orm/bun-sql';

/**
 * Satu pool Bun SQL ke MaxScale.
 * Dibuat lazily supaya backend tetap hidup walau database belum tersedia;
 * hanya endpoint CRUD yang membalas 503.
 */
let client: SQL | undefined;
let database: ReturnType<typeof createDatabase> | undefined;

function poolConfig() {
  return {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    database: process.env.DB_NAME ?? 'lb_demo',
    user: process.env.DB_USER ?? 'lb_app',
    password: process.env.DB_PASSWORD ?? 'lb_app_password',
    // ponytail: 10 koneksi x 5 backend = 50 koneksi ke MaxScale; naikkan hanya bila
    // antrean CRUD benar-benar penuh, bukan karena satu request lambat.
    max: Number(process.env.DB_CONNECTION_LIMIT ?? 10),
    // Di bawah responseHeaderTimeout Traefik (2 detik), supaya saat DB mati
    // backend sempat membalas 503, bukan dipotong Traefik menjadi 504.
    connectionTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 1000) / 1000,
    idleTimeout: 30,
  };
}

function createDatabase() {
  const config = poolConfig();
  client = new SQL({
    adapter: 'mysql',
    hostname: config.host,
    port: config.port,
    database: config.database,
    username: config.user,
    password: config.password,
    max: config.max,
    connectionTimeout: config.connectionTimeout,
    idleTimeout: config.idleTimeout,
  });
  return drizzle.mysql({ client });
}

export type AppDatabase = ReturnType<typeof createDatabase>;

export function getDb(): AppDatabase {
  database ??= createDatabase();
  return database;
}

export function databaseTarget(): string {
  const config = poolConfig();
  return `${config.user}@${config.host}:${config.port}/${config.database}`;
}

export async function closeDb(): Promise<void> {
  const current = client;
  client = undefined;
  database = undefined;
  await current?.close();
}

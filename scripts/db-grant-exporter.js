#!/usr/bin/env node
/**
 * Membuat/menyegarkan user monitoring `lb_exporter` di MariaDB.
 *
 * Kenapa script, bukan hanya SQL init:
 * - File init hanya dijalankan saat volume masih kosong.
 * - Password exporter dibaca dari env, jadi tidak ditulis dua kali.
 *
 * Idempotent: aman dijalankan berkali-kali. `db-up` dan `db-reset` memanggil
 * script ini otomatis supaya volume lama ikut punya user exporter.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE = ['compose', '-p', 'lb-db', '-f', resolve(ROOT, 'docker-compose.db.yml')];

const rootPassword = process.env.MARIADB_ROOT_PASSWORD ?? 'lb_root_password';
const exporterPassword = process.env.MARIADB_EXPORTER_PASSWORD ?? 'lb_exporter_password';
const waitSeconds = Number(process.env.DB_GRANT_TIMEOUT_SECONDS ?? 90);

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** Escape untuk literal string SQL (MariaDB menganggap '' sebagai kutip). */
function sqlString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

function mariadb(sql, { timeoutMs = 10_000 } = {}) {
  return spawnSync(
    'docker',
    [
      ...COMPOSE,
      'exec',
      '-T',
      'mariadb',
      'mariadb',
      '-uroot',
      // `docker compose exec` tidak meneruskan env host ke container, jadi
      // MYSQL_PWD tidak bisa dipakai. Password dikirim sebagai argumen.
      `--password=${rootPassword}`,
      '--batch',
      '--skip-column-names',
      '-e',
      sql,
    ],
    {
      encoding: 'utf8',
      timeout: timeoutMs,
    },
  );
}

async function waitForDatabase() {
  const deadline = Date.now() + waitSeconds * 1000;
  let lastError = '';
  while (Date.now() < deadline) {
    const result = mariadb('SELECT 1', { timeoutMs: 4000 });
    if (result.status === 0) return;
    lastError = (result.stderr || result.stdout || '').trim();
    await sleep(2000);
  }
  throw new Error(`MariaDB tidak siap dalam ${waitSeconds} detik. ${lastError}`);
}

const grantSql = [
  `CREATE USER IF NOT EXISTS 'lb_exporter'@'%' IDENTIFIED BY ${sqlString(exporterPassword)};`,
  `ALTER USER 'lb_exporter'@'%' IDENTIFIED BY ${sqlString(exporterPassword)};`,
  "GRANT PROCESS, REPLICATION CLIENT, SLAVE MONITOR ON *.* TO 'lb_exporter'@'%';",
  'FLUSH PRIVILEGES;',
].join('\n');

try {
  await waitForDatabase();
  const result = mariadb(grantSql, { timeoutMs: 15_000 });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'gagal menjalankan GRANT').trim());
  }
  console.log('user lb_exporter siap (PROCESS, REPLICATION CLIENT, SLAVE MONITOR)');
} catch (error) {
  console.error(`[db-grant-exporter] ${error.message}`);
  console.error('[db-grant-exporter] pastikan `make db-up` sudah jalan dan MARIADB_ROOT_PASSWORD benar.');
  process.exit(1);
}

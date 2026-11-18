#!/usr/bin/env node
/**
 * Membuat/menyegarkan SEMUA user database di setiap node `lb-db`.
 *
 * Kenapa per node, bukan sekali di primary:
 * - `mysql.*` sengaja tidak diandalkan ikut replikasi. Saat sebuah replika
 *   dipromosikan menjadi primary, user `lb_app` dan `lb_repl` harus sudah ada
 *   di sana — kalau menunggu replikasi GRANT, ada jendela di mana penulisan
 *   sudah diarahkan ke node itu tetapi login aplikasi ditolak.
 * - User MaxScale (`lb_monitor`) juga harus ada di semua node, karena monitor
 *   memeriksa setiap node dan mempromosikan salah satunya.
 *
 * Kenapa script, bukan hanya SQL init:
 * - File init hanya dijalankan saat volume masih kosong.
 * - Password dibaca dari env, jadi tidak ditulis dua kali.
 *
 * Idempotent: aman dijalankan berkali-kali. `db-up`, `db-reset`, dan `db-rejoin`
 * memanggil script ini otomatis.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeRoles } from './db-replica-clone.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE = ['compose', '-p', 'lb-db', '-f', resolve(ROOT, 'docker-compose.db.yml')];

/** Nama service compose; juga nama host di network `lb-net`. */
export const NODES = ['mariadb-primary', 'mariadb-replica-1', 'mariadb-replica-2'];

const rootPassword = process.env.MARIADB_ROOT_PASSWORD ?? 'lb_root_password';
const appDatabase = process.env.MARIADB_DATABASE ?? 'lb_demo';
const appUser = process.env.MARIADB_USER ?? 'lb_app';
const appPassword = process.env.MARIADB_PASSWORD ?? 'lb_app_password';
const replPassword = process.env.MARIADB_REPL_PASSWORD ?? 'lb_repl_password';
const monitorPassword = process.env.MARIADB_MONITOR_PASSWORD ?? 'lb_monitor_password';
const exporterPassword = process.env.MARIADB_EXPORTER_PASSWORD ?? 'lb_exporter_password';
const waitSeconds = Number(process.env.DB_GRANT_TIMEOUT_SECONDS ?? 90);

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** Escape untuk literal string SQL (MariaDB menganggap '' sebagai kutip). */
function sqlString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

/** Identifier database dipakai di GRANT, jadi hanya izinkan nama yang aman. */
function sqlIdentifier(value) {
  if (!/^[A-Za-z0-9_$]+$/.test(String(value))) {
    throw new Error(`nama database tidak aman untuk GRANT: ${value}`);
  }
  return `\`${value}\``;
}

function mysqlOnNode(node, sql, { timeoutMs = 10_000 } = {}) {
  return spawnSync(
    'docker',
    [
      ...COMPOSE,
      'exec',
      '-T',
      node,
      'mariadb',
      '-uroot',
      // `docker compose exec` tidak meneruskan env host ke container, jadi
      // MYSQL_PWD tidak bisa dipakai. Password dikirim sebagai argumen.
      `--password=${rootPassword}`,
      // User dan GRANT sengaja TIDAK masuk binlog: setiap node membuat user-nya
      // sendiri, jadi tidak perlu direplikasi. Kalau ditulis ke binlog, replika
      // menghasilkan urutan GTID miliknya sendiri yang bisa bentrok dengan
      // event primary saat `gtid_strict_mode=ON`.
      '--init-command=SET SESSION sql_log_bin=0',
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

async function waitForNode(node) {
  const deadline = Date.now() + waitSeconds * 1000;
  let lastError = '';
  while (Date.now() < deadline) {
    const result = mysqlOnNode(node, 'SELECT 1', { timeoutMs: 4000 });
    if (result.status === 0) return;
    lastError = (result.stderr || result.stdout || '').trim();
    await sleep(2000);
  }
  throw new Error(`${node} tidak siap dalam ${waitSeconds} detik. ${lastError}`);
}

/**
 * Password dan hak akses. `SUPER` ada di `lb_monitor` karena MariaDB Monitor
 * MaxScale perlu mempromosikan replika (`STOP SLAVE`, `SET GLOBAL read_only`).
 * Ini kredensial demo; jangan dipakai di luar mesin lokal.
 */
function grantSql({ withApplicationDatabase }) {
  const database = sqlIdentifier(appDatabase);
  return [
    withApplicationDatabase ? `CREATE DATABASE IF NOT EXISTS ${database};` : null,
    `CREATE USER IF NOT EXISTS ${sqlString(appUser)}@'%' IDENTIFIED BY ${sqlString(appPassword)};`,
    `ALTER USER ${sqlString(appUser)}@'%' IDENTIFIED BY ${sqlString(appPassword)};`,
    `GRANT ALL PRIVILEGES ON ${database}.* TO ${sqlString(appUser)}@'%';`,
    // MaxScale memakai user service (`lb_app`) untuk membaca definisi akun dari
    // `mysql.*` saat menyusun cache autentikasi. Tanpa SELECT di sini, setiap
    // koneksi mencetak "Failed to query server ... for user account info".
    // Ini hanya metadata; isi database aplikasi tetap dibatasi GRANT di atas.
    `GRANT SELECT ON mysql.* TO ${sqlString(appUser)}@'%';`,
    // User replikasi: dipakai `CHANGE MASTER TO` oleh replika mana pun, jadi
    // harus ada di semua node (siapa pun yang sedang menjadi primary).
    `CREATE USER IF NOT EXISTS 'lb_repl'@'%' IDENTIFIED BY ${sqlString(replPassword)};`,
    "ALTER USER 'lb_repl'@'%' IDENTIFIED BY " + sqlString(replPassword) + ';',
    "GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO 'lb_repl'@'%';",
    // User MaxScale: memantau peran tiap node dan mempromosikan replika.
    // `SUPER` cukup untuk MariaDB 11.4; hak granular di bawah disertakan supaya
    // monitor tidak bergantung pada satu hak lama saja.
    `CREATE USER IF NOT EXISTS 'lb_monitor'@'%' IDENTIFIED BY ${sqlString(monitorPassword)};`,
    "ALTER USER 'lb_monitor'@'%' IDENTIFIED BY " + sqlString(monitorPassword) + ';',
    // MariaDB 11.4 tidak menganggap SUPER cukup untuk failover: `STOP SLAVE`
    // pada node yang dipromosikan menuntut REPLICATION SLAVE ADMIN, dan
    // `SET read_only` menuntut READ_ONLY ADMIN. Daftar ini mengikuti hak yang
    // disebut dokumentasi MariaDB Monitor; SUPER tetap disertakan untuk
    // kompatibilitas dengan versi MariaDB lama.
    "GRANT REPLICATION CLIENT, REPLICATION SLAVE, SLAVE MONITOR, PROCESS, RELOAD, SUPER ON *.* TO 'lb_monitor'@'%';",
    "GRANT REPLICA MONITOR, READ_ONLY ADMIN, REPLICATION SLAVE ADMIN, REPLICATION MASTER ADMIN, BINLOG ADMIN, CONNECTION ADMIN, SET USER ON *.* TO 'lb_monitor'@'%';",
    "GRANT SELECT ON mysql.* TO 'lb_monitor'@'%';",
    // User exporter: hanya membaca status, tidak boleh menulis.
    `CREATE USER IF NOT EXISTS 'lb_exporter'@'%' IDENTIFIED BY ${sqlString(exporterPassword)};`,
    "ALTER USER 'lb_exporter'@'%' IDENTIFIED BY " + sqlString(exporterPassword) + ';',
    "GRANT PROCESS, REPLICATION CLIENT, SLAVE MONITOR ON *.* TO 'lb_exporter'@'%';",
    'FLUSH PRIVILEGES;',
  ]
    .filter(Boolean)
    .join('\n');
}

try {
  // Database aplikasi hanya dibuat di node yang bisa ditulis. Nama service
  // TIDAK dipakai: setelah failover, `mariadb-replica-1` bisa menjadi primary.
  const writable = nodeRoles().filter((entry) => !entry.readOnly);
  const primary = writable.length === 1 ? writable[0].node : null;

  for (const node of NODES) {
    await waitForNode(node);
    // Replika mendapat database dari dump saat clone; `CREATE DATABASE` di sana
    // hanya akan membuatnya tampak siap sebelum datanya ada.
    const result = mysqlOnNode(node, grantSql({ withApplicationDatabase: node === primary }), {
      timeoutMs: 20_000,
    });
    if (result.status !== 0) {
      throw new Error(`${node}: ${(result.stderr || result.stdout || 'gagal menjalankan GRANT').trim()}`);
    }
    console.log(`${node}: user ${appUser}, lb_repl, lb_monitor, lb_exporter siap`);
  }
} catch (error) {
  console.error(`[db-grant-users] ${error.message}`);
  console.error('[db-grant-users] pastikan `make db-up` sudah jalan dan MARIADB_ROOT_PASSWORD benar.');
  process.exit(1);
}

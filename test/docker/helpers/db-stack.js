/**
 * Helper untuk menguji cluster database sungguhan: 1 primary + 2 replika
 * di belakang MaxScale. Tidak ada mock — test ini memang mematikan primary.
 *
 * Yang sengaja dipakai ulang dari repo, bukan ditulis lagi di sini:
 * - `scripts/db-grant-users.js` dan `scripts/db-replica-clone.js`, supaya
 *   test menguji jalur yang sama dengan `make db-up` / `make db-rejoin`.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const COMPOSE_ARGS = ['compose', '-p', 'lb-db', '-f', resolve(ROOT, 'docker-compose.db.yml')];

export const NODES = ['mariadb-primary', 'mariadb-replica-1', 'mariadb-replica-2'];
export const PRIMARY = 'mariadb-primary';
export const DATABASE = process.env.MARIADB_DATABASE ?? 'lb_demo';

const rootPassword = process.env.MARIADB_ROOT_PASSWORD ?? 'lb_root_password';
const appUser = process.env.MARIADB_USER ?? 'lb_app';
const appPassword = process.env.MARIADB_PASSWORD ?? 'lb_app_password';

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

export async function waitFor(predicate, { timeoutMs = 60000, intervalMs = 500, label = 'kondisi' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timeout menunggu ${label}${last ? `: ${last.message}` : ''}`);
}

export function dbCompose(args, { allowFail = false } = {}) {
  const result = spawnSync('docker', [...COMPOSE_ARGS, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 300000,
  });
  if (result.status !== 0 && !allowFail) {
    throw new Error(
      `docker compose ${args.join(' ')} gagal (exit ${result.status})\n--- stdout ---\n${result.stdout ?? ''}\n--- stderr ---\n${result.stderr ?? ''}`,
    );
  }
  return result;
}

/** Jalankan skrip repo (grant / clone) dengan node yang sama seperti Makefile. */
export function runScript(name, args = [], { allowFail = false } = {}) {
  const result = spawnSync(process.execPath, [resolve(ROOT, 'scripts', name), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 300000,
  });
  if (result.status !== 0 && !allowFail) {
    throw new Error(`${name} ${args.join(' ')} gagal:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  }
  return result;
}

/** SQL sebagai root di satu node. `null` bila node tidak menjawab. */
export function nodeSql(node, sql, { timeoutMs = 10000, skipColumnNames = true } = {}) {
  const result = spawnSync(
    'docker',
    [
      ...COMPOSE_ARGS,
      'exec',
      '-T',
      node,
      'mariadb',
      '-uroot',
      `--password=${rootPassword}`,
      '--batch',
      ...(skipColumnNames ? ['--skip-column-names'] : []),
      '-e',
      sql,
    ],
    { encoding: 'utf8', timeout: timeoutMs },
  );
  if (result.status !== 0) return null;
  return (result.stdout ?? '').trim();
}

/**
 * Node yang bisa dipakai menjalankan klien `mariadb`.
 * Klien dijalankan DI DALAM container, jadi node yang mati tidak bisa dipakai
 * sebagai titik tolak — ini persis jebakan saat primary sengaja dimatikan.
 */
function liveNode() {
  return NODES.find((node) => nodeSql(node, 'SELECT 1') !== null) ?? null;
}

/** SQL lewat pintu masuk aplikasi (MaxScale 4006). Ini yang diuji, bukan
 * koneksi langsung ke node: setelah failover, alamat inilah yang harus tetap
 * bekerja tanpa perubahan konfigurasi dari sisi aplikasi.
 */
export function appSql(sql, { via = null, timeoutMs = 10000 } = {}) {
  const runner = via ?? liveNode();
  if (!runner) return { ok: false, out: '', err: 'tidak ada container MariaDB yang hidup untuk menjalankan klien' };
  return mariadb(appSqlArgs(['-hmaxscale', '-P4006'], sql), { via: runner, timeoutMs });
}

/** SQL sebagai user aplikasi langsung ke satu node (untuk menguji read_only). */
export function appSqlDirect(node, sql) {
  return mariadb(appSqlArgs([`-h${node}`], sql), { via: node });
}

function appSqlArgs(hostArgs, sql) {
  return [
    ...hostArgs,
    `-u${appUser}`,
    `--password=${appPassword}`,
    '--connect-timeout=3',
    '--batch',
    '--skip-column-names',
    '-e',
    sql,
  ];
}

function mariadb(args, { via, timeoutMs = 10000 }) {
  const result = spawnSync(
    'docker',
    [
      ...COMPOSE_ARGS,
      'exec',
      '-T',
      via,
      'mariadb',
      // Listener MaxScale di demo ini tanpa TLS; klien 11.4 menawarkan TLS
      // lebih dulu dan akan gagal tanpa flag ini.
      '--skip-ssl',
      ...args,
    ],
    { encoding: 'utf8', timeout: timeoutMs },
  );
  return {
    ok: result.status === 0,
    out: (result.stdout ?? '').trim(),
    err: (result.stderr ?? '').trim(),
  };
}

/** `{ node, readOnly, serverId }` untuk node yang menjawab. */
export function roles() {
  return NODES.map((node) => {
    const value = nodeSql(node, 'SELECT @@read_only, @@server_id');
    if (value === null) return { node, readOnly: null, serverId: null };
    const [readOnly, serverId] = value.split('\t');
    return { node, readOnly: readOnly === '1', serverId: Number(serverId) };
  });
}

/** Baris `SHOW SLAVE STATUS` sebagai objek, atau null bila node bukan replika. */
export function replication(node) {
  // Tanpa `--skip-column-names`: nama kolom dibutuhkan untuk memetakan nilai,
  // karena urutan kolom berbeda antar versi MariaDB.
  const raw = nodeSql(node, 'SHOW SLAVE STATUS', { skipColumnNames: false });
  if (!raw) return null;
  const [headerLine, valueLine] = raw.split(/\r?\n/);
  if (!valueLine) return null;
  const headers = headerLine.split('\t');
  const values = valueLine.split('\t');
  const row = {};
  headers.forEach((header, index) => {
    row[header] = values[index];
  });
  return row;
}

/** Tunggu MaxScale benar-benar melayani koneksi aplikasi. */
export async function waitForMaxscale({ timeoutMs = 120000 } = {}) {
  return waitFor(
    () => {
      const ping = appSql('SELECT 1');
      return ping.ok;
    },
    { timeoutMs, label: 'MaxScale 4006 menjawab' },
  );
}

/** Nyalakan cluster lengkap dengan urutan yang sama seperti `make db-up`. */
export async function bringUp() {
  dbCompose(['up', '-d', ...NODES]);
  runScript('db-grant-users.js');
  runScript('db-replica-clone.js', ['--force']);
  dbCompose(['up', '-d', 'maxscale', 'adminer']);
  await waitForMaxscale();
}

export function stopNode(node) {
  dbCompose(['stop', node]);
}

export function startNode(node) {
  dbCompose(['start', node]);
}

/** Diagnostik yang dicetak saat test gagal. */
export function diagnostics() {
  const ps = dbCompose(['ps'], { allowFail: true }).stdout ?? '';
  const maxscale = dbCompose(['logs', '--tail', '40', 'maxscale'], { allowFail: true }).stdout ?? '';
  return `--- docker compose ps ---\n${ps}\n--- maxscale (40 baris) ---\n${maxscale}`;
}

/** Kembalikan cluster ke keadaan sehat tanpa menghapus volume. */
export function heal() {
  dbCompose(['up', '-d', ...NODES], { allowFail: true });
  runScript('db-grant-users.js', [], { allowFail: true });
  runScript('db-replica-clone.js', ['--force'], { allowFail: true });
  dbCompose(['up', '-d', 'maxscale', 'adminer'], { allowFail: true });
}

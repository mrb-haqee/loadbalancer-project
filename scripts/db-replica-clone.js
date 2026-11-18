#!/usr/bin/env node
/**
 * Mengisi / menyegarkan replika dari primary yang sedang aktif.
 *
 * Dipakai dua peristiwa yang berbeda:
 * - `make db-up` / `make db-reset`: replika baru (volume kosong) harus diisi
 *   sebelum bisa mengejar primary.
 * - `make db-rejoin NODE=mariadb-primary`: node yang baru kembali hidup (mis.
 *   primary lama setelah failover) harus dibuang datanya yang mungkin sudah
 *   bercabang, lalu di-clone ulang sebagai replika.
 *
 * Kenapa dump, bukan `mariadb-backup`:
 * - Katalog demo berisi belasan baris; dump/restore selesai dalam hitungan detik
 *   dan mudah dibaca. `mariadb-backup` menambah user SST, izin volume, dan satu
 *   lagi cara gagal.
 *
 * Kenapa primary DICARI, bukan ditulis di skrip:
 * - Setelah failover, primary bisa `mariadb-replica-1` atau `mariadb-replica-2`.
 *   Menulis `mariadb-primary` di sini akan meng-clone dari node yang sudah mati.
 *
 * Idempotent: replika yang sudah mereplikasi dari primary yang benar dilewati.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE = ['compose', '-p', 'lb-db', '-f', resolve(ROOT, 'docker-compose.db.yml')];

/** Nama service compose; juga nama host di network `lb-net`. */
export const NODES = ['mariadb-primary', 'mariadb-replica-1', 'mariadb-replica-2'];

const rootPassword = process.env.MARIADB_ROOT_PASSWORD ?? 'lb_root_password';
const replPassword = process.env.MARIADB_REPL_PASSWORD ?? 'lb_repl_password';
const database = process.env.MARIADB_DATABASE ?? 'lb_demo';
const waitSeconds = Number(process.env.DB_CLONE_TIMEOUT_SECONDS ?? 120);

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function sqlString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

function sqlIdentifier(value) {
  if (!/^[A-Za-z0-9_$]+$/.test(String(value))) {
    throw new Error(`nama database tidak aman: ${value}`);
  }
  return `\`${value}\``;
}

function run(node, args, { input, timeoutMs = 60_000 } = {}) {
  return spawnSync(
    'docker',
    [...COMPOSE, 'exec', '-T', node, ...args],
    {
      encoding: 'utf8',
      input,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
}

/** Jalankan SQL sebagai root di satu node. Error tidak dilempar. */
function sql(node, statement, options) {
  return run(node, ['mariadb', '-uroot', `--password=${rootPassword}`, '--batch', '--skip-column-names', '-e', statement], options);
}

/** Jalankan SQL dan kembalikan stdout; error dilempar. */
function must(node, statement, options) {
  const result = sql(node, statement, options);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`${node}: ${statement.split('\n')[0]} gagal: ${detail}`);
  }
  return (result.stdout ?? '').trim();
}

async function waitForNode(node, { timeoutSeconds = waitSeconds } = {}) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastError = '';
  while (Date.now() < deadline) {
    const result = sql(node, 'SELECT 1', { timeoutMs: 4000 });
    if (result.status === 0) return;
    lastError = (result.stderr || result.stdout || '').trim();
    await sleep(2000);
  }
  throw new Error(`${node} tidak siap dalam ${timeoutSeconds} detik. ${lastError}`);
}

/** `{ node, readOnly }` untuk semua node yang bisa dihubungi. */
export function nodeRoles() {
  const roles = [];
  for (const node of NODES) {
    const result = sql(node, 'SELECT @@read_only, @@server_id');
    if (result.status !== 0) continue;
    const [readOnly, serverId] = (result.stdout ?? '').trim().split('\t');
    roles.push({ node, readOnly: readOnly === '1', serverId: Number(serverId) });
  }
  return roles;
}

/**
 * Server_id node yang sedang dilayani MaxScale (jalur aplikasi).
 * Mengembalikan null bila MaxScale belum hidup / belum punya master.
 */
function maxscaleMasterServerId() {
  const appUser = process.env.MARIADB_USER ?? 'lb_app';
  const appPassword = process.env.MARIADB_PASSWORD ?? 'lb_app_password';
  // Koneksi lewat MaxScale sengaja dipakai, bukan REST API: yang ingin diketahui
  // adalah "node mana yang dilihat APLIKASI sebagai primary", dan itu persis
  // yang dijawab listener 4006.
  for (const via of NODES) {
    const result = run(
      via,
      [
        'mariadb',
        // Klien 11.4 mencoba TLS lebih dulu; listener MaxScale di demo ini
        // sengaja tanpa TLS. Tanpa `--skip-ssl` setiap probe gagal dan
        // `findPrimaryNode` salah menyimpulkan "MaxScale belum bisa dihubungi".
        '--skip-ssl',
        '-hmaxscale',
        '-P4006',
        `-u${appUser}`,
        `--password=${appPassword}`,
        '--batch',
        '--skip-column-names',
        '-e',
        'SELECT @@server_id',
      ],
      { timeoutMs: 10_000 },
    );
    if (result.status === 0) {
      const value = (result.stdout ?? '').trim();
      return value ? Number(value) : null;
    }
  }
  return null;
}

/**
 * Node yang saat ini menerima penulisan, menurut MaxScale bila tersedia.
 *
 * `read_only` saja tidak cukup: saat primary lama dihidupkan lagi, ia masih
 * `read_only=OFF` sampai di-rejoin, sehingga scan sederhana akan melihat dua
 * "primary". MaxScale tetap memegang master yang sah, jadi jalur aplikasi
 * adalah sumber kebenaran. Scan `read_only` hanya dipakai saat bootstrap
 * (MaxScale belum jalan).
 */
export function findPrimaryNode() {
  const roles = nodeRoles();
  const writable = roles.filter((entry) => !entry.readOnly);

  const masterId = maxscaleMasterServerId();
  if (masterId !== null) {
    const master = roles.find((entry) => entry.serverId === masterId && !entry.readOnly);
    if (master) return master.node;
    throw new Error(
      `MaxScale melayani server_id ${masterId}, tetapi node itu tidak bisa ditulis. Periksa \`make db-status\`.`,
    );
  }

  if (writable.length === 1) return writable[0].node;
  if (writable.length === 0) {
    throw new Error('tidak ada node yang bisa ditulis (semua read_only). Jalankan `make db-status`.');
  }
  throw new Error(
    `ada lebih dari satu node bisa ditulis dan MaxScale belum bisa dihubungi: ${writable.map((entry) => entry.node).join(', ')}. ` +
      'Nyalakan MaxScale (`make db-up`) sebelum mempromosikan / me-rejoin node.',
  );
}

/** Baris `SHOW SLAVE STATUS` sebagai objek, atau null bila replika belum disetel. */
export function slaveStatus(node) {
  const result = run(node, ['mariadb', '-uroot', `--password=${rootPassword}`, '--batch', '-e', 'SHOW SLAVE STATUS']);
  if (result.status !== 0) return null;
  const lines = (result.stdout ?? '').trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const headers = lines[0].split('\t');
  const values = lines[1].split('\t');
  const row = {};
  headers.forEach((header, index) => {
    row[header] = values[index];
  });
  return row;
}

function isHealthyReplica(node, primary) {
  const status = slaveStatus(node);
  if (!status) return false;
  return (
    status.Master_Host === primary &&
    status.Slave_IO_Running === 'Yes' &&
    status.Slave_SQL_Running === 'Yes'
  );
}

/**
 * Ambil dump konsisten dari primary.
 * Opsi posisi ditulis dalam bentuk komentar (`=2`) dan WAJIB dipakai apa
 * adanya: menebak posisi sendiri (sebelum atau sesudah dump) berujung data
 * ganda atau data hilang.
 *
 * MariaDB 11.4 menyebutnya `--master-data`; versi yang lebih baru menerima
 * `--source-data` (nama netral). Keduanya dicoba supaya skrip tidak pecah saat
 * image dinaikkan. `--gtid` membuat dump memuat `gtid_slave_pos` — posisi itulah
 * yang dipakai, bukan nama file binlog.
 */
function dumpArgs(positionFlag) {
  return [
    'mariadb-dump',
    '-uroot',
    `--password=${rootPassword}`,
    '--single-transaction',
    positionFlag,
    '--gtid',
    '--routines',
    '--triggers',
    '--events',
    '--databases',
    database,
  ];
}

function dumpFrom(primary) {
  let result = run(primary, dumpArgs('--source-data=2'), { timeoutMs: 120_000 });
  if (result.status !== 0 && /unknown variable/i.test(result.stderr ?? '')) {
    result = run(primary, dumpArgs('--master-data=2'), { timeoutMs: 120_000 });
  }
  if (result.status !== 0) {
    throw new Error(`${primary}: mariadb-dump gagal: ${(result.stderr || '').trim()}`);
  }
  const dump = result.stdout ?? '';
  const gtid = dump.match(/SET\s+(?:@@)?GLOBAL\s+gtid_slave_pos\s*=\s*'([^']+)'/i);
  const filePosition = dump.match(
    /CHANGE\s+MASTER\s+TO\s+MASTER_LOG_FILE\s*=\s*'([^']+)'\s*,\s*MASTER_LOG_POS\s*=\s*(\d+)/i,
  );
  return {
    dump,
    gtidPosition: gtid?.[1] ?? null,
    logFile: filePosition?.[1] ?? null,
    logPosition: filePosition?.[2] ?? null,
  };
}

/**
 * Clone satu node dari primary.
 * `read_only` sengaja TIDAK dimatikan: MaxScale memakai variabel itu untuk
 * mengenali peran. Restore tetap bisa jalan karena root punya hak SUPER —
 * MariaDB tidak punya `super_read_only` seperti MySQL, jadi root selalu boleh
 * menulis saat `read_only=ON`. User aplikasi (`lb_app`) tidak punya SUPER.
 */
export async function cloneNode(node, primary) {
  if (node === primary) {
    throw new Error(`${node} adalah primary aktif; menolak meng-clone dari dirinya sendiri.`);
  }
  await waitForNode(node);
  console.log(`[clone] ${node} ← ${primary} ...`);

  const { dump, gtidPosition, logFile, logPosition } = dumpFrom(primary);
  if (!gtidPosition && !(logFile && logPosition)) {
    throw new Error('dump tidak memuat posisi replikasi (periksa --master-data=2 --gtid dan log_bin di primary).');
  }

  // Hentikan replikasi lama, kosongkan binlog node ini, dan buang database yang
  // mungkin sudah bercabang (mis. primary lama yang sempat menulis sendiri).
  // `sql_log_bin=0` di DROP mencegah event lokal yang bisa membuat urutan GTID
  // node ini bentrok dengan event primary.
  sql(node, 'STOP SLAVE;');
  sql(node, 'RESET SLAVE ALL;');
  must(node, 'RESET MASTER;');
  must(
    node,
    `SET SESSION sql_log_bin = 0; DROP DATABASE IF EXISTS ${sqlIdentifier(database)};`,
  );

  // `sql_log_bin=0` supaya restore tidak menghasilkan event binlog baru di node
  // ini (posisi GTID-nya harus persis mengikuti primary, bukan bercabang).
  const restore = run(
    node,
    ['mariadb', '-uroot', `--password=${rootPassword}`, '--init-command=SET SESSION sql_log_bin=0'],
    { input: dump, timeoutMs: 120_000 },
  );
  if (restore.status !== 0) {
    throw new Error(`${node}: restore dump gagal: ${(restore.stderr || restore.stdout || '').trim()}`);
  }

  // Restore sudah memakai `sql_log_bin=0`, tetapi `RESET MASTER` diulang di sini
  // supaya binlog node ini benar-benar kosong sebelum mengejar primary. Kalau
  // ada event lokal tersisa, `gtid_strict_mode` akan menolak event primary yang
  // urutan seq_no-nya tidak nyambung.
  must(node, 'RESET MASTER;');

  if (gtidPosition) {
    must(node, `SET GLOBAL gtid_slave_pos = ${sqlString(gtidPosition)};`);
  }

  const changeMaster = [
    'CHANGE MASTER TO',
    `MASTER_HOST = ${sqlString(primary)},`,
    'MASTER_PORT = 3306,',
    "MASTER_USER = 'lb_repl',",
    `MASTER_PASSWORD = ${sqlString(replPassword)},`,
    // MariaDB 11.4 mengaktifkan TLS + verifikasi sertifikat untuk koneksi
    // replika secara default. Cluster ini hanya di network Docker lokal dan
    // seluruh stack lain juga tanpa TLS, jadi dimatikan eksplisit — bukan
    // dibiarkan bergantung pada sertifikat yang kebetulan ada.
    'MASTER_SSL = 0,',
    gtidPosition ? 'MASTER_USE_GTID = slave_pos;' : `MASTER_LOG_FILE = ${sqlString(logFile)}, MASTER_LOG_POS = ${logPosition};`,
  ].join(' ');
  must(node, changeMaster);
  must(node, 'START SLAVE;');

  // Node ini sekarang replika, jadi harus `read_only=ON` — juga saat ia bekas
  // primary yang baru di-rejoin (`make db-rejoin`). Tanpa ini, selama beberapa
  // detik MaxScale bisa melihat dua node yang bisa ditulis.
  // Root tetap boleh menulis (MariaDB tidak punya `super_read_only`), jadi
  // langkah berikutnya di Makefile masih bisa melakukan grant.
  must(node, 'SET GLOBAL read_only = ON;');

  console.log(`[clone] ${node} mulai mereplikasi dari ${primary}`);
}

/**
 * Pastikan setiap node di `targets` mereplikasi dari primary aktif.
 * Replika yang sudah sehat dilewati (idempotent).
 */
export async function ensureReplication({ targets = null, force = false } = {}) {
  // Tunggu hanya node yang benar-benar dipakai. `make db-rejoin DB_NODE=x`
  // tidak boleh gagal karena replika lain kebetulan sedang mati.
  for (const node of targets ?? NODES) {
    await waitForNode(node);
  }
  const primary = findPrimaryNode();
  const wanted = targets ?? NODES.filter((node) => node !== primary);
  for (const node of wanted) {
    if (node === primary) {
      console.log(`[clone] ${node} adalah primary aktif; dilewati`);
      continue;
    }
    if (!force && isHealthyReplica(node, primary)) {
      console.log(`[clone] ${node} sudah mereplikasi dari ${primary}; dilewati`);
      continue;
    }
    await cloneNode(node, primary);
  }
  return primary;
}

function parseArgs(argv) {
  const nodes = [];
  let force = false;
  for (const arg of argv) {
    if (arg === '--force') force = true;
    else if (NODES.includes(arg)) nodes.push(arg);
  }
  return { nodes, force };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { nodes, force } = parseArgs(process.argv.slice(2));
  try {
    const primary = await ensureReplication({ targets: nodes.length ? nodes : null, force });
    console.log(`[clone] primary aktif: ${primary}`);
  } catch (error) {
    console.error(`[db-replica-clone] ${error.message}`);
    process.exit(1);
  }
}

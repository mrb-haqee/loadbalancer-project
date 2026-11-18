#!/usr/bin/env node
/**
 * Ringkasan satu layar untuk cluster database: siapa primary, siapa replika,
 * apakah replikasinya jalan, dan berapa lag-nya.
 *
 * Peran dibaca dari `@@read_only`, bukan dari nama container. Setelah failover,
 * `mariadb-replica-1` bisa menjadi primary — nama tidak lagi menipu.
 *
 * `make db-status` memanggil skrip ini. Exit code 1 bila tidak ada tepat satu
 * primary, supaya bisa dipakai di skrip/CI.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NODES, findPrimaryNode, nodeRoles, slaveStatus } from './db-replica-clone.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = resolve(ROOT, 'docker-compose.db.yml');

const appUser = process.env.MARIADB_USER ?? 'lb_app';
const appPassword = process.env.MARIADB_PASSWORD ?? 'lb_app_password';

function pad(value, width) {
  return String(value).padEnd(width);
}

let primary;
try {
  primary = findPrimaryNode();
} catch (error) {
  console.error(`[db-status] ${error.message}`);
  process.exit(1);
}

const roles = nodeRoles();
const rows = NODES.map((node) => {
  const role = roles.find((entry) => entry.node === node);
  const status = role ? slaveStatus(node) : null;
  const lag = status?.Seconds_Behind_Master;
  return {
    node,
    role: !role ? 'DOWN' : role.readOnly ? 'replica' : 'PRIMARY',
    readOnly: role ? (role.readOnly ? 'ON' : 'OFF') : '-',
    io: status?.Slave_IO_Running ?? '-',
    sql: status?.Slave_SQL_Running ?? '-',
    lag: lag === undefined || lag === null || lag === 'NULL' ? '-' : `${lag}s`,
    master: status?.Master_Host ?? '-',
  };
});

const widths = {
  node: Math.max(4, ...rows.map((row) => row.node.length)),
  role: 7,
  readOnly: 8,
  io: 2,
  sql: 3,
  lag: 4,
  master: Math.max(6, ...rows.map((row) => row.master.length)),
};

console.log(
  [
    pad('node', widths.node),
    pad('role', widths.role),
    pad('read_only', widths.readOnly),
    pad('io', widths.io),
    pad('sql', widths.sql),
    pad('lag', widths.lag),
    'master',
  ].join('  '),
);
for (const row of rows) {
  console.log(
    [
      pad(row.node, widths.node),
      pad(row.role, widths.role),
      pad(row.readOnly, widths.readOnly),
      pad(row.io, widths.io),
      pad(row.sql, widths.sql),
      pad(row.lag, widths.lag),
      row.master,
    ].join('  '),
  );
}

// Bukti bahwa jalur aplikasi (lewat MaxScale) benar-benar sampai ke primary.
const ping = spawnSync(
  'docker',
  [
    'compose',
    '-p',
    'lb-db',
    '-f',
    COMPOSE_FILE,
    'exec',
    '-T',
    primary,
    'mariadb',
    // Klien MariaDB 11.4 mencoba TLS lebih dulu; listener MaxScale di demo ini
    // sengaja tanpa TLS, jadi negosiasi itu harus dimatikan eksplisit.
    '--skip-ssl',
    '-hmaxscale',
    '-P4006',
    `-u${appUser}`,
    `--password=${appPassword}`,
    '--batch',
    '--skip-column-names',
    '-e',
    'SELECT @@read_only',
  ],
  { encoding: 'utf8', timeout: 15000 },
);

if (ping.status === 0) {
  console.log(`\nmaxscale:4006 -> ${primary} (read_only=${(ping.stdout ?? '').trim() || '?'})`);
} else {
  const detail = `${ping.stderr ?? ''}${ping.stdout ?? ''}`.trim().split(/\r?\n/).filter(Boolean)[0] ?? 'tanpa pesan';
  console.log(`\nmaxscale:4006 TIDAK menjawab: ${detail}`);
}

console.log(`primary aktif: ${primary}`);

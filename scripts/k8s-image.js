#!/usr/bin/env node
/**
 * Impor image Docker ke semua node cluster k3d.
 *
 * `k3d image import` gagal di sebagian setup Windows + Docker Desktop dengan
 * pesan `ctr: content digest ...: not found`. Skrip ini memakai jalur yang
 * lebih langsung dan terbukti jalan di sini:
 *
 *   docker save  →  docker cp ke node  →  ctr -n k8s.io images import
 *
 *   bun scripts/k8s-image.js lb-backend:dev
 *   bun scripts/k8s-image.js traefik:v3.6.6 --cluster lb-k8s
 *
 * Image harus sudah ada di Docker host (hasil `docker build` atau `docker
 * pull`). Tanpa registry, ini cara paling sederhana memasukkan image ke k3s.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const positional = [];
let cluster = process.env.K8S_CLUSTER || 'lb-k8s';

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--cluster') {
    cluster = args[index + 1];
    index += 1;
  } else if (arg.startsWith('--cluster=')) {
    cluster = arg.slice('--cluster='.length);
  } else {
    positional.push(arg);
  }
}

const image = positional[0];

if (!image) {
  console.error('Pemakaian: bun scripts/k8s-image.js <image:tag> [--cluster <nama>]');
  process.exit(1);
}

/** Jalankan perintah, tampilkan output, dan hentikan skrip kalau gagal. */
function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    console.error(`Gagal: ${command} ${commandArgs.join(' ')}`);
    if (detail) console.error(detail);
    process.exit(result.status ?? 1);
  }
  return (result.stdout || '').trim();
}

/** Node yang menjalankan k3s (server + agent), tanpa loadbalancer/tools. */
function clusterNodes() {
  const output = run('docker', [
    'ps',
    '-a',
    '--filter',
    `label=k3d.cluster=${cluster}`,
    '--format',
    '{{.Names}}\t{{.Label "k3d.role"}}',
  ]);
  return output
    .split(/\r?\n/)
    .map((line) => line.split('\t'))
    .filter(([, role]) => role === 'server' || role === 'agent')
    .map(([name]) => name);
}

const nodes = clusterNodes();
if (nodes.length === 0) {
  console.error(`Tidak ada node untuk cluster '${cluster}'. Cek: k3d cluster list`);
  process.exit(1);
}

const workDir = mkdtempSync(join(tmpdir(), 'k3d-image-'));
const tarball = join(workDir, 'image.tar');

try {
  console.log(`Menyimpan ${image} ke tar...`);
  run('docker', ['save', image, '-o', tarball]);

  for (const node of nodes) {
    console.log(`Mengimpor ke ${node}...`);
    run('docker', ['cp', tarball, `${node}:/tmp/k3d-image.tar`]);
    run('docker', ['exec', node, 'ctr', '-n', 'k8s.io', 'images', 'import', '/tmp/k3d-image.tar']);
    run('docker', ['exec', node, 'rm', '-f', '/tmp/k3d-image.tar']);
  }

  console.log(`Selesai: ${image} tersedia di ${nodes.length} node (${cluster}).`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

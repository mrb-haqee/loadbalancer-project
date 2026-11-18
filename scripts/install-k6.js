#!/usr/bin/env node
/**
 * Install k6 (binary resmi Grafana) tanpa package manager OS.
 *
 *   bun scripts/install-k6.js           # install kalau belum ada
 *   bun scripts/install-k6.js --force   # paksa unduh ulang
 *
 * k6 bukan paket JavaScript (binary Go), jadi `bun add k6` tidak bisa dipakai:
 * paket npm bernama "k6" hanyalah dummy untuk autocomplete editor.
 * Skrip ini mengunduh asset resmi dari GitHub releases ke tools/k6/.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS_DIR = join(ROOT, 'tools', 'k6');
const TEMP_DIR = join(ROOT, 'tools', '.k6-download');
const BINARY_NAME = process.platform === 'win32' ? 'k6.exe' : 'k6';
const BINARY_PATH = join(TOOLS_DIR, BINARY_NAME);
const force = process.argv.includes('--force');

const PLATFORM = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[process.platform];
const ARCH = { x64: 'amd64', arm64: 'arm64', arm: 'armv7' }[process.arch];

if (!PLATFORM || !ARCH) {
  console.error(`Platform tidak didukung: ${process.platform}/${process.arch}`);
  process.exit(1);
}

function printVersion() {
  const result = spawnSync(BINARY_PATH, ['version'], { encoding: 'utf8' });
  const version = (result.stdout || result.stderr).trim().split('\n')[0];
  console.log(`k6 siap: ${BINARY_PATH}`);
  console.log(`  ${version}`);
}

if (existsSync(BINARY_PATH) && !force) {
  console.log('k6 sudah terpasang, lewati unduhan (pakai --force untuk unduh ulang).');
  printVersion();
  process.exit(0);
}

function findBinary(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      const found = findBinary(full);
      if (found) return found;
    } else if (entry === BINARY_NAME) {
      return full;
    }
  }
  return null;
}

console.log('Mengambil rilis terbaru k6 dari GitHub...');
const releaseRes = await fetch('https://api.github.com/repos/grafana/k6/releases/latest', {
  headers: { 'user-agent': 'lb-demo-installer', accept: 'application/vnd.github+json' },
});
if (!releaseRes.ok) {
  console.error(`Gagal mengambil info rilis: HTTP ${releaseRes.status}`);
  process.exit(1);
}
const release = await releaseRes.json();

const asset = release.assets.find(
  (candidate) =>
    candidate.name.includes(PLATFORM) &&
    candidate.name.includes(ARCH) &&
    (candidate.name.endsWith('.zip') || candidate.name.endsWith('.tar.gz')),
);
if (!asset) {
  console.error(`Asset untuk ${PLATFORM}/${ARCH} tidak ditemukan pada ${release.tag_name}`);
  process.exit(1);
}

console.log(`  ${release.tag_name} → ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)`);

const download = await fetch(asset.browser_download_url, { redirect: 'follow' });
if (!download.ok) {
  console.error(`Gagal mengunduh: HTTP ${download.status}`);
  process.exit(1);
}
const bytes = Buffer.from(await download.arrayBuffer());

rmSync(TEMP_DIR, { recursive: true, force: true });
mkdirSync(TEMP_DIR, { recursive: true });
const archivePath = join(TEMP_DIR, asset.name);
writeFileSync(archivePath, bytes);
console.log(`  tersimpan: ${archivePath}`);

console.log('Mengekstrak (bsdtar mendukung zip & tar.gz)...');
const extract = spawnSync('tar', ['-xf', archivePath, '-C', TEMP_DIR], { encoding: 'utf8' });
if (extract.status !== 0) {
  console.error(`Gagal mengekstrak:\n${extract.stdout}\n${extract.stderr}`);
  process.exit(1);
}

const extracted = findBinary(TEMP_DIR);
if (!extracted) {
  console.error('Binary k6 tidak ditemukan di dalam arsip.');
  process.exit(1);
}

mkdirSync(TOOLS_DIR, { recursive: true });
rmSync(BINARY_PATH, { force: true });
writeFileSync(BINARY_PATH, readFileSync(extracted));
if (process.platform !== 'win32') chmodSync(BINARY_PATH, 0o755);
rmSync(TEMP_DIR, { recursive: true, force: true });

printVersion();
console.log(`\nJalankan: bun scripts/k6.js run k6/load-test.js`);
console.log(`Atau    : make k6-load   (default BASE_URL=http://server.localhost)`);

#!/usr/bin/env node
/**
 * Pembungkus k6 supaya perintahnya sama di Windows/Linux/macOS.
 *
 *   bun scripts/k6.js run k6/load-test.js
 *   bun scripts/k6.js run k6/failover.js -e BASE_URL=http://127.0.0.1:8088
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = join(ROOT, 'tools', 'k6', process.platform === 'win32' ? 'k6.exe' : 'k6');

if (!existsSync(binary)) {
  console.error('k6 belum terpasang di tools/k6/.');
  console.error('Jalankan dulu: bun scripts/install-k6.js');
  process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(2), { cwd: ROOT, stdio: 'inherit' });
process.exit(result.status ?? 1);

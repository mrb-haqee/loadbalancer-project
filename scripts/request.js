#!/usr/bin/env node
/**
 * Alat uji request manual ke load balancer yang SEDANG BERJALAN.
 *
 *   npm run request -- --requests 30
 *   npm run request -- --requests 600 --concurrency 50
 *   npm run request -- --path /halo --requests 9 --verbose
 *   npm run request -- --method POST --path /kirim --body '{"a":1}'
 *
 * Berbeda dari `npm test` yang menyalakan cluster sendiri.
 */
import { loadConfig } from '../src/shared/config.js';

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [key, inline] = arg.slice(2).split('=');
    if (inline !== undefined) {
      result[key] = inline;
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      result[key] = argv[i + 1];
      i += 1;
    } else {
      result[key] = 'true';
    }
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const config = loadConfig();

const total = Math.max(1, Number(args.requests ?? 30));
const concurrency = Math.min(Math.max(1, Number(args.concurrency ?? 1)), 500);
const path = args.path ?? '/halo';
const method = (args.method ?? 'GET').toUpperCase();
const body = args.body ?? null;
const base = (args.base ?? `http://${config.loadBalancer.host}:${config.loadBalancer.port}`).replace(/\/$/, '');
const showEach = args.verbose === 'true' || (args.verbose === undefined && total <= 20);

const results = [];
let nextIndex = 0;

async function sendOne(index) {
  const startedAt = performance.now();
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ?? undefined,
      signal: AbortSignal.timeout(15000),
    });
    await res.arrayBuffer();
    return {
      index,
      status: res.status,
      servedBy: res.headers.get('x-served-by') ?? '(tidak ada)',
      ms: Math.round(performance.now() - startedAt),
      error: null,
    };
  } catch (error) {
    return {
      index,
      status: 0,
      servedBy: '(gagal)',
      ms: Math.round(performance.now() - startedAt),
      error: error.message,
    };
  }
}

async function worker() {
  while (true) {
    const index = nextIndex;
    nextIndex += 1;
    if (index >= total) return;
    const result = await sendOne(index);
    results.push(result);
    if (showEach) {
      const tag = result.status === 0 ? 'GAGAL' : result.status;
      console.log(
        `#${String(result.index + 1).padStart(3)}  ${String(tag).padEnd(5)}  ` +
          `${result.servedBy.padEnd(10)} ${String(result.ms).padStart(4)}ms` +
          (result.error ? `  ${result.error}` : ''),
      );
    }
  }
}

function bar(share, width = 24) {
  const filled = Math.round((share / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

const startedAt = Date.now();
console.log(
  `Menembak ${total} request ${method} ke ${base}${path}` +
    `${concurrency > 1 ? ` (konkurensi ${concurrency})` : ''}...\n`,
);

await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));
const durationMs = Date.now() - startedAt;

const statusCount = new Map();
const backendCount = new Map();
for (const result of results) {
  const key = result.status === 0 ? 'ERROR' : result.status;
  statusCount.set(key, (statusCount.get(key) ?? 0) + 1);
  backendCount.set(result.servedBy, (backendCount.get(result.servedBy) ?? 0) + 1);
}

const succeeded = results.filter((r) => r.status >= 200 && r.status < 300).length;
const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
const p = (percent) => latencies[Math.min(latencies.length - 1, Math.floor((percent / 100) * latencies.length))];

console.log('\nRingkasan');
console.log('-'.repeat(58));
console.log(`Sukses 2xx   : ${succeeded}/${total}`);
console.log(`Gagal        : ${total - succeeded}`);
console.log(`Status       : ${[...statusCount].map(([k, v]) => `${k}=${v}`).join(', ')}`);
console.log(`Durasi       : ${durationMs} ms (±${Math.round((total / durationMs) * 1000)} req/detik)`);
console.log(`Latensi      : min ${latencies[0]}ms · median ${p(50)}ms · p95 ${p(95)}ms · max ${latencies.at(-1)}ms`);

console.log('\nSebaran backend');
console.log('-'.repeat(58));
console.log('Backend      Request   Porsi');
for (const [backend, count] of [...backendCount].sort((a, b) => b[1] - a[1])) {
  const share = (count / total) * 100;
  console.log(
    `${backend.padEnd(12)} ${String(count).padStart(7)}   ${share.toFixed(1).padStart(5)}%  ${bar(share)}`,
  );
}

const errors = results.filter((r) => r.error).slice(0, 5);
if (errors.length) {
  console.log('\nContoh error');
  console.log('-'.repeat(58));
  for (const error of errors) console.log(`#${error.index + 1}: ${error.error}`);
}

process.exitCode = succeeded === total ? 0 : 1;

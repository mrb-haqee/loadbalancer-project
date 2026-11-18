#!/usr/bin/env node
/**
 * Uji CRUD acak lewat load balancer.
 *
 * Membuat COUNT entitas katalog dengan payload acak, memakai USERS worker
 * paralel yang berbagi satu antrean. Mode `full` menjalani siklus
 * POST → GET → PUT → GET → DELETE → GET(404); mode `create` hanya POST.
 *
 * Semua data yang dibuat dihapus lagi di akhir kecuali `--keep`/KEEP=1,
 * termasuk saat run gagal di tengah jalan.
 *
 * Pemakaian:
 *   node scripts/crud-load.js --count 500 --users 20
 *   node scripts/crud-load.js --count 2000 --users 50 --report monitoring/reports/crud.json
 *   node scripts/crud-load.js --mode create --keep
 *
 * Parameter juga bisa lewat env: COUNT, USERS, BASE_URL, MODE, KEEP, REPORT.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { dirname } from 'node:path';

const WORDS = [
  'demo',
  'uji',
  'acak',
  'beban',
  'katalog',
  'server',
  'catatan',
  'lokal',
  'data',
  'contoh',
];

const USAGE = `Uji CRUD acak lewat load balancer.

Pemakaian:
  node scripts/crud-load.js [opsi]
  make crud-load COUNT=500 USERS=20

Opsi:
  -c, --count N      Jumlah entitas yang dibuat (default 100)
  -u, --users N      Jumlah worker paralel (default 10)
      --base URL     Base URL, default http://server.localhost
      --mode MODE    full (default) atau create
      --timeout MS   Timeout per request (default 20000)
      --keep         Jangan hapus data setelah run
      --report PATH  Simpan ringkasan JSON ke PATH
  -h, --help         Tampilkan bantuan ini

Env var yang setara: COUNT, USERS, BASE_URL, MODE, KEEP, REPORT.

Mode full per entitas: POST, GET, PUT, GET, DELETE, GET (harus 404).
Mode create per entitas: POST saja, lalu dibersihkan di akhir.
`;

const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const pick = (items) => items[randInt(0, items.length - 1)];
const nowMs = () => performance.now();

function fail(message) {
  console.error(`crud-load: ${message}`);
  console.error('Jalankan `node scripts/crud-load.js --help` untuk daftar opsi.');
  process.exit(2);
}

function parseNumber(name, value, { min = 1 } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) fail(`${name} harus bilangan bulat >= ${min}, dapat: ${value}`);
  return parsed;
}

function parseArgs(argv) {
  const env = process.env;
  const config = {
    count: env.COUNT ? parseNumber('COUNT', env.COUNT) : 100,
    users: env.USERS ? parseNumber('USERS', env.USERS) : 10,
    baseUrl: env.BASE_URL || 'http://server.localhost',
    mode: env.MODE || 'full',
    keep: env.KEEP === '1' || env.KEEP === 'true',
    report: env.REPORT || null,
    timeoutMs: env.TIMEOUT_MS ? parseNumber('TIMEOUT_MS', env.TIMEOUT_MS) : 20000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const [flag, inline] = raw.includes('=') ? raw.split(/=(.*)/s).slice(0, 2) : [raw, undefined];
    const value = () => {
      if (inline !== undefined) return inline;
      i += 1;
      if (i >= argv.length) fail(`${flag} butuh nilai`);
      return argv[i];
    };

    switch (flag) {
      case '-c':
      case '--count':
        config.count = parseNumber('count', value());
        break;
      case '-u':
      case '--users':
        config.users = parseNumber('users', value());
        break;
      case '--base':
        config.baseUrl = value();
        break;
      case '--mode':
        config.mode = value();
        break;
      case '--timeout':
        config.timeoutMs = parseNumber('timeout', value());
        break;
      case '--keep':
        config.keep = true;
        break;
      case '--report':
        config.report = value();
        break;
      case '-h':
      case '--help':
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        fail(`opsi tidak dikenal: ${raw}`);
    }
  }

  if (!['full', 'create'].includes(config.mode)) fail(`mode harus "full" atau "create", dapat: ${config.mode}`);
  try {
    const url = new URL(config.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protokol harus http/https');
  } catch (error) {
    fail(`base URL tidak valid (${config.baseUrl}): ${error.message}`);
  }

  config.baseUrl = config.baseUrl.replace(/\/+$/, '');
  return config;
}

const config = parseArgs(process.argv.slice(2));
const basePath = new URL(config.baseUrl).pathname.replace(/\/+$/, '');
const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: Math.max(config.users * 2, 10) }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: Math.max(config.users * 2, 10) }),
};

const stats = {
  requests: 0,
  ok: 0,
  failed: 0,
  entityFailures: 0,
  created: 0,
  deletedInCycle: 0,
  servedBy: {},
  operations: new Map(),
  failures: [],
};

const begunAt = new Date();

function operationStat(name) {
  if (!stats.operations.has(name)) {
    stats.operations.set(name, { total: 0, ok: 0, failed: 0, latencies: [] });
  }
  return stats.operations.get(name);
}

function record(name, durationMs, ok, servedBy) {
  stats.requests += 1;
  const op = operationStat(name);
  op.total += 1;
  op.latencies.push(durationMs);
  if (ok) {
    stats.ok += 1;
    op.ok += 1;
    if (servedBy) stats.servedBy[servedBy] = (stats.servedBy[servedBy] ?? 0) + 1;
  } else {
    stats.failed += 1;
    op.failed += 1;
  }
}

class RequestFailure extends Error {
  constructor(message, { status = null, systemic = false } = {}) {
    super(message);
    this.name = 'RequestFailure';
    this.status = status;
    this.systemic = systemic;
  }
}

function shorten(text, max = 200) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Satu request HTTP; .localhost ditembak 127.0.0.1 dengan header Host. */
function httpCall(method, path, body) {
  const target = new URL(config.baseUrl);
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
  const headers = { accept: 'application/json' };
  if (payload) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(payload.length);
  }

  let hostname = target.hostname;
  let port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
  if (hostname.endsWith('.localhost')) {
    headers.host = hostname;
    hostname = '127.0.0.1';
  }

  const client = target.protocol === 'https:' ? https : http;
  const startedAt = nowMs();

  return new Promise((resolvePromise, rejectPromise) => {
    const req = client.request(
      {
        protocol: target.protocol,
        hostname,
        port,
        method,
        path: `${basePath}${path}`,
        headers,
        agent: agents[target.protocol],
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            /* biarkan teks */
          }
          resolvePromise({
            status: res.statusCode,
            headers: res.headers,
            text,
            json,
            servedBy: res.headers['x-served-by'],
            durationMs: nowMs() - startedAt,
          });
        });
      },
    );

    req.setTimeout(config.timeoutMs, () => {
      const error = new Error(`request timeout ${config.timeoutMs}ms: ${method} ${path}`);
      error.code = 'ETIMEDOUT';
      req.destroy(error);
    });
    req.on('error', (error) => {
      error.durationMs = nowMs() - startedAt;
      rejectPromise(error);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** Request dengan status yang diharapkan; kegagalan dihitung ke statistik. */
async function call(name, method, path, body, expectedStatus) {
  let res;
  try {
    res = await httpCall(method, path, body);
  } catch (error) {
    record(name, error.durationMs ?? 0, false, null);
    const systemic = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ECONNRESET', 'EPIPE'].includes(
      error.code,
    );
    throw new RequestFailure(`${method} ${path} gagal: ${error.message}`, { systemic });
  }

  const ok = res.status === expectedStatus;
  record(name, res.durationMs, ok, res.servedBy);
  if (!ok) {
    const detail = res.json?.error?.message ?? shorten(res.text);
    throw new RequestFailure(`${method} ${path} → ${res.status} (harap ${expectedStatus})${detail ? `: ${detail}` : ''}`, {
      status: res.status,
      systemic: res.status >= 500,
    });
  }
  return res;
}

function makePayload(index, name) {
  const note = `${pick(WORDS)} ${pick(WORDS)} ${pick(WORDS)} #${index}`;
  return {
    name,
    host: `10.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(1, 254)}`,
    port: randInt(1, 65535),
    weight: randInt(1, 100),
    enabled: Math.random() < 0.75,
    note,
  };
}

function assertEntity(actual, expected, context) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
    throw new RequestFailure(`${context}: respons bukan objek`);
  }
  if (!Number.isInteger(actual.id) || actual.id <= 0) {
    throw new RequestFailure(`${context}: id tidak valid (${JSON.stringify(actual.id)})`);
  }
  for (const field of ['name', 'host', 'port', 'weight', 'enabled', 'note']) {
    if (actual[field] !== expected[field]) {
      throw new RequestFailure(
        `${context}: ${field} tidak sesuai (harap ${JSON.stringify(expected[field])}, dapat ${JSON.stringify(actual[field])})`,
      );
    }
  }
}

const createdIds = [];
let cleaned = 0;
let cleanupFailed = 0;

async function runEntity(index) {
  const name = `crud-${runId}-${index}`;
  const entity = makePayload(index, name);
  let id = null;
  let deleted = false;

  try {
    const post = await call('POST /api/servers', 'POST', '/api/servers', entity, 201);
    id = post.json?.id;
    stats.created += 1;
    assertEntity(post.json, entity, 'POST');
    if (post.headers.location !== `/api/servers/${id}`) {
      throw new RequestFailure(`POST: Location tidak sesuai (${post.headers.location})`);
    }

    if (config.mode === 'create') return;

    const path = `/api/servers/${id}`;
    const get1 = await call('GET /api/servers/:id', 'GET', path, undefined, 200);
    assertEntity(get1.json, entity, 'GET setelah POST');

    const updated = makePayload(index, name);
    const put = await call('PUT /api/servers/:id', 'PUT', path, updated, 200);
    assertEntity(put.json, updated, 'PUT');

    const get2 = await call('GET /api/servers/:id', 'GET', path, undefined, 200);
    assertEntity(get2.json, updated, 'GET setelah PUT');

    await call('DELETE /api/servers/:id', 'DELETE', path, undefined, 204);
    deleted = true;
    stats.deletedInCycle += 1;

    const gone = await call('GET /api/servers/:id', 'GET', path, undefined, 404);
    if (gone.json?.error?.code !== 'NOT_FOUND') {
      throw new RequestFailure(`GET setelah DELETE: kode error bukan NOT_FOUND (${gone.json?.error?.code})`);
    }
  } catch (error) {
    if (!(error instanceof RequestFailure)) throw error;
    stats.entityFailures += 1;
    if (stats.failures.length < 50) {
      stats.failures.push({ index, name, message: error.message, status: error.status });
    }
    throw error;
  } finally {
    if (id && (config.mode === 'create' || !deleted)) createdIds.push(id);
  }
}

async function cleanup() {
  if (config.keep || createdIds.length === 0) return;
  let next = 0;
  const workers = Array.from({ length: Math.min(config.users, createdIds.length) }, async () => {
    while (next < createdIds.length) {
      const id = createdIds[next];
      next += 1;
      try {
        const res = await httpCall('DELETE', `/api/servers/${id}`);
        if (res.status === 204 || res.status === 404) cleaned += 1;
        else cleanupFailed += 1;
      } catch {
        cleanupFailed += 1;
      }
    }
  });
  await Promise.all(workers);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function formatMs(value) {
  return `${value.toFixed(1)} ms`;
}

function padded(value, width) {
  return String(value).padEnd(width);
}

function printSummary({ interrupted, abortReason, durationMs }) {
  const seconds = durationMs / 1000;
  const perSecond = seconds > 0 ? stats.requests / seconds : 0;

  console.log('');
  console.log('Ringkasan uji CRUD acak');
  console.log(`  base        : ${config.baseUrl}`);
  console.log(`  mode        : ${config.mode}`);
  console.log(`  entitas     : ${config.count}`);
  console.log(`  user        : ${config.users}`);
  console.log(`  durasi      : ${seconds.toFixed(2)} detik`);
  console.log(`  throughput  : ${perSecond.toFixed(1)} request/detik`);

  console.log('');
  console.log('Operasi                     total      ok   gagal      p50      p95      max');
  for (const [name, op] of stats.operations) {
    const sorted = [...op.latencies].sort((a, b) => a - b);
    console.log(
      `  ${padded(name, 26)} ${padded(op.total, 7)} ${padded(op.ok, 7)} ${padded(op.failed, 7)} ` +
        `${padded(formatMs(percentile(sorted, 50)), 9)} ${padded(formatMs(percentile(sorted, 95)), 9)} ` +
        `${formatMs(sorted[sorted.length - 1] ?? 0)}`,
    );
  }

  console.log('');
  console.log(`Request : ${stats.ok}/${stats.requests} sesuai harapan, ${stats.failed} gagal`);
  console.log(`Entitas : ${done} selesai, ${stats.entityFailures} gagal (diminta ${config.count})`);

  const spread = Object.entries(stats.servedBy)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([server, total]) => `${server} ${total}`)
    .join(' · ');
  console.log(`Backend : ${spread || '(tidak ada header x-served-by)'}`);

  const leftover = Math.max(stats.created - stats.deletedInCycle - cleaned, 0);
  console.log(
    `Data    : ${stats.created} dibuat · ${stats.deletedInCycle} dihapus dalam siklus · ` +
      `${cleaned} dibersihkan · ${leftover} tersisa`,
  );
  if (config.keep) console.log('KEEP=1 : data sengaja dipertahankan di katalog.');
  if (cleanupFailed > 0) console.log(`Peringatan: ${cleanupFailed} data gagal dihapus.`);

  if (stats.failures.length > 0) {
    console.log('');
    console.log(`Kegagalan pertama (${stats.failures.length} dari ${stats.failed}):`);
    stats.failures.slice(0, 10).forEach((failure, i) => {
      console.log(`  ${i + 1}. #${failure.index} ${failure.message}`);
    });
  }
  if (abortReason) {
    console.log('');
    console.log(`Berhenti lebih awal: ${abortReason}`);
  }
  if (interrupted) console.log('Run dibatalkan (SIGINT); data yang sempat dibuat tetap dibersihkan.');
}

function writeReport({ durationMs, interrupted, abortReason }) {
  if (!config.report) return;
  const operations = {};
  for (const [name, op] of stats.operations) {
    const sorted = [...op.latencies].sort((a, b) => a - b);
    operations[name] = {
      total: op.total,
      ok: op.ok,
      failed: op.failed,
      p50Ms: Number(percentile(sorted, 50).toFixed(1)),
      p95Ms: Number(percentile(sorted, 95).toFixed(1)),
      maxMs: Number((sorted[sorted.length - 1] ?? 0).toFixed(1)),
    };
  }

  const report = {
    tool: 'crud-load',
    ok: stats.entityFailures === 0 && cleanupFailed === 0 && !abortReason && !interrupted,
    startedAt: begunAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(durationMs),
    config: {
      baseUrl: config.baseUrl,
      mode: config.mode,
      count: config.count,
      users: config.users,
      keep: config.keep,
      timeoutMs: config.timeoutMs,
    },
    summary: {
      requests: stats.requests,
      ok: stats.ok,
      failed: stats.failed,
      entityFailures: stats.entityFailures,
      entitiesCompleted: done,
      requestsPerSecond: Number((stats.requests / Math.max(durationMs / 1000, 0.001)).toFixed(1)),
      created: stats.created,
      deletedInCycle: stats.deletedInCycle,
      cleanupTargets: createdIds.length,
      cleaned,
      cleanupFailed,
    },
    servedBy: stats.servedBy,
    operations,
    failures: stats.failures,
    aborted: abortReason ?? null,
  };

  mkdirSync(dirname(config.report), { recursive: true });
  writeFileSync(config.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Laporan JSON: ${config.report}`);
}

let interrupted = false;
let abortReason = null;
process.on('SIGINT', () => {
  interrupted = true;
  abortReason ??= 'dibatalkan pengguna (SIGINT)';
});

const startedAt = nowMs();
let done = 0;
let nextIndex = 0;

const progress = process.stderr.isTTY
  ? setInterval(() => {
      const percent = Math.floor((done / config.count) * 100);
      process.stderr.write(`\rprogres ${percent}% (${done}/${config.count} entitas)`);
    }, 500)
  : null;

async function worker() {
  while (!abortReason && !interrupted) {
    const index = nextIndex;
    nextIndex += 1;
    if (index >= config.count) return;

    try {
      await runEntity(index);
    } catch (error) {
      if (error instanceof RequestFailure && error.systemic) {
        abortReason ??= `${error.message} — kemungkinan stack mati; coba \`make stack-up\` atau \`make db-up\`.`;
        return;
      }
      if (!(error instanceof RequestFailure)) {
        abortReason ??= `kesalahan internal: ${error.stack ?? error.message}`;
        return;
      }
    }
    done += 1;
  }
}

try {
  await Promise.all(Array.from({ length: Math.min(config.users, config.count) }, () => worker()));
} finally {
  if (progress) {
    clearInterval(progress);
    process.stderr.write('\r'.padEnd(60) + '\r');
  }
}

await cleanup();
const durationMs = nowMs() - startedAt;

printSummary({ interrupted, abortReason, durationMs });
writeReport({ durationMs, interrupted, abortReason });

const exitCode = stats.entityFailures > 0 || cleanupFailed > 0 || abortReason || interrupted ? 1 : 0;
process.exitCode = exitCode;

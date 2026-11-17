#!/usr/bin/env node
import http from 'node:http';
import { loadConfig } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';

const config = loadConfig();
const backendId = process.env.BACKEND_ID;
const fromConfig = config.backends.find((backend) => backend.id === backendId);

if (!backendId || (!fromConfig && !process.env.BACKEND_PORT)) {
  console.error(`[backend] BACKEND_ID tidak dikenal: ${backendId ?? '(kosong)'}`);
  console.error(`[backend] pilihan yang tersedia: ${config.backends.map((b) => b.id).join(', ')}`);
  console.error('[backend] di container, set BACKEND_ID dan BACKEND_PORT (mis. backend-1 / 3000).');
  process.exit(1);
}

// Di container identitas datang dari env, di lokal dari config.json.
const self = {
  id: backendId,
  host: process.env.BACKEND_HOST ?? fromConfig?.host ?? '127.0.0.1',
  port: Number(process.env.BACKEND_PORT ?? fromConfig?.port ?? 3000),
};

const log = createLogger(self.id);
const startedAt = Date.now();
let requestCount = 0;
let slowRequestCount = 0;

// Histogram durasi request untuk /metrics (format Prometheus).
// Health check dan /metrics sendiri tidak dihitung agar angkanya tidak tercemar
// probe 2 detik milik Traefik.
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5];
const durationBucketCounts = new Array(DURATION_BUCKETS.length).fill(0);
let durationSum = 0;
let durationCount = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? self.host}`);
  const startedAtNs = process.hrtime.bigint();

  res.on('finish', () => {
    if (url.pathname === '/health' || url.pathname === '/metrics') return;
    const seconds = Number(process.hrtime.bigint() - startedAtNs) / 1e9;
    durationSum += seconds;
    durationCount += 1;
    for (let i = 0; i < DURATION_BUCKETS.length; i += 1) {
      if (seconds <= DURATION_BUCKETS[i]) durationBucketCounts[i] += 1;
    }
  });

  // Health endpoint: sengaja tidak dihitung sebagai trafik aplikasi.
  if (url.pathname === '/health') {
    return sendJson(res, 200, {
      status: 'ok',
      serverId: self.id,
      port: self.port,
      pid: process.pid,
      uptimeMs: Date.now() - startedAt,
      requestCount,
    });
  }

  // Endpoint metrics Prometheus: juga tidak dihitung sebagai trafik aplikasi.
  // Format teks polos, tanpa dependency. Hanya diakses dari network lb-net.
  if (url.pathname === '/metrics') {
    const labels = `server="${self.id}"`;
    const histogram = DURATION_BUCKETS.map(
      (le, index) =>
        `lb_backend_request_duration_seconds_bucket{${labels},le="${le}"} ${durationBucketCounts[index]}`,
    );
    histogram.push(`lb_backend_request_duration_seconds_bucket{${labels},le="+Inf"} ${durationCount}`);
    const body = [
      '# HELP lb_backend_requests_total Total request aplikasi yang diterima backend ini.',
      '# TYPE lb_backend_requests_total counter',
      `lb_backend_requests_total{${labels}} ${requestCount}`,
      '# HELP lb_backend_slow_requests_total Total request ke /slow.',
      '# TYPE lb_backend_slow_requests_total counter',
      `lb_backend_slow_requests_total{${labels}} ${slowRequestCount}`,
      '# HELP lb_backend_request_duration_seconds Durasi request yang dilayani (detik).',
      '# TYPE lb_backend_request_duration_seconds histogram',
      ...histogram,
      `lb_backend_request_duration_seconds_sum{${labels}} ${durationSum}`,
      `lb_backend_request_duration_seconds_count{${labels}} ${durationCount}`,
      '',
    ].join('\n');
    res.writeHead(200, {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    return res.end(body);
  }

  requestCount += 1;
  const body = await readBody(req);

  // Endpoint bantu demo: menahan respons selama N ms (default 250, maks 10000).
  // Catatan: lewat Traefik, responseHeaderTimeout 2s memotong yang di atas 2 detik.
  if (url.pathname === '/slow') {
    slowRequestCount += 1;
    const requested = Number(url.searchParams.get('ms') ?? 250);
    const delayMs = Math.min(Math.max(Number.isFinite(requested) ? requested : 250, 0), 10000);
    await sleep(delayMs);
    return sendJson(
      res,
      200,
      {
        servedBy: self.id,
        port: self.port,
        pid: process.pid,
        delayMs,
        requestCount,
        slowRequestCount,
        servedAt: new Date().toISOString(),
      },
      { 'x-served-by': self.id },
    );
  }

  sendJson(
    res,
    200,
    {
      servedBy: self.id,
      port: self.port,
      pid: process.pid,
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      requestCount,
      bodyBytes: Buffer.byteLength(body),
      servedAt: new Date().toISOString(),
    },
    { 'x-served-by': self.id },
  );
});

server.on('error', (error) => {
  log.error(`gagal listen di ${self.host}:${self.port} -> ${error.message}`);
  process.exit(1);
});

server.listen(self.port, self.host, () => {
  log.info(`siap di http://${self.host}:${self.port} (pid ${process.pid})`);
});

function shutdown(signal) {
  log.info(`${signal} diterima, menutup server`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

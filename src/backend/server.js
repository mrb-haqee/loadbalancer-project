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

  requestCount += 1;
  const body = await readBody(req);

  // Endpoint bantu untuk test least-connections: menahan koneksi selama N ms.
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

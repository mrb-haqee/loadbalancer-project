#!/usr/bin/env node
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { BackendRegistry } from './registry.js';
import { proxyRequest } from './proxy.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
const log = createLogger('load-balancer');
const dashboardHtml = readFileSync(resolve(HERE, '..', 'dashboard', 'index.html'), 'utf8');

const registry = new BackendRegistry({
  backends: config.backends,
  algorithm: config.loadBalancer.algorithm,
  healthCheck: config.loadBalancer.healthCheck,
  log,
});

const startedAt = Date.now();
const totals = { proxied: 0, rejected: 0, failures: 0 };

function respondJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function statsPayload() {
  const snapshot = registry.snapshot();
  return {
    loadBalancer: {
      pid: process.pid,
      port: config.loadBalancer.port,
      algorithm: snapshot.algorithm,
      startedAt: new Date(startedAt).toISOString(),
      uptimeMs: Date.now() - startedAt,
    },
    totals: {
      requests: totals.proxied + totals.rejected,
      proxied: totals.proxied,
      rejected: totals.rejected,
      upstreamFailures: totals.failures,
    },
    healthyCount: snapshot.healthyCount,
    totalCount: snapshot.totalCount,
    backends: snapshot.backends,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(dashboardHtml),
    });
    res.end(dashboardHtml);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/stats') {
    respondJson(res, 200, statsPayload());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    const stats = statsPayload();
    respondJson(res, stats.healthyCount > 0 ? 200 : 503, {
      status: stats.healthyCount > 0 ? 'ok' : 'degraded',
      role: 'load-balancer',
      algorithm: stats.loadBalancer.algorithm,
      healthyBackends: stats.healthyCount,
      totalBackends: stats.totalCount,
      uptimeMs: stats.loadBalancer.uptimeMs,
    });
    return;
  }

  if (url.pathname === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }

  // Semua path lain diteruskan ke backend.
  const backend = await proxyRequest(req, res, { registry, log });
  if (backend) {
    totals.proxied += 1;
  } else {
    totals.rejected += 1;
    totals.failures += 1;
  }
});

server.on('clientError', (error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.on('error', (error) => {
  log.error(`gagal listen di ${config.loadBalancer.host}:${config.loadBalancer.port} -> ${error.message}`);
  process.exit(1);
});

registry.startHealthChecks();

server.listen(config.loadBalancer.port, config.loadBalancer.host, () => {
  const base = `http://${config.loadBalancer.host}:${config.loadBalancer.port}`;
  log.info(`siap di ${base} | algoritma: ${registry.algorithm} | backend: ${config.backends.length}`);
  log.info(`health check tiap ${config.loadBalancer.healthCheck.intervalMs}ms ke ${config.loadBalancer.healthCheck.path}`);
});

function shutdown(signal) {
  log.info(`${signal} diterima, menghentikan load balancer`);
  registry.stopHealthChecks();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

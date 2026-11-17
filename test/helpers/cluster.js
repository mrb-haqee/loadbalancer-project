import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BACKEND_SCRIPT = resolve(ROOT, 'src/backend/server.js');
const LB_SCRIPT = resolve(ROOT, 'src/load-balancer/index.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 100, label = 'kondisi' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timeout menunggu ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

/**
 * Menjalankan satu cluster terisolasi: 3 backend + 1 load balancer.
 * Port dipilih bebas dan konfigurasi ditulis ke file sementara,
 * jadi test bisa paralel tanpa saling bertabrakan dengan `npm start`.
 */
export async function startCluster({
  algorithm = 'round-robin',
  backendCount = 3,
  healthCheck = {},
} = {}) {
  const ports = [];
  for (let i = 0; i < backendCount; i += 1) ports.push(await freePort());
  const lbPort = await freePort();

  const config = {
    loadBalancer: {
      host: '127.0.0.1',
      port: lbPort,
      algorithm,
      healthCheck: {
        path: '/health',
        intervalMs: healthCheck.intervalMs ?? 200,
        timeoutMs: healthCheck.timeoutMs ?? 300,
        failureThreshold: healthCheck.failureThreshold ?? 1,
        successThreshold: healthCheck.successThreshold ?? 1,
      },
    },
    backends: ports.map((port, index) => ({
      id: `server-${index + 1}`,
      host: '127.0.0.1',
      port,
    })),
  };

  const dir = mkdtempSync(join(tmpdir(), 'lb-cluster-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

  const processes = new Map();
  const logs = [];

  function spawnService(script, extraEnv) {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, CONFIG_PATH: configPath, LOG_LEVEL: 'silent', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const bucket = { id: extraEnv.BACKEND_ID ?? 'load-balancer', child, output: '' };
    child.stdout.on('data', (d) => (bucket.output += d.toString()));
    child.stderr.on('data', (d) => (bucket.output += d.toString()));
    logs.push(bucket);
    return bucket;
  }

  function startBackendProcess(backend) {
    const bucket = spawnService(BACKEND_SCRIPT, { BACKEND_ID: backend.id });
    processes.set(backend.id, bucket);
    return bucket;
  }

  async function fetchJson(url, init) {
    const res = await fetch(url, init);
    const text = await res.text();
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* biarkan sebagai teks (mis. HTML dashboard) */
    }
    return { status: res.status, headers: res.headers, body, text };
  }

  const lbBase = `http://127.0.0.1:${lbPort}`;

  async function request(path = '/', init) {
    const res = await fetchJson(`${lbBase}${path}`, init);
    return { ...res, servedBy: res.headers.get('x-served-by') };
  }

  async function requestDirect(backendId, path = '/') {
    const backend = config.backends.find((b) => b.id === backendId);
    return fetchJson(`http://${backend.host}:${backend.port}${path}`);
  }

  async function stats() {
    return fetchJson(`${lbBase}/stats`);
  }

  try {
    for (const backend of config.backends) startBackendProcess(backend);

    for (const backend of config.backends) {
      await waitFor(
        async () => {
          const res = await fetchJson(`http://${backend.host}:${backend.port}/health`);
          return res.status === 200;
        },
        { label: `${backend.id} hidup`, timeoutMs: 15000 },
      );
    }

    spawnService(LB_SCRIPT, {});
    await waitFor(
      async () => {
        const res = await fetchJson(`${lbBase}/health`);
        return res.status === 200;
      },
      { label: 'load balancer hidup', timeoutMs: 15000 },
    );
  } catch (error) {
    await stop();
    throw new Error(`${error.message}\n--- log cluster ---\n${logs.map((l) => `[${l.id}]\n${l.output}`).join('\n')}`);
  }

  async function killBackend(backendId) {
    const bucket = processes.get(backendId);
    if (!bucket) throw new Error(`Backend ${backendId} tidak berjalan`);
    await new Promise((resolveExit) => {
      bucket.child.once('exit', resolveExit);
      bucket.child.kill();
    });
    processes.delete(backendId);
  }

  async function startBackend(backendId) {
    const backend = config.backends.find((b) => b.id === backendId);
    startBackendProcess(backend);
    await waitFor(
      async () => {
        try {
          const res = await fetchJson(`http://${backend.host}:${backend.port}/health`);
          return res.status === 200;
        } catch {
          return false;
        }
      },
      { label: `${backendId} hidup kembali` },
    );
  }

  async function stop() {
    for (const { child } of processes.values()) {
      if (child.exitCode === null && !child.killed) child.kill();
    }
    processes.clear();
    for (const bucket of logs) {
      if (bucket.child.exitCode === null && !bucket.child.killed) bucket.child.kill();
    }
    await sleep(150);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* abaikan */
    }
  }

  return {
    config,
    lbPort,
    lbBase,
    algorithm,
    request,
    requestDirect,
    stats,
    killBackend,
    startBackend,
    stop,
    logs: () => logs.map((l) => `[${l.id}]\n${l.output}`).join('\n'),
  };
}

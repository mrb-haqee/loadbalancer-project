import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PROJECT = 'lb-demo';
const COMPOSE_ARGS = ['compose', '-p', PROJECT, '-f', resolve(ROOT, 'docker-compose.yml')];

export const LB_URL = process.env.LB_DOCKER_URL ?? 'http://127.0.0.1:8088';
export const DASHBOARD_URL = process.env.LB_DASHBOARD_URL ?? 'http://127.0.0.1:8089';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function dockerAvailable() {
  const result = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  return result.status === 0;
}

export function compose(args, { allowFail = false } = {}) {
  const result = spawnSync('docker', [...COMPOSE_ARGS, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 300000,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (result.status !== 0 && !allowFail) {
    throw new Error(
      `docker compose ${args.join(' ')} gagal (exit ${result.status})\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    );
  }
  return { status: result.status, stdout, stderr };
}

export async function waitFor(predicate, { timeoutMs = 30000, intervalMs = 300, label = 'kondisi' } = {}) {
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

export async function request(path = '/', { base = LB_URL, ...init } = {}) {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* biarkan teks (dashboard HTML) */
  }
  return { status: res.status, headers: res.headers, body, text, servedBy: res.headers.get('x-served-by') };
}

export function services() {
  const { stdout } = compose(['ps', '--format', 'json']);
  const text = stdout.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

export async function up({ rebuild = true } = {}) {
  compose(['up', '-d', ...(rebuild ? ['--build'] : [])]);
  await waitFor(
    async () => {
      try {
        const res = await request('/warmup');
        return res.status === 200 && Boolean(res.servedBy);
      } catch {
        return false;
      }
    },
    { label: 'load balancer container menjawab lewat Traefik', timeoutMs: 120000 },
  );

  // Traefik punya throttle ~2 detik sebelum container baru masuk konfigurasi.
  // Jangan mulai test sebelum ketiga backend benar-benar terdaftar dan UP.
  await waitFor(
    async () => {
      const api = await request('/api/http/services', { base: DASHBOARD_URL });
      const demo = api.body.find((svc) => String(svc.name).startsWith('demo@'));
      const servers = demo?.loadBalancer?.servers ?? [];
      const statuses = Object.values(demo?.serverStatus ?? {});
      return servers.length === 3 && statuses.filter((status) => status === 'UP').length === 3;
    },
    { label: '3 backend terdaftar dan berstatus UP di Traefik', timeoutMs: 60000 },
  );
}

export function down() {
  compose(['down', '--remove-orphans'], { allowFail: true });
}

export function stopService(name) {
  compose(['stop', name]);
}

export function startService(name) {
  compose(['start', name]);
}

export function logs(tail = 80) {
  return compose(['logs', '--tail', String(tail)]).stdout;
}

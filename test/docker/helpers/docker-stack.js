import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PROJECT = 'lb-demo';
const COMPOSE_ARGS = ['compose', '-p', PROJECT, '-f', resolve(ROOT, 'docker-compose.yml')];

export const LB_URL = process.env.LB_DOCKER_URL ?? 'http://127.0.0.1:8088';
export const LB_HOST_URL = process.env.LB_HOST_URL ?? 'http://server.localhost';
export const DASHBOARD_URL = process.env.LB_DASHBOARD_URL ?? 'http://127.0.0.1:8089';

/** URL khusus satu server, mis. http://server-2.localhost */
export function directUrl(serverId) {
  return `http://${serverId}.localhost`;
}

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
  const { signal, timeoutMs = 20000, ...rest } = init;
  // Jangan pakai AbortSignal.timeout(): timer-nya unref'd, sehingga kalau fetch
  // menggantung (mis. hostname belum siap), event loop Node bisa kosong dan
  // proses keluar dengan "Promise resolution is still pending".
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`request timeout ${timeoutMs}ms: ${base}${path}`)),
    timeoutMs,
  );
  try {
    const res = await fetch(`${base}${path}`, { ...rest, signal: signal ?? controller.signal });
    const text = await res.text();
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* biarkan teks (dashboard HTML) */
    }
    return { status: res.status, headers: res.headers, body, text, servedBy: res.headers.get('x-served-by') };
  } finally {
    clearTimeout(timer);
  }
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

  // Tunggu API Traefik hidup dulu; ini penanda paling andal bahwa Traefik sudah
  // selesai start dan port 80/8089 sudah terbuka.
  await waitFor(
    async () => {
      const api = await request('/api/http/services', { base: DASHBOARD_URL });
      return api.status === 200;
    },
    { label: `API Traefik di ${DASHBOARD_URL} hidup`, timeoutMs: 120000 },
  );

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
  // Jangan mulai test sebelum ketiga server benar-benar terdaftar dan UP.
  await waitFor(
    async () => {
      const api = await request('/api/http/services', { base: DASHBOARD_URL });
      const demo = api.body.find((svc) => String(svc.name).startsWith('demo@'));
      const servers = demo?.loadBalancer?.servers ?? [];
      const statuses = Object.values(demo?.serverStatus ?? {});
      return servers.length === 3 && statuses.filter((status) => status === 'UP').length === 3;
    },
    { label: '3 server terdaftar dan berstatus UP di Traefik', timeoutMs: 60000 },
  );

  // Router "demo" pernah dibuang Traefik karena ambigu (2 service per container),
  // jadi pastikan router-nya benar-benar enabled sebelum test dimulai.
  await waitFor(
    async () => {
      const routers = await request('/api/http/routers', { base: DASHBOARD_URL });
      const demo = routers.body.find((router) => String(router.name).startsWith('demo@'));
      return demo?.status === 'enabled';
    },
    { label: 'router demo@docker enabled', timeoutMs: 30000 },
  );

  // Port 80 + hostname: harus jalan tanpa menyebut port sama sekali.
  await waitFor(
    async () => {
      try {
        const res = await request('/warmup', { base: LB_HOST_URL });
        return res.status === 200;
      } catch {
        return false;
      }
    },
    { label: `${LB_HOST_URL} menjawab (port 80)`, timeoutMs: 30000 },
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

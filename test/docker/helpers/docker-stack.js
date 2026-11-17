import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PROJECT = 'lb-demo';
const COMPOSE_ARGS = ['compose', '-p', PROJECT, '-f', resolve(ROOT, 'docker-compose.yml')];
const TRAEFIK_COMPOSE_ARGS = ['compose', '-p', 'lb-traefik', '-f', resolve(ROOT, 'docker-compose.traefik.yml')];
const NETWORK = 'lb-net';

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
  const { timeoutMs = 20000, ...rest } = init;
  const url = new URL(`${base}${path}`);
  const headers = { ...(rest.headers ?? {}) };

  // Jangan bergantung pada resolusi DNS `*.localhost` milik OS: di sebagian
  // mesin Windows hanya sebagian nama yang diresolusi. Untuk host .localhost
  // kita tembak 127.0.0.1 dan tetap mengirim Host header yang sama, sehingga
  // aturan router Traefik tetap diuji apa adanya.
  if (url.hostname.endsWith('.localhost')) {
    headers.host = url.hostname;
    url.hostname = '127.0.0.1';
    url.port = url.port || '80';
  }

  // Jangan pakai AbortSignal.timeout(): timer-nya unref'd, sehingga kalau
  // koneksi menggantung, event loop Node bisa kosong dan proses keluar dengan
  // "Promise resolution is still pending".
  const response = await new Promise((resolvePromise, rejectPromise) => {
    const req = http.request(
      url,
      { method: rest.method ?? 'GET', headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolvePromise({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timeout ${timeoutMs}ms: ${base}${path}`)));
    req.on('error', rejectPromise);
    if (rest.body) req.write(rest.body);
    req.end();
  });

  let body = response.text;
  try {
    body = JSON.parse(response.text);
  } catch {
    /* biarkan teks (dashboard HTML) */
  }
  return {
    status: response.status,
    headers: response.headers,
    body,
    text: response.text,
    servedBy: response.headers['x-served-by'],
  };
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

function run(args) {
  const result = spawnSync(args[0], args.slice(1), { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
  if (result.status !== 0) {
    throw new Error(
      `${args.join(' ')} gagal (exit ${result.status})\n--- stdout ---\n${result.stdout ?? ''}\n--- stderr ---\n${result.stderr ?? ''}`,
    );
  }
  return result;
}

/** Network bersama lb-net dibuat di luar compose, jadi harus dipastikan ada. */
function ensureNetwork() {
  const exists =
    spawnSync('docker', ['network', 'inspect', NETWORK], { encoding: 'utf8', timeout: 30000 }).status === 0;
  if (!exists) run(['docker', 'network', 'create', NETWORK]);
}

export async function up({ rebuild = true } = {}) {
  // Traefik bukan lagi bagian project lb-demo, jadi test harus memastikan
  // network bersama dan Traefik hidup lebih dulu. Keduanya idempotent.
  ensureNetwork();
  run(['docker', ...TRAEFIK_COMPOSE_ARGS, 'up', '-d']);

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
  // Jangan mulai test sebelum kelima server benar-benar terdaftar dan UP.
  await waitFor(
    async () => {
      const api = await request('/api/http/services', { base: DASHBOARD_URL });
      const demo = api.body.find((svc) => String(svc.name).startsWith('demo@'));
      const servers = demo?.loadBalancer?.servers ?? [];
      const statuses = Object.values(demo?.serverStatus ?? {});
      return servers.length === 5 && statuses.filter((status) => status === 'UP').length === 5;
    },
    { label: '5 server terdaftar dan berstatus UP di Traefik', timeoutMs: 60000 },
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
  // Hanya lb-demo yang dimatikan. Traefik dibiarkan hidup karena mungkin dipakai
  // project lain (mis. dashboard Grafana di lb-k6); test tidak merusak stack
  // yang sedang dipakai.
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

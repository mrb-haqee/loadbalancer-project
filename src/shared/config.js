import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Satu sumber identitas backend.
 * Di container, identitas sebenarnya datang dari env (BACKEND_ID/BACKEND_HOST/
 * BACKEND_PORT); file ini dipakai sebagai daftar id yang sah dan sebagai
 * fallback saat backend dijalankan langsung tanpa env.
 * CONFIG_PATH dipakai bila ingin menunjuk file konfigurasi lain.
 */
export function resolveConfigPath() {
  return process.env.CONFIG_PATH
    ? resolve(process.env.CONFIG_PATH)
    : resolve(PROJECT_ROOT, 'config.json');
}

export function loadConfig() {
  const path = resolveConfigPath();
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const backends = (raw.backends ?? []).map((backend, index) => ({
    id: backend.id ?? `server-${index + 1}`,
    host: backend.host ?? '127.0.0.1',
    port: backend.port,
  }));

  if (!backends.length) {
    throw new Error(`Tidak ada backend di konfigurasi: ${path}`);
  }
  for (const backend of backends) {
    if (!Number.isInteger(backend.port) || backend.port < 1 || backend.port > 65535) {
      throw new Error(`Port backend tidak valid untuk ${backend.id}: ${backend.port}`);
    }
  }
  return { configPath: path, backends };
}

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Satu sumber konfigurasi untuk LB dan semua backend.
 * CONFIG_PATH dipakai oleh test suite agar tiap skenario memakai port sendiri.
 */
export function resolveConfigPath() {
  return process.env.CONFIG_PATH
    ? resolve(process.env.CONFIG_PATH)
    : resolve(PROJECT_ROOT, 'config.json');
}

export function loadConfig() {
  const path = resolveConfigPath();
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const lb = raw.loadBalancer ?? {};
  const hc = lb.healthCheck ?? {};

  const config = {
    configPath: path,
    loadBalancer: {
      host: lb.host ?? '127.0.0.1',
      port: lb.port ?? 8080,
      algorithm: lb.algorithm ?? 'round-robin',
      healthCheck: {
        path: hc.path ?? '/health',
        intervalMs: hc.intervalMs ?? 2000,
        timeoutMs: hc.timeoutMs ?? 1000,
        failureThreshold: hc.failureThreshold ?? 1,
        successThreshold: hc.successThreshold ?? 1,
      },
    },
    backends: (raw.backends ?? []).map((backend, index) => ({
      id: backend.id ?? `server-${index + 1}`,
      host: backend.host ?? '127.0.0.1',
      port: backend.port,
    })),
  };

  if (!config.backends.length) {
    throw new Error(`Tidak ada backend di konfigurasi: ${path}`);
  }
  for (const backend of config.backends) {
    if (!Number.isInteger(backend.port) || backend.port < 1 || backend.port > 65535) {
      throw new Error(`Port backend tidak valid untuk ${backend.id}: ${backend.port}`);
    }
  }
  return config;
}

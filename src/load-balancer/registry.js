import http from 'node:http';
import { createBalancer } from './balancer.js';

/**
 * BackendRegistry menyimpan keadaan tiap backend:
 * - status sehat/tidak (hasil health check aktif + kegagalan pasif),
 * - koneksi aktif (dipakai least-connections),
 * - statistik request/gagal.
 */
export class BackendRegistry {
  constructor({ backends, algorithm, healthCheck, log }) {
    this.log = log;
    this.healthCheck = healthCheck;
    this.balancer = createBalancer(algorithm);
    this.timer = null;
    this.checking = false;

    this.entries = backends.map((backend) => ({
      id: backend.id,
      host: backend.host,
      port: backend.port,
      // Optimistis di awal: dianggap sehat sampai probe pertama gagal.
      healthy: true,
      probed: false,
      activeConnections: 0,
      totalRequests: 0,
      totalFailures: 0,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      lastCheckedAt: null,
      lastError: null,
    }));
  }

  get algorithm() {
    return this.balancer.name;
  }

  get healthyBackends() {
    return this.entries.filter((entry) => entry.healthy);
  }

  get(id) {
    return this.entries.find((entry) => entry.id === id) ?? null;
  }

  /** Pilih backend sehat, boleh mengecualikan yang sudah dicoba pada request ini. */
  pick(exclude = new Set()) {
    const candidates = this.healthyBackends.filter((entry) => !exclude.has(entry.id));
    return this.balancer.pick(candidates);
  }

  recordRequestStart(entry) {
    entry.activeConnections += 1;
    entry.totalRequests += 1;
  }

  recordRequestEnd(entry) {
    entry.activeConnections = Math.max(0, entry.activeConnections - 1);
  }

  /** Kegagalan pasif: backend langsung diturunkan agar request berikutnya tidak ikut gagal. */
  markDown(entry, reason) {
    entry.totalFailures += 1;
    entry.lastError = String(reason);
    entry.consecutiveFailures += 1;
    if (entry.healthy) {
      entry.healthy = false;
      this.log.warn(`${entry.id} ditandai MATI: ${entry.lastError}`);
    }
  }

  markUp(entry) {
    entry.consecutiveFailures = 0;
    if (!entry.healthy) {
      entry.healthy = true;
      entry.lastError = null;
      this.log.info(`${entry.id} kembali HIDUP`);
    }
  }

  probe(entry) {
    return new Promise((resolve) => {
      const req = http.request(
        {
          host: entry.host,
          port: entry.port,
          method: 'GET',
          path: this.healthCheck.path,
          timeout: this.healthCheck.timeoutMs,
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout health check')));
      req.on('error', (error) => resolve(error));
      req.end();
    });
  }

  async runHealthChecks() {
    if (this.checking) return;
    this.checking = true;
    try {
      await Promise.all(
        this.entries.map(async (entry) => {
          const result = await this.probe(entry);
          entry.lastCheckedAt = new Date().toISOString();

          if (result === true) {
            entry.consecutiveSuccesses += 1;
            entry.consecutiveFailures = 0;
            entry.probed = true;
            if (entry.consecutiveSuccesses >= this.healthCheck.successThreshold) {
              this.markUp(entry);
            }
            return;
          }

          const reason = result instanceof Error ? result.message : `HTTP ${result}`;
          entry.consecutiveSuccesses = 0;
          entry.consecutiveFailures += 1;
          entry.lastError = reason;
          entry.probed = true;
          if (
            entry.consecutiveFailures >= this.healthCheck.failureThreshold &&
            entry.healthy
          ) {
            entry.healthy = false;
            this.log.warn(`${entry.id} ditandai MATI (health check): ${reason}`);
          }
        }),
      );
    } finally {
      this.checking = false;
    }
  }

  startHealthChecks() {
    if (this.timer) return;
    this.runHealthChecks().catch(() => {});
    this.timer = setInterval(() => {
      this.runHealthChecks().catch(() => {});
    }, this.healthCheck.intervalMs);
    this.timer.unref();
  }

  stopHealthChecks() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  snapshot() {
    return {
      algorithm: this.algorithm,
      healthyCount: this.healthyBackends.length,
      totalCount: this.entries.length,
      backends: this.entries.map((entry) => ({
        id: entry.id,
        host: entry.host,
        port: entry.port,
        healthy: entry.healthy,
        activeConnections: entry.activeConnections,
        requests: entry.totalRequests,
        failures: entry.totalFailures,
        lastCheckedAt: entry.lastCheckedAt,
        lastError: entry.lastError,
      })),
    };
  }
}

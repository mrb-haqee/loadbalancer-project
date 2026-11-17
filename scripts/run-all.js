#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/shared/config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig();
const env = { ...process.env, CONFIG_PATH: config.configPath };
const children = [];
let shuttingDown = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnService(script, extraEnv = {}) {
  const child = spawn(process.execPath, [resolve(ROOT, script)], {
    env: { ...env, ...extraEnv },
    stdio: 'inherit',
  });
  children.push(child);
  return child;
}

async function waitForHealth(url, attempts = 60, delayMs = 250) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {
      /* service belum siap */
    }
    await sleep(delayMs);
  }
  return false;
}

async function stopAll(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nMenghentikan semua service...');
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill();
  }
  await sleep(300);
  process.exit(exitCode);
}

function fail(message) {
  console.error(`\n✖ ${message}`);
  return stopAll(1);
}

async function main() {
  const lbBase = `http://${config.loadBalancer.host}:${config.loadBalancer.port}`;

  console.log('Menjalankan 3 backend server...');
  for (const backend of config.backends) {
    spawnService('src/backend/server.js', { BACKEND_ID: backend.id });
  }

  for (const backend of config.backends) {
    const ok = await waitForHealth(`http://${backend.host}:${backend.port}/health`);
    if (!ok) {
      return fail(
        `Backend ${backend.id} tidak merespons di port ${backend.port}. ` +
          `Pastikan port itu tidak dipakai aplikasi lain.`,
      );
    }
  }

  console.log('Menjalankan load balancer...');
  spawnService('src/load-balancer/index.js');

  const lbOk = await waitForHealth(`${lbBase}/health`);
  if (!lbOk) {
    return fail(
      `Load balancer tidak merespons di port ${config.loadBalancer.port}. ` +
        `Pastikan port itu tidak dipakai aplikasi lain.`,
    );
  }

  const line = '='.repeat(64);
  console.log(`\n${line}`);
  console.log('  LOAD BALANCER SIAP');
  console.log(line);
  console.log(`  Dashboard     : ${lbBase}/`);
  console.log(`  Stats (JSON)  : ${lbBase}/stats`);
  console.log(`  Health LB     : ${lbBase}/health`);
  console.log(`  Algoritma     : ${config.loadBalancer.algorithm}`);
  console.log(`  Health check  : tiap ${config.loadBalancer.healthCheck.intervalMs}ms`);
  console.log('  Backend       :');
  for (const backend of config.backends) {
    console.log(`    - ${backend.id.padEnd(8)} http://${backend.host}:${backend.port}`);
  }
  console.log(line);
  console.log('  Uji cepat    : curl ' + lbBase + '/halo');
  console.log('  Matikan 1    : tutup salah satu proses backend yang berjalan');
  console.log('  Ctrl+C       : hentikan semua service');
  console.log(`${line}\n`);
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

main().catch(async (error) => {
  console.error(error);
  await stopAll(1);
});

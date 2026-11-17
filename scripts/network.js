#!/usr/bin/env node
/**
 * Membuat network bersama `lb-net` sekali saja.
 * Dipakai tiga project compose (lb-traefik, lb-demo, lb-k6) sebagai network
 * external, jadi tidak ada project yang menjadi pemilik tersembunyi.
 * Aman dijalankan berulang.
 */
import { spawnSync } from 'node:child_process';

const NAME = 'lb-net';
const exists = spawnSync('docker', ['network', 'inspect', NAME], { stdio: 'ignore' }).status === 0;

if (exists) {
  console.log(`network ${NAME} sudah ada`);
} else {
  const created = spawnSync('docker', ['network', 'create', NAME], { stdio: 'inherit' });
  if (created.status !== 0) process.exit(created.status ?? 1);
  console.log(`network ${NAME} dibuat`);
}

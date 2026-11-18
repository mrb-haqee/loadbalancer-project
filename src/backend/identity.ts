import { loadConfig } from '../shared/config';

const config = loadConfig();
const backendId = process.env.BACKEND_ID;
const fromConfig = config.backends.find((backend) => backend.id === backendId);

if (!backendId || (!fromConfig && !process.env.BACKEND_PORT)) {
  console.error(`[backend] BACKEND_ID tidak dikenal: ${backendId ?? '(kosong)'}`);
  console.error(`[backend] pilihan yang tersedia: ${config.backends.map((b) => b.id).join(', ')}`);
  console.error('[backend] di container, set BACKEND_ID dan BACKEND_PORT (mis. server-1 / 3000).');
  process.exit(1);
}

// Di container identitas datang dari env, di lokal dari config.json.
export const self = {
  id: backendId,
  host: process.env.BACKEND_HOST ?? fromConfig?.host ?? '127.0.0.1',
  port: Number(process.env.BACKEND_PORT ?? fromConfig?.port ?? 3000),
};

import http from 'node:http';

const MAX_BODY_BYTES = 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 10000;

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body terlalu besar'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Kirim satu request ke satu backend, buffer response agar bisa di-retry. */
function sendToBackend(req, backend, body) {
  return new Promise((resolve, reject) => {
    const headers = { ...req.headers };
    headers.host = `${backend.host}:${backend.port}`;
    delete headers['transfer-encoding'];
    if (body.length) {
      headers['content-length'] = String(body.length);
    } else {
      delete headers['content-length'];
    }

    const upstream = http.request(
      {
        host: backend.host,
        port: backend.port,
        method: req.method,
        path: req.url,
        headers,
        timeout: UPSTREAM_TIMEOUT_MS,
      },
      (upstreamRes) => {
        const chunks = [];
        upstreamRes.on('data', (chunk) => chunks.push(chunk));
        upstreamRes.on('end', () =>
          resolve({
            statusCode: upstreamRes.statusCode ?? 502,
            headers: upstreamRes.headers,
            body: Buffer.concat(chunks),
          }),
        );
        upstreamRes.on('error', reject);
      },
    );

    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', reject);
    if (body.length) upstream.write(body);
    upstream.end();
  });
}

/**
 * Teruskan request ke backend terpilih.
 * Bila backend gagal (mis. proses dimatikan), backend ditandai mati lalu
 * request dicoba ulang ke backend lain → failover pasif tanpa error ke klien.
 */
export async function proxyRequest(req, res, { registry, log, maxAttempts = 2 }) {
  const body = await readRequestBody(req);
  const tried = new Set();
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const backend = registry.pick(tried);
    if (!backend) break;
    tried.add(backend.id);
    registry.recordRequestStart(backend);

    try {
      const result = await sendToBackend(req, backend, body);
      registry.recordRequestEnd(backend);
      registry.markUp(backend);

      const headers = { ...result.headers };
      delete headers['transfer-encoding'];
      delete headers.connection;
      headers['content-length'] = String(result.body.length);
      headers['x-served-by'] = backend.id;
      headers['x-load-balancer'] = 'node-lb';

      res.writeHead(result.statusCode, headers);
      res.end(result.body);
      return backend;
    } catch (error) {
      registry.recordRequestEnd(backend);
      registry.markDown(backend, error.message);
      lastError = error;
      log.warn(`request ke ${backend.id} gagal (${error.message}), mencoba backend lain`);
    }
  }

  if (!res.headersSent) {
    const payload = {
      error: 'tidak ada backend sehat yang tersedia',
      tried: [...tried],
      reason: lastError?.message ?? null,
    };
    const text = JSON.stringify(payload, null, 2);
    res.writeHead(503, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
    });
    res.end(text);
  }
  return null;
}

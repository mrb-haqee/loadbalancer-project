FROM oven/bun:1.3-alpine

WORKDIR /app

# Runtime hanya butuh elysia + drizzle-orm. Bun menjalankan .ts langsung,
# jadi tidak ada tahap build/tsc di image.
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

COPY config.json ./
COPY src ./src

ENV NODE_ENV=production \
    BACKEND_HOST=0.0.0.0 \
    BACKEND_PORT=3000

EXPOSE 3000

# Docker menandai container "unhealthy" bila /health gagal;
# Traefik memakai status ini untuk mengeluarkan container dari rotasi.
HEALTHCHECK --interval=2s --timeout=2s --start-period=5s --retries=2 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.BACKEND_PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "src/backend/server.ts"]
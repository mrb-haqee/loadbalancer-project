FROM node:22-alpine

WORKDIR /app

# Satu-satunya dependency runtime: driver MariaDB (mysql2).
# src/backend/public/index.html ikut tersalin bersama folder src.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY config.json ./
COPY src ./src

ENV NODE_ENV=production \
    BACKEND_HOST=0.0.0.0 \
    BACKEND_PORT=3000

EXPOSE 3000

# Docker menandai container "unhealthy" bila /health gagal;
# Traefik memakai status ini untuk mengeluarkan container dari rotasi.
HEALTHCHECK --interval=2s --timeout=2s --start-period=5s --retries=2 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.BACKEND_PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/backend/server.js"]

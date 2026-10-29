# ── Web: build the React (Vite) frontend → /backend/public ──
FROM node:24-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
# CACHEBUST (passed fresh by scripts/local.sh -b) forces the frontend source copy +
# build below to re-run every rebuild, so code changes always land. npm install above
# stays cached, so it's still fast.
ARG CACHEBUST=0
COPY frontend/ ./
# vite.config.ts outDir is '../backend/public' → emits to /backend/public
RUN npm run build:only

# ── Base: backend dependency layer ──
FROM node:24-alpine AS base
WORKDIR /app
COPY backend/package.json backend/package-lock.json* ./

# ── Dev: backend deps + nodemon. Serves the built SPA (no frontend HMR in Docker;
#    for HMR run `cd frontend && npm run dev`). Built as netbird-control:dev ──
FROM base AS dev
RUN npm install
ARG CACHEBUST=0
COPY backend/*.js VERSION ./
# Extracted backend modules (backend/lib/*) - *.js above only matches top-level files.
COPY backend/lib/ ./lib/
# The Windows diagnostics script - served as a download by the Troubleshoot page.
COPY backend/scripts/ ./scripts/
COPY --from=web /backend/public ./public
# Run as the built-in non-root `node` user (drops root inside the container).
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
# Liveness probe: healthcheck.js hits GET /api/health (see backend/healthcheck.js).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD ["node", "healthcheck.js"]
CMD ["npm", "run", "dev"]

# ── Prod: production backend deps + the prebuilt SPA ──
FROM base AS prod
RUN npm ci --only=production 2>/dev/null || npm install --only=production
ARG CACHEBUST=0
COPY backend/*.js VERSION ./
# Extracted backend modules (backend/lib/*) - *.js above only matches top-level files.
COPY backend/lib/ ./lib/
# The Windows diagnostics script - served as a download by the Troubleshoot page.
COPY backend/scripts/ ./scripts/
COPY --from=web /backend/public ./public
# Run as the built-in non-root `node` user (drops root inside the container).
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
# Liveness probe: healthcheck.js hits GET /api/health (see backend/healthcheck.js).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD ["node", "healthcheck.js"]
CMD ["node", "server.js"]

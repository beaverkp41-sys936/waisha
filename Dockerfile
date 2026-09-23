# WAISHA API — builds identically locally, in CI, and on Render.
FROM node:22-slim

# Exact pnpm version, inside our own container (no system shims involved)
RUN npm install -g pnpm@9.15.9

WORKDIR /app

# 1) Manifests first — this layer caches; source changes don't re-trigger install
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/types/package.json packages/types/package.json
COPY api/package.json api/package.json
COPY web/package.json web/package.json

# 2) The exact install CI runs — output will show "Scope: all 4 workspace projects"
RUN pnpm install --frozen-lockfile

# 3) Sources, then build exactly as CI does
COPY . .
RUN pnpm --filter @waisha/api build

WORKDIR /app/api
EXPOSE 4000
CMD ["node", "dist/main.js"]
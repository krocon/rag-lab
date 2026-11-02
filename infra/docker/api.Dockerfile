# syntax=docker/dockerfile:1
# RAGLab API image. Build from the repository root:
#   docker build -f infra/docker/api.Dockerfile -t raglab-api .
#
# One image, two commands:
#   default                     → starts the API (node dist/main.js)
#   node dist/db/migrate.js     → applies pending SQL migrations and exits (compose service "migrate")

# Node 26 LTS (ADR 0001), pinned to an exact tag in every FROM line so Dependabot can update it.
FROM node:26.13.0-trixie-slim AS build
# Same pnpm version as "packageManager" in package.json.
ARG PNPM_VERSION=11.28.9
ENV CI=true
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /repo
# Manifests first: the dependency layer is only rebuilt when they change.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=raglab-pnpm-store,target=/pnpm-store \
  pnpm install --frozen-lockfile --store-dir /pnpm-store --filter @raglab/api...
COPY packages/shared packages/shared
COPY apps/api apps/api
# `deploy --prod` writes package.json + production node_modules (no dev dependencies, no
# workspace sources) to /out.
RUN --mount=type=cache,id=raglab-pnpm-store,target=/pnpm-store \
  pnpm --filter @raglab/api build \
  && pnpm --filter @raglab/api deploy --prod --legacy --store-dir /pnpm-store /out

FROM node:26.13.0-trixie-slim AS runtime
LABEL org.opencontainers.image.title="raglab-api" \
      org.opencontainers.image.description="RAGLab REST API (Fastify) and migration runner" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production
# The runtime needs node only: remove npm/npx from the file system (less attack surface; the
# base layer keeps its size).
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
# Files stay owned by root and are read-only for the runtime user "node" (uid 1000).
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
# SQL migrations, read by dist/db/migrate.js.
COPY --from=build /repo/apps/api/drizzle ./drizzle
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Migrations are NOT applied here: run the image once with `node dist/db/migrate.js` first
# (docker compose does that in the "migrate" service).
CMD ["node", "dist/main.js"]

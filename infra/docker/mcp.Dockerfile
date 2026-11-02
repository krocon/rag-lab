# syntax=docker/dockerfile:1
# RAGLab MCP server image (stdio). Build from the repository root:
#   docker build -f infra/docker/mcp.Dockerfile -t raglab-mcp .
# Run it with an open stdin, e.g. through compose: docker compose run --rm -T mcp (README → MCP).

FROM node:26.13.0-trixie-slim AS build
ARG PNPM_VERSION=11.28.9
ENV CI=true
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/mcp/package.json apps/mcp/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=raglab-pnpm-store,target=/pnpm-store \
  pnpm install --frozen-lockfile --store-dir /pnpm-store --filter @raglab/mcp...
COPY packages/shared packages/shared
COPY apps/mcp apps/mcp
RUN --mount=type=cache,id=raglab-pnpm-store,target=/pnpm-store \
  pnpm --filter @raglab/mcp build \
  && pnpm --filter @raglab/mcp deploy --prod --legacy --store-dir /pnpm-store /out

FROM node:26.13.0-trixie-slim AS runtime
LABEL org.opencontainers.image.title="raglab-mcp" \
      org.opencontainers.image.description="RAGLab MCP server (stdio, read-only tools)" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production
# Runtime needs node only (see api.Dockerfile).
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/mcp/dist ./dist
USER node
# stdout carries the MCP protocol; logs go to stderr. No port, no health check (one process per
# client session, started by the MCP client).
ENTRYPOINT ["node", "dist/main.js"]

# syntax=docker/dockerfile:1
# RAGLab API image. Build from the repository root:
#   docker build -f infra/docker/api.Dockerfile -t raglab-api .

ARG NODE_IMAGE=node:26.13.0-bookworm-slim

FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION=11.28.9
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @raglab/api...
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @raglab/api build \
  && pnpm --filter @raglab/api deploy --prod --legacy /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
COPY --from=build --chown=node:node /repo/apps/api/drizzle ./drizzle
USER node
EXPOSE 3000
# Applies pending migrations, then starts the API.
CMD ["sh", "-c", "node dist/db/migrate.js && exec node dist/main.js"]

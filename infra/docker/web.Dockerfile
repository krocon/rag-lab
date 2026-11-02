# syntax=docker/dockerfile:1
# RAGLab web image (static Angular build served by nginx). Build from the repository root:
#   docker build -f infra/docker/web.Dockerfile -t raglab-web .

ARG NODE_IMAGE=node:26.13.0-bookworm-slim

FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION=11.28.9
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @raglab/web...
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @raglab/web build

FROM nginxinc/nginx-unprivileged:1.30-alpine AS runtime
COPY infra/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist/web/browser /usr/share/nginx/html
EXPOSE 8080

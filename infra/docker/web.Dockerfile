# syntax=docker/dockerfile:1
# RAGLab web image (static Angular build served by nginx, /api proxied to the API container).
# Build from the repository root:
#   docker build -f infra/docker/web.Dockerfile -t raglab-web .

# The build output is plain HTML/JS/CSS, so this stage runs on the build host's platform even for
# multi-platform images (no emulation needed).
FROM --platform=$BUILDPLATFORM node:26.13.0-trixie-slim AS build
ARG PNPM_VERSION=11.28.9
ENV CI=true
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=raglab-pnpm-store,target=/pnpm-store \
  pnpm install --frozen-lockfile --store-dir /pnpm-store --filter @raglab/web...
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @raglab/web build

# Runs as the unprivileged user "nginx" (uid 101) and listens on 8080.
FROM nginxinc/nginx-unprivileged:1.30.6-alpine AS runtime
LABEL org.opencontainers.image.title="raglab-web" \
      org.opencontainers.image.description="RAGLab web app (Angular) served by nginx" \
      org.opencontainers.image.licenses="MIT"
COPY infra/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY infra/docker/nginx-security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /repo/apps/web/dist/web/browser /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=5 \
  CMD ["wget", "-q", "--spider", "http://127.0.0.1:8080/healthz"]

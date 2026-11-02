import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest, RouteOptions } from 'fastify';
import type { AppConfig } from '../config/env.js';
import { AppError, errorResponseSchema } from './errors.js';

/**
 * HTTP hardening of the API (docs/security.md): security headers (helmet), CORS allowlist,
 * Host allowlist (DNS rebinding), Origin check for state-changing requests (CSRF), rate limits
 * and generic schema additions. Called by `buildApp` before any route is registered.
 */

/**
 * CSP of API responses. The API serves JSON and SSE only – nothing may be rendered, framed or
 * loaded from it as a document.
 */
export const API_CSP_DIRECTIVES = {
  defaultSrc: ["'none'"],
  baseUri: ["'none'"],
  formAction: ["'none'"],
  frameAncestors: ["'none'"],
} as const;

/**
 * CSP of the Swagger UI under /api/docs (own HTML, scripts and styles; no inline scripts).
 * `'unsafe-inline'` for styles is needed by Swagger UI's rendering (style attributes).
 */
export const SWAGGER_UI_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Methods allowed by CORS; the API has no PUT. */
export const CORS_METHODS = ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'];
/** Request headers a browser may send cross-origin (beyond CORS-safelisted ones). */
export const CORS_ALLOWED_HEADERS = ['Content-Type', 'Accept'];

/** Methods that change state and are therefore subject to the Origin check. */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

type RouteLimitKey = 'uploadMax' | 'chatMax' | 'searchMax';

/**
 * Routes with a stricter rate limit than the global one. Each route has its own counter per
 * client; all other routes share the global limit (`RATE_LIMIT_MAX`).
 */
export const ROUTE_RATE_LIMITS: readonly { method: string; url: string; limit: RouteLimitKey }[] = [
  { method: 'POST', url: '/api/collections/:id/documents', limit: 'uploadMax' },
  { method: 'POST', url: '/api/chat', limit: 'chatMax' },
  { method: 'POST', url: '/api/retrieval/search', limit: 'searchMax' },
  { method: 'POST', url: '/api/playground/search', limit: 'searchMax' },
];

/** Query schema for routes without query parameters: unknown parameters → 400. */
const NO_QUERY_SCHEMA = { type: 'object', additionalProperties: false, properties: {} } as const;

export async function registerSecurity(app: FastifyInstance, config: AppConfig): Promise<void> {
  const { server, security } = config;

  await app.register(helmet, {
    contentSecurityPolicy: { useDefaults: false, directives: { ...API_CSP_DIRECTIVES } },
    // HSTS belongs to the TLS-terminating reverse proxy; the API itself speaks plain HTTP.
    hsts: false,
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });

  await app.register(cors, {
    origin: server.corsOrigins,
    methods: CORS_METHODS,
    allowedHeaders: CORS_ALLOWED_HEADERS,
    exposedHeaders: [
      'Retry-After',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
    ],
    credentials: false,
    maxAge: 600,
  });

  app.addHook('onRequest', async (request) => {
    assertAllowedHost(request, server.allowedHosts);
    assertAllowedOrigin(request, server.corsOrigins);
  });

  // Runs for every route registered afterwards (all API routes): documents the standard error
  // responses, rejects unknown query parameters and attaches the stricter rate limits.
  app.addHook('onRoute', (route) => {
    hardenRouteSchema(route);
    const methods: string[] = Array.isArray(route.method) ? route.method : [route.method];
    const special = ROUTE_RATE_LIMITS.find(
      (entry) => entry.url === route.url && methods.includes(entry.method),
    );
    if (special && security.rateLimit.enabled) {
      route.config = { ...route.config, rateLimit: { max: security.rateLimit[special.limit] } };
    }
  });

  if (security.rateLimit.enabled) {
    await app.register(rateLimit, {
      global: true,
      max: security.rateLimit.max,
      timeWindow: security.rateLimit.windowMs,
      // `Retry-After` and `X-RateLimit-*` headers are set by the plugin; the body uses the API
      // error format via the central error handler.
      errorResponseBuilder: (_request, context) =>
        new AppError(429, 'RATE_LIMITED', `Too many requests. Try again in ${context.after}.`, {
          limit: context.max,
          retryAfterSeconds: Math.ceil(context.ttl / 1000),
        }),
    });
  }
}

/** Adds `querystring` (no parameters) and the standard error responses to API route schemas. */
function hardenRouteSchema(route: RouteOptions): void {
  const schema = route.schema as
    (Record<string, unknown> & { hide?: boolean; response?: Record<string, unknown> }) | undefined;
  // Swagger UI's own routes are hidden; they serve files, not API data.
  if (!schema || schema.hide === true) {
    return;
  }
  schema['querystring'] ??= NO_QUERY_SCHEMA;
  if (schema.response) {
    schema.response['403'] ??= errorResponseSchema;
    schema.response['429'] ??= errorResponseSchema;
    schema.response['500'] ??= errorResponseSchema;
  }
}

/** Host name of a `Host` header without port, lower case (`[::1]:3000` → `[::1]`). */
export function hostName(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  const value = header.trim().toLowerCase();
  const name = value.startsWith('[') ? value.slice(0, value.indexOf(']') + 1) : value.split(':')[0];
  return name?.replace(/\.$/, '') || undefined;
}

/**
 * DNS-rebinding protection: a malicious website can make its own domain resolve to 127.0.0.1;
 * the browser then sends `Host: evil.example` to the local API and treats the response as
 * same-origin. Only configured host names are accepted (`ALLOWED_HOSTS`).
 */
function assertAllowedHost(request: FastifyRequest, allowedHosts: string[] | null): void {
  if (allowedHosts === null) {
    return;
  }
  const host = hostName(request.headers.host);
  if (host === undefined || !allowedHosts.includes(host)) {
    throw new AppError(
      403,
      'HOST_NOT_ALLOWED',
      'The Host header of this request is not allowed. Add the host name to ALLOWED_HOSTS.',
      { host: host ?? null },
    );
  }
}

/**
 * CSRF protection: browsers send `Origin` with every cross-origin POST/PATCH/DELETE. Simple
 * requests (e.g. multipart uploads) are not preflighted by CORS and would otherwise reach the
 * handler. Requests without `Origin` (curl, scripts) are not affected.
 */
function assertAllowedOrigin(request: FastifyRequest, corsOrigins: readonly string[]): void {
  const origin = request.headers.origin;
  if (origin === undefined || !UNSAFE_METHODS.has(request.method)) {
    return;
  }
  if (corsOrigins.includes(origin) || isSameOrigin(origin, request.headers.host)) {
    return;
  }
  throw new AppError(
    403,
    'ORIGIN_NOT_ALLOWED',
    'Requests from this origin are not allowed. Add the origin to CORS_ORIGINS.',
    { origin },
  );
}

function isSameOrigin(origin: string, host: string | undefined): boolean {
  if (!host) {
    return false;
  }
  try {
    return new URL(origin).host === host.trim().toLowerCase();
  } catch {
    // `Origin: null` (sandboxed frames, file://) and malformed values.
    return false;
  }
}

/** `127.0.0.0/8`, `::1` and `localhost` – reachable from this machine only. */
export function isLoopbackHost(host: string): boolean {
  const value = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '::1' || /^127(\.\d{1,3}){3}$/.test(value);
}

/**
 * Configuration that weakens the local-only security model. Logged as warnings at startup
 * (main.ts); RAGLab has no authentication, see docs/security.md.
 */
export function securityWarnings(config: AppConfig): string[] {
  const { server, security } = config;
  const warnings: string[] = [];
  const exposed = !isLoopbackHost(server.host);
  if (exposed && !server.networkAccessProtected) {
    warnings.push(
      `API_HOST=${server.host} makes the API reachable from other machines, but RAGLab has no ` +
        'authentication. Bind to 127.0.0.1, or put a reverse proxy with authentication in front ' +
        'of it and set NETWORK_ACCESS_PROTECTED=true (see docs/security.md).',
    );
  }
  if (server.allowedHosts === null) {
    warnings.push(
      'ALLOWED_HOSTS=* disables the Host check: websites can reach the API via DNS rebinding.',
    );
  }
  if (!security.rateLimit.enabled) {
    warnings.push('RATE_LIMIT_ENABLED=false: requests are not rate limited.');
  }
  return warnings;
}

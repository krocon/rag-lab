/** API endpoints. Relative URLs: the dev server proxies /api (proxy.conf.json), nginx does in Docker. */
export const API_PATHS = {
  health: '/api/health',
  readiness: '/api/health/ready',
  systemInfo: '/api/system/info',
} as const;

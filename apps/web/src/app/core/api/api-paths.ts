/** API endpoints. Relative URLs: the dev server proxies /api (proxy.conf.json), nginx does in Docker. */
export const API_PATHS = {
  health: '/api/health',
  readiness: '/api/health/ready',
  systemInfo: '/api/system/info',
  systemProviders: '/api/system/providers',
  collections: '/api/collections',
  collection: (id: string) => `/api/collections/${encodeURIComponent(id)}`,
  collectionDocuments: (id: string) => `/api/collections/${encodeURIComponent(id)}/documents`,
  document: (id: string) => `/api/documents/${encodeURIComponent(id)}`,
  documentContent: (id: string) => `/api/documents/${encodeURIComponent(id)}/content`,
  documentChunks: (id: string) => `/api/documents/${encodeURIComponent(id)}/chunks`,
  chat: '/api/chat',
  playgroundSearch: '/api/playground/search',
  documentReindex: (id: string) => `/api/documents/${encodeURIComponent(id)}/reindex`,
} as const;

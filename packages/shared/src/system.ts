export type ComponentStatus = 'up' | 'down';

/** Response of `GET /api/health` (liveness – the process is running). */
export interface LivenessResponse {
  status: 'ok';
  service: 'raglab-api';
  version: string;
  uptimeSeconds: number;
  timestamp: string;
}

/** Response of `GET /api/health/ready` (readiness – dependencies are usable). */
export interface ReadinessResponse {
  status: 'ready' | 'not_ready';
  checks: {
    database: { status: ComponentStatus; latencyMs?: number; error?: string };
    pgvector: { status: ComponentStatus; version?: string; error?: string };
  };
  timestamp: string;
}

/**
 * Response of `GET /api/system/info`: the *configured* providers.
 * Values come from configuration; nothing here proves that a provider is reachable.
 */
export interface SystemInfoResponse {
  version: string;
  nodeVersion: string;
  embedding: {
    provider: string;
    model: string;
    dimensions: number;
  };
  chat: {
    provider: string;
    model: string;
  };
  retrieval: {
    defaultTopK: number;
  };
  chunking: {
    targetSize: number;
    overlap: number;
  };
}

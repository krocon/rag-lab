import type { ServerResponse } from 'node:http';

/** Interval of keep-alive comments while waiting (e.g. while the model loads). */
export const SSE_HEARTBEAT_MS = 15_000;

/**
 * One SSE frame: `event: <name>\ndata: <json>\n\n`. `JSON.stringify` escapes line breaks, so the
 * data always fits on one `data:` line.
 */
export function formatSseEvent(event: string, data: unknown): string {
  if (/[\r\n]/.test(event)) {
    throw new Error('SSE event names must not contain line breaks');
  }
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** An SSE comment line (ignored by clients), used as heartbeat. */
export function formatSseComment(text: string): string {
  return `: ${text.replace(/[\r\n]+/g, ' ')}\n\n`;
}

export interface SseWriter {
  /** Writes one event; waits while the socket buffer is full. No-op after close. */
  send(event: string, data: unknown): Promise<void>;
  /** Ends the response (idempotent). */
  close(): void;
  readonly closed: boolean;
}

/**
 * Small SSE helper on a raw Node response whose headers were already written. Writes respect
 * backpressure; an optional heartbeat comment keeps proxies and clients from timing out.
 */
export function createSseWriter(
  response: ServerResponse,
  { heartbeatMs = SSE_HEARTBEAT_MS }: { heartbeatMs?: number } = {},
): SseWriter {
  let closed = false;
  const isGone = () => closed || response.destroyed || response.writableEnded;
  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          if (!isGone()) {
            response.write(formatSseComment('heartbeat'));
          }
        }, heartbeatMs)
      : undefined;
  heartbeat?.unref();

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(heartbeat);
    if (!response.writableEnded) {
      response.end();
    }
  };
  response.once('close', () => {
    closed = true;
    clearInterval(heartbeat);
  });

  return {
    get closed() {
      return isGone();
    },
    async send(event, data) {
      if (isGone()) {
        return;
      }
      if (!response.write(formatSseEvent(event, data))) {
        await new Promise<void>((resolve) => {
          const done = () => {
            response.off('drain', done);
            response.off('close', done);
            resolve();
          };
          response.on('drain', done);
          response.on('close', done);
        });
      }
    },
    close,
  };
}

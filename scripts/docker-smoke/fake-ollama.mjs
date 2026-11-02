// @ts-check
/**
 * Minimal fake of the Ollama REST API for the Docker smoke test (scripts/docker-smoke.mjs). It
 * lets the containerised stack run upload → embedding → retrieval → chat without real models:
 *
 *   GET  /api/tags   lists the two fake models
 *   POST /api/embed  deterministic bag-of-words vectors (similar texts → similar vectors)
 *   POST /api/chat   streams a fixed answer as NDJSON, one piece every `tokenDelayMs`, so the test
 *                    can tell a streamed response from a buffered one
 *
 * Test helper only – never a substitute for a real model in quality measurements.
 */
import { createServer } from 'node:http';

/**
 * @param {{ embedModel: string, chatModel: string, dimensions: number, tokenDelayMs: number }} options
 * @returns {import('node:http').Server}
 */
export function createFakeOllama({ embedModel, chatModel, dimensions, tokenDelayMs }) {
  /** @param {string} text */
  const embed = (text) => {
    const vector = new Array(dimensions).fill(0);
    for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      let hash = 2166136261;
      for (const char of word) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
      vector[Math.abs(hash) % dimensions] += 1;
    }
    const norm = Math.hypot(...vector) || 1;
    // A zero vector has no cosine distance; give empty texts a constant direction instead.
    return norm === 1 && vector.every((v) => v === 0)
      ? vector.map((_, i) => (i === 0 ? 1 : 0))
      : vector.map((v) => v / norm);
  };

  return createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      /** @param {number} status @param {unknown} body */
      const json = (status, body) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      if (request.method === 'GET' && request.url === '/api/tags') {
        return json(200, {
          models: [embedModel, chatModel].map((name) => ({
            name: `${name}:latest`,
            model: `${name}:latest`,
          })),
        });
      }
      const body = raw ? JSON.parse(raw) : {};
      if (request.method === 'POST' && request.url === '/api/embed') {
        const input = Array.isArray(body.input) ? body.input : [body.input];
        return json(200, {
          model: body.model,
          embeddings: input.map((/** @type {unknown} */ text) => embed(String(text))),
        });
      }
      if (request.method === 'POST' && request.url === '/api/chat') {
        const pieces = [
          'The smoke test ',
          'document says ',
          'RAGLab runs ',
          'in containers ',
          '[1].',
        ];
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        let i = 0;
        const timer = setInterval(() => {
          if (i < pieces.length) {
            response.write(
              `${JSON.stringify({ model: body.model, message: { role: 'assistant', content: pieces[i] }, done: false })}\n`,
            );
            i++;
          } else {
            clearInterval(timer);
            response.end(
              `${JSON.stringify({ model: body.model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' })}\n`,
            );
          }
        }, tokenDelayMs);
        response.on('close', () => clearInterval(timer));
        return;
      }
      json(404, { error: 'not found' });
    });
  });
}

/**
 * Type-only contracts between API and web app.
 *
 * Rule: this package contains *types only* (no runtime code). Consumers must use
 * `import type`, so nothing from here ends up in compiled JavaScript and the
 * package needs no build step.
 */
export type * from './chat.js';
export type * from './chunks.js';
export type * from './collections.js';
export type * from './documents.js';
export type * from './errors.js';
export type * from './playground.js';
export type * from './retrieval.js';
export type * from './system.js';

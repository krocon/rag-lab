/**
 * Type-only contracts between API and web app.
 *
 * Rule: this package contains *types only* (no runtime code). Consumers must use
 * `import type`, so nothing from here ends up in compiled JavaScript and the
 * package needs no build step.
 */
export type * from './system.js';

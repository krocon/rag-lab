import { type EffectRef, InjectionToken, effect, inject, untracked } from '@angular/core';

/** Interval between two status polls of documents that are still being processed. */
export const POLL_INTERVAL_MS = new InjectionToken<number>('POLL_INTERVAL_MS', {
  providedIn: 'root',
  factory: () => 2000,
});

/**
 * Calls `tick` once per interval as long as `active()` is true.
 *
 * The timer is (re)scheduled whenever `active` becomes true again – typically after the reloaded
 * data has arrived (`!resource.isLoading()`), so requests never overlap. It is cleared
 * as soon as `active()` turns false or the owning component is destroyed (leaving the page).
 * Must be called in an injection context.
 */
export function pollWhile(active: () => boolean, tick: () => void): EffectRef {
  const intervalMs = inject(POLL_INTERVAL_MS);
  return effect((onCleanup) => {
    if (!active()) {
      return;
    }
    const handle = setTimeout(() => untracked(tick), intervalMs);
    onCleanup(() => clearTimeout(handle));
  });
}

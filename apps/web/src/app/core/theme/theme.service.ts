import { DOCUMENT, Injectable, effect, inject, signal } from '@angular/core';

export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'raglab.theme';
const PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'];

/** Holds the theme preference and mirrors it to `<html data-theme>` and localStorage. */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly storage = this.document.defaultView?.localStorage;

  readonly preference = signal<ThemePreference>(this.readStoredPreference());

  constructor() {
    effect(() => {
      const preference = this.preference();
      const root = this.document.documentElement;
      if (preference === 'system') {
        root.removeAttribute('data-theme');
      } else {
        root.setAttribute('data-theme', preference);
      }
      try {
        this.storage?.setItem(STORAGE_KEY, preference);
      } catch {
        // Storage can be unavailable (privacy mode); the theme still works for this session.
      }
    });
  }

  set(preference: ThemePreference): void {
    this.preference.set(preference);
  }

  private readStoredPreference(): ThemePreference {
    try {
      const stored = this.storage?.getItem(STORAGE_KEY);
      return PREFERENCES.find((value) => value === stored) ?? 'system';
    } catch {
      return 'system';
    }
  }
}

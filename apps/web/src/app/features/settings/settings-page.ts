import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import type { SystemInfoResponse } from '@raglab/shared';
import { API_PATHS } from '../../core/api/api-paths';
import { ThemeService, type ThemePreference } from '../../core/theme/theme.service';

@Component({
  selector: 'rl-settings-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Settings</h1>

    <section class="rl-card" aria-labelledby="appearance-heading">
      <h2 id="appearance-heading">Appearance</h2>
      <fieldset class="theme-options">
        <legend>Theme</legend>
        @for (option of themeOptions; track option.value) {
          <label>
            <input
              type="radio"
              name="theme"
              [value]="option.value"
              [checked]="theme.preference() === option.value"
              (change)="theme.set(option.value)"
            />
            {{ option.label }}
          </label>
        }
      </fieldset>
    </section>

    <section class="rl-card" aria-labelledby="providers-heading">
      <h2 id="providers-heading">Providers and models</h2>
      <p class="rl-muted">
        Read-only. Values come from the API configuration (<code>.env</code>); change them there and
        restart the API. Reachability of providers is not checked yet.
      </p>

      @if (info.isLoading()) {
        <p role="status">Loading configuration…</p>
      } @else if (info.hasValue()) {
        @let config = info.value();
        <dl class="config">
          <dt>Embedding provider</dt>
          <dd>{{ config.embedding.provider }}</dd>
          <dt>Embedding model</dt>
          <dd>
            <code>{{ config.embedding.model }}</code>
          </dd>
          <dt>Embedding dimensions</dt>
          <dd>{{ config.embedding.dimensions }}</dd>
          <dt>Chat provider</dt>
          <dd>{{ config.chat.provider }}</dd>
          <dt>Chat model</dt>
          <dd>
            <code>{{ config.chat.model }}</code>
          </dd>
          <dt>Default top-K</dt>
          <dd>{{ config.retrieval.defaultTopK }}</dd>
          <dt>Chunk size / overlap</dt>
          <dd>{{ config.chunking.targetSize }} / {{ config.chunking.overlap }} characters</dd>
          <dt>API version</dt>
          <dd>{{ config.version }} (Node {{ config.nodeVersion }})</dd>
        </dl>
      } @else {
        <div role="alert" class="error">
          <p>
            <span class="rl-badge rl-badge--danger"><span aria-hidden="true">✕</span> Error</span>
            The configuration could not be loaded. Is the API running?
          </p>
          <button type="button" class="rl-btn" (click)="info.reload()">Try again</button>
        </div>
      }
    </section>
  `,
  styles: `
    :host {
      display: grid;
      gap: 1.25rem;
      max-width: 760px;
    }
    h1 {
      margin-bottom: 0;
    }
    .theme-options {
      border: none;
      padding: 0;
      margin: 0;
      display: flex;
      gap: 1.25rem;
      flex-wrap: wrap;
    }
    .theme-options legend {
      font-weight: 600;
      margin-bottom: 0.5rem;
    }
    .theme-options label {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      cursor: pointer;
    }
    .config {
      display: grid;
      grid-template-columns: minmax(10rem, max-content) 1fr;
      gap: 0.5rem 1.5rem;
      margin: 0;
    }
    .config dt {
      font-weight: 600;
    }
    .config dd {
      margin: 0;
    }
    .error p {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      flex-wrap: wrap;
    }
  `,
})
export class SettingsPage {
  protected readonly theme = inject(ThemeService);
  protected readonly info = httpResource<SystemInfoResponse>(() => API_PATHS.systemInfo);

  protected readonly themeOptions: readonly { value: ThemePreference; label: string }[] = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ];
}

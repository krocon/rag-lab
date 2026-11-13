import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { linkHost, safeHttpsUrl } from '../../core/util/source-location';

/**
 * Link to an external page (e.g. the lines of a chunk in its repository), opened in a new tab
 * without `window.opener` and without a referrer. Renders nothing unless the URL is `https://`
 * and free of credentials, so an unexpected value never becomes a clickable link.
 */
@Component({
  selector: 'rl-external-link',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (safeUrl(); as url) {
      <a class="external" [href]="url" target="_blank" rel="noopener noreferrer"
        >{{ label() ?? 'View on ' + host() }} <span aria-hidden="true">↗</span
        ><span class="rl-visually-hidden"> (opens in a new tab)</span></a
      >
    }
  `,
  styles: `
    .external {
      overflow-wrap: anywhere;
    }
  `,
})
export class ExternalLink {
  readonly url = input.required<string | null>();
  /** Link text; defaults to `View on <host>`. */
  readonly label = input<string | undefined>(undefined);

  protected readonly safeUrl = computed(() => safeHttpsUrl(this.url()));
  protected readonly host = computed(() => linkHost(this.url()));
}

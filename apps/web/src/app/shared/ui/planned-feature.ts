import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Honest placeholder for features that are not implemented yet.
 * It names the prompt that will implement the feature instead of showing fake data.
 */
@Component({
  selector: 'rl-planned-feature',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="rl-card planned" [attr.aria-labelledby]="headingId">
      <p class="planned__status">
        <span class="rl-badge rl-badge--warn"><span aria-hidden="true">◷</span> Planned</span>
      </p>
      <h2 [id]="headingId">Not implemented yet</h2>
      <p>{{ summary() }}</p>
      @if (capabilities().length > 0) {
        <p class="rl-muted">What this page will offer:</p>
        <ul>
          @for (capability of capabilities(); track capability) {
            <li>{{ capability }}</li>
          }
        </ul>
      }
      <p class="rl-muted">
        Implemented by <code>{{ prompt() }}</code> (see <code>prompts/README.md</code>).
      </p>
    </section>
  `,
  styles: `
    .planned {
      max-width: 720px;
    }
    .planned__status {
      margin-bottom: 0.75rem;
    }
    ul {
      margin: 0 0 0.75rem;
      padding-left: 1.25rem;
    }
  `,
})
export class PlannedFeature {
  private static nextId = 0;

  readonly summary = input.required<string>();
  readonly prompt = input.required<string>();
  readonly capabilities = input<readonly string[]>([]);

  protected readonly headingId = `rl-planned-${PlannedFeature.nextId++}`;
}

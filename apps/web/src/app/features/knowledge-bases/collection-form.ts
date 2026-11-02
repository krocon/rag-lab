import {
  ChangeDetectionStrategy,
  Component,
  type ElementRef,
  computed,
  effect,
  input,
  linkedSignal,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { CollectionDto } from '@raglab/shared';
import type { ApiRequestError } from '../../core/api/api-error';

export const NAME_MAX_LENGTH = 120;
export const DESCRIPTION_MAX_LENGTH = 2000;

export interface CollectionFormValue {
  name: string;
  /** `null` when empty. */
  description: string | null;
}

interface FieldErrors {
  name?: string;
  description?: string;
  form?: string;
}

/**
 * Create/edit form for a collection: name (required, unique) and description.
 * Validates on the client like the API does and shows server errors (`409`, `400`) at the field.
 */
@Component({
  selector: 'rl-collection-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form novalidate (submit)="submit($event)">
      @if (errors().form; as message) {
        <p class="rl-alert" role="alert"><span aria-hidden="true">✕</span> {{ message }}</p>
      }
      <div class="rl-field">
        <label [for]="ids.name">Name (required)</label>
        <input
          #nameInput
          type="text"
          name="name"
          autocomplete="off"
          required
          [id]="ids.name"
          [value]="name()"
          [attr.aria-invalid]="errors().name ? true : null"
          [attr.aria-describedby]="describedBy(ids.nameHint, ids.nameError, errors().name)"
          (input)="onNameInput($event)"
          (blur)="nameTouched.set(true)"
        />
        <p class="rl-field__hint" [id]="ids.nameHint">
          Unique, up to {{ nameMaxLength }} characters.
        </p>
        @if (errors().name; as message) {
          <p class="rl-field__error" [id]="ids.nameError">
            <span aria-hidden="true">✕</span> {{ message }}
          </p>
        }
      </div>
      <div class="rl-field">
        <label [for]="ids.description">Description (optional)</label>
        <textarea
          #descriptionInput
          name="description"
          rows="3"
          [id]="ids.description"
          [value]="description()"
          [attr.aria-invalid]="errors().description ? true : null"
          [attr.aria-describedby]="
            describedBy(ids.descriptionHint, ids.descriptionError, errors().description)
          "
          (input)="onDescriptionInput($event)"
        ></textarea>
        <p class="rl-field__hint" [id]="ids.descriptionHint">
          Up to {{ descriptionMaxLength }} characters ({{ description().length }} used).
        </p>
        @if (errors().description; as message) {
          <p class="rl-field__error" [id]="ids.descriptionError">
            <span aria-hidden="true">✕</span> {{ message }}
          </p>
        }
      </div>
      <div class="rl-actions">
        <button type="submit" class="rl-btn rl-btn--primary" [disabled]="busy()">
          {{ busy() ? 'Saving…' : submitLabel() }}
        </button>
        <button type="button" class="rl-btn" [disabled]="busy()" (click)="cancelled.emit()">
          Cancel
        </button>
      </div>
    </form>
  `,
})
export class CollectionForm {
  private static nextId = 0;

  /** Values to edit; omitted when creating. */
  readonly initial = input<Pick<CollectionDto, 'name' | 'description'> | undefined>(undefined);
  readonly submitLabel = input('Save');
  readonly busy = input(false);
  /** Error of the last save attempt; mapped to the matching field. */
  readonly serverError = input<ApiRequestError | undefined>(undefined);

  readonly save = output<CollectionFormValue>();
  readonly cancelled = output();

  protected readonly nameMaxLength = NAME_MAX_LENGTH;
  protected readonly descriptionMaxLength = DESCRIPTION_MAX_LENGTH;

  protected readonly ids = (() => {
    const id = CollectionForm.nextId++;
    return {
      name: `rl-collection-name-${id}`,
      nameHint: `rl-collection-name-hint-${id}`,
      nameError: `rl-collection-name-error-${id}`,
      description: `rl-collection-description-${id}`,
      descriptionHint: `rl-collection-description-hint-${id}`,
      descriptionError: `rl-collection-description-error-${id}`,
    };
  })();

  protected readonly name = linkedSignal(() => this.initial()?.name ?? '');
  protected readonly description = linkedSignal(() => this.initial()?.description ?? '');
  protected readonly nameTouched = signal(false);
  private readonly submitted = signal(false);

  /** Server errors per field; editing a field clears its server error. */
  private readonly serverErrors = linkedSignal<FieldErrors>(() =>
    mapServerError(this.serverError()),
  );

  private readonly clientErrors = computed<FieldErrors>(() => {
    const name = this.name().trim();
    const errors: FieldErrors = {};
    if (name.length === 0) {
      errors.name = 'Enter a name.';
    } else if (name.length > NAME_MAX_LENGTH) {
      errors.name = `The name is ${name.length} characters long; use at most ${NAME_MAX_LENGTH}.`;
    }
    const description = this.description().trim();
    if (description.length > DESCRIPTION_MAX_LENGTH) {
      errors.description = `The description is ${description.length} characters long; use at most ${DESCRIPTION_MAX_LENGTH}.`;
    }
    return errors;
  });

  /** Client errors appear after the field was left or the form was submitted. */
  protected readonly errors = computed<FieldErrors>(() => {
    const client = this.clientErrors();
    const server = this.serverErrors();
    const showName = this.submitted() || this.nameTouched();
    return {
      name: (showName ? client.name : undefined) ?? server.name,
      description: client.description ?? server.description,
      form: server.form,
    };
  });

  private readonly nameInput = viewChild.required<ElementRef<HTMLInputElement>>('nameInput');
  private readonly descriptionInput =
    viewChild.required<ElementRef<HTMLTextAreaElement>>('descriptionInput');

  constructor() {
    // Move focus to the field the server rejected (once per server response).
    effect(() => {
      const server = mapServerError(this.serverError());
      untracked(() => {
        if (server.name) {
          this.nameInput().nativeElement.focus();
        } else if (server.description) {
          this.descriptionInput().nativeElement.focus();
        }
      });
    });
  }

  /** Focuses the name field (e.g. right after the form was opened). */
  focus(): void {
    this.nameInput().nativeElement.focus();
  }

  protected describedBy(hintId: string, errorId: string, error: string | undefined): string {
    return error ? `${hintId} ${errorId}` : hintId;
  }

  protected onNameInput(event: Event): void {
    this.name.set((event.target as HTMLInputElement).value);
    this.serverErrors.update(({ name: _name, ...rest }) => rest);
  }

  protected onDescriptionInput(event: Event): void {
    this.description.set((event.target as HTMLTextAreaElement).value);
    this.serverErrors.update(({ description: _description, ...rest }) => rest);
  }

  protected submit(event: Event): void {
    event.preventDefault();
    if (this.busy()) {
      return;
    }
    this.submitted.set(true);
    const client = this.clientErrors();
    if (client.name) {
      this.nameInput().nativeElement.focus();
      return;
    }
    if (client.description) {
      this.descriptionInput().nativeElement.focus();
      return;
    }
    const description = this.description().trim();
    this.save.emit({ name: this.name().trim(), description: description || null });
  }
}

function mapServerError(error: ApiRequestError | undefined): FieldErrors {
  if (!error) {
    return {};
  }
  if (error.status === 409) {
    const name = error.detail('name');
    return {
      name: name
        ? `A knowledge base named "${name}" already exists. Choose a different name.`
        : 'A knowledge base with this name already exists. Choose a different name.',
    };
  }
  if (error.code === 'VALIDATION_ERROR') {
    const errors: FieldErrors = {};
    for (const issue of error.validationIssues) {
      if (issue.location.startsWith('body/name')) {
        errors.name ??= `Name ${issue.message}.`;
      } else if (issue.location.startsWith('body/description')) {
        errors.description ??= `Description ${issue.message}.`;
      }
    }
    if (errors.name || errors.description) {
      return errors;
    }
  }
  return { form: error.message };
}

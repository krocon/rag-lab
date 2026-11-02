import { required } from '../../../testing/fixtures';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { ApiRequestError } from '../../core/api/api-error';
import { CollectionForm, type CollectionFormValue } from './collection-form';

describe('CollectionForm', () => {
  let fixture: ComponentFixture<CollectionForm>;
  let element: HTMLElement;
  let saved: CollectionFormValue[];

  beforeEach(async () => {
    fixture = TestBed.createComponent(CollectionForm);
    element = fixture.nativeElement as HTMLElement;
    saved = [];
    fixture.componentInstance.save.subscribe((value) => saved.push(value));
    await fixture.whenStable();
  });

  const nameInput = () => required(element.querySelector<HTMLInputElement>('input[name="name"]'));
  const descriptionInput = () => required(element.querySelector<HTMLTextAreaElement>('textarea'));
  const errorOf = (field: HTMLElement) =>
    (field.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => element.querySelector(`#${id}`)?.textContent?.trim() ?? '')
      .join(' | ');

  async function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
    field.value = value;
    field.dispatchEvent(new Event('input'));
    await fixture.whenStable();
  }

  async function submit() {
    element.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
  }

  it('labels every field', () => {
    expect(element.querySelector(`label[for="${nameInput().id}"]`)?.textContent).toContain('Name');
    expect(element.querySelector(`label[for="${descriptionInput().id}"]`)?.textContent).toContain(
      'Description',
    );
  });

  it('requires a name and points to the error via aria-describedby', async () => {
    await type(nameInput(), '   ');
    await submit();

    expect(saved).toEqual([]);
    expect(nameInput().getAttribute('aria-invalid')).toBe('true');
    expect(errorOf(nameInput())).toContain('Enter a name.');
  });

  it('rejects names longer than 120 characters', async () => {
    await type(nameInput(), 'x'.repeat(121));
    await submit();

    expect(saved).toEqual([]);
    expect(errorOf(nameInput())).toContain('use at most 120');
  });

  it('emits trimmed values; an empty description becomes null', async () => {
    await type(nameInput(), '  Docs  ');
    await type(descriptionInput(), '   ');
    await submit();

    expect(saved).toEqual([{ name: 'Docs', description: null }]);
  });

  it('shows a 409 at the name field and clears it when the name changes', async () => {
    fixture.componentRef.setInput(
      'serverError',
      new ApiRequestError(
        409,
        'COLLECTION_NAME_TAKEN',
        'A collection named "Docs" already exists',
        {
          name: 'Docs',
        },
      ),
    );
    await fixture.whenStable();

    expect(nameInput().getAttribute('aria-invalid')).toBe('true');
    expect(errorOf(nameInput())).toContain('A knowledge base named "Docs" already exists');
    expect(document.activeElement).toBe(nameInput());

    await type(nameInput(), 'Docs 2');
    expect(nameInput().getAttribute('aria-invalid')).toBeNull();
  });

  it('maps 400 validation issues to the matching field', async () => {
    fixture.componentRef.setInput(
      'serverError',
      new ApiRequestError(400, 'VALIDATION_ERROR', 'Invalid', [
        { location: 'body/description', message: 'must NOT have more than 2000 characters' },
      ]),
    );
    await fixture.whenStable();

    expect(errorOf(descriptionInput())).toContain(
      'Description must NOT have more than 2000 characters.',
    );
  });

  it('shows other server errors for the whole form', async () => {
    fixture.componentRef.setInput(
      'serverError',
      new ApiRequestError(0, 'NETWORK_ERROR', 'The API is not reachable.'),
    );
    await fixture.whenStable();

    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      'The API is not reachable.',
    );
  });

  it('prefills the values when editing', async () => {
    fixture.componentRef.setInput('initial', { name: 'Docs', description: 'Notes' });
    await fixture.whenStable();

    expect(nameInput().value).toBe('Docs');
    expect(descriptionInput().value).toBe('Notes');
  });
});

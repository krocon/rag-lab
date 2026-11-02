import { HttpEventType, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { DocumentDto } from '@raglab/shared';
import {
  COLLECTION_ID,
  DOCUMENT_ID,
  apiError,
  document as documentDto,
  systemInfo,
  text,
  required,
} from '../../../testing/fixtures';
import { DocumentUpload } from './document-upload';

const UPLOAD_URL = `/api/collections/${COLLECTION_ID}/documents`;

function file(name: string, content = '# Hello'): File {
  return new File([content], name);
}

describe('DocumentUpload', () => {
  let fixture: ComponentFixture<DocumentUpload>;
  let http: HttpTestingController;
  let element: HTMLElement;
  let uploaded: DocumentDto[];

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(DocumentUpload);
    fixture.componentRef.setInput('collectionId', COLLECTION_ID);
    element = fixture.nativeElement as HTMLElement;
    uploaded = [];
    fixture.componentInstance.uploaded.subscribe((document) => uploaded.push(document));
    TestBed.tick();
    http.expectOne('/api/system/info').flush(systemInfo);
    await fixture.whenStable();
  });

  afterEach(() => http.verify());

  const items = () => Array.from(element.querySelectorAll('ul[aria-label="Uploads"] > li'));
  const item = (name: string) => items().find((li) => text(li).startsWith(name));

  async function drop(...files: File[]): Promise<void> {
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { files, types: ['Files'] } });
    element.querySelector('[data-testid="dropzone"]')?.dispatchEvent(event);
    await fixture.whenStable();
  }

  it('shows the limits and offers a keyboard-accessible file picker', () => {
    expect(text(element)).toContain('(.md, .markdown, .txt), UTF-8, up to 1 KiB each');
    const button = Array.from(element.querySelectorAll('button')).find((b) =>
      text(b).includes('Choose files'),
    );
    const input = required(element.querySelector<HTMLInputElement>('input[type="file"]'));
    expect(input.multiple).toBe(true);
    expect(input.getAttribute('accept')).toBe('.md,.markdown,.txt');
    const click = vi.spyOn(input, 'click').mockImplementation(() => undefined);
    button?.click();
    expect(click).toHaveBeenCalled();
  });

  it('rejects unsupported, too large and empty files before uploading', async () => {
    await drop(file('paper.pdf'), file('big.md', 'x'.repeat(2048)), file('empty.txt', ''));

    expect(text(item('paper.pdf'))).toContain('Not uploaded');
    expect(text(item('paper.pdf'))).toContain('not a supported file type');
    expect(text(item('big.md'))).toContain('"big.md" is 2 KiB; the limit is 1 KiB per file.');
    expect(text(item('empty.txt'))).toContain('"empty.txt" is empty.');
    expect(text(element.querySelector('[role="status"]'))).toContain('paper.pdf');
    http.expectNone(UPLOAD_URL);
  });

  it('uploads with progress and reports the stored document', async () => {
    await drop(file('notes.md'));

    const request = http.expectOne({ method: 'POST', url: UPLOAD_URL });
    expect((request.request.body as FormData).getAll('file')).toHaveLength(1);
    request.event({ type: HttpEventType.UploadProgress, loaded: 50, total: 100 });
    await fixture.whenStable();

    const progress = item('notes.md')?.querySelector('progress');
    expect(progress?.getAttribute('value')).toBe('50');
    expect(progress?.getAttribute('aria-label')).toBe('Upload progress of notes.md');
    expect(text(item('notes.md'))).toContain('50 %');

    request.flush(
      { documents: [documentDto({ status: 'pending' })] },
      { status: 202, statusText: 'Accepted' },
    );
    await fixture.whenStable();

    expect(text(item('notes.md'))).toContain('Uploaded');
    expect(text(element.querySelector('[role="status"]'))).toContain('"notes.md" uploaded');
    expect(uploaded.map((d) => d.id)).toEqual([DOCUMENT_ID]);
  });

  it('uploads files one by one and reports server errors per file', async () => {
    await drop(file('copy.md'), file('weird.md'), file('large.md'));

    http.expectOne(UPLOAD_URL).flush(
      apiError('DUPLICATE_DOCUMENT', 'same content', {
        filename: 'copy.md',
        existingDocumentId: DOCUMENT_ID,
      }),
      { status: 409, statusText: 'Conflict' },
    );
    await fixture.whenStable();
    http
      .expectOne(UPLOAD_URL)
      .flush(apiError('UNSUPPORTED_FILE_TYPE', '"weird.md" has an unsupported type.'), {
        status: 415,
        statusText: 'Unsupported Media Type',
      });
    await fixture.whenStable();
    http
      .expectOne(UPLOAD_URL)
      .flush(apiError('FILE_TOO_LARGE', '"large.md" exceeds the maximum file size of 5 MiB.'), {
        status: 413,
        statusText: 'Payload Too Large',
      });
    await fixture.whenStable();

    const duplicate = item('copy.md');
    expect(text(duplicate)).toContain('Upload failed');
    expect(text(duplicate)).toContain('already in this knowledge base');
    expect(duplicate?.querySelector('a')?.getAttribute('href')).toBe(
      `/knowledge-bases/${COLLECTION_ID}/documents/${DOCUMENT_ID}`,
    );
    expect(text(item('weird.md'))).toContain('"weird.md" has an unsupported type.');
    expect(text(item('large.md'))).toContain('exceeds the maximum file size of 5 MiB');
    expect(uploaded).toEqual([]);
  });

  it('clears finished uploads', async () => {
    await drop(file('paper.pdf'));
    Array.from(element.querySelectorAll('button'))
      .find((b) => text(b) === 'Clear finished uploads')
      ?.click();
    await fixture.whenStable();

    expect(items()).toHaveLength(0);
  });

  it('leaves checks to the server when the limits cannot be loaded', async () => {
    fixture.destroy();
    fixture = TestBed.createComponent(DocumentUpload);
    fixture.componentRef.setInput('collectionId', COLLECTION_ID);
    element = fixture.nativeElement as HTMLElement;
    TestBed.tick();
    http.expectOne('/api/system/info').flush(null, { status: 500, statusText: 'Error' });
    await fixture.whenStable();

    expect(text(element)).toContain('Upload limits could not be loaded');
    await drop(file('paper.pdf'));
    http
      .expectOne(UPLOAD_URL)
      .flush(apiError('UNSUPPORTED_FILE_TYPE', '"paper.pdf" is not a supported file type.'), {
        status: 415,
        statusText: 'Unsupported Media Type',
      });
    await fixture.whenStable();

    expect(text(item('paper.pdf'))).toContain('"paper.pdf" is not a supported file type.');
  });
});

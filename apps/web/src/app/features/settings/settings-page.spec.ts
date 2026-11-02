import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import type { SystemInfoResponse } from '@raglab/shared';
import { ThemeService } from '../../core/theme/theme.service';
import { SettingsPage } from './settings-page';

const info: SystemInfoResponse = {
  version: '0.1.0',
  nodeVersion: 'v24.21.0',
  embedding: { provider: 'ollama', model: 'example-embed', dimensions: 768 },
  chat: { provider: 'ollama', model: 'example-chat' },
  retrieval: { defaultTopK: 8 },
  chunking: { targetSize: 1200, overlap: 200 },
};

describe('SettingsPage', () => {
  let fixture: ComponentFixture<SettingsPage>;
  let http: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      imports: [SettingsPage],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(SettingsPage);
    // Not whenStable(): it would wait for the pending HTTP request that each test flushes.
    TestBed.tick();
  });

  afterEach(() => http.verify());

  it('shows the configured providers and models', async () => {
    http.expectOne('/api/system/info').flush(info);
    await fixture.whenStable();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('example-embed');
    expect(text).toContain('768');
    expect(text).toContain('example-chat');
    expect(text).toContain('1200 / 200 characters');
  });

  it('shows an error with retry when the API fails', async () => {
    http.expectOne('/api/system/info').flush(null, { status: 500, statusText: 'Server Error' });
    await fixture.whenStable();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('could not be loaded');

    element.querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
    TestBed.tick();
    http.expectOne('/api/system/info').flush(info);
  });

  it('switches the theme via the radio group', async () => {
    http.expectOne('/api/system/info').flush(info);
    await fixture.whenStable();

    const dark = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
      'input[value="dark"]',
    );
    dark?.click();
    await fixture.whenStable();

    expect(TestBed.inject(ThemeService).preference()).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});

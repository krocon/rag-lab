import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import type { LivenessResponse, ReadinessResponse } from '@raglab/shared';
import { SystemStatus } from './system-status';

const liveness: LivenessResponse = {
  status: 'ok',
  service: 'raglab-api',
  version: '0.1.0',
  uptimeSeconds: 5,
  timestamp: '2026-11-02T08:00:00.000Z',
};

const ready: ReadinessResponse = {
  status: 'ready',
  checks: {
    database: { status: 'up', latencyMs: 3 },
    pgvector: { status: 'up', version: '0.8.7' },
  },
  timestamp: '2026-11-02T08:00:00.000Z',
};

describe('SystemStatus', () => {
  let fixture: ComponentFixture<SystemStatus>;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [SystemStatus],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(SystemStatus);
    // Not whenStable(): it would wait for the pending HTTP requests that each test flushes.
    TestBed.tick();
  });

  afterEach(() => http.verify());

  function badge(label: string): string {
    const element = fixture.nativeElement as HTMLElement;
    return element.querySelector(`[data-testid="status-${label}"]`)?.textContent?.trim() ?? '';
  }

  it('shows a checking state while requests are pending', () => {
    expect(badge('API')).toContain('Checking');
    http.expectOne('/api/health').flush(liveness);
    http.expectOne('/api/health/ready').flush(ready);
  });

  it('shows all components as up when the API is ready', async () => {
    http.expectOne('/api/health').flush(liveness);
    http.expectOne('/api/health/ready').flush(ready);
    await fixture.whenStable();

    expect(badge('API')).toContain('Running');
    expect(badge('Database')).toContain('Up');
    expect(badge('pgvector')).toContain('Up');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('v0.8.7');
  });

  it('reads the 503 body when the database is down', async () => {
    const notReady: ReadinessResponse = {
      status: 'not_ready',
      checks: {
        database: { status: 'down', error: 'connect ECONNREFUSED' },
        pgvector: { status: 'down', error: 'database unreachable' },
      },
      timestamp: ready.timestamp,
    };
    http.expectOne('/api/health').flush(liveness);
    http
      .expectOne('/api/health/ready')
      .flush(notReady, { status: 503, statusText: 'Service Unavailable' });
    await fixture.whenStable();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(badge('API')).toContain('Running');
    expect(badge('Database')).toContain('Down');
    expect(text).toContain('connect ECONNREFUSED');
    expect(text).toContain('pnpm db:up');
  });

  it('reports an unreachable API', async () => {
    http.expectOne('/api/health').error(new ProgressEvent('error'));
    http.expectOne('/api/health/ready').error(new ProgressEvent('error'));
    await fixture.whenStable();

    expect(badge('API')).toContain('Unreachable');
    expect(badge('Database')).toContain('Unknown');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('pnpm dev:api');
  });
});

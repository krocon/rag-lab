import { TestBed } from '@angular/core/testing';
import { ThemeService } from './theme.service';

describe('ThemeService', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('defaults to the system preference without forcing a theme', () => {
    const service = TestBed.inject(ThemeService);
    TestBed.tick();

    expect(service.preference()).toBe('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('applies and persists an explicit choice', () => {
    const service = TestBed.inject(ThemeService);
    service.set('light');
    TestBed.tick();

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('raglab.theme')).toBe('light');
  });

  it('restores a stored preference and ignores invalid values', () => {
    localStorage.setItem('raglab.theme', 'dark');
    expect(TestBed.inject(ThemeService).preference()).toBe('dark');

    TestBed.resetTestingModule();
    localStorage.setItem('raglab.theme', 'neon');
    expect(TestBed.inject(ThemeService).preference()).toBe('system');
  });
});

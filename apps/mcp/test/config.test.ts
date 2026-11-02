import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  configWarnings,
  DEFAULT_API_URL,
  isLoopbackUrl,
  loadConfig,
  normalizeApiUrl,
} from '../src/config.js';

describe('loadConfig', () => {
  it('uses safe defaults', () => {
    expect(loadConfig({})).toEqual({
      apiUrl: DEFAULT_API_URL,
      maxOutputChars: 20_000,
      requestTimeoutMs: 90_000,
      chatTimeoutMs: 300_000,
    });
  });

  it('reads and normalises all variables; empty strings count as unset', () => {
    expect(
      loadConfig({
        RAGLAB_API_URL: ' http://localhost:3100/ ',
        MCP_MAX_OUTPUT_CHARS: '5000',
        MCP_REQUEST_TIMEOUT_MS: '2000',
        MCP_CHAT_TIMEOUT_MS: '',
      }),
    ).toEqual({
      apiUrl: 'http://localhost:3100',
      maxOutputChars: 5000,
      requestTimeoutMs: 2000,
      chatTimeoutMs: 300_000,
    });
  });

  it('lists every invalid variable', () => {
    try {
      loadConfig({
        RAGLAB_API_URL: 'ftp://example.com',
        MCP_MAX_OUTPUT_CHARS: '10',
        MCP_REQUEST_TIMEOUT_MS: 'soon',
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).issues.join('\n');
      expect(issues).toContain('RAGLAB_API_URL');
      expect(issues).toContain('MCP_MAX_OUTPUT_CHARS');
      expect(issues).toContain('MCP_REQUEST_TIMEOUT_MS');
    }
  });
});

describe('normalizeApiUrl', () => {
  it.each([
    ['http://127.0.0.1:3000', 'http://127.0.0.1:3000'],
    ['https://raglab.example.com/base/', 'https://raglab.example.com/base'],
    ['http://[::1]:3000', 'http://[::1]:3000'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeApiUrl(input)).toBe(expected);
  });

  it.each([
    ['not a url', 'absolute URL'],
    ['file:///etc/passwd', 'http or https'],
    ['http://user:secret@127.0.0.1:3000', 'credentials'],
    ['http://127.0.0.1:3000/?x=1', 'query'],
  ])('rejects %s', (input, message) => {
    const result = normalizeApiUrl(input);
    expect(typeof result).toBe('object');
    expect((result as { error: string }).error).toContain(message);
  });
});

describe('configWarnings', () => {
  it('warns only for non-local API hosts', () => {
    expect(isLoopbackUrl('http://localhost:3000')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.2:3000')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:3000')).toBe(true);
    expect(configWarnings(loadConfig({}))).toEqual([]);
    const warnings = configWarnings(loadConfig({ RAGLAB_API_URL: 'http://10.0.0.5:3000' }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('no authentication');
  });
});

describe('.env.example', () => {
  it('documents every MCP variable with its default value', () => {
    const example = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
    const env = Object.fromEntries(
      example
        .split('\n')
        .filter((line) => /^(RAGLAB|MCP)_[A-Z_]+=/.test(line))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    expect(Object.keys(env).sort()).toEqual([
      'MCP_CHAT_TIMEOUT_MS',
      'MCP_MAX_OUTPUT_CHARS',
      'MCP_REQUEST_TIMEOUT_MS',
      'RAGLAB_API_URL',
    ]);
    expect(loadConfig(env)).toEqual(loadConfig({}));
  });
});

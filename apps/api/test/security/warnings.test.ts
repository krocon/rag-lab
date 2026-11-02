import { describe, expect, it } from 'vitest';
import { hostName, isLoopbackHost, securityWarnings } from '../../src/http/security.js';
import { testConfig } from '../helpers.js';

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]'])(
    '%s is local',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each(['0.0.0.0', '::', '192.168.1.10', 'raglab.example.com', '128.0.0.1', 'localhost.evil'])(
    '%s is not local',
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );
});

describe('hostName', () => {
  it.each([
    ['localhost:3000', 'localhost'],
    ['LOCALHOST', 'localhost'],
    ['[::1]:3000', '[::1]'],
    ['example.com.', 'example.com'],
    ['', undefined],
    [undefined, undefined],
  ])('%j → %j', (header, expected) => {
    expect(hostName(header)).toBe(expected);
  });
});

describe('securityWarnings (logged at startup)', () => {
  it('are empty for the local default configuration', () => {
    expect(securityWarnings(testConfig())).toEqual([]);
  });

  it('warn when the API listens on a non-local address without a protecting layer', () => {
    const [warning] = securityWarnings(testConfig({ API_HOST: '0.0.0.0' }));
    expect(warning).toMatch(/API_HOST=0\.0\.0\.0 .*no authentication/);
    expect(warning).toContain('NETWORK_ACCESS_PROTECTED=true');

    expect(
      securityWarnings(testConfig({ API_HOST: '0.0.0.0', NETWORK_ACCESS_PROTECTED: 'true' })),
    ).toEqual([]);
  });

  it('warn about a disabled Host check and disabled rate limits', () => {
    const warnings = securityWarnings(
      testConfig({ ALLOWED_HOSTS: '*', RATE_LIMIT_ENABLED: 'false' }),
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('DNS rebinding');
    expect(warnings[1]).toContain('RATE_LIMIT_ENABLED=false');
  });
});

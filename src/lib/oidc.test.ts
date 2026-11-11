import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getOidcConfig, getOidcProviderName, isOidcConfigured } from './oidc';

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('CLOUD_MODE', '');
  vi.stubEnv('OIDC_DISCOVERY_URL', 'https://idp.example/.well-known/openid-configuration');
  vi.stubEnv('OIDC_CLIENT_ID', 'umami');
  vi.stubEnv('OIDC_CLIENT_SECRET', 'secret');
  vi.stubEnv('OIDC_PROVIDER_NAME', '');
  vi.stubEnv('OIDC_SCOPES', '');
  vi.stubEnv('OIDC_DISABLE_SIGNUP', '');
});

describe('isOidcConfigured', () => {
  test('is on when the discovery URL and client credentials are set', () => {
    expect(isOidcConfigured()).toBe(true);
  });

  test.each(['OIDC_DISCOVERY_URL', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'])(
    'is off without %s',
    name => {
      vi.stubEnv(name, '');

      expect(isOidcConfigured()).toBe(false);
    },
  );

  test('is off in cloud mode', () => {
    vi.stubEnv('CLOUD_MODE', '1');

    expect(isOidcConfigured()).toBe(false);
  });
});

describe('getOidcProviderName', () => {
  test('falls back to a generic name', () => {
    expect(getOidcProviderName()).toBe('SSO');
  });

  test('uses the configured name', () => {
    vi.stubEnv('OIDC_PROVIDER_NAME', 'Authentik');

    expect(getOidcProviderName()).toBe('Authentik');
  });
});

describe('getOidcConfig', () => {
  test('requests the standard scopes by default', () => {
    expect(getOidcConfig().scopes).toEqual(['openid', 'profile', 'email']);
  });

  test('splits configured scopes on whitespace', () => {
    vi.stubEnv('OIDC_SCOPES', 'openid  email groups');

    expect(getOidcConfig().scopes).toEqual(['openid', 'email', 'groups']);
  });

  test('lets new users sign up unless that is disabled', () => {
    expect(getOidcConfig().disableSignUp).toBe(false);

    vi.stubEnv('OIDC_DISABLE_SIGNUP', '1');

    expect(getOidcConfig().disableSignUp).toBe(true);
  });

  test('takes the username from preferred_username, lowercased like every Umami username', () => {
    const user = getOidcConfig().mapProfileToUser({
      preferred_username: 'Alice',
      email: 'alice@example.com',
      name: 'Alice A',
    });

    expect(user).toEqual({ username: 'alice', displayUsername: 'alice', name: 'Alice A' });
  });

  test('falls back to the email when the provider sends no preferred_username', () => {
    const user = getOidcConfig().mapProfileToUser({ email: 'Carol@Example.com' });

    expect(user).toEqual({
      username: 'carol@example.com',
      displayUsername: 'carol@example.com',
      name: 'carol@example.com',
    });
  });

  test('gives a user without an email a placeholder address derived from the subject', () => {
    const user = getOidcConfig().mapProfileToUser({ sub: 'subject-1', preferred_username: 'dan' });

    expect(user).toMatchObject({
      username: 'dan',
      email: expect.stringMatching(/^[0-9a-f]{32}@placeholder\.local$/),
    });
    expect(getOidcConfig().mapProfileToUser({ sub: 'subject-2' }).email).not.toBe(user.email);
  });
});

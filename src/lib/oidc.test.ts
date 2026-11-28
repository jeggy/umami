import { beforeEach, describe, expect, test, vi } from 'vitest';
import { encrypt, secret } from '@/lib/crypto';
import {
  getGenericOAuthConfig,
  getLoginProviders,
  getOidcProviders,
  invalidateOidcProviders,
  isUsable,
  mapProfileToUser,
  resolveProviders,
  type StoredOidcProvider,
} from './oidc';

const rows = vi.hoisted(() => ({ value: [] as Record<string, any>[] }));

vi.mock('@/queries/prisma/oidcProvider', () => ({ findOidcProviders: async () => rows.value }));

const ENV = {
  OIDC_DISCOVERY_URL: 'https://idp.example/.well-known/openid-configuration',
  OIDC_CLIENT_ID: 'umami',
  OIDC_CLIENT_SECRET: 'secret',
};

function stored(fields: Partial<StoredOidcProvider> = {}): StoredOidcProvider {
  return {
    slug: 'authentik',
    name: 'Authentik',
    discoveryUrl: 'https://authentik.example/.well-known/openid-configuration',
    clientId: 'umami-client',
    clientSecret: { status: 'set', value: 'stored-secret' },
    scopes: null,
    groupsClaim: 'groups',
    disableSignup: false,
    disableProviderLogout: false,
    mappings: [],
    ...fields,
  };
}

describe('resolveProviders', () => {
  test('has no provider without environment variables or stored rows', () => {
    expect(resolveProviders({}, [])).toEqual([]);
  });

  test('takes the provider "oidc" from the environment, with every set field locked', () => {
    const [provider] = resolveProviders(ENV, []);

    expect(provider).toEqual({
      slug: 'oidc',
      name: 'SSO',
      discoveryUrl: ENV.OIDC_DISCOVERY_URL,
      clientId: 'umami',
      clientSecret: { status: 'set', value: 'secret' },
      scopes: 'openid profile email',
      groupsClaim: 'groups',
      disableSignup: false,
      disableProviderLogout: false,
      mappings: [],
      lockedBy: {
        discoveryUrl: 'OIDC_DISCOVERY_URL',
        clientId: 'OIDC_CLIENT_ID',
        clientSecret: 'OIDC_CLIENT_SECRET',
      },
      stored: false,
    });
    expect(isUsable(provider)).toBe(true);
  });

  test.each(['OIDC_DISCOVERY_URL', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'])(
    'offers no sign-in through the environment provider without %s',
    name => {
      const [provider] = resolveProviders({ ...ENV, [name]: '' }, []);

      expect(isUsable(provider)).toBe(false);
      expect(Object.values(provider.lockedBy)).not.toContain(name);
    },
  );

  test('fills what the environment leaves unset from the stored row "oidc", and the environment wins', () => {
    const row = stored({
      slug: 'oidc',
      name: 'Keycloak',
      discoveryUrl: 'https://ignored.example/.well-known/openid-configuration',
      clientId: null,
      clientSecret: { status: 'set', value: 'stored-secret' },
      disableSignup: true,
      mappings: [{ group: '/umami', role: 'user', teamId: null, teamRole: null }],
    });

    const [provider] = resolveProviders(
      { OIDC_DISCOVERY_URL: ENV.OIDC_DISCOVERY_URL, OIDC_CLIENT_ID: 'umami' },
      [row],
    );

    expect(provider).toMatchObject({
      slug: 'oidc',
      name: 'Keycloak',
      discoveryUrl: ENV.OIDC_DISCOVERY_URL,
      clientId: 'umami',
      clientSecret: { status: 'set', value: 'stored-secret' },
      disableSignup: true,
      mappings: row.mappings,
      lockedBy: { discoveryUrl: 'OIDC_DISCOVERY_URL', clientId: 'OIDC_CLIENT_ID' },
      stored: true,
    });
    expect(isUsable(provider)).toBe(true);
  });

  test('lists the environment provider first, then the stored ones', () => {
    const providers = resolveProviders(ENV, [stored({ slug: 'b' }), stored({ slug: 'a' })]);

    expect(providers.map(({ slug }) => slug)).toEqual(['oidc', 'b', 'a']);
    expect(providers[1]).toMatchObject({
      lockedBy: {},
      stored: true,
      scopes: 'openid profile email',
    });
  });

  test('reads 0 and false as off, and other values as on', () => {
    const [provider] = resolveProviders(
      { ...ENV, OIDC_DISABLE_SIGNUP: ' FALSE ', OIDC_DISABLE_PROVIDER_LOGOUT: '1' },
      [stored({ slug: 'oidc', disableSignup: true })],
    );

    expect(provider).toMatchObject({ disableSignup: false, disableProviderLogout: true });
    expect(provider.lockedBy).toMatchObject({
      disableSignup: 'OIDC_DISABLE_SIGNUP',
      disableProviderLogout: 'OIDC_DISABLE_PROVIDER_LOGOUT',
    });
  });

  test('offers no sign-in through a provider whose secret cannot be read', () => {
    const [provider] = resolveProviders({}, [stored({ clientSecret: { status: 'unreadable' } })]);

    expect(isUsable(provider)).toBe(false);
  });
});

describe('getOidcProviders', () => {
  function row(fields: Record<string, any> = {}) {
    return {
      id: '00000000-0000-0000-0000-000000000001',
      slug: 'authentik',
      name: 'Authentik',
      discoveryUrl: 'https://authentik.example/.well-known/openid-configuration',
      clientId: 'umami-client',
      clientSecret: encrypt('stored-secret', secret()),
      scopes: null,
      groupsClaim: 'groups',
      disableSignup: false,
      disableProviderLogout: false,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      groupMappings: [],
      ...fields,
    };
  }

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('APP_SECRET', 'test-secret');
    vi.stubEnv('CLOUD_MODE', '');
    for (const name of Object.keys(ENV)) {
      vi.stubEnv(name, '');
    }
    rows.value = [];
    invalidateOidcProviders();
  });

  test('decrypts the stored client secret', async () => {
    rows.value = [row()];

    const [provider] = await getOidcProviders();

    expect(provider.clientSecret).toEqual({ status: 'set', value: 'stored-secret' });
    expect(await getLoginProviders()).toEqual([{ slug: 'authentik', name: 'Authentik' }]);
  });

  test('marks a secret encrypted under another APP_SECRET as unreadable', async () => {
    rows.value = [row()];
    vi.stubEnv('APP_SECRET', 'another-secret');

    const [provider] = await getOidcProviders();

    expect(provider.clientSecret).toEqual({ status: 'unreadable' });
    expect(await getLoginProviders()).toEqual([]);
  });

  test('has no providers in cloud mode', async () => {
    rows.value = [row()];
    vi.stubEnv('CLOUD_MODE', '1');

    expect(await getOidcProviders()).toEqual([]);
  });

  test('returns the same providers until a change is saved', async () => {
    rows.value = [row()];
    const first = await getOidcProviders();

    rows.value = [row({ name: 'Renamed', updatedAt: new Date(1) })];

    expect(await getOidcProviders()).toBe(first);

    invalidateOidcProviders();
    const [provider] = await getOidcProviders();

    expect(provider.name).toBe('Renamed');
  });
});

describe('getGenericOAuthConfig', () => {
  test('splits the scopes on whitespace', () => {
    const [provider] = resolveProviders({ ...ENV, OIDC_SCOPES: 'openid  email groups' }, []);

    expect(getGenericOAuthConfig(provider)).toMatchObject({
      providerId: 'oidc',
      clientSecret: 'secret',
      scopes: ['openid', 'email', 'groups'],
    });
  });
});

describe('mapProfileToUser', () => {
  test('takes the username from preferred_username, lowercased like every Umami username', () => {
    const user = mapProfileToUser({
      preferred_username: 'Alice',
      email: 'alice@example.com',
      name: 'Alice A',
    });

    expect(user).toEqual({ username: 'alice', displayUsername: 'alice', name: 'Alice A' });
  });

  test('falls back to the email when the provider sends no preferred_username', () => {
    const user = mapProfileToUser({ email: 'Carol@Example.com' });

    expect(user).toEqual({
      username: 'carol@example.com',
      displayUsername: 'carol@example.com',
      name: 'carol@example.com',
    });
  });

  test('gives a user without an email a placeholder address derived from the subject', () => {
    const user = mapProfileToUser({ sub: 'subject-1', preferred_username: 'dan' });

    expect(user).toMatchObject({
      username: 'dan',
      email: expect.stringMatching(/^[0-9a-f]{32}@placeholder\.local$/),
    });
    expect(mapProfileToUser({ sub: 'subject-2' }).email).not.toBe(user.email);
  });
});

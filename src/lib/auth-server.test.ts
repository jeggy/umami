import { memoryAdapter } from 'better-auth/adapters/memory';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const ORIGIN = 'http://localhost:3000';

const state = vi.hoisted(() => ({
  db: {} as Record<string, Record<string, any>[]>,
  profile: {} as Record<string, any>,
}));

// The real configuration runs against better-auth's in-memory adapter instead of Postgres.
vi.mock('better-auth/adapters/prisma', () => ({ prismaAdapter: () => memoryAdapter(state.db) }));
vi.mock('@/lib/prisma', () => ({ default: { client: {} } }));

// The provider's endpoints are replaced, so no discovery document or token exchange is fetched.
vi.mock('@/lib/oidc', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/oidc')>();

  return {
    ...actual,
    getOidcConfig: () => ({
      ...actual.getOidcConfig(),
      discoveryUrl: undefined,
      authorizationUrl: 'https://idp.example/authorize',
      tokenUrl: 'https://idp.example/token',
      getToken: async () => ({ accessToken: 'access-token', tokenType: 'bearer' }),
      // A custom getUserInfo has to supply the id that better-auth otherwise takes from sub.
      getUserInfo: async () => ({ id: state.profile.sub, ...state.profile }),
    }),
  };
});

async function createAuth() {
  vi.resetModules();
  delete globalThis['better-auth-instance'];
  const { getAuth } = await import('./auth-server');

  return getAuth();
}

/** Starts a provider sign-in from the login page and returns where the provider's answer leads. */
async function signInWithProvider(profile: Record<string, any>, answer = 'code=code') {
  state.profile = profile;
  const auth = await createAuth();

  const start = await auth.handler(
    new Request(`${ORIGIN}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ provider: 'oidc', callbackURL: '/', errorCallbackURL: '/login' }),
    }),
  );
  const { url } = await start.json();
  const cookie = start.headers
    .getSetCookie()
    .map(value => value.split(';')[0])
    .join('; ');

  const callback = await auth.handler(
    new Request(
      `${ORIGIN}/api/auth/callback/oidc?${answer}&state=${new URL(url).searchParams.get('state')}`,
      { headers: { cookie } },
    ),
  );

  return new URL(callback.headers.get('location'), ORIGIN);
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('APP_SECRET', 'test-secret');
  vi.stubEnv('CLOUD_MODE', '');
  vi.stubEnv('REDIS_URL', '');
  vi.stubEnv('OIDC_DISCOVERY_URL', 'https://idp.example/.well-known/openid-configuration');
  vi.stubEnv('OIDC_CLIENT_ID', 'umami');
  vi.stubEnv('OIDC_CLIENT_SECRET', 'secret');
  vi.stubEnv('OIDC_DISABLE_SIGNUP', '');

  state.db = {
    user: [
      {
        id: 'local-user',
        username: 'alice',
        displayUsername: 'alice',
        displayName: 'alice',
        email: 'local-user@placeholder.local',
        emailVerified: false,
        role: 'user',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    account: [],
    authSession: [],
    verification: [],
  };
});

describe('provider sign-in errors', () => {
  test('a provider username that a local user holds returns to the login page without a new user', async () => {
    const location = await signInWithProvider({
      sub: 'subject-1',
      preferred_username: 'Alice',
      email: 'alice@example.com',
      email_verified: true,
    });

    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('error')).toBe('USERNAME_IS_ALREADY_TAKEN');
    expect(state.db.user).toHaveLength(1);
  });

  test('an unknown user returns to the login page when sign-up is disabled', async () => {
    vi.stubEnv('OIDC_DISABLE_SIGNUP', '1');

    const location = await signInWithProvider({
      sub: 'subject-2',
      preferred_username: 'bob',
      email: 'bob@example.com',
    });

    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('error')).toBe('signup_disabled');
  });

  test('a provider email address that a local user has, without a linked account, returns to the login page', async () => {
    const location = await signInWithProvider({
      sub: 'subject-3',
      preferred_username: 'carol',
      email: 'local-user@placeholder.local',
    });

    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('error')).toBe('account_not_linked');
  });

  test('an error from the provider returns to the login page with its code', async () => {
    const location = await signInWithProvider({}, 'error=access_denied');

    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('error')).toBe('access_denied');
  });

  test('a callback without a valid state returns to the login page', async () => {
    const auth = await createAuth();

    const callback = await auth.handler(
      new Request(`${ORIGIN}/api/auth/callback/oidc?code=code&state=unknown`),
    );
    const location = new URL(callback.headers.get('location'), ORIGIN);

    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('error')).toBe('state_mismatch');
  });
});

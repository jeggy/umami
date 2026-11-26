import { memoryAdapter } from 'better-auth/adapters/memory';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const ORIGIN = 'http://localhost:3000';

const state = vi.hoisted(() => ({
  db: {} as Record<string, Record<string, any>[]>,
  profile: {} as Record<string, any>,
  endSessionEndpoint: undefined as string | undefined,
  twoFactorEnabled: false,
}));

// The real configuration runs against better-auth's in-memory adapter instead of Postgres.
vi.mock('better-auth/adapters/prisma', () => ({ prismaAdapter: () => memoryAdapter(state.db) }));
vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      twoFactorAuth: { findUnique: async () => state.twoFactorEnabled && { isEnabled: true } },
    },
  },
}));
vi.mock('@/lib/two-factor/policy', () => ({ isTwoFactorSetupRequired: async () => false }));

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
      endSessionEndpoint: state.endSessionEndpoint,
      getToken: async () => ({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        idToken: 'id-token',
        tokenType: 'bearer',
      }),
      // A custom getUserInfo has to supply the id that better-auth otherwise takes from sub.
      getUserInfo: async () => ({ id: state.profile.sub, ...state.profile }),
    }),
  };
});

async function loadAuthServer() {
  vi.resetModules();
  delete globalThis['better-auth-instance'];

  return import('./auth-server');
}

async function createAuth() {
  return (await loadAuthServer()).getAuth();
}

/**
 * Starts a provider sign-in from the login page. Returns where the provider's answer leads and
 * the cookies the browser holds afterwards.
 */
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

  return {
    location: new URL(callback.headers.get('location'), ORIGIN),
    cookie: callback.headers
      .getSetCookie()
      .map(value => value.split(';')[0])
      .join('; '),
  };
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
  vi.stubEnv('OIDC_DISABLE_PROVIDER_LOGOUT', '');
  state.endSessionEndpoint = 'https://idp.example/logout';
  state.twoFactorEnabled = false;

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
    const { location } = await signInWithProvider({
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

    const { location } = await signInWithProvider({
      sub: 'subject-2',
      preferred_username: 'bob',
      email: 'bob@example.com',
    });

    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('error')).toBe('signup_disabled');
  });

  test('a provider email address that a local user has, without a linked account, returns to the login page', async () => {
    const { location } = await signInWithProvider({
      sub: 'subject-3',
      preferred_username: 'carol',
      email: 'local-user@placeholder.local',
    });

    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('error')).toBe('account_not_linked');
  });

  test('an error from the provider returns to the login page with its code', async () => {
    const { location } = await signInWithProvider({}, 'error=access_denied');

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

describe('logout', () => {
  const profile = { sub: 'subject-4', preferred_username: 'dave', email: 'dave@example.com' };

  // Without a configured base URL, better-auth falls back to window.location, which exists only
  // under jsdom. On the server it has no base URL at all.
  beforeEach(() => {
    vi.stubGlobal('window', undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function logoutRequest(cookie: string, headers: Record<string, string> = {}) {
    return new Request(`${ORIGIN}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie, ...headers },
    });
  }

  test('a provider session ends at the provider too, which sends the user back to the login page', async () => {
    const { cookie } = await signInWithProvider(profile);
    const { endUserSession } = await import('./auth-server');

    const { redirect } = await endUserSession(logoutRequest(cookie));
    const url = new URL(redirect);

    expect(`${url.origin}${url.pathname}`).toBe('https://idp.example/logout');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      id_token_hint: 'id-token',
      post_logout_redirect_uri: `${ORIGIN}/login`,
      client_id: 'umami',
    });
    expect(state.db.authSession).toHaveLength(0);
  });

  test('only the ID token of the provider is kept', async () => {
    await signInWithProvider(profile);

    expect(state.db.account).toEqual([
      expect.objectContaining({ idToken: 'id-token', accessToken: null, refreshToken: null }),
    ]);
  });

  test('the return address behind a reverse proxy is the public one', async () => {
    const { cookie } = await signInWithProvider(profile);
    const { endUserSession } = await import('./auth-server');

    const { redirect } = await endUserSession(
      logoutRequest(cookie, { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'umami.example' }),
    );

    expect(new URL(redirect).searchParams.get('post_logout_redirect_uri')).toBe(
      'https://umami.example/login',
    );
  });

  test('a password session of a user with a linked provider account ends only in Umami', async () => {
    await signInWithProvider(profile);
    const { createUserSession, endUserSession } = await import('./auth-server');
    const userId = state.db.account[0].userId;
    const { headers } = await createUserSession(
      new Request(`${ORIGIN}/api/auth/login`, { method: 'POST' }),
      userId,
    );
    const cookie = headers.getSetCookie()[0].split(';')[0];

    const { redirect } = await endUserSession(logoutRequest(cookie));

    expect(redirect).toBeUndefined();
    expect(state.db.authSession.filter(session => session.userId === userId)).toHaveLength(1);
  });

  test('a session that finished a provider sign-in with 2FA ends at the provider too', async () => {
    vi.stubEnv('TWO_FACTOR_ENCRYPTION_KEY', '0'.repeat(64));
    state.twoFactorEnabled = true;
    const { location } = await signInWithProvider(profile);
    const { createUserSession, endUserSession } = await import('./auth-server');
    const { parseSecureToken } = await import('@/lib/jwt');
    const { secret } = await import('@/lib/crypto');
    // What /api/2fa/verify does with the partial token once the code is right.
    const partial = parseSecureToken(
      decodeURIComponent(location.hash.slice('#token='.length)),
      secret(),
    ) as Record<string, string>;
    const { headers } = await createUserSession(
      new Request(`${ORIGIN}/api/2fa/verify`, { method: 'POST' }),
      partial.userId,
      partial.providerId,
    );

    const { redirect } = await endUserSession(
      logoutRequest(headers.getSetCookie()[0].split(';')[0]),
    );

    expect(redirect).toMatch(/^https:\/\/idp\.example\/logout\?/);
  });

  test('a provider without an end-session endpoint ends only in Umami', async () => {
    state.endSessionEndpoint = undefined;
    const { cookie } = await signInWithProvider(profile);
    const { endUserSession } = await import('./auth-server');

    const { redirect } = await endUserSession(logoutRequest(cookie));

    expect(redirect).toBeUndefined();
    expect(state.db.authSession).toHaveLength(0);
  });

  test('OIDC_DISABLE_PROVIDER_LOGOUT=1 ends the session only in Umami', async () => {
    vi.stubEnv('OIDC_DISABLE_PROVIDER_LOGOUT', '1');
    const { cookie } = await signInWithProvider(profile);
    const { endUserSession } = await import('./auth-server');

    const { redirect } = await endUserSession(logoutRequest(cookie));

    expect(redirect).toBeUndefined();
  });
});

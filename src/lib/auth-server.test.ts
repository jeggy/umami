import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { encrypt, secret } from '@/lib/crypto';

const ORIGIN = 'http://localhost:3000';

const TEAM_A = '00000000-0000-0000-0000-00000000000a';
const TEAM_B = '00000000-0000-0000-0000-00000000000b';

const state = vi.hoisted(() => ({
  db: {} as Record<string, Record<string, any>[]>,
  teamUsers: [] as Record<string, any>[],
  providers: [] as Record<string, any>[],
  lastGroups: {} as Record<string, string[]>,
  profile: {} as Record<string, any>,
  endSessionEndpoint: undefined as string | undefined,
  twoFactorEnabled: false,
  discoveryUrls: {} as Record<string, string>,
}));

// The real configuration runs against better-auth's in-memory adapter instead of Postgres. Umami's
// own tables that a provider sign-in writes are kept in memory too.
vi.mock('better-auth/adapters/prisma', () => ({ prismaAdapter: () => memoryAdapter(state.db) }));
vi.mock('@/lib/prisma', () => {
  const sameMembership = (where: Record<string, any>) => (row: Record<string, any>) =>
    row.userId === where.userId && row.teamId === where.teamId;

  const client = {
    twoFactorAuth: { findUnique: async () => state.twoFactorEnabled && { isEnabled: true } },
    account: {
      findMany: async ({ where }) =>
        state.db.account.filter(row => row.providerId === where.providerId),
      deleteMany: async ({ where }) => {
        state.db.account = state.db.account.filter(row => row.providerId !== where.providerId);
      },
    },
    authSession: {
      deleteMany: async ({ where }) => {
        state.db.authSession = state.db.authSession.filter(
          row => row.providerId !== where.providerId,
        );
      },
    },
    oidcProvider: {
      deleteMany: async ({ where }) => {
        state.providers = state.providers.filter(row => row.slug !== where.slug);
      },
    },
    user: {
      update: async ({ where, data }) =>
        Object.assign(
          state.db.user.find(({ id }) => id === where.id),
          data,
        ),
    },
    // Every team a mapping names exists.
    team: { findMany: async ({ where }) => where.id.in.map((id: string) => ({ id })) },
    teamUser: {
      findMany: async ({ where }) =>
        state.teamUsers.filter(
          row => row.userId === where.userId && where.teamId.in.includes(row.teamId),
        ),
      create: async ({ data }) => state.teamUsers.push({ ...data }),
      updateMany: async ({ where, data }) => {
        for (const row of state.teamUsers.filter(sameMembership(where))) {
          Object.assign(row, data);
        }
      },
      deleteMany: async ({ where }) => {
        state.teamUsers = state.teamUsers.filter(row => !sameMembership(where)(row));
      },
    },
  };

  return { default: { client, transaction: (run: (tx: typeof client) => unknown) => run(client) } };
});
vi.mock('@/lib/two-factor/policy', () => ({ isTwoFactorSetupRequired: async () => false }));
vi.mock('@/queries/prisma/oidcProvider', async importOriginal => ({
  ...(await importOriginal<typeof import('@/queries/prisma/oidcProvider')>()),
  findOidcProviders: async () => state.providers,
  saveLastGroups: async (slug: string, groups: string[]) => {
    state.lastGroups[slug] = groups;
  },
}));

// The providers' endpoints are replaced, so no discovery document or token exchange is fetched.
vi.mock('@/lib/oidc', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/oidc')>();

  return {
    ...actual,
    getGenericOAuthConfig: (provider: import('@/lib/oidc').OidcProvider) => ({
      ...actual.getGenericOAuthConfig(provider),
      discoveryUrl: state.discoveryUrls[provider.slug],
      authorizationUrl: `https://${provider.slug}.example/authorize`,
      tokenUrl: `https://${provider.slug}.example/token`,
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
  // A mocked module survives resetModules, and with it the cached providers.
  (await import('@/lib/oidc')).invalidateOidcProviders();

  return import('./auth-server');
}

/** A stored provider row as findOidcProviders returns it. */
function providerRow(slug: string, fields: Record<string, any> = {}) {
  return {
    id: `provider-${slug}`,
    slug,
    name: null,
    discoveryUrl: null,
    clientId: null,
    clientSecret: null,
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

function mapping(group: string, role: string | null, teamId?: string, teamRole?: string) {
  return { group, role, teamId: teamId ?? null, teamRole: teamRole ?? null };
}

/** The Cookie header a browser sends back after a response with these headers. */
function cookiesOf(headers: Headers) {
  return headers
    .getSetCookie()
    .map(value => value.split(';')[0])
    .join('; ');
}

/**
 * Starts a provider sign-in from the login page. Returns where the provider's answer leads and
 * the cookies the browser holds afterwards.
 */
async function signInWithProvider(
  profile: Record<string, any>,
  { answer = 'code=code', provider = 'oidc' } = {},
) {
  state.profile = profile;
  const auth = await (await loadAuthServer()).getAuth();

  const start = await auth.handler(
    new Request(`${ORIGIN}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ provider, callbackURL: '/', errorCallbackURL: '/login' }),
    }),
  );
  const { url } = await start.json();
  const cookie = cookiesOf(start.headers);

  const callback = await auth.handler(
    new Request(
      `${ORIGIN}/api/auth/callback/${provider}?${answer}&state=${new URL(url).searchParams.get('state')}`,
      { headers: { cookie } },
    ),
  );

  return {
    location: new URL(callback.headers.get('location'), ORIGIN),
    cookie: cookiesOf(callback.headers),
  };
}

/**
 * Creates a session as Umami's own routes do once they have authenticated the user, and returns
 * its cookies.
 */
async function createSession(userId: string, providerId?: string) {
  const { createUserSession } = await import('./auth-server');
  const { headers } = await createUserSession(
    new Request(`${ORIGIN}/api/auth/login`, { method: 'POST' }),
    userId,
    providerId,
  );

  return cookiesOf(headers);
}

function logoutRequest(cookie: string, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/auth/logout`, {
    method: 'POST',
    headers: { cookie, ...headers },
  });
}

beforeEach(() => {
  // Without a configured base URL, better-auth falls back to window.location, which exists only
  // under jsdom. On the server it has no base URL at all.
  vi.stubGlobal('window', undefined);
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
  state.teamUsers = [];
  state.providers = [];
  state.lastGroups = {};
  state.discoveryUrls = {};

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

afterEach(() => {
  vi.unstubAllGlobals();
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
    const { location } = await signInWithProvider({}, { answer: 'error=access_denied' });

    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('error')).toBe('access_denied');
  });

  test('a callback without a valid state returns to the login page', async () => {
    const auth = await (await loadAuthServer()).getAuth();

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
    const { endUserSession } = await import('./auth-server');
    const userId = state.db.account[0].userId;
    const cookie = await createSession(userId);

    const { redirect } = await endUserSession(logoutRequest(cookie));

    expect(redirect).toBeUndefined();
    expect(state.db.authSession.filter(session => session.userId === userId)).toHaveLength(1);
  });

  test('a session that finished a provider sign-in with 2FA ends at the provider too', async () => {
    vi.stubEnv('TWO_FACTOR_ENCRYPTION_KEY', '0'.repeat(64));
    state.twoFactorEnabled = true;
    const { location } = await signInWithProvider(profile);
    const { endUserSession } = await import('./auth-server');
    const { parseSecureToken } = await import('@/lib/jwt');
    const { secret } = await import('@/lib/crypto');
    // What /api/2fa/verify does with the partial token once the code is right.
    const partial = parseSecureToken(
      decodeURIComponent(location.hash.slice('#token='.length)),
      secret(),
    ) as Record<string, string>;
    const cookie = await createSession(partial.userId, partial.providerId);

    const { redirect } = await endUserSession(logoutRequest(cookie));

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

describe('group mapping', () => {
  const profile = {
    sub: 'subject-5',
    preferred_username: 'erin',
    email: 'erin@example.com',
    groups: ['/umami-admins', '/team-a-managers'],
  };

  const mappings = [
    mapping('/umami-admins', 'admin'),
    mapping('/umami-users', 'user'),
    mapping('/team-a-members', null, TEAM_A, 'team-member'),
    mapping('/team-a-managers', null, TEAM_A, 'team-manager'),
    mapping('/team-b', null, TEAM_B, 'team-member'),
  ];

  function signedInUser() {
    return state.db.user.find(({ username }) => username === 'erin');
  }

  function membershipsOf(userId: string) {
    return Object.fromEntries(
      state.teamUsers.filter(row => row.userId === userId).map(row => [row.teamId, row.role]),
    );
  }

  beforeEach(() => {
    state.providers = [providerRow('oidc', { groupMappings: mappings })];
  });

  test('a new user gets the role and the team memberships of their groups', async () => {
    const { location } = await signInWithProvider(profile);
    const user = signedInUser();

    expect(location.pathname).toBe('/');
    expect(user.role).toBe('admin');
    expect(membershipsOf(user.id)).toEqual({ [TEAM_A]: 'team-manager' });
    expect(state.lastGroups).toEqual({ oidc: profile.groups });
  });

  test('every sign-in of a linked user follows the groups: roles are raised and lowered, memberships added and removed', async () => {
    await signInWithProvider({
      ...profile,
      groups: ['/umami-users', '/team-a-members', '/team-b'],
    });
    const user = signedInUser();
    const TEAM_C = '00000000-0000-0000-0000-00000000000c';
    state.teamUsers.push({
      id: 'membership-c',
      userId: user.id,
      teamId: TEAM_C,
      role: 'team-owner',
    });

    expect(user.role).toBe('user');
    expect(membershipsOf(user.id)).toEqual({
      [TEAM_A]: 'team-member',
      [TEAM_B]: 'team-member',
      [TEAM_C]: 'team-owner',
    });

    await signInWithProvider(profile);

    expect(signedInUser().role).toBe('admin');
    // Team B is mapped but none of its groups apply any more. No mapping names team C.
    expect(membershipsOf(user.id)).toEqual({ [TEAM_A]: 'team-manager', [TEAM_C]: 'team-owner' });

    await signInWithProvider({ ...profile, groups: ['/team-a-members'] });

    expect(signedInUser().role).toBe('user');
    expect(membershipsOf(user.id)).toEqual({ [TEAM_A]: 'team-member', [TEAM_C]: 'team-owner' });
  });

  test.each([
    ['in none of the mapped groups', { groups: ['/other'] }],
    ['without a groups claim', { groups: undefined }],
  ])('a user %s cannot sign in', async (_, groups) => {
    const { location, cookie } = await signInWithProvider({ ...profile, ...groups });

    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('error')).toBe('group_not_allowed');
    expect(cookie).not.toContain('session_token');
    expect(signedInUser()).toBeUndefined();
    expect(state.db.authSession).toHaveLength(0);
  });

  test('a linked user who left every mapped group cannot sign in and keeps no session', async () => {
    await signInWithProvider(profile);
    state.db.authSession = [];

    const { location } = await signInWithProvider({ ...profile, groups: [] });

    expect(location.searchParams.get('error')).toBe('group_not_allowed');
    expect(state.db.authSession).toHaveLength(0);
  });

  test('a local user without a linked account is never changed', async () => {
    state.db.user[0].role = 'admin';
    state.teamUsers.push({
      id: 'membership-a',
      userId: 'local-user',
      teamId: TEAM_B,
      role: 'team-owner',
    });
    await loadAuthServer();

    await createSession('local-user');
    await signInWithProvider({ ...profile, groups: ['/umami-users'] });

    expect(state.db.user[0].role).toBe('admin');
    expect(membershipsOf('local-user')).toEqual({ [TEAM_B]: 'team-owner' });
    expect(signedInUser().role).toBe('user');
  });

  test('a provider sign-in that fails after the group check grants nothing to a later session', async () => {
    // The groups pass, then the provider username collides with the local user "alice".
    const { location } = await signInWithProvider({ ...profile, preferred_username: 'Alice' });

    await createSession('local-user');

    expect(location.searchParams.get('error')).toBe('USERNAME_IS_ALREADY_TAKEN');
    expect(state.db.user[0].role).toBe('user');
    expect(membershipsOf('local-user')).toEqual({});
  });

  test('a user with 2FA gets what the groups grant only from the second step', async () => {
    vi.stubEnv('TWO_FACTOR_ENCRYPTION_KEY', '0'.repeat(64));
    state.twoFactorEnabled = true;
    const { location } = await signInWithProvider(profile);
    const user = signedInUser();
    const { parseSecureToken } = await import('@/lib/jwt');
    const { readPartialTokenGrant } = await import('@/lib/two-factor/partial-token');

    expect(location.pathname).toBe('/login/two-factor');
    expect(user.role).toBe('user');
    expect(membershipsOf(user.id)).toEqual({});

    const partial = parseSecureToken(
      decodeURIComponent(location.hash.slice('#token='.length)),
      secret(),
    ) as Record<string, any>;

    expect(readPartialTokenGrant(partial)).toEqual({
      allowed: true,
      role: 'admin',
      teams: new Map([
        [TEAM_A, 'team-manager'],
        [TEAM_B, null],
      ]),
    });
  });

  test('without mappings everyone signs in and nothing changes', async () => {
    state.providers = [];

    await signInWithProvider({ ...profile, groups: undefined });

    expect(signedInUser().role).toBe('user');
    expect(state.teamUsers).toEqual([]);
  });
});

describe('several providers', () => {
  const profile = { sub: 'subject-6', preferred_username: 'frank', email: 'frank@example.com' };

  beforeEach(() => {
    state.providers = [
      providerRow('authentik', {
        name: 'Authentik',
        discoveryUrl: 'https://authentik.example/.well-known/openid-configuration',
        clientId: 'umami-authentik',
        clientSecret: encrypt('authentik-secret', secret()),
        groupMappings: [mapping('staff', 'view-only')],
      }),
    ];
  });

  test('a stored provider signs in through its own callback with its own mapping', async () => {
    const { location } = await signInWithProvider(
      { ...profile, groups: 'staff' },
      { provider: 'authentik' },
    );

    expect(location.pathname).toBe('/');
    expect(state.db.account).toEqual([expect.objectContaining({ providerId: 'authentik' })]);
    expect(state.db.user.find(({ username }) => username === 'frank').role).toBe('view-only');
  });

  test("the environment provider's mapping does not apply to another provider", async () => {
    state.providers.push(providerRow('oidc', { groupMappings: [mapping('/umami', 'admin')] }));

    const { location } = await signInWithProvider(
      { ...profile, groups: ['staff'] },
      { provider: 'authentik' },
    );

    expect(location.pathname).toBe('/');
  });

  test('logout ends the session at the provider it came from, with that provider’s client ID', async () => {
    const { cookie } = await signInWithProvider(
      { ...profile, groups: ['staff'] },
      { provider: 'authentik' },
    );
    const { endUserSession } = await import('./auth-server');

    const { redirect } = await endUserSession(logoutRequest(cookie));

    expect(new URL(redirect).searchParams.get('client_id')).toBe('umami-authentik');
  });
});

describe('removing a provider', () => {
  const row = () =>
    providerRow('authentik', {
      discoveryUrl: 'https://authentik.example/.well-known/openid-configuration',
      clientId: 'umami-authentik',
      clientSecret: encrypt('authentik-secret', secret()),
    });

  test('ends its links and its sessions, so a new provider with its slug cannot sign in as the old user', async () => {
    state.providers = [row()];
    const profile = { sub: 'subject-8', preferred_username: 'hank', email: 'hank@example.com' };
    const { cookie } = await signInWithProvider(profile, { provider: 'authentik' });
    const hank = state.db.user.find(({ username }) => username === 'hank');
    const passwordCookie = await createSession(hank.id);
    const { getAuth, removeOidcProvider } = await import('./auth-server');

    await removeOidcProvider('authentik');
    const auth = await getAuth();

    expect(state.providers).toEqual([]);
    expect(state.db.account).toEqual([]);
    expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
    expect(
      await auth.api.getSession({ headers: new Headers({ cookie: passwordCookie }) }),
    ).toMatchObject({ user: { id: hank.id } });

    // Another issuer behind the same slug sends the same subject for someone else.
    state.providers = [row()];
    await signInWithProvider(
      { ...profile, preferred_username: 'ivy', email: 'ivy@example.com' },
      { provider: 'authentik' },
    );

    expect(state.db.account).toEqual([
      expect.objectContaining({
        userId: state.db.user.find(({ username }) => username === 'ivy').id,
      }),
    ]);
  });
});

describe('discovery', () => {
  // Answers once `answering` is set, and leaves the request hanging before.
  let answering = false;
  const server = createServer((request, response) => {
    if (answering) {
      const origin = `http://${request.headers.host}`;

      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
        }),
      );
    }
  });

  beforeAll(async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  const providerIds = async (auth: { $context: Promise<{ socialProviders: { id: string }[] }> }) =>
    (await auth.$context).socialProviders.map(({ id }) => id).sort();

  test('a provider whose discovery hangs is left off until it answers, and sign-in keeps working', async () => {
    const { port } = server.address() as AddressInfo;
    const usable = {
      clientId: 'umami',
      clientSecret: encrypt('secret', secret()),
      discoveryUrl: 'https://unused.example/.well-known/openid-configuration',
    };
    state.providers = [providerRow('hanging', usable), providerRow('authentik', usable)];
    state.discoveryUrls = { hanging: `http://127.0.0.1:${port}/.well-known/openid-configuration` };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { getAuth, getDiscoveryStatuses } = await loadAuthServer();

    const auth = await getAuth();
    const cookie = await createSession('local-user');

    expect(await providerIds(auth)).toEqual(['authentik', 'oidc']);
    expect(await getDiscoveryStatuses()).toMatchObject({ hanging: 'failed', authentik: 'ok' });
    expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).toMatchObject({
      user: { id: 'local-user' },
    });

    answering = true;
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);

    await vi.waitFor(async () =>
      expect(await providerIds(await getAuth())).toEqual(['authentik', 'hanging', 'oidc']),
    );
    expect(await getDiscoveryStatuses()).toMatchObject({ hanging: 'ok', authentik: 'ok' });
    vi.mocked(Date.now).mockRestore();
  }, 20_000);
});

describe('configuration changes', () => {
  test('a saved change builds a new instance, and the sessions stay valid', async () => {
    const { cookie } = await signInWithProvider({
      sub: 'subject-7',
      preferred_username: 'gina',
      email: 'gina@example.com',
    });
    const { getAuth } = await import('./auth-server');
    const { invalidateOidcProviders } = await import('@/lib/oidc');
    const before = await getAuth();

    expect(await getAuth()).toBe(before);

    state.providers = [providerRow('oidc', { name: 'Keycloak' })];
    invalidateOidcProviders();
    const after = await getAuth();

    expect(after).not.toBe(before);
    expect(await after.api.getSession({ headers: new Headers({ cookie }) })).toMatchObject({
      user: { username: 'gina' },
    });
  });
});

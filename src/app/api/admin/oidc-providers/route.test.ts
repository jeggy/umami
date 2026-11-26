import { beforeEach, describe, expect, test, vi } from 'vitest';
import { decrypt, secret } from '@/lib/crypto';
import { DELETE, POST as UPDATE } from './[slug]/route';
import { GET, POST } from './route';

const TEAM_A = '00000000-0000-0000-0000-00000000000a';

const state = vi.hoisted(() => ({
  user: { id: 'admin-1', isAdmin: true } as Record<string, any> | null,
  rows: [] as Record<string, any>[],
  teams: [] as string[],
}));

vi.mock('@/lib/auth', () => ({
  checkAuth: async () => state.user && { user: state.user, authType: 'session' },
}));

// The stored rows live in memory.
vi.mock('@/queries/prisma', () => ({
  getLastGroups: async () => ({
    authentik: { groups: ['staff'], signedInAt: '2026-11-26T00:00:00.000Z' },
  }),
  hasMissingTeams: async (mappings = []) =>
    mappings.some(({ teamId }) => teamId && !state.teams.includes(teamId)),
  saveOidcProvider: async (slug: string, data: Record<string, any>, mappings?: any[]) => {
    let row = state.rows.find(row => row.slug === slug);

    if (!row) {
      row = {
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
      };
      state.rows.push(row);
    }

    Object.assign(row, data);

    if (mappings) {
      row.groupMappings = mappings;
    }
  },
  deleteOidcProvider: async (slug: string) => {
    state.rows = state.rows.filter(row => row.slug !== slug);
  },
}));

vi.mock('@/queries/prisma/oidcProvider', () => ({ findOidcProviders: async () => state.rows }));

function request(method: string, path = '', body?: Record<string, unknown>) {
  return new Request(`http://localhost/api/admin/oidc-providers${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body && { body: JSON.stringify(body) }),
  });
}

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

const AUTHENTIK = {
  slug: 'authentik',
  name: 'Authentik',
  discoveryUrl: 'https://authentik.example/.well-known/openid-configuration',
  clientId: 'umami',
  clientSecret: 'top-secret',
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('APP_SECRET', 'test-secret');
  vi.stubEnv('CLOUD_MODE', '');
  for (const name of [
    'OIDC_DISCOVERY_URL',
    'OIDC_CLIENT_ID',
    'OIDC_CLIENT_SECRET',
    'OIDC_PROVIDER_NAME',
  ]) {
    vi.stubEnv(name, '');
  }
  state.user = { id: 'admin-1', isAdmin: true };
  state.rows = [];
  state.teams = [TEAM_A];
  (await import('@/lib/oidc')).invalidateOidcProviders();
});

describe('access', () => {
  test.each([
    ['a user who is not an administrator', { id: 'user-1', isAdmin: false }, 401],
    ['a request without a session', null, 401],
  ])('is refused for %s', async (_, user, status) => {
    state.user = user;

    expect((await GET(request('GET'))).status).toBe(status);
    expect((await POST(request('POST', '', AUTHENTIK))).status).toBe(status);
    expect(
      (await UPDATE(request('POST', '/authentik', { name: 'x' }), params('authentik'))).status,
    ).toBe(status);
    expect((await DELETE(request('DELETE', '/authentik'), params('authentik'))).status).toBe(
      status,
    );
    expect(state.rows).toEqual([]);
  });

  test('does not exist in cloud mode', async () => {
    vi.stubEnv('CLOUD_MODE', '1');

    expect((await GET(request('GET'))).status).toBe(404);
    expect((await POST(request('POST', '', AUTHENTIK))).status).toBe(404);
    expect((await UPDATE(request('POST', '/oidc', {}), params('oidc'))).status).toBe(404);
    expect((await DELETE(request('DELETE', '/oidc'), params('oidc'))).status).toBe(404);
  });
});

describe('client secret', () => {
  test('is stored encrypted and never returned', async () => {
    const created = await POST(request('POST', '', AUTHENTIK));
    const list = await (await GET(request('GET'))).json();

    expect(JSON.stringify(await created.clone().json())).not.toContain('top-secret');
    expect(JSON.stringify(list)).not.toContain('top-secret');
    expect(list.providers).toEqual([
      expect.objectContaining({
        slug: 'authentik',
        clientSecret: 'set',
        lastGroups: { groups: ['staff'], signedInAt: '2026-11-26T00:00:00.000Z' },
      }),
    ]);
    expect(state.rows[0].clientSecret).not.toBe('top-secret');
    expect(decrypt(state.rows[0].clientSecret, secret())).toBe('top-secret');
  });

  test('is shown as unreadable after APP_SECRET changed, until it is entered again', async () => {
    await POST(request('POST', '', AUTHENTIK));
    vi.stubEnv('APP_SECRET', 'another-secret');
    (await import('@/lib/oidc')).invalidateOidcProviders();

    const { providers } = await (await GET(request('GET'))).json();

    expect(providers[0].clientSecret).toBe('unreadable');

    const updated = await UPDATE(
      request('POST', '/authentik', { clientSecret: 'new-secret' }),
      params('authentik'),
    );

    expect((await updated.json()).clientSecret).toBe('set');
  });

  test('keeps its value when an update leaves it out', async () => {
    await POST(request('POST', '', AUTHENTIK));
    const stored = state.rows[0].clientSecret;

    await UPDATE(request('POST', '/authentik', { name: 'Renamed' }), params('authentik'));

    expect(state.rows[0]).toMatchObject({ name: 'Renamed', clientSecret: stored });
  });
});

describe('providers', () => {
  test('an environment variable wins over a stored setting, which the update leaves out', async () => {
    vi.stubEnv('OIDC_DISCOVERY_URL', 'https://idp.example/.well-known/openid-configuration');
    vi.stubEnv('OIDC_CLIENT_ID', 'umami');
    vi.stubEnv('OIDC_CLIENT_SECRET', 'env-secret');

    const response = await UPDATE(
      request('POST', '/oidc', {
        name: 'Keycloak',
        clientId: 'ignored',
        mappings: [{ group: '/umami-admins', role: 'admin', teamId: null, teamRole: null }],
      }),
      params('oidc'),
    );
    const provider = await response.json();

    expect(provider).toMatchObject({
      slug: 'oidc',
      name: 'Keycloak',
      clientId: 'umami',
      clientSecret: 'set',
      lockedBy: { clientId: 'OIDC_CLIENT_ID' },
      mappings: [{ group: '/umami-admins', role: 'admin', teamId: null, teamRole: null }],
    });
    expect(state.rows[0]).not.toHaveProperty('clientId', 'ignored');
    expect(JSON.stringify(provider)).not.toContain('env-secret');
  });

  test.each([
    ['a slug with capitals', { slug: 'Authentik' }],
    ['a reserved slug', { slug: 'credential' }],
    [
      'a team without a team role',
      { mappings: [{ group: 'a', role: null, teamId: TEAM_A, teamRole: null }] },
    ],
    [
      'an unknown role',
      { mappings: [{ group: 'a', role: 'owner', teamId: null, teamRole: null }] },
    ],
  ])('refuses %s', async (_, fields) => {
    const response = await POST(request('POST', '', { ...AUTHENTIK, ...fields }));

    expect(response.status).toBe(400);
    expect(state.rows).toEqual([]);
  });

  test('refuses a mapping to a team that does not exist', async () => {
    const mappings = [
      {
        group: 'a',
        role: null,
        teamId: '00000000-0000-0000-0000-00000000000f',
        teamRole: 'team-member',
      },
    ];

    expect((await POST(request('POST', '', { ...AUTHENTIK, mappings }))).status).toBe(400);
  });

  test('refuses a second provider with the same slug', async () => {
    await POST(request('POST', '', AUTHENTIK));

    expect((await POST(request('POST', '', AUTHENTIK))).status).toBe(400);
  });

  test('updating or deleting an unknown provider is not found', async () => {
    expect((await UPDATE(request('POST', '/nope', { name: 'x' }), params('nope'))).status).toBe(
      404,
    );
    expect((await DELETE(request('DELETE', '/nope'), params('nope'))).status).toBe(404);
  });

  test('a deleted provider is gone from the list', async () => {
    await POST(request('POST', '', AUTHENTIK));

    expect((await DELETE(request('DELETE', '/authentik'), params('authentik'))).status).toBe(200);
    expect((await (await GET(request('GET'))).json()).providers).toEqual([]);
  });
});

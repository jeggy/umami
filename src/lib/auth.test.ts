import { beforeEach, describe, expect, test, vi } from 'vitest';
import { parseToken } from '@/lib/jwt';
import { getApiKeyByHash, updateApiKeyLastUsed } from '@/queries/prisma/apiKey';
import { getShare } from '@/queries/prisma/share';
import { getUser } from '@/queries/prisma/user';
import { hashApiKey } from './api-key';
import { checkAuth, hasPermission } from './auth';

vi.hoisted(() => {
  process.env.APP_SECRET ??= 'test-app-secret';
});

const getSessionMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth-server', () => ({
  getAuth: () => ({ api: { getSession: getSessionMock } }),
}));

vi.mock('@/lib/jwt', () => ({
  parseToken: vi.fn(() => null),
}));

vi.mock('@/queries/prisma/user', () => ({
  getUser: vi.fn(),
}));

vi.mock('@/queries/prisma/share', () => ({
  getShare: vi.fn(),
}));

vi.mock('@/queries/prisma/apiKey', () => ({
  getApiKeyByHash: vi.fn(),
  updateApiKeyLastUsed: vi.fn(() => Promise.resolve()),
}));

const prismaMocks = vi.hoisted(() => ({
  findTwoFactorAuth: vi.fn(),
  findBoard: vi.fn(),
  findWebsites: vi.fn(),
  findPixels: vi.fn(),
  findLinks: vi.fn(),
  findTeamUsers: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      twoFactorAuth: { findUnique: prismaMocks.findTwoFactorAuth },
      board: { findUnique: prismaMocks.findBoard },
      website: { findMany: prismaMocks.findWebsites },
      pixel: { findMany: prismaMocks.findPixels },
      link: { findMany: prismaMocks.findLinks },
      teamUser: { findMany: prismaMocks.findTeamUsers },
    },
  },
}));

const parseTokenMock = vi.mocked(parseToken);
const getShareMock = vi.mocked(getShare);
const getUserMock = vi.mocked(getUser);
const getApiKeyByHashMock = vi.mocked(getApiKeyByHash);
const updateApiKeyLastUsedMock = vi.mocked(updateApiKeyLastUsed);

const PASSWORD_HASH = '$2b$10$currentpasswordhashvalue';

function authedRequest() {
  return new Request('http://localhost/api/test', {
    headers: { authorization: 'Bearer session-token' },
  });
}

function mockSession(session: Record<string, unknown> = {}, userId = 'user-1') {
  getSessionMock.mockResolvedValue({
    session: { token: 'session-token', userId, ...session },
    user: { id: userId },
  });
}

function mockUser(overrides: Record<string, unknown> = {}) {
  getUserMock.mockResolvedValue({
    id: 'user-1',
    username: 'bob',
    role: 'user',
    password: PASSWORD_HASH,
    ...overrides,
  } as any);
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('CLOUD_MODE', '');
  getSessionMock.mockReset();
  getSessionMock.mockResolvedValue(null);
  parseTokenMock.mockReset();
  parseTokenMock.mockReturnValue(null);
  getShareMock.mockReset();
  getUserMock.mockReset();
  getApiKeyByHashMock.mockReset();
  updateApiKeyLastUsedMock.mockClear();
  prismaMocks.findTwoFactorAuth.mockReset();
});

describe('checkAuth api keys', () => {
  const API_KEY = 'umami_abcdefghijklmnopqrstuvwxyz012345';

  function apiKeyRequest(path = '/api/websites') {
    return new Request(`http://localhost${path}`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
  }

  function mockApiKey(lastUsedAt: Date | null = null) {
    getApiKeyByHashMock.mockResolvedValue({
      id: 'key-1',
      userId: 'user-1',
      name: 'CI',
      keyHash: hashApiKey(API_KEY),
      keyPrefix: 'umami_abcdefgh',
      lastUsedAt,
      createdAt: new Date(),
    } as any);
  }

  test('authorizes a valid api key and looks it up by hash', async () => {
    mockApiKey();
    mockUser();

    const result: any = await checkAuth(apiKeyRequest());

    expect(getApiKeyByHashMock).toHaveBeenCalledWith(hashApiKey(API_KEY));
    expect(result?.user?.id).toBe('user-1');
    expect(result?.user).not.toHaveProperty('password');
    expect(result?.apiKey).toEqual({ id: 'key-1', name: 'CI' });
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  test('rejects an unknown api key', async () => {
    getApiKeyByHashMock.mockResolvedValue(null);

    const result = await checkAuth(apiKeyRequest());

    expect(result).toBeNull();
    expect(getUserMock).not.toHaveBeenCalled();
  });

  test('rejects an api key whose user no longer exists', async () => {
    mockApiKey();
    getUserMock.mockResolvedValue(null as any);

    const result = await checkAuth(apiKeyRequest());

    expect(result).toBeNull();
  });

  test('rejects api keys on sensitive routes', async () => {
    mockApiKey();
    mockUser();

    for (const path of [
      '/api/me/password',
      '/api/me/api-keys',
      '/api/me/api-keys/key-1',
      '/api/2fa/status',
      '/api/auth/logout',
      '/api/users',
      '/api/admin/users',
    ]) {
      expect(await checkAuth(apiKeyRequest(path))).toBeNull();
    }

    expect(getApiKeyByHashMock).not.toHaveBeenCalled();
  });

  test('ignores api keys in cloud mode', async () => {
    vi.stubEnv('CLOUD_MODE', '1');
    mockApiKey();
    mockUser();

    const result = await checkAuth(apiKeyRequest());

    expect(result).toBeNull();
    expect(getApiKeyByHashMock).not.toHaveBeenCalled();
    expect(getSessionMock).toHaveBeenCalled();
  });

  test('updates lastUsedAt when stale', async () => {
    mockApiKey(new Date(Date.now() - 60 * 60 * 1000));
    mockUser();

    await checkAuth(apiKeyRequest());

    expect(updateApiKeyLastUsedMock).toHaveBeenCalledWith('key-1');
  });

  test('does not update lastUsedAt when recently used', async () => {
    mockApiKey(new Date());
    mockUser();

    await checkAuth(apiKeyRequest());

    expect(updateApiKeyLastUsedMock).not.toHaveBeenCalled();
  });

  test('does not treat a session token as an api key', async () => {
    mockSession();
    mockUser();

    const result = await checkAuth(authedRequest());

    expect(result?.user?.id).toBe('user-1');
    expect(getApiKeyByHashMock).not.toHaveBeenCalled();
  });
});

describe('checkAuth sessions', () => {
  test('authorizes a request that carries a session', async () => {
    mockSession();
    mockUser();

    const result = await checkAuth(authedRequest());

    expect(result?.user?.id).toBe('user-1');
    expect(result?.authType).toBe('session');
    expect(result?.token).toBe('session-token');
  });

  test('rejects a request without a session', async () => {
    // Covers a missing cookie, an unknown bearer value and a session that was revoked, for
    // example by a password change.
    mockUser();

    const result = await checkAuth(authedRequest());

    expect(result).toBeNull();
  });

  test('rejects a session whose user has been deleted', async () => {
    // getUser filters soft-deleted users, whose sessions may still exist.
    mockSession();
    getUserMock.mockResolvedValue(null);

    expect(await checkAuth(authedRequest())).toBeNull();
  });

  test('rejects the request when the session lookup fails', async () => {
    getSessionMock.mockRejectedValue(new Error('storage unavailable'));

    expect(await checkAuth(authedRequest())).toBeNull();
  });

  test('ignores the session cookie on a state-changing request from another site', async () => {
    mockSession();
    mockUser();

    const request = (site: string, method = 'POST', headers = {}) =>
      new Request('http://localhost/api/test', {
        method,
        headers: {
          cookie: 'umami.session_token=session-token',
          'sec-fetch-site': site,
          ...headers,
        },
      });

    expect(await checkAuth(request('same-site'))).toBeNull();
    expect(await checkAuth(request('cross-site'))).toBeNull();
    expect(getSessionMock).not.toHaveBeenCalled();

    expect(await checkAuth(request('same-origin'))).not.toBeNull();
    expect(await checkAuth(request('cross-site', 'GET'))).not.toBeNull();
    // A bearer token is never sent by the browser on its own.
    expect(
      await checkAuth(request('cross-site', 'POST', { authorization: 'Bearer session-token' })),
    ).not.toBeNull();
  });

  test('does not expose the password hash on the returned user', async () => {
    mockSession();
    mockUser();

    const result = await checkAuth(authedRequest());

    expect(result?.user).not.toHaveProperty('password');
  });

  test('marks a session that must change its seeded password', async () => {
    const systemUserId = '41e2b680-648e-4b09-bcd7-3e2b10c06264';
    const systemUserPasswordHash = '$2b$10$BUli0c.muyCW1ErNJc3jL.vFRFtFJWrT8/GcR4A.sUdCznaXiqFXa';
    mockSession({}, systemUserId);
    mockUser({ id: systemUserId, password: systemUserPasswordHash });

    const result: any = await checkAuth(authedRequest());

    expect(result?.passwordChangeRequired).toBe(true);
  });
});

describe('checkAuth share tokens', () => {
  // GHSA-w2qx-g7w2-5qgj / GHSA-g4r3-g4pv-w7cx: share tokens are stateless, so the
  // share row must be re-checked or deleting a share never revokes access.
  const shareToken = {
    type: 'share',
    shareId: 'share-1',
    shareType: 1,
    websiteId: 'website-1',
    parameters: { overview: true, sessions: true },
  };

  function shareRequest() {
    return new Request('http://localhost/api/test', {
      headers: { 'x-umami-share-token': 'share-jwt', 'x-umami-share-context': '1' },
    });
  }

  beforeEach(() => {
    parseTokenMock.mockReturnValue(shareToken as any);
  });

  test('rejects a token whose share has been deleted', async () => {
    getShareMock.mockResolvedValue(null);

    expect(await checkAuth(shareRequest())).toBeNull();
    expect(getShareMock).toHaveBeenCalledWith('share-1');
  });

  test('rejects a token whose share now points at a different entity', async () => {
    getShareMock.mockResolvedValue({
      id: 'share-1',
      shareType: 1,
      entityId: 'website-2',
      parameters: {},
    } as any);

    expect(await checkAuth(shareRequest())).toBeNull();
  });

  test('rejects a token without a shareId', async () => {
    parseTokenMock.mockReturnValue({ type: 'share', websiteId: 'website-1' } as any);

    expect(await checkAuth(shareRequest())).toBeNull();
    expect(getShareMock).not.toHaveBeenCalled();
  });

  test('accepts a live share and uses its current parameters', async () => {
    getShareMock.mockResolvedValue({
      id: 'share-1',
      shareType: 1,
      entityId: 'website-1',
      parameters: { overview: true, sessions: false },
    } as any);

    const result: any = await checkAuth(shareRequest());

    expect(result?.authType).toBe('share');
    expect(result?.shareToken.websiteId).toBe('website-1');
    expect(result?.shareToken.parameters).toEqual({ overview: true, sessions: false });
  });
});

describe('checkAuth board share tokens', () => {
  // Board share tokens embed the board's entity ids when minted. Removing an entity from the
  // board, or transferring it to someone else, must take effect for tokens already issued.
  type Owned = { id: string; userId: string | null; teamId: string | null };

  function boardWith(
    websiteIds: string[],
    owner: { userId?: string; teamId?: string; ownerDeleted?: boolean },
  ) {
    return {
      type: 'mixed',
      parameters: {
        rows: [{ columns: websiteIds.map(websiteId => ({ component: { websiteId } })) }],
      },
      userId: owner.userId ?? null,
      teamId: owner.teamId ?? null,
      user: owner.userId
        ? {
            id: owner.userId,
            role: 'user',
            deletedAt: owner.ownerDeleted ? new Date() : null,
          }
        : null,
    };
  }

  function withWebsites(websites: Owned[]) {
    prismaMocks.findWebsites.mockImplementation(async ({ where }: any) =>
      websites.filter(({ id }) => where.id.in.includes(id)),
    );
  }

  async function boardShareWebsiteIds(tokenWebsiteIds: string[]) {
    parseTokenMock.mockReturnValue({
      type: 'share',
      shareId: 'share-1',
      shareType: 4,
      boardId: 'board-1',
      websiteIds: tokenWebsiteIds,
      pixelIds: [],
      linkIds: [],
    } as any);

    const result: any = await checkAuth(
      new Request('http://localhost/api/test', {
        headers: { 'x-umami-share-token': 'share-jwt', 'x-umami-share-context': '1' },
      }),
    );

    return result?.shareToken.websiteIds;
  }

  beforeEach(() => {
    getShareMock.mockResolvedValue({
      id: 'share-1',
      shareType: 4,
      entityId: 'board-1',
      parameters: {},
    } as any);
    prismaMocks.findTeamUsers.mockResolvedValue([]);
  });

  test('exposes nothing once the board owner has been deleted', async () => {
    prismaMocks.findBoard.mockResolvedValue(
      boardWith(['site-a'], { userId: 'owner-1', ownerDeleted: true }),
    );
    withWebsites([{ id: 'site-a', userId: 'owner-1', teamId: null }]);

    expect(await boardShareWebsiteIds(['site-a'])).toEqual([]);
  });

  test('drops a website that has been removed from the board', async () => {
    prismaMocks.findBoard.mockResolvedValue(boardWith(['site-b'], { userId: 'owner-1' }));
    withWebsites([
      { id: 'site-a', userId: 'owner-1', teamId: null },
      { id: 'site-b', userId: 'owner-1', teamId: null },
    ]);

    expect(await boardShareWebsiteIds(['site-a', 'site-b'])).toEqual(['site-b']);
  });

  test('drops a website transferred to another user while still on the board', async () => {
    prismaMocks.findBoard.mockResolvedValue(boardWith(['site-a', 'site-b'], { userId: 'owner-1' }));
    withWebsites([
      { id: 'site-a', userId: 'new-owner', teamId: null },
      { id: 'site-b', userId: 'owner-1', teamId: null },
    ]);

    expect(await boardShareWebsiteIds(['site-a', 'site-b'])).toEqual(['site-b']);
  });

  test('keeps a team website on a personal board only while the owner is a team member', async () => {
    prismaMocks.findBoard.mockResolvedValue(boardWith(['site-t'], { userId: 'owner-1' }));
    withWebsites([{ id: 'site-t', userId: null, teamId: 'team-1' }]);

    prismaMocks.findTeamUsers.mockResolvedValue([{ teamId: 'team-1' }]);
    expect(await boardShareWebsiteIds(['site-t'])).toEqual(['site-t']);

    prismaMocks.findTeamUsers.mockResolvedValue([]);
    expect(await boardShareWebsiteIds(['site-t'])).toEqual([]);
  });

  test('keeps only websites the team owns on a team board', async () => {
    prismaMocks.findBoard.mockResolvedValue(boardWith(['site-t', 'site-x'], { teamId: 'team-1' }));
    withWebsites([
      { id: 'site-t', userId: null, teamId: 'team-1' },
      { id: 'site-x', userId: null, teamId: 'team-2' },
    ]);

    expect(await boardShareWebsiteIds(['site-t', 'site-x'])).toEqual(['site-t']);
  });

  test('never grants a website the token was not minted with', async () => {
    prismaMocks.findBoard.mockResolvedValue(boardWith(['site-a', 'site-b'], { userId: 'owner-1' }));
    withWebsites([
      { id: 'site-a', userId: 'owner-1', teamId: null },
      { id: 'site-b', userId: 'owner-1', teamId: null },
    ]);

    expect(await boardShareWebsiteIds(['site-a'])).toEqual(['site-a']);
  });
});

describe('checkAuth required 2FA setup', () => {
  test('flags a session issued before required 2FA was set up', async () => {
    // Without this flag a password alone would grant full access to accounts the admin requires
    // to use 2FA; parseRequest uses it to limit the session to the setup routes.
    mockSession({ twoFactorSetup: true });
    mockUser();
    prismaMocks.findTwoFactorAuth.mockResolvedValue(null);

    const result: any = await checkAuth(authedRequest());

    expect(result?.user?.id).toBe('user-1');
    expect(result?.twoFactorSetupPending).toBe(true);
  });

  test('keeps a setup that was started but not confirmed restricted', async () => {
    mockSession({ twoFactorSetup: true });
    mockUser();
    prismaMocks.findTwoFactorAuth.mockResolvedValue({ isEnabled: false });

    const result: any = await checkAuth(authedRequest());

    expect(result?.twoFactorSetupPending).toBe(true);
  });

  test('lifts the restriction on the same session once 2FA is enabled', async () => {
    mockSession({ twoFactorSetup: true });
    mockUser();
    prismaMocks.findTwoFactorAuth.mockResolvedValue({ isEnabled: true });

    const result: any = await checkAuth(authedRequest());

    expect(result?.twoFactorSetupPending).toBe(false);
  });

  test('does not look up 2FA for ordinary sessions', async () => {
    mockSession();
    mockUser();

    const result: any = await checkAuth(authedRequest());

    expect(result?.twoFactorSetupPending).toBe(false);
    expect(prismaMocks.findTwoFactorAuth).not.toHaveBeenCalled();
  });
});

// Permission checks use this in plain conditions like `if (!hasPermission(...))`.
// If it returned a Promise, those conditions would always pass and grant access.
test('hasPermission returns a boolean synchronously', () => {
  expect(hasPermission('view-only', 'website:update')).toBe(false);
  expect(hasPermission('user', 'website:update')).toBe(true);
});

import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  parseRequest: vi.fn(),
  getUserByUsername: vi.fn(),
  checkPassword: vi.fn(),
  hasDefaultPassword: vi.fn(),
  findTwoFactorAuth: vi.fn(),
  createSecureToken: vi.fn(),
  secret: vi.fn(),
  getAllUserTeams: vi.fn(),
  createUserSession: vi.fn(),
  isTwoFactorConfigured: vi.fn(),
  addTeamBillingStatus: vi.fn(),
}));

vi.mock('@/lib/request', () => ({
  parseRequest: mocks.parseRequest,
}));

vi.mock('@/queries/prisma', () => ({
  getAllUserTeams: mocks.getAllUserTeams,
  getUserByUsername: mocks.getUserByUsername,
}));

vi.mock('@/lib/password', () => ({
  checkPassword: mocks.checkPassword,
  hasDefaultPassword: mocks.hasDefaultPassword,
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      twoFactorAuth: {
        findUnique: mocks.findTwoFactorAuth,
      },
    },
  },
}));

vi.mock('@/lib/jwt', () => ({
  createSecureToken: mocks.createSecureToken,
}));

vi.mock('@/lib/crypto', () => ({
  secret: mocks.secret,
}));

vi.mock('@/lib/auth-server', () => ({
  createUserSession: mocks.createUserSession,
}));

vi.mock('@/lib/two-factor/crypto', () => ({
  getTwoFactorConfigurationError: () => ({
    code: 'two-factor-error-not-configured',
    message: 'TWO_FACTOR_ENCRYPTION_KEY is missing or invalid',
  }),
  isTwoFactorConfigured: mocks.isTwoFactorConfigured,
}));

vi.mock('@/lib/load', () => ({
  addTeamBillingStatus: mocks.addTeamBillingStatus,
}));

import { POST } from './route';

beforeEach(() => {
  mocks.parseRequest.mockReset();
  mocks.getUserByUsername.mockReset();
  mocks.checkPassword.mockReset();
  mocks.hasDefaultPassword.mockReset();
  mocks.hasDefaultPassword.mockReturnValue(false);
  mocks.findTwoFactorAuth.mockReset();
  mocks.createSecureToken.mockReset();
  mocks.secret.mockReset();
  mocks.getAllUserTeams.mockReset();
  mocks.createUserSession.mockReset();
  mocks.isTwoFactorConfigured.mockReset();
  mocks.addTeamBillingStatus.mockReset();

  mocks.parseRequest.mockResolvedValue({
    body: { username: 'alice', password: 'secret' },
    error: undefined,
  });
  mocks.getUserByUsername.mockResolvedValue({
    id: 'user-1',
    username: 'alice',
    password: 'hashed-password',
    role: 'admin',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  });
  mocks.checkPassword.mockReturnValue(true);
  mocks.findTwoFactorAuth.mockResolvedValue({ userId: 'user-1', isEnabled: true });
  mocks.isTwoFactorConfigured.mockReturnValue(true);
  mocks.addTeamBillingStatus.mockResolvedValue([]);
  mocks.secret.mockReturnValue('app-secret');
  mocks.createSecureToken.mockReturnValue('partial-auth-token');
  mocks.createUserSession.mockResolvedValue({
    token: 'full-auth-token',
    headers: new Headers({ 'set-cookie': 'umami.session_token=full-auth-token' }),
  });
});

test('POST returns a configuration error instead of partial auth when 2FA is enabled but unavailable', async () => {
  mocks.isTwoFactorConfigured.mockReturnValue(false);

  const response = await POST(new Request('http://localhost/api/auth/login', { method: 'POST' }));

  expect(mocks.createSecureToken).not.toHaveBeenCalled();
  await expect(response.json()).resolves.toMatchObject({
    error: {
      code: 'two-factor-error-not-configured',
    },
  });
  expect(response.status).toBe(503);
});

test('POST opens a session and returns it as a cookie and as a token', async () => {
  // Browsers keep the cookie; API clients send the token as a bearer token.
  mocks.findTwoFactorAuth.mockResolvedValue(null);

  const response = await POST(new Request('http://localhost/api/auth/login', { method: 'POST' }));

  expect(mocks.createUserSession).toHaveBeenCalledWith(expect.any(Request), 'user-1');
  expect(response.headers.get('set-cookie')).toBe('umami.session_token=full-auth-token');
  await expect(response.json()).resolves.toMatchObject({ token: 'full-auth-token' });
});

test('POST rejects users who have no password', async () => {
  // A user who only signs in through an external provider has no credential to check.
  mocks.getUserByUsername.mockResolvedValue({ id: 'user-1', username: 'alice', password: null });

  const response = await POST(new Request('http://localhost/api/auth/login', { method: 'POST' }));

  expect(response.status).toBe(401);
  expect(mocks.checkPassword).not.toHaveBeenCalled();
  expect(mocks.createUserSession).not.toHaveBeenCalled();
});

test('POST tells the seeded administrator to change its initial password', async () => {
  // The app relies on this flag to show the password dialog right after login.
  mocks.findTwoFactorAuth.mockResolvedValue(null);
  mocks.hasDefaultPassword.mockReturnValue(true);

  const response = await POST(new Request('http://localhost/api/auth/login', { method: 'POST' }));

  expect(mocks.hasDefaultPassword).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'user-1', password: 'hashed-password' }),
  );
  await expect(response.json()).resolves.toMatchObject({
    user: { passwordChangeRequired: true },
  });
});

test('POST does not flag users whose password has been changed', async () => {
  mocks.findTwoFactorAuth.mockResolvedValue(null);

  const response = await POST(new Request('http://localhost/api/auth/login', { method: 'POST' }));

  await expect(response.json()).resolves.toMatchObject({
    user: { passwordChangeRequired: false },
  });
});

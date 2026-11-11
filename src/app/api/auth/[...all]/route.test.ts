import { beforeEach, expect, test, vi } from 'vitest';
import { GET, POST } from './route';

const mocks = vi.hoisted(() => ({
  handler: vi.fn(),
  checkAuth: vi.fn(),
  findAccount: vi.fn(),
}));
const { handler } = mocks;

vi.mock('@/lib/auth-server', () => ({
  getAuth: () => ({ handler }),
}));

vi.mock('@/lib/auth', () => ({
  checkAuth: mocks.checkAuth,
}));

vi.mock('@/lib/prisma', () => ({
  default: { client: { account: { findUnique: mocks.findAccount } } },
}));

function call(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) {
  const request = new Request(`http://localhost/api/auth/${path}`, {
    method,
    ...(body && { body: JSON.stringify(body) }),
  });

  return method === 'GET' ? GET(request) : POST(request);
}

beforeEach(() => {
  handler.mockReset();
  handler.mockResolvedValue(new Response(null, { status: 200 }));
  mocks.checkAuth.mockReset();
  mocks.checkAuth.mockResolvedValue({ authType: 'session', twoFactorSetupPending: false });
  mocks.findAccount.mockReset();
  mocks.findAccount.mockResolvedValue({ id: 'account-1', providerId: 'oidc' });
});

test.each([
  ['POST', 'sign-in/social'],
  ['GET', 'callback/oidc'],
  ['POST', 'link-social'],
  ['GET', 'list-accounts'],
  ['POST', 'unlink-account'],
  ['POST', 'sso/verify'],
] as const)('%s %s reaches better-auth', async (method, path) => {
  const response = await call(method, path);

  expect(handler).toHaveBeenCalledTimes(1);
  expect(response.status).toBe(200);
});

// These would sign a user in without the 2FA step, or change accounts without Umami's
// permission checks.
test.each([
  ['POST', 'sign-in/username'],
  ['POST', 'sign-in/email'],
  ['POST', 'sign-up/email'],
  ['POST', 'update-user'],
  ['POST', 'change-password'],
  ['POST', 'sign-out'],
  ['GET', 'get-session'],
  ['GET', 'list-sessions'],
  ['GET', 'admin/list-users'],
  ['GET', 'callbackx'],
] as const)('%s %s is not exposed', async (method, path) => {
  const response = await call(method, path);

  expect(handler).not.toHaveBeenCalled();
  expect(response.status).toBe(404);
});

// An ID token would create a session without the provider redirect, and so without the 2FA step.
test.each(['sign-in/social', 'link-social'])('POST %s rejects an ID token', async path => {
  const response = await call('POST', path, { provider: 'oidc', idToken: { token: 'jwt' } });

  expect(handler).not.toHaveBeenCalled();
  expect(response.status).toBe(400);
});

test.each([
  ['POST', 'link-social'],
  ['GET', 'list-accounts'],
  ['POST', 'unlink-account'],
] as const)('%s %s requires a full session', async (method, path) => {
  mocks.checkAuth.mockResolvedValue(null);
  expect((await call(method, path)).status).toBe(401);

  mocks.checkAuth.mockResolvedValue({ authType: 'session', twoFactorSetupPending: true });
  expect((await call(method, path)).status).toBe(401);

  expect(handler).not.toHaveBeenCalled();
});

test('POST unlink-account does not remove the password account', async () => {
  mocks.findAccount.mockResolvedValue({ id: 'account-2', providerId: 'credential' });

  const response = await call('POST', 'unlink-account', { accountId: 'account-2' });

  expect(handler).not.toHaveBeenCalled();
  expect(response.status).toBe(400);
});

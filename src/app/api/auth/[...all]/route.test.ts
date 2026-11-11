import { beforeEach, expect, test, vi } from 'vitest';
import { GET, POST } from './route';

const handler = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth-server', () => ({
  getAuth: () => ({ handler }),
}));

function call(method: 'GET' | 'POST', path: string) {
  const request = new Request(`http://localhost/api/auth/${path}`, { method });

  return method === 'GET' ? GET(request) : POST(request);
}

beforeEach(() => {
  handler.mockReset();
  handler.mockResolvedValue(new Response(null, { status: 200 }));
});

test('POST sso/verify reaches better-auth', async () => {
  const response = await call('POST', 'sso/verify');

  expect(handler).toHaveBeenCalledTimes(1);
  expect(response.status).toBe(200);
});

// These would sign a user in without the 2FA step, or change accounts without Umami's
// permission checks.
test.each([
  ['POST', 'sign-in/username'],
  ['POST', 'sign-in/email'],
  ['POST', 'sign-in/social'],
  ['POST', 'sign-up/email'],
  ['POST', 'update-user'],
  ['POST', 'change-password'],
  ['POST', 'sign-out'],
  ['GET', 'get-session'],
  ['GET', 'list-sessions'],
  ['GET', 'list-accounts'],
  ['POST', 'unlink-account'],
  ['GET', 'sso/verifyx'],
] as const)('%s %s is not exposed', async (method, path) => {
  const response = await call(method, path);

  expect(handler).not.toHaveBeenCalled();
  expect(response.status).toBe(404);
});

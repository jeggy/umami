import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { checkAuth } from '@/lib/auth';
import { AUTH_SESSION_TTL } from '@/lib/constants';
import { createUserSession, getAuth, refreshUserSession, withClientIp } from './auth-server';

vi.hoisted(() => {
  process.env.APP_SECRET ??= 'test-app-secret';
});

// A real better-auth instance on an in-memory database, so the tests see which writes and
// cookies better-auth itself produces.
const db = vi.hoisted(() => ({
  user: [] as Record<string, any>[],
  authSession: [] as Record<string, any>[],
  account: [] as Record<string, any>[],
  verification: [] as Record<string, any>[],
}));

vi.mock('better-auth/adapters/prisma', async () => {
  const { memoryAdapter } = await import('better-auth/adapters/memory');
  return { prismaAdapter: () => memoryAdapter(db) };
});

vi.mock('@/lib/prisma', () => ({
  default: { client: { twoFactorAuth: { findUnique: async () => null } } },
}));

vi.mock('@/lib/redis', () => ({ default: { enabled: false } }));

vi.mock('@/lib/two-factor/policy', () => ({ isTwoFactorSetupRequired: async () => false }));

vi.mock('@/queries/prisma/oidcProvider', () => ({ findOidcProviders: async () => [] }));

vi.mock('@/queries/prisma/user', () => ({
  getUser: async (id: string) => {
    const user = db.user.find(row => row.id === id);
    return user && { ...user, role: 'user', password: null };
  },
}));

const DAY = 24 * 60 * 60 * 1000;

const USER_ID = 'user-1';

afterEach(() => {
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  for (const rows of Object.values(db)) {
    rows.length = 0;
  }

  db.user.push({
    id: USER_ID,
    email: 'someone@example.com',
    emailVerified: false,
    name: 'Someone',
    username: 'someone',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

function sessionCookie(headers: Headers) {
  return headers.getSetCookie().find(cookie => cookie.includes('.session_token='));
}

async function signIn(init: RequestInit = {}, create = createUserSession) {
  const request = new Request('http://localhost/api/auth/login', { method: 'POST', ...init });
  const { token, headers } = await create(request, USER_ID);

  return { token, cookie: sessionCookie(headers).split(';')[0], setCookie: sessionCookie(headers) };
}

async function setExpiry(token: string, expiresAt: Date) {
  const ctx = await (await getAuth()).$context;
  await ctx.internalAdapter.updateSession(token, { expiresAt });
}

async function storedExpiry(token: string) {
  const ctx = await (await getAuth()).$context;
  return (await ctx.internalAdapter.findSession(token)).session.expiresAt.getTime();
}

test('an ordinary request authenticates without extending the session', async () => {
  const { token, cookie } = await signIn();
  const nearExpiry = new Date(Date.now() + 2 * DAY);
  await setExpiry(token, nearExpiry);

  const auth = await checkAuth(new Request('http://localhost/api/me', { headers: { cookie } }));

  expect(auth.user.id).toBe(USER_ID);
  expect(await storedExpiry(token)).toBe(nearExpiry.getTime());
});

test('a session near its expiry is extended and its cookie reissued', async () => {
  const { token, cookie } = await signIn();
  await setExpiry(token, new Date(Date.now() + 2 * DAY));

  const headers = await refreshUserSession(
    new Request('http://localhost/api/auth/verify', { method: 'POST', headers: { cookie } }),
  );

  expect(await storedExpiry(token)).toBeGreaterThan(Date.now() + AUTH_SESSION_TTL * 1000 - DAY);
  expect(sessionCookie(headers)).toContain(`Max-Age=${AUTH_SESSION_TTL}`);
  expect(sessionCookie(headers).split(';')[0]).toBe(cookie);
});

test('a session refreshed within the last day is left as it is', async () => {
  const { token, cookie } = await signIn();
  const expiry = await storedExpiry(token);

  const headers = await refreshUserSession(
    new Request('http://localhost/api/auth/verify', { method: 'POST', headers: { cookie } }),
  );

  expect(sessionCookie(headers)).toBeUndefined();
  expect(await storedExpiry(token)).toBe(expiry);
});

test('a bearer token session is extended and keeps its token', async () => {
  const { token } = await signIn();
  await setExpiry(token, new Date(Date.now() + 2 * DAY));
  const authorization = `Bearer ${token}`;

  await refreshUserSession(
    new Request('http://localhost/api/auth/verify', { method: 'POST', headers: { authorization } }),
  );
  const auth = await checkAuth(
    new Request('http://localhost/api/me', { headers: { authorization } }),
  );

  expect(await storedExpiry(token)).toBeGreaterThan(Date.now() + AUTH_SESSION_TTL * 1000 - DAY);
  expect(auth.user.id).toBe(USER_ID);
});

test('any request with a bearer token extends its session once a day', async () => {
  const { token } = await signIn();
  const request = () =>
    checkAuth(
      new Request('http://localhost/api/websites', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
  const recent = await storedExpiry(token);

  expect((await request()).user.id).toBe(USER_ID);
  expect(await storedExpiry(token)).toBe(recent);

  await setExpiry(token, new Date(Date.now() + 2 * DAY));

  expect((await request()).user.id).toBe(USER_ID);
  expect(await storedExpiry(token)).toBeGreaterThan(Date.now() + AUTH_SESSION_TTL * 1000 - DAY);
});

test('a session started behind a TLS-terminating proxy gets a Secure cookie', async () => {
  const { cookie, setCookie } = await signIn({ headers: { 'x-forwarded-proto': 'https' } });
  const auth = await checkAuth(new Request('http://localhost/api/me', { headers: { cookie } }));

  expect(setCookie).toMatch(/^umami\.session_token=.*; Secure$/);
  expect(auth.user.id).toBe(USER_ID);
});

test('a session started over plain http gets a cookie without Secure', async () => {
  const { setCookie } = await signIn();

  expect(setCookie).toMatch(/^umami\.session_token=/);
  expect(setCookie).not.toMatch(/secure/i);
});

test('COOKIE_SECURE=1 sets a __Secure- cookie and reads it back', async () => {
  vi.stubEnv('COOKIE_SECURE', '1');
  vi.resetModules();

  const server = await import('./auth-server');
  const { checkAuth: check } = await import('@/lib/auth');
  const { cookie, setCookie } = await signIn({}, server.createUserSession);
  const auth = await check(new Request('http://localhost/api/me', { headers: { cookie } }));

  expect(setCookie).toMatch(/^__Secure-umami\.session_token=.*; Secure/);
  expect(auth.user.id).toBe(USER_ID);
});

// better-auth limits requests per client address, and without the resolved one it would count
// every client behind a proxy chain in one bucket.
describe('client address', () => {
  test('is taken from a proxy chain', () => {
    const headers = withClientIp(new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.2' }));

    expect(headers.get('x-umami-auth-client-ip')).toBe('203.0.113.7');
  });

  test('is never one the client sent in the internal header', () => {
    const headers = withClientIp(new Headers({ 'x-umami-auth-client-ip': '198.51.100.1' }));

    expect(headers.has('x-umami-auth-client-ip')).toBe(false);
  });
});

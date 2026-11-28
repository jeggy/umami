import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { getForcedSecureCookies, withSecureCookies } from './auth-cookies';

const COOKIE = 'umami.session_token=abc; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax';

function cookiesFor(url: string, headers: Record<string, string> = {}) {
  const response = new Headers([
    ['set-cookie', COOKIE],
    ['set-cookie', 'umami.state=xyz; Path=/'],
    ['cache-control', 'no-store'],
  ]);

  return withSecureCookies(new Request(url, { headers }), response);
}

beforeEach(() => {
  vi.stubEnv('COOKIE_SECURE', '');
  vi.stubEnv('CLOUD_URL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

test('a plain http request gets cookies without Secure', () => {
  expect(cookiesFor('http://umami.test/api/auth/login').getSetCookie()).toEqual([
    COOKIE,
    'umami.state=xyz; Path=/',
  ]);
});

test('an https request gets Secure cookies', () => {
  const headers = cookiesFor('https://umami.test/api/auth/login');

  expect(headers.getSetCookie()).toEqual([`${COOKIE}; Secure`, 'umami.state=xyz; Path=/; Secure']);
  expect(headers.get('cache-control')).toBe('no-store');
});

test('a request a TLS-terminating proxy forwarded as https gets Secure cookies', () => {
  const headers = cookiesFor('http://umami:3000/api/auth/login', {
    'x-forwarded-proto': 'https',
  });

  expect(headers.getSetCookie()).toEqual([`${COOKIE}; Secure`, 'umami.state=xyz; Path=/; Secure']);
});

test('the first protocol of a proxy chain decides', () => {
  const headers = cookiesFor('http://umami:3000/api/auth/login', {
    'x-forwarded-proto': 'http, https',
  });

  expect(headers.getSetCookie()[0]).toBe(COOKIE);
});

test('a cookie that is already Secure is left as it is', () => {
  const headers = withSecureCookies(
    new Request('https://umami.test/'),
    new Headers({ 'set-cookie': 'a=b; Secure; Path=/' }),
  );

  expect(headers.getSetCookie()).toEqual(['a=b; Secure; Path=/']);
});

test.each([
  ['1', true],
  ['true', true],
  ['0', false],
  ['false', false],
])('COOKIE_SECURE=%s decides for every request', (value, secure) => {
  vi.stubEnv('COOKIE_SECURE', value);

  expect(getForcedSecureCookies()).toBe(secure);
  // better-auth applies the forced choice itself, with the __Secure- name prefix.
  expect(cookiesFor('https://umami.test/').getSetCookie()[0]).toBe(COOKIE);
  expect(cookiesFor('http://umami.test/').getSetCookie()[0]).toBe(COOKIE);
});

test('an https CLOUD_URL forces Secure cookies', () => {
  vi.stubEnv('CLOUD_URL', 'https://cloud.umami.test');

  expect(getForcedSecureCookies()).toBe(true);
});

test('with neither variable set, each request decides', () => {
  expect(getForcedSecureCookies()).toBeUndefined();
});

import { beforeEach, expect, test, vi } from 'vitest';
import { endUserSession } from '@/lib/auth-server';
import { parseRequest } from '@/lib/request';
import { POST } from './route';

vi.mock('@/lib/auth-server', () => ({
  endUserSession: vi.fn(),
}));

vi.mock('@/lib/request', () => ({
  parseRequest: vi.fn(),
}));

const endUserSessionMock = vi.mocked(endUserSession);
const parseRequestMock = vi.mocked(parseRequest);

beforeEach(() => {
  endUserSessionMock.mockReset();
  parseRequestMock.mockReset();
});

test('POST ends the session and clears its cookie', async () => {
  parseRequestMock.mockResolvedValue({ auth: { user: { id: 'user-1' } }, error: undefined } as any);
  endUserSessionMock.mockResolvedValue({
    headers: new Headers({ 'set-cookie': 'umami.session_token=; Max-Age=0' }),
    redirect: undefined,
  });

  const request = new Request('http://localhost/api/auth/logout', { method: 'POST' });
  const response = await POST(request);

  expect(endUserSessionMock).toHaveBeenCalledWith(request);
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toBe('umami.session_token=; Max-Age=0');
  expect(await response.json()).toEqual({ ok: true });
});

test('POST returns where to end the provider session', async () => {
  const redirect = 'https://idp.example/logout?id_token_hint=id-token';
  parseRequestMock.mockResolvedValue({ auth: { user: { id: 'user-1' } }, error: undefined } as any);
  endUserSessionMock.mockResolvedValue({ headers: new Headers(), redirect });

  const response = await POST(new Request('http://localhost/api/auth/logout', { method: 'POST' }));

  expect(await response.json()).toEqual({ ok: true, redirect });
});

test('POST does not end a session when auth fails', async () => {
  parseRequestMock.mockResolvedValue({
    auth: null,
    error: () => new Response(null, { status: 401 }),
  } as any);

  const response = await POST(new Request('http://localhost/api/auth/logout', { method: 'POST' }));

  expect(endUserSessionMock).not.toHaveBeenCalled();
  expect(response.status).toBe(401);
});

import { beforeEach, expect, test, vi } from 'vitest';
import { createUserSession, revokeUserSessions, setUserPassword } from '@/lib/auth-server';
import { checkPassword } from '@/lib/password';
import { parseRequest } from '@/lib/request';
import { getUser } from '@/queries/prisma/user';
import { POST } from './route';

vi.mock('@/lib/request', () => ({
  parseRequest: vi.fn(),
}));

vi.mock('@/queries/prisma/user', () => ({
  getUser: vi.fn(),
}));

vi.mock('@/lib/auth-server', () => ({
  createUserSession: vi.fn(),
  revokeUserSessions: vi.fn(),
  setUserPassword: vi.fn(),
}));

vi.mock('@/lib/password', () => ({
  checkPassword: vi.fn(),
}));

const parseRequestMock = vi.mocked(parseRequest);
const getUserMock = vi.mocked(getUser);
const checkPasswordMock = vi.mocked(checkPassword);
const createUserSessionMock = vi.mocked(createUserSession);
const revokeUserSessionsMock = vi.mocked(revokeUserSessions);
const setUserPasswordMock = vi.mocked(setUserPassword);

beforeEach(() => {
  parseRequestMock.mockReset();
  getUserMock.mockReset();
  checkPasswordMock.mockReset();
  createUserSessionMock.mockReset();
  revokeUserSessionsMock.mockReset();
  setUserPasswordMock.mockReset();
});

function mockSuccessfulChange() {
  parseRequestMock.mockResolvedValue({
    auth: { user: { id: 'admin-user' } },
    body: { currentPassword: 'umami', newPassword: 'new-password' },
    error: undefined,
  } as any);
  getUserMock.mockResolvedValue({
    id: 'admin-user',
    role: 'admin',
    password: 'seeded-password',
  } as any);
  checkPasswordMock.mockReturnValue(true);
  createUserSessionMock.mockResolvedValue({
    token: 'new-session-token',
    headers: new Headers({ 'set-cookie': 'umami.session_token=new-session-token' }),
  });
}

function changePassword() {
  return POST(new Request('http://localhost/api/me/password', { method: 'POST' }));
}

test('POST keeps the user signed in with a new session', async () => {
  // Changing the password ends every existing session, including the one used here.
  mockSuccessfulChange();

  const response = await changePassword();

  expect(setUserPasswordMock).toHaveBeenCalledWith('admin-user', 'new-password');
  expect(response.headers.get('set-cookie')).toBe('umami.session_token=new-session-token');
  await expect(response.json()).resolves.toMatchObject({
    id: 'admin-user',
    token: 'new-session-token',
  });
});

test('POST ends the sessions opened with the old password before issuing the new one', async () => {
  mockSuccessfulChange();

  await changePassword();

  expect(revokeUserSessionsMock).toHaveBeenCalledWith('admin-user');
  expect(revokeUserSessionsMock.mock.invocationCallOrder[0]).toBeLessThan(
    createUserSessionMock.mock.invocationCallOrder[0],
  );
});

test('POST does not issue a session when the current password is wrong', async () => {
  mockSuccessfulChange();
  checkPasswordMock.mockReturnValue(false);

  const response = await changePassword();

  expect(response.status).toBe(400);
  expect(createUserSessionMock).not.toHaveBeenCalled();
  expect(setUserPasswordMock).not.toHaveBeenCalled();
});

// A user who only signs in through an external provider has no password to confirm.
test('POST rejects the change when the user has no password', async () => {
  mockSuccessfulChange();
  getUserMock.mockResolvedValue({ id: 'admin-user', role: 'admin', password: null } as any);

  const response = await changePassword();

  expect(response.status).toBe(400);
  expect(setUserPasswordMock).not.toHaveBeenCalled();
});

// The user can be deleted after the request was authenticated.
test('POST returns 404 when the user no longer exists', async () => {
  parseRequestMock.mockResolvedValue({
    auth: { user: { id: 'deleted-user' } },
    body: { currentPassword: 'old-password', newPassword: 'new-password' },
    error: undefined,
  } as any);
  getUserMock.mockResolvedValue(null);

  const response = await POST(new Request('http://localhost/api/me/password', { method: 'POST' }));

  expect(response.status).toBe(404);
  expect(setUserPasswordMock).not.toHaveBeenCalled();
});

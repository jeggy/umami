import { beforeEach, expect, test, vi } from 'vitest';
import { revokeUserSessions, setUserPassword } from '@/lib/auth-server';
import { parseRequest } from '@/lib/request';
import { getUser, updateUser } from '@/queries/prisma';
import { POST } from './route';

vi.mock('@/lib/auth-server', () => ({ revokeUserSessions: vi.fn(), setUserPassword: vi.fn() }));
vi.mock('@/lib/request', () => ({ parseRequest: vi.fn() }));
vi.mock('@/permissions', () => ({
  canDeleteUser: vi.fn(),
  canUpdateUser: vi.fn().mockResolvedValue(true),
  canViewUser: vi.fn(),
}));
vi.mock('@/queries/prisma', () => ({
  deleteUser: vi.fn(),
  getUser: vi.fn(),
  getUserByUsername: vi.fn(),
  updateUser: vi.fn(async (_id: string, data: any) => data),
}));

function postAs(user: { id: string; isAdmin: boolean }, body: Record<string, any>) {
  vi.mocked(parseRequest).mockResolvedValue({ auth: { user }, body, error: null } as any);

  return POST(new Request('http://localhost/api/users/user-1', { method: 'POST' }), {
    params: Promise.resolve({ userId: 'user-1' }),
  });
}

beforeEach(() => {
  vi.mocked(updateUser).mockClear();
  vi.mocked(setUserPassword).mockClear();
  vi.mocked(revokeUserSessions).mockClear();
  vi.mocked(getUser).mockResolvedValue({ id: 'user-1', username: 'user' } as any);
});

// A user changing their own password must prove they know the current one, which only
// /api/me/password checks. Otherwise a stolen session becomes a permanent account takeover.
test('a user cannot set their own password through the user-management endpoint', async () => {
  const response = await postAs({ id: 'user-1', isAdmin: false }, { password: 'new-password' });

  expect(response.status).toBe(200);
  expect(setUserPassword).not.toHaveBeenCalled();
  expect(updateUser).toHaveBeenCalledWith('user-1', {});
});

test('an admin can still set a user password', async () => {
  await postAs({ id: 'admin-1', isAdmin: true }, { password: 'new-password' });

  expect(setUserPassword).toHaveBeenCalledWith('user-1', 'new-password');
  // The user's existing sessions were opened with the old password.
  expect(revokeUserSessions).toHaveBeenCalledWith('user-1');
});

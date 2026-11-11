import { renderHook } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { httpGet } from '@/lib/fetch';
import { useApi } from './useApi';

vi.mock('@/store/app', () => ({
  useApp: (selector: (state: object) => unknown) => selector({}),
}));
vi.mock('@/lib/fetch', () => ({
  httpGet: vi.fn(async () => ({ ok: true, data: {} })),
  httpPost: vi.fn(),
  httpPut: vi.fn(),
  httpPatch: vi.fn(),
  httpDelete: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

test('does not send an authorization header', async () => {
  // The session travels in an httpOnly cookie. A bearer value sent alongside it would be read as
  // the session and replace the cookie.
  const { get } = renderHook(() => useApi()).result.current;

  await get('/me');

  expect(httpGet).toHaveBeenCalledWith(expect.any(String), {}, {});
});

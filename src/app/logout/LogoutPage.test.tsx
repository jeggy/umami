import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setUser } from '@/store/app';
import { LogoutPage } from './LogoutPage';

const post = vi.hoisted(() => vi.fn());

vi.mock('@/components/hooks', () => ({ useApi: () => ({ post }) }));
vi.mock('@/store/app', () => ({ setUser: vi.fn() }));

const location = window.location;

beforeEach(() => {
  post.mockReset();
  vi.mocked(setUser).mockReset();
  // jsdom cannot navigate, so the page's navigation is read from a plain object.
  Object.defineProperty(window, 'location', { configurable: true, value: { href: '' } });
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: location });
});

test('a user who signed in through a provider goes on to end the provider session', async () => {
  const redirect = 'https://idp.example/logout?id_token_hint=id-token';
  post.mockResolvedValue({ ok: true, redirect });

  render(<LogoutPage />);

  await waitFor(() => expect(window.location.href).toBe(redirect));
  expect(post).toHaveBeenCalledWith('/auth/logout');
  expect(setUser).toHaveBeenCalledWith(null);
});

test('any other user goes to the login page', async () => {
  post.mockResolvedValue({ ok: true });

  render(<LogoutPage />);

  await waitFor(() => expect(window.location.href).toBe('/login'));
  expect(setUser).toHaveBeenCalledWith(null);
});

test('a failed logout request still leads to the login page', async () => {
  post.mockRejectedValue(new Error('offline'));

  render(<LogoutPage />);

  await waitFor(() => expect(window.location.href).toBe('/login'));
  expect(setUser).toHaveBeenCalledWith(null);
});

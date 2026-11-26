import { beforeEach, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { LoginForm } from './LoginForm';

const mocks = vi.hoisted(() => ({ searchParams: new URLSearchParams(), post: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => mocks.searchParams,
}));

vi.mock('@/components/hooks', () => ({
  useMessages: () => ({
    t: (value: string, values?: { name?: string }) =>
      values?.name ? `${value} (${values.name})` : value,
    labels: new Proxy({}, { get: (_, key) => String(key) }),
    messages: new Proxy({}, { get: (_, key) => String(key) }),
    getErrorMessage: () => undefined,
  }),
  useUpdateQuery: () => ({ mutateAsync: vi.fn(), error: undefined }),
  useConfig: () => ({ oidcEnabled: true, oidcProviderName: 'Keycloak' }),
  useApi: () => ({ post: mocks.post }),
}));

beforeEach(() => {
  mocks.searchParams = new URLSearchParams();
  mocks.post.mockReset();
});

test.each([
  ['USERNAME_IS_ALREADY_TAKEN', 'externalAccountExists'],
  ['account_not_linked', 'externalAccountExists'],
  ['signup_disabled', 'externalSignupDisabled'],
  ['state_mismatch', 'externalLoginFailed'],
  ['access_denied', 'externalLoginFailed'],
])('explains the provider error %s', (code, message) => {
  mocks.searchParams = new URLSearchParams({ error: code });

  render(<LoginForm />);

  expect(screen.getByText(`${message} (Keycloak)`)).toBeInTheDocument();
});

test('shows no provider error without an error code', () => {
  render(<LoginForm />);

  expect(screen.queryByText(/^external/)).not.toBeInTheDocument();
});

test('reports a provider sign-in that cannot start', async () => {
  mocks.post.mockRejectedValue(new Error('discovery failed'));
  const { user } = render(<LoginForm />);

  await user.click(screen.getByText('loginWith (Keycloak)'));

  await waitFor(() =>
    expect(screen.getByText('externalLoginFailed (Keycloak)')).toBeInTheDocument(),
  );
});

import { beforeEach, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { LoginForm } from './LoginForm';

const KEYCLOAK = { slug: 'oidc', name: 'Keycloak' };
const AUTHENTIK = { slug: 'authentik', name: 'Authentik' };

const mocks = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
  post: vi.fn(),
  providers: [] as { slug: string; name: string }[],
}));

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
  useConfig: () => ({ oidcProviders: mocks.providers }),
  useApi: () => ({ post: mocks.post }),
}));

beforeEach(() => {
  mocks.searchParams = new URLSearchParams();
  mocks.post.mockReset();
  mocks.providers = [KEYCLOAK];
});

test.each([
  ['USERNAME_IS_ALREADY_TAKEN', 'externalAccountExists'],
  ['account_not_linked', 'externalAccountExists'],
  ['signup_disabled', 'externalSignupDisabled'],
  ['state_mismatch', 'externalLoginFailed'],
  ['access_denied', 'externalLoginFailed'],
  ['group_not_allowed', 'externalGroupNotAllowed'],
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

test('shows a sign-in button for each provider, which starts that provider', async () => {
  mocks.providers = [KEYCLOAK, AUTHENTIK];
  mocks.post.mockResolvedValue({ url: '#' });
  const { user } = render(<LoginForm />);

  await user.click(screen.getByText('loginWith (Authentik)'));

  expect(screen.getByText('loginWith (Keycloak)')).toBeInTheDocument();
  expect(mocks.post).toHaveBeenCalledWith(
    '/auth/sign-in/social',
    expect.objectContaining({
      provider: 'authentik',
      errorCallbackURL: '/login?provider=authentik',
    }),
  );
});

test('names the provider whose sign-in failed', () => {
  mocks.providers = [KEYCLOAK, AUTHENTIK];
  mocks.searchParams = new URLSearchParams({ error: 'signup_disabled', provider: 'authentik' });

  render(<LoginForm />);

  expect(screen.getByText('externalSignupDisabled (Authentik)')).toBeInTheDocument();
});

test('shows no sign-in button without a provider', () => {
  mocks.providers = [];

  render(<LoginForm />);

  expect(screen.queryByText(/^loginWith/)).not.toBeInTheDocument();
});

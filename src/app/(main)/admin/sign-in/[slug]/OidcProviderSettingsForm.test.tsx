import { expect, test, vi } from 'vitest';
import type { OidcProviderResponse } from '@/components/hooks';
import { render, screen } from '@/test/render';
import { OidcProviderSettingsForm } from './OidcProviderSettingsForm';

vi.mock('@/components/hooks', () => ({
  useMessages: () => ({
    t: (value: string) => value,
    getErrorMessage: () => undefined,
    labels: new Proxy({}, { get: (_, key) => String(key) }),
    messages: new Proxy({}, { get: (_, key) => String(key) }),
  }),
  useUpdateQuery: () => ({ mutateAsync: vi.fn(), isPending: false, toast: vi.fn() }),
}));

const provider: OidcProviderResponse = {
  slug: 'keycloak',
  name: 'Keycloak',
  discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
  clientId: 'umami',
  clientSecret: 'set',
  scopes: 'openid profile email',
  groupsClaim: 'groups',
  disableSignup: false,
  disableProviderLogout: false,
  mappings: [],
  lockedBy: {},
  stored: true,
  discovery: 'ok',
  lastGroups: null,
};

test('shows both addresses to register at the provider', () => {
  render(<OidcProviderSettingsForm provider={provider} />);

  expect(screen.getByLabelText('callbackUrl')).toHaveValue(
    `${window.location.origin}/api/auth/callback/keycloak`,
  );
  expect(screen.getByLabelText('postLogoutRedirectUri')).toHaveValue(
    `${window.location.origin}/login`,
  );
});

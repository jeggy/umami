import { describe, expect, test, vi } from 'vitest';
import type { OidcProviderResponse } from '@/components/hooks';
import { render, screen } from '@/test/render';
import { OidcProvidersTable } from './OidcProvidersTable';

vi.mock('@/components/hooks', () => ({
  useMessages: () => ({
    t: (value: string) => value,
    labels: {
      name: 'Name',
      providerId: 'Provider ID',
      groupMappings: 'Group mappings',
      status: 'Status',
      providerActive: 'On the login page',
      providerIncomplete: 'Incomplete',
      secretUnreadable: 'Secret unreadable',
    },
  }),
}));

function createProvider(
  slug: string,
  fields: Partial<OidcProviderResponse> = {},
): OidcProviderResponse {
  return {
    slug,
    name: slug,
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
    lastGroups: null,
    ...fields,
  };
}

describe('OidcProvidersTable', () => {
  test('links each provider and shows whether the login page offers it', () => {
    render(
      <OidcProvidersTable
        data={[
          createProvider('keycloak', {
            mappings: [{ group: '/umami-admins', role: 'admin', teamId: null, teamRole: null }],
          }),
          createProvider('authentik', { clientSecret: 'missing' }),
          createProvider('dex', { clientSecret: 'unreadable' }),
        ]}
      />,
    );

    expect(screen.getByRole('link', { name: 'keycloak' })).toHaveAttribute(
      'href',
      '/admin/sign-in/keycloak',
    );
    expect(screen.getByText('On the login page')).toBeInTheDocument();
    expect(screen.getByText('Incomplete')).toBeInTheDocument();
    expect(screen.getByText('Secret unreadable')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });
});

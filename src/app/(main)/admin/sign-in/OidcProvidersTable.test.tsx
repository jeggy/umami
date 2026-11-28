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
      providerReachable: 'Reachable',
      providerUnreachable: 'Unreachable',
      providerUnchecked: 'Not checked',
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
    discovery: 'ok',
    lastGroups: null,
    ...fields,
  };
}

describe('OidcProvidersTable', () => {
  test('links each provider and shows whether sign-in through it can work', () => {
    render(
      <OidcProvidersTable
        data={[
          createProvider('keycloak', {
            mappings: [{ group: '/umami-admins', role: 'admin', teamId: null, teamRole: null }],
          }),
          createProvider('broken', { discovery: 'failed' }),
          createProvider('fresh', { discovery: 'unchecked' }),
          createProvider('authentik', { clientSecret: 'missing', discovery: 'unchecked' }),
          createProvider('dex', { clientSecret: 'unreadable', discovery: 'unchecked' }),
        ]}
      />,
    );

    expect(screen.getByRole('link', { name: 'keycloak' })).toHaveAttribute(
      'href',
      '/admin/sign-in/keycloak',
    );
    expect(screen.getByText('Reachable')).toBeInTheDocument();
    expect(screen.getByText('Unreachable')).toBeInTheDocument();
    expect(screen.getByText('Not checked')).toBeInTheDocument();
    expect(screen.getByText('Incomplete')).toBeInTheDocument();
    expect(screen.getByText('Secret unreadable')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });
});

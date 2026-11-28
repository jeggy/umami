import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { OidcProviderResponse } from '@/components/hooks';
import { render, screen, within } from '@/test/render';
import { OidcGroupMappingsForm } from './OidcGroupMappingsForm';

const mutateAsync = vi.hoisted(() => vi.fn());
const screenSize = vi.hoisted(() => ({ isPhone: false }));

vi.mock('@/components/hooks', async importOriginal => ({
  ...(await importOriginal<object>()),
  useMessages: () => ({
    t: (value: string, values?: Record<string, string>) =>
      values ? `${value} ${JSON.stringify(values)}` : value,
    getErrorMessage: () => undefined,
    labels: new Proxy({}, { get: (_, key) => String(key) }),
    messages: new Proxy({}, { get: (_, key) => String(key) }),
  }),
  useApi: () => ({ get: vi.fn(), useQuery: () => ({ data: { data: [] } }) }),
  useMobile: () => screenSize,
  useUpdateQuery: () => ({ mutateAsync, isPending: false, toast: vi.fn() }),
}));

function createProvider(fields: Partial<OidcProviderResponse> = {}): OidcProviderResponse {
  return {
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
    lastGroups: { groups: ['/staff'], signedInAt: '2026-11-26T00:00:00.000Z' },
    ...fields,
  };
}

beforeEach(() => {
  mutateAsync.mockReset();
  screenSize.isPhone = false;
  mutateAsync.mockResolvedValue({});
});

describe('OidcGroupMappingsForm', () => {
  test('the first mapping waits for a confirmation that names who can still sign in', async () => {
    const { user } = render(<OidcGroupMappingsForm provider={createProvider()} />);

    await user.click(screen.getByRole('button', { name: 'addMapping: /staff' }));
    await user.click(screen.getByTestId('button-save-mappings'));

    expect(
      await screen.findByText('confirmFirstMapping {"name":"Keycloak","groups":"/staff"}'),
    ).toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'limitSignIn' }));

    expect(mutateAsync).toHaveBeenCalledWith(
      { mappings: [{ group: '/staff', role: null, teamId: null, teamRole: null }] },
      expect.anything(),
    );
  });

  test('cancelling the confirmation saves nothing', async () => {
    const { user } = render(<OidcGroupMappingsForm provider={createProvider()} />);

    await user.click(screen.getByRole('button', { name: 'addMapping: /staff' }));
    await user.click(screen.getByTestId('button-save-mappings'));
    await user.click(await screen.findByRole('button', { name: 'cancel' }));

    expect(mutateAsync).not.toHaveBeenCalled();
  });

  test('a provider that already has mappings saves without a confirmation', async () => {
    const { user } = render(
      <OidcGroupMappingsForm
        provider={createProvider({
          mappings: [{ group: '/admins', role: 'admin', teamId: null, teamRole: null }],
        })}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'addMapping: /staff' }));
    await user.click(screen.getByTestId('button-save-mappings'));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'limitSignIn' })).not.toBeInTheDocument();
  });

  test('on a phone each mapping is a card that labels its fields and keeps Remove in reach', async () => {
    screenSize.isPhone = true;
    const { user } = render(
      <OidcGroupMappingsForm
        provider={createProvider({
          mappings: [{ group: '/admins', role: 'admin', teamId: null, teamRole: null }],
        })}
      />,
    );

    const card = screen.getByTestId('mapping-card');

    for (const label of ['group', 'role', 'team', 'teamRole']) {
      expect(within(card).getByText(label)).toBeInTheDocument();
    }
    await user.click(within(card).getByRole('button', { name: 'remove' }));
    expect(screen.queryByTestId('mapping-card')).not.toBeInTheDocument();
  });
});

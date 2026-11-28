import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { OidcProviderAddForm, toProviderId } from './OidcProviderAddButton';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@/components/hooks', () => ({
  useMessages: () => ({
    t: (value: string) => value,
    getErrorMessage: () => undefined,
    labels: new Proxy({}, { get: (_, key) => String(key) }),
    messages: new Proxy({}, { get: (_, key) => String(key) }),
  }),
  useUpdateQuery: () => ({ mutateAsync: vi.fn(), isPending: false, toast: vi.fn() }),
}));

const field = (testId: string) => {
  const element = screen.getByTestId(testId);

  return element.matches('input') ? element : element.querySelector('input');
};

describe('toProviderId', () => {
  test.each([
    ['Keycloak', 'keycloak'],
    ['My Company SSO', 'my-company-sso'],
    ['  Zitadel (prod)  ', 'zitadel-prod'],
    ['Équipe Rouge', 'equipe-rouge'],
    ['', ''],
  ])('%j becomes %j', (name, id) => {
    expect(toProviderId(name)).toBe(id);
  });
});

describe('OidcProviderAddForm', () => {
  test('suggests the provider ID from the name until the admin types another one', async () => {
    const { user } = render(<OidcProviderAddForm onClose={vi.fn()} />);

    await user.type(field('input-name'), 'My Keycloak');
    expect(field('input-slug')).toHaveValue('my-keycloak');

    await user.clear(field('input-slug'));
    await user.type(field('input-slug'), 'kc');
    await user.type(field('input-name'), ' 2');
    expect(field('input-slug')).toHaveValue('kc');
  });

  test('says how a valid provider ID looks', async () => {
    const { user } = render(<OidcProviderAddForm onClose={vi.fn()} />);

    await user.type(field('input-name'), 'Keycloak');
    await user.clear(field('input-slug'));
    await user.type(field('input-slug'), 'Key_Cloak');
    await user.click(screen.getByTestId('button-submit'));

    expect(await screen.findByText('invalidProviderId')).toBeInTheDocument();
  });
});

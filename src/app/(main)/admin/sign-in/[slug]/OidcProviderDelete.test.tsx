import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { OidcProviderResponse } from '@/components/hooks';
import { render, screen, within } from '@/test/render';
import { OidcProviderDelete } from './OidcProviderDelete';

const state = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  error: null as Error | null,
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@/components/hooks', () => ({
  useMessages: () => ({
    t: (value: string, values?: Record<string, string>) =>
      values ? `${value} ${JSON.stringify(values)}` : value,
    getErrorMessage: (error?: Error) => error?.message,
    labels: new Proxy({}, { get: (_, key) => String(key) }),
    messages: new Proxy({}, { get: (_, key) => String(key) }),
  }),
  useDeleteQuery: () => ({
    mutateAsync: state.mutateAsync,
    isPending: false,
    error: state.error,
  }),
}));

const provider = { slug: 'keycloak', name: 'Keycloak' } as OidcProviderResponse;

beforeEach(() => {
  state.mutateAsync.mockReset();
  state.error = null;
});

describe('OidcProviderDelete', () => {
  test('names what the delete removes and keeps, and deletes only after DELETE is typed', async () => {
    const { user } = render(<OidcProviderDelete provider={provider} />);

    expect(screen.getByText('deleteProviderWarning')).toBeInTheDocument();
    await user.click(screen.getByTestId('button-delete'));

    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText('deleteProvider')).toBeInTheDocument();
    expect(
      within(dialog).getByText('confirmDeleteProvider {"name":"Keycloak"}'),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'delete' }));
    expect(state.mutateAsync).not.toHaveBeenCalled();

    await user.type(within(dialog).getByRole('textbox'), 'DELETE');
    await user.click(within(dialog).getByRole('button', { name: 'delete' }));
    expect(state.mutateAsync).toHaveBeenCalledTimes(1);
  });

  test("shows the server's error when the delete fails", async () => {
    state.error = new Error('The provider could not be removed.');
    const { user } = render(<OidcProviderDelete provider={provider} />);

    await user.click(screen.getByTestId('button-delete'));

    expect(
      await within(await screen.findByRole('dialog')).findByText(
        'The provider could not be removed.',
      ),
    ).toBeInTheDocument();
  });
});

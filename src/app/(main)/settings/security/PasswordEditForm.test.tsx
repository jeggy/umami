import { expect, test, vi } from 'vitest';
import { render, screen, userEvent, waitFor } from '@/test/render';
import { PasswordEditForm } from './PasswordEditForm';

const mockMutateAsync = vi.fn();

vi.mock('@/components/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/components/hooks')>('@/components/hooks');

  return {
    ...actual,
    useUpdateQuery: () => ({ mutateAsync: mockMutateAsync, error: null, isPending: false }),
  };
});

test('reports the change once the password is saved', async () => {
  // The response sets the new session cookie itself, so the form has nothing to store.
  mockMutateAsync.mockImplementation(async (_data, { onSuccess }) => {
    await onSuccess({ id: 'user-1', token: 'new-session-token' });
  });
  const onSave = vi.fn();

  render(<PasswordEditForm onSave={onSave} required={true} />);

  await userEvent.type(await screen.findByLabelText('Current password'), 'umami');
  await userEvent.type(screen.getByLabelText('New password'), 'new-password');
  await userEvent.type(screen.getByLabelText('Confirm password'), 'new-password');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(onSave).toHaveBeenCalled());
});

test('cannot be cancelled when the password change is required', async () => {
  render(<PasswordEditForm onSave={vi.fn()} required={true} />);

  expect(await screen.findByRole('button', { name: 'Save' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
});

import { useQueryClient } from '@tanstack/react-query';
import { Button, Column, Dialog, DialogTrigger, Modal, Text } from '@umami/react-zen';
import { useRouter } from 'next/navigation';
import { ActionForm } from '@/components/common/ActionForm';
import { TypeConfirmationForm } from '@/components/common/TypeConfirmationForm';
import { type OidcProviderResponse, useDeleteQuery, useMessages } from '@/components/hooks';

const CONFIRM_VALUE = 'DELETE';

export function OidcProviderDelete({ provider }: { provider: OidcProviderResponse }) {
  const { t, labels, messages } = useMessages();

  return (
    <ActionForm label={t(labels.deleteProvider)} description={t(messages.deleteProviderWarning)}>
      <DialogTrigger>
        <Button data-test="button-delete" variant="danger">
          {t(labels.delete)}
        </Button>
        <Modal>
          <Dialog title={t(labels.deleteProvider)} style={{ width: 400 }}>
            {({ close }) => <OidcProviderDeleteForm provider={provider} onClose={close} />}
          </Dialog>
        </Modal>
      </DialogTrigger>
    </ActionForm>
  );
}

export function OidcProviderDeleteForm({
  provider,
  onClose,
}: {
  provider: OidcProviderResponse;
  onClose: () => void;
}) {
  const { t, labels, messages } = useMessages();
  const { mutateAsync, isPending, error } = useDeleteQuery(
    `/admin/oidc-providers/${provider.slug}`,
  );
  const queryClient = useQueryClient();
  const router = useRouter();

  const handleConfirm = async () => {
    await mutateAsync(null, {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: ['oidc-providers'] });
        onClose();
        router.push('/admin/sign-in');
      },
    });
  };

  return (
    <Column gap="4">
      <Text>{t(messages.confirmDeleteProvider, { name: provider.name })}</Text>
      <TypeConfirmationForm
        confirmationValue={CONFIRM_VALUE}
        onConfirm={handleConfirm}
        onClose={onClose}
        isLoading={isPending}
        error={error}
        buttonLabel={t(labels.delete)}
        buttonVariant="danger"
      />
    </Column>
  );
}

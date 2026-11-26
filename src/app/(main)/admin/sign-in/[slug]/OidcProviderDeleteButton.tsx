import { useQueryClient } from '@tanstack/react-query';
import { AlertDialog, Button, DialogTrigger, Icon, Modal, Text } from '@umami/react-zen';
import { useRouter } from 'next/navigation';
import { type OidcProviderResponse, useDeleteQuery, useMessages } from '@/components/hooks';
import { Trash } from '@/components/icons';

export function OidcProviderDeleteButton({ provider }: { provider: OidcProviderResponse }) {
  const { t, labels, messages } = useMessages();
  const { mutateAsync } = useDeleteQuery(`/admin/oidc-providers/${provider.slug}`);
  const queryClient = useQueryClient();
  const router = useRouter();

  const handleConfirm = async () => {
    await mutateAsync();
    await queryClient.invalidateQueries({ queryKey: ['oidc-providers'] });
    router.push('/admin/sign-in');
  };

  return (
    <DialogTrigger>
      <Button data-test="button-delete">
        <Icon size="sm">
          <Trash />
        </Icon>
        <Text>{t(labels.delete)}</Text>
      </Button>
      <Modal>
        <AlertDialog
          title={t(labels.delete)}
          onConfirm={handleConfirm}
          confirmLabel={t(labels.delete)}
          cancelLabel={t(labels.cancel)}
          isDanger
          style={{ width: 400 }}
        >
          {t(messages.confirmDeleteProvider, { name: provider.name, id: provider.slug })}
        </AlertDialog>
      </Modal>
    </DialogTrigger>
  );
}

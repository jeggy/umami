import { useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Dialog,
  DialogTrigger,
  Form,
  FormButtons,
  FormField,
  FormSubmitButton,
  Icon,
  Modal,
  Text,
  TextField,
} from '@umami/react-zen';
import { useRouter } from 'next/navigation';
import { useMessages, useUpdateQuery } from '@/components/hooks';
import { Plus } from '@/components/icons';

export function OidcProviderAddButton() {
  const { t, labels } = useMessages();

  return (
    <DialogTrigger>
      <Button variant="primary" data-test="button-add-oidc-provider">
        <Icon>
          <Plus />
        </Icon>
        <Text>{t(labels.addProvider)}</Text>
      </Button>
      <Modal>
        <Dialog title={t(labels.addProvider)} style={{ width: 440 }}>
          {({ close }) => <OidcProviderAddForm onClose={close} />}
        </Dialog>
      </Modal>
    </DialogTrigger>
  );
}

function OidcProviderAddForm({ onClose }: { onClose: () => void }) {
  const { t, labels, messages, getErrorMessage } = useMessages();
  const router = useRouter();
  const { mutateAsync, error, isPending, toast } = useUpdateQuery('/admin/oidc-providers');
  const queryClient = useQueryClient();

  const handleSubmit = async ({ slug, name }: { slug: string; name: string }) => {
    await mutateAsync(
      { slug, name },
      {
        onSuccess: async () => {
          toast(t(messages.saved));
          await queryClient.invalidateQueries({ queryKey: ['oidc-providers'] });
          onClose();
          router.push(`/admin/sign-in/${slug}`);
        },
      },
    );
  };

  return (
    <Form
      onSubmit={handleSubmit}
      error={getErrorMessage(error)}
      defaultValues={{ name: '', slug: '' }}
    >
      <FormField name="name" label={t(labels.name)} rules={{ required: t(labels.required) }}>
        <TextField autoFocus autoComplete="off" placeholder="Keycloak" data-test="input-name" />
      </FormField>
      <FormField
        name="slug"
        label={t(labels.providerId)}
        description={t(messages.providerIdDescription)}
        rules={{
          required: t(labels.required),
          pattern: { value: /^[a-z0-9-]{1,50}$/, message: t(messages.invalidValue) },
        }}
      >
        <TextField autoComplete="off" placeholder="keycloak" data-test="input-slug" />
      </FormField>
      <FormButtons>
        <Button isDisabled={isPending} onPress={onClose}>
          {t(labels.cancel)}
        </Button>
        <FormSubmitButton variant="primary" isLoading={isPending} data-test="button-submit">
          {t(labels.add)}
        </FormSubmitButton>
      </FormButtons>
    </Form>
  );
}

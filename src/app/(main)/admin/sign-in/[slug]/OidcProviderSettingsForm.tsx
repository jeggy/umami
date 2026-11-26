import { useQueryClient } from '@tanstack/react-query';
import {
  Form,
  FormButtons,
  FormField,
  FormSubmitButton,
  PasswordField,
  Switch,
  TextField,
} from '@umami/react-zen';
import { useState } from 'react';
import { type OidcProviderResponse, useMessages, useUpdateQuery } from '@/components/hooks';

interface SettingsValues {
  name: string;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  groupsClaim: string;
  disableSignup: boolean;
  disableProviderLogout: boolean;
}

function toValues(provider: OidcProviderResponse): SettingsValues {
  return {
    name: provider.name,
    discoveryUrl: provider.discoveryUrl ?? '',
    clientId: provider.clientId ?? '',
    clientSecret: '',
    scopes: provider.scopes,
    groupsClaim: provider.groupsClaim,
    disableSignup: provider.disableSignup,
    disableProviderLogout: provider.disableProviderLogout,
  };
}

/** The settings to save: an empty text clears its setting, and an empty secret keeps the stored one. */
function toSettings(
  { clientSecret, groupsClaim, disableSignup, disableProviderLogout, ...text }: SettingsValues,
  lockedBy: OidcProviderResponse['lockedBy'],
) {
  const settings = {
    ...Object.fromEntries(
      Object.entries(text).map(([field, value]) => [field, value.trim() || null]),
    ),
    groupsClaim: groupsClaim.trim(),
    disableSignup,
    disableProviderLogout,
    ...(clientSecret && { clientSecret }),
  };

  return Object.fromEntries(Object.entries(settings).filter(([field]) => !(field in lockedBy)));
}

export function OidcProviderSettingsForm({ provider }: { provider: OidcProviderResponse }) {
  const { t, labels, messages, getErrorMessage } = useMessages();
  const { slug, lockedBy } = provider;
  const { mutateAsync, error, isPending, toast } = useUpdateQuery(`/admin/oidc-providers/${slug}`);
  const queryClient = useQueryClient();
  // Remounting the form after a save shows the stored values and empties the secret field.
  const [saves, setSaves] = useState(0);

  const callbackUrl = `${globalThis.location?.origin}${process.env.basePath || ''}/api/auth/callback/${slug}`;
  const lockNote = (field: keyof typeof lockedBy) =>
    lockedBy[field] && t(messages.setByEnv, { name: lockedBy[field] });

  const secretNote =
    lockNote('clientSecret') ||
    {
      set: t(messages.clientSecretStored),
      unreadable: t(messages.clientSecretUnreadable),
      missing: undefined,
    }[provider.clientSecret];

  const handleSubmit = async (values: SettingsValues) => {
    await mutateAsync(toSettings(values, lockedBy), {
      onSuccess: async () => {
        toast(t(messages.saved));
        await queryClient.invalidateQueries({ queryKey: ['oidc-providers'] });
        setSaves(saves + 1);
      },
    });
  };

  return (
    <Form
      key={saves}
      onSubmit={handleSubmit}
      error={getErrorMessage(error)}
      defaultValues={toValues(provider)}
      style={{ maxWidth: 600 }}
    >
      <TextField
        label={t(labels.callbackUrl)}
        description={t(messages.callbackUrlDescription)}
        value={callbackUrl}
        isReadOnly
        allowCopy
        data-test="input-callback-url"
      />
      <FormField
        name="name"
        label={t(labels.name)}
        description={lockNote('name')}
        rules={{ required: t(labels.required) }}
      >
        <TextField isReadOnly={!!lockedBy.name} autoComplete="off" />
      </FormField>
      <FormField
        name="discoveryUrl"
        label={t(labels.discoveryUrl)}
        description={lockNote('discoveryUrl')}
      >
        <TextField
          isReadOnly={!!lockedBy.discoveryUrl}
          autoComplete="off"
          placeholder="https://idp.example.com/realms/main/.well-known/openid-configuration"
        />
      </FormField>
      <FormField name="clientId" label={t(labels.clientId)} description={lockNote('clientId')}>
        <TextField isReadOnly={!!lockedBy.clientId} autoComplete="off" />
      </FormField>
      <FormField name="clientSecret" label={t(labels.clientSecret)} description={secretNote}>
        {lockedBy.clientSecret ? (
          <TextField placeholder="••••••••" isReadOnly />
        ) : (
          <PasswordField autoComplete="new-password" data-test="input-client-secret" />
        )}
      </FormField>
      <FormField
        name="scopes"
        label={t(labels.scopes)}
        description={lockNote('scopes') || t(messages.scopesDescription)}
      >
        <TextField isReadOnly={!!lockedBy.scopes} autoComplete="off" />
      </FormField>
      <FormField
        name="groupsClaim"
        label={t(labels.groupsClaim)}
        description={t(messages.groupsClaimDescription)}
        rules={{ required: t(labels.required) }}
      >
        <TextField autoComplete="off" />
      </FormField>
      <FormField name="disableSignup" description={lockNote('disableSignup')}>
        <Switch isDisabled={!!lockedBy.disableSignup}>{t(labels.onlyLinkedAccounts)}</Switch>
      </FormField>
      <FormField name="disableProviderLogout" description={lockNote('disableProviderLogout')}>
        <Switch isDisabled={!!lockedBy.disableProviderLogout}>
          {t(labels.keepProviderSession)}
        </Switch>
      </FormField>
      <FormButtons>
        <FormSubmitButton variant="primary" isLoading={isPending} data-test="button-submit">
          {t(labels.save)}
        </FormSubmitButton>
      </FormButtons>
    </Form>
  );
}

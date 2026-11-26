import {
  Button,
  Column,
  Form,
  FormButtons,
  FormField,
  FormSubmitButton,
  Heading,
  Icon,
  PasswordField,
  TextField,
} from '@umami/react-zen';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useApi, useConfig, useMessages, useUpdateQuery } from '@/components/hooks';
import { Logo } from '@/components/svg';
import { OIDC_PROVIDER_ID } from '@/lib/constants';
import { consumeReturnUrl } from '@/lib/return-url';
import { setUser } from '@/store/app';

// The error codes from better-auth that need more than "sign-in failed". The first two mean a
// local user already holds the provider's username or email address and has to link the account.
const EXTERNAL_LOGIN_ERRORS: Record<string, string> = {
  USERNAME_IS_ALREADY_TAKEN: 'externalAccountExists',
  account_not_linked: 'externalAccountExists',
  signup_disabled: 'externalSignupDisabled',
};

export function LoginForm() {
  const { t, labels, messages, getErrorMessage } = useMessages();
  const router = useRouter();
  const { mutateAsync, error } = useUpdateQuery('/auth/login');
  const { oidcEnabled, oidcProviderName } = useConfig();
  const { post } = useApi();
  // The provider redirects back here with an error code when the sign-in fails.
  const [externalError, setExternalError] = useState(useSearchParams().get('error'));
  const basePath = process.env.basePath || '';

  const handleExternalLogin = async () => {
    try {
      const { url } = await post('/auth/sign-in/social', {
        provider: OIDC_PROVIDER_ID,
        callbackURL: `${basePath}${consumeReturnUrl() ?? '/'}`,
        errorCallbackURL: `${basePath}/login`,
      });

      window.location.href = url;
    } catch {
      setExternalError('request_failed');
    }
  };

  const handleSubmit = async (data: any) => {
    await mutateAsync(data, {
      onSuccess: async (response: any) => {
        if (response.requiresTwoFactor) {
          sessionStorage.setItem('umami.partial-token', response.partialToken);
          router.push('/login/two-factor');
          return;
        }
        setUser(response.user);
        router.push(consumeReturnUrl() ?? '/');
      },
    });
  };

  return (
    <Column justifyContent="center" alignItems="center" gap="6">
      <Icon size="lg">
        <Logo />
      </Icon>
      <Heading>umami</Heading>
      <Form
        onSubmit={handleSubmit}
        error={
          getErrorMessage(error) ??
          (externalError
            ? t(messages[EXTERNAL_LOGIN_ERRORS[externalError] ?? 'externalLoginFailed'], {
                name: oidcProviderName,
              })
            : undefined)
        }
        defaultValues={{ username: '', password: '' }}
        style={{ minWidth: 300 }}
      >
        <FormField
          label={t(labels.username)}
          data-test="input-username"
          name="username"
          rules={{ required: t(labels.required) }}
        >
          <TextField autoComplete="username" autoFocus />
        </FormField>

        <FormField
          label={t(labels.password)}
          data-test="input-password"
          name="password"
          rules={{ required: t(labels.required) }}
        >
          <PasswordField autoComplete="current-password" />
        </FormField>
        <FormButtons>
          <FormSubmitButton
            data-test="button-submit"
            variant="primary"
            style={{ flex: 1 }}
            isDisabled={false}
          >
            {t(labels.login)}
          </FormSubmitButton>
        </FormButtons>
        {oidcEnabled && (
          <Button data-test="button-login-external" onPress={handleExternalLogin}>
            {t(labels.loginWith, { name: oidcProviderName })}
          </Button>
        )}
      </Form>
    </Column>
  );
}

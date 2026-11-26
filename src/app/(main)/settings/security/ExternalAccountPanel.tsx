'use client';
import { Button, Column, Row, Text } from '@umami/react-zen';
import { useState } from 'react';
import { Badge } from '@/components/common/Badge';
import { Panel } from '@/components/common/Panel';
import { useApi, useConfig, useLinkedAccountsQuery, useMessages } from '@/components/hooks';
import { CREDENTIAL_PROVIDER_ID } from '@/lib/constants';

function hasLinkError(slug: string) {
  if (typeof window === 'undefined') {
    return false;
  }

  const params = new URLSearchParams(window.location.search);

  return params.has('error') && params.get('provider') === slug;
}

export function ExternalAccountPanel({ provider }: { provider: { slug: string; name: string } }) {
  const { slug, name } = provider;
  const { t, labels, messages } = useMessages();
  const { oidcProviders } = useConfig();
  const { post } = useApi();
  const { data: accounts, refetch } = useLinkedAccountsQuery(true);
  // The provider redirects back here with an error code when linking fails.
  const [linkFailed, setLinkFailed] = useState(() => hasLinkError(slug));

  if (!accounts) {
    return null;
  }

  const account = accounts.find(({ providerId }) => providerId === slug);
  // Unlinking the only way to sign in would lock the user out.
  const canUnlink = accounts.some(
    ({ id, providerId }) =>
      id !== account?.id &&
      (providerId === CREDENTIAL_PROVIDER_ID ||
        oidcProviders.some(provider => provider.slug === providerId)),
  );

  const handleLink = async () => {
    const returnUrl = `${process.env.basePath || ''}/settings/security`;

    try {
      const { url } = await post('/auth/link-social', {
        provider: slug,
        callbackURL: returnUrl,
        errorCallbackURL: `${returnUrl}?provider=${encodeURIComponent(slug)}`,
      });

      window.location.href = url;
    } catch {
      setLinkFailed(true);
    }
  };

  const handleUnlink = async () => {
    await post('/auth/unlink-account', { accountId: account.id });
    await refetch();
  };

  return (
    <Panel>
      <Column gap="4">
        <Row alignItems="center" gap="3">
          <Text weight="bold">{t(labels.externalAccount, { name })}</Text>
          {account ? (
            <Badge variant="good">{t(labels.externalAccountLinked)}</Badge>
          ) : (
            <Badge variant="gray">{t(labels.externalAccountNotLinked)}</Badge>
          )}
        </Row>
        <Text>{t(messages.externalAccountDescription, { name })}</Text>
        {linkFailed && !account && (
          <Text style={{ color: 'var(--zen-status-error)' }}>
            {t(messages.externalLinkFailed, { name })}
          </Text>
        )}
        <Row>
          {account ? (
            <Button
              data-test="button-unlink-account"
              isDisabled={!canUnlink}
              onPress={handleUnlink}
            >
              {t(labels.unlinkAccount)}
            </Button>
          ) : (
            <Button data-test="button-link-account" onPress={handleLink}>
              {t(labels.linkAccount)}
            </Button>
          )}
        </Row>
      </Column>
    </Panel>
  );
}

'use client';
import { Alert, AlertDescription, AlertTitle, Column, Text } from '@umami/react-zen';
import { Empty } from '@/components/common/Empty';
import { LoadingPanel } from '@/components/common/LoadingPanel';
import { PageHeader } from '@/components/common/PageHeader';
import { Panel } from '@/components/common/Panel';
import { useMessages, useOidcProvidersQuery } from '@/components/hooks';
import { AlertTriangle, KeyRound } from '@/components/icons';
import { OidcProviderStatus } from '../OidcProviderStatus';
import { OidcGroupMappingsForm } from './OidcGroupMappingsForm';
import { OidcProviderDelete } from './OidcProviderDelete';
import { OidcProviderSettingsForm } from './OidcProviderSettingsForm';

export function OidcProviderPage({ slug }: { slug: string }) {
  const { t, labels, messages } = useMessages();
  const { data, isLoading, error } = useOidcProvidersQuery();
  const provider = data?.providers.find(provider => provider.slug === slug);

  return (
    <LoadingPanel
      data={provider}
      isLoading={isLoading}
      error={error}
      isEmpty={!provider}
      renderEmpty={() => <Empty message={t(messages.noDataAvailable)} />}
    >
      {provider && (
        <Column gap="6" margin="2">
          <PageHeader
            title={provider.name}
            titleSuffix={<OidcProviderStatus provider={provider} />}
            description={provider.slug}
            icon={<KeyRound />}
          />
          <Panel title={t(labels.settings)} gap="4">
            {provider.discovery === 'failed' && (
              <Alert data-test="alert-discovery-failed">
                <AlertTriangle />
                <AlertTitle>{t(messages.discoveryFailedTitle)}</AlertTitle>
                <AlertDescription>{t(messages.discoveryFailed)}</AlertDescription>
              </Alert>
            )}
            <OidcProviderSettingsForm provider={provider} />
          </Panel>
          <Panel title={t(labels.groupMappings)} gap="4">
            <Alert data-test="alert-group-lockout">
              <AlertTriangle />
              <AlertTitle>{t(messages.groupMappingsLockoutTitle)}</AlertTitle>
              <AlertDescription>{t(messages.groupMappingsLockout)}</AlertDescription>
            </Alert>
            <Text color="muted" style={{ maxWidth: '75ch' }}>
              {t(messages.groupMappingsDescription)}
            </Text>
            <OidcGroupMappingsForm provider={provider} />
          </Panel>
          {/* The provider from the OIDC_* variables stays as long as they are set. */}
          {provider.stored && !Object.keys(provider.lockedBy).length && (
            <Panel>
              <OidcProviderDelete provider={provider} />
            </Panel>
          )}
        </Column>
      )}
    </LoadingPanel>
  );
}

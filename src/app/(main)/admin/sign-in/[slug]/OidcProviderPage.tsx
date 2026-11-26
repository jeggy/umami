'use client';
import { Column, Text } from '@umami/react-zen';
import { Empty } from '@/components/common/Empty';
import { LoadingPanel } from '@/components/common/LoadingPanel';
import { PageHeader } from '@/components/common/PageHeader';
import { Panel } from '@/components/common/Panel';
import { useMessages, useOidcProvidersQuery } from '@/components/hooks';
import { KeyRound } from '@/components/icons';
import { OidcGroupMappingsForm } from './OidcGroupMappingsForm';
import { OidcProviderDeleteButton } from './OidcProviderDeleteButton';
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
          <PageHeader title={provider.name} description={provider.slug} icon={<KeyRound />}>
            {/* The provider from the OIDC_* variables stays as long as they are set. */}
            {provider.stored && !Object.keys(provider.lockedBy).length && (
              <OidcProviderDeleteButton provider={provider} />
            )}
          </PageHeader>
          <Panel title={t(labels.settings)} gap="4">
            <OidcProviderSettingsForm provider={provider} />
          </Panel>
          <Panel title={t(labels.groupMappings)} gap="4">
            <Text color="muted" style={{ maxWidth: '75ch' }}>
              {t(messages.groupMappingsDescription)}
            </Text>
            <OidcGroupMappingsForm provider={provider} />
          </Panel>
        </Column>
      )}
    </LoadingPanel>
  );
}

'use client';
import { Column } from '@umami/react-zen';
import { Empty } from '@/components/common/Empty';
import { LoadingPanel } from '@/components/common/LoadingPanel';
import { PageHeader } from '@/components/common/PageHeader';
import { Panel } from '@/components/common/Panel';
import { useMessages, useOidcProvidersQuery } from '@/components/hooks';
import { OidcProviderAddButton } from './OidcProviderAddButton';
import { OidcProvidersTable } from './OidcProvidersTable';

export function AdminSignInPage() {
  const { t, labels, messages } = useMessages();
  const { data, isLoading, error } = useOidcProvidersQuery();

  return (
    <Column gap="6" margin="2">
      <PageHeader title={t(labels.signIn)}>
        <OidcProviderAddButton />
      </PageHeader>
      <Panel description={t(messages.signInDescription)} gap="4">
        <LoadingPanel
          data={data?.providers}
          isLoading={isLoading}
          error={error}
          minHeight="70px"
          renderEmpty={() => <Empty message={t(messages.noOidcProviders)} />}
        >
          <OidcProvidersTable data={data?.providers} />
        </LoadingPanel>
      </Panel>
    </Column>
  );
}

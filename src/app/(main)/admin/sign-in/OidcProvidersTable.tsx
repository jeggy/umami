import { DataColumn, DataTable } from '@umami/react-zen';
import Link from '@/components/common/Link';
import { type OidcProviderResponse, useMessages } from '@/components/hooks';
import { OidcProviderStatus } from './OidcProviderStatus';

export function OidcProvidersTable({ data }: { data: OidcProviderResponse[] }) {
  const { t, labels } = useMessages();

  return (
    <DataTable data={data}>
      <DataColumn id="name" label={t(labels.name)} width="2fr">
        {(row: OidcProviderResponse) => (
          <Link href={`/admin/sign-in/${row.slug}`} data-test="link-oidc-provider">
            {row.name}
          </Link>
        )}
      </DataColumn>
      <DataColumn id="slug" label={t(labels.providerId)}>
        {(row: OidcProviderResponse) => row.slug}
      </DataColumn>
      <DataColumn id="mappings" label={t(labels.groupMappings)}>
        {(row: OidcProviderResponse) => row.mappings.length}
      </DataColumn>
      <DataColumn id="status" label={t(labels.status)} width="1.5fr">
        {(row: OidcProviderResponse) => <OidcProviderStatus provider={row} />}
      </DataColumn>
    </DataTable>
  );
}

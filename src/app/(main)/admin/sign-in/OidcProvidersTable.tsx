import { DataColumn, DataTable, StatusLight, Text } from '@umami/react-zen';
import Link from '@/components/common/Link';
import { type OidcProviderResponse, useMessages } from '@/components/hooks';

const STATUS = {
  active: { variant: 'success', label: 'providerActive' },
  incomplete: { variant: 'inactive', label: 'providerIncomplete' },
  unreadable: { variant: 'warning', label: 'secretUnreadable' },
} as const;

/** Whether the login page offers the provider, mirroring isUsable on the server. */
function getProviderStatus({ discoveryUrl, clientId, clientSecret }: OidcProviderResponse) {
  if (clientSecret === 'unreadable') {
    return 'unreadable';
  }

  return discoveryUrl && clientId && clientSecret === 'set' ? 'active' : 'incomplete';
}

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
        {(row: OidcProviderResponse) => {
          const { variant, label } = STATUS[getProviderStatus(row)];

          return (
            <StatusLight variant={variant}>
              <Text>{t(labels[label])}</Text>
            </StatusLight>
          );
        }}
      </DataColumn>
    </DataTable>
  );
}

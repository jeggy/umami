import { StatusLight, Text } from '@umami/react-zen';
import { type OidcProviderResponse, useMessages } from '@/components/hooks';

const STATUS = {
  reachable: { variant: 'success', label: 'providerReachable' },
  unreachable: { variant: 'warning', label: 'providerUnreachable' },
  unchecked: { variant: 'inactive', label: 'providerUnchecked' },
  incomplete: { variant: 'inactive', label: 'providerIncomplete' },
  unreadable: { variant: 'warning', label: 'secretUnreadable' },
} as const;

/**
 * Whether sign-in through the provider can work. The login page offers a provider once its
 * settings are complete, as isUsable on the server says, and sign-in through it fails while its
 * discovery document cannot be fetched.
 */
export function getProviderStatus({
  discoveryUrl,
  clientId,
  clientSecret,
  discovery,
}: OidcProviderResponse) {
  if (clientSecret === 'unreadable') {
    return 'unreadable';
  }

  if (!discoveryUrl || !clientId || clientSecret !== 'set') {
    return 'incomplete';
  }

  return discovery === 'ok' ? 'reachable' : discovery === 'failed' ? 'unreachable' : 'unchecked';
}

export function OidcProviderStatus({ provider }: { provider: OidcProviderResponse }) {
  const { t, labels } = useMessages();
  const { variant, label } = STATUS[getProviderStatus(provider)];

  return (
    <StatusLight variant={variant}>
      <Text>{t(labels[label])}</Text>
    </StatusLight>
  );
}

import type { OidcProviderResponse } from '@/components/hooks';

/** Whether the login page offers the provider, mirroring isUsable on the server. */
export function getProviderStatus({ discoveryUrl, clientId, clientSecret }: OidcProviderResponse) {
  if (clientSecret === 'unreadable') {
    return 'unreadable';
  }

  return discoveryUrl && clientId && clientSecret === 'set' ? 'active' : 'incomplete';
}

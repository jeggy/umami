import type { OidcProviderResponse } from '@/lib/oidc-admin';
import { useApi } from '../useApi';

export type { OidcProviderResponse };

/**
 * Every OIDC provider with its settings and group mappings, for administrators. A change
 * invalidates the query key "oidc-providers", which keeps the shown data while it reloads.
 */
export function useOidcProvidersQuery() {
  const { get, useQuery } = useApi();

  return useQuery<{ providers: OidcProviderResponse[] }>({
    queryKey: ['oidc-providers'],
    queryFn: () => get('/admin/oidc-providers'),
  });
}

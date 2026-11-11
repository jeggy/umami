import { useApi } from '../useApi';

export interface LinkedAccount {
  id: string;
  providerId: string;
  accountId: string;
}

/** The ways the current user can sign in: a password and any linked external accounts. */
export function useLinkedAccountsQuery(enabled: boolean) {
  const { get, useQuery } = useApi();

  return useQuery<LinkedAccount[]>({
    queryKey: ['linked-accounts'],
    queryFn: () => get('/auth/list-accounts'),
    enabled,
  });
}

'use client';
import { useEffect } from 'react';
import { useApi } from '@/components/hooks';
import { setUser } from '@/store/app';

export function LogoutPage() {
  const { post } = useApi();

  useEffect(() => {
    async function logout() {
      let redirect: string | undefined;

      try {
        // The session cookie goes with this request, so the server ends that session. A user who
        // signed in through a provider is sent on to end the provider's session as well.
        ({ redirect } = await post('/auth/logout'));
      } catch {
        // The local logout below must still happen if the server call fails.
      } finally {
        setUser(null);
        window.location.href = redirect || `${process.env.basePath || ''}/login`;
      }
    }

    logout();
  }, [post]);

  return null;
}

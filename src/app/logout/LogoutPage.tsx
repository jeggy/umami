'use client';
import { useEffect } from 'react';
import { useApi } from '@/components/hooks';
import { setUser } from '@/store/app';

export function LogoutPage() {
  const { post } = useApi();

  useEffect(() => {
    async function logout() {
      try {
        // The session cookie goes with this request, so the server ends that session.
        await post('/auth/logout');
      } catch {
        // The local logout below must still happen if the server call fails.
      } finally {
        setUser(null);
        window.location.href = `${process.env.basePath || ''}/login`;
      }
    }

    logout();
  }, [post]);

  return null;
}

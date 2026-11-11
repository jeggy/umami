'use client';
import { useEffect } from 'react';
import { useApi } from '@/components/hooks';
import { setUser } from '@/store/app';

export function LogoutPage() {
  const { post } = useApi();

  useEffect(() => {
    async function logout() {
      await post('/auth/logout').catch(() => undefined);

      setUser(null);

      window.location.href = `${process.env.basePath || ''}/login`;
    }

    logout();
  }, [post]);

  return null;
}

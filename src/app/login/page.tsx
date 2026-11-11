import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoginPage } from './LoginPage';

export const dynamic = 'force-dynamic';

export default async function () {
  if (process.env.DISABLE_LOGIN || process.env.CLOUD_MODE) {
    return null;
  }

  return (
    <Suspense>
      <LoginPage />
    </Suspense>
  );
}

export const metadata: Metadata = {
  title: 'Login',
};

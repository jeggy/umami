import type { Metadata } from 'next';
import { AdminSignInPage } from './AdminSignInPage';

export default function () {
  return <AdminSignInPage />;
}

export const metadata: Metadata = {
  title: 'Sign-in',
};

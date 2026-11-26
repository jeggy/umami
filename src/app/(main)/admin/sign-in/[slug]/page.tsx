import type { Metadata } from 'next';
import { OidcProviderPage } from './OidcProviderPage';

export default async function ({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  return <OidcProviderPage slug={slug} />;
}

export const metadata: Metadata = {
  title: 'Sign-in provider',
};

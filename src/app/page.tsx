'use client';
import { LAST_TEAM_CONFIG } from '@/lib/constants';
import { getItem } from '@/lib/storage';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export default function RootPage() {
  const router = useRouter();

  useEffect(() => {
    const lastTeam = getItem(LAST_TEAM_CONFIG);

    // The session cookie is httpOnly, so the page cannot tell whether the user
    // is signed in. The app redirects to /login when the session check fails.
    if (lastTeam) {
      router.replace(`/teams/${lastTeam}/websites`);
    } else {
      router.replace(`/websites`);
    }
  }, [router]);

  return null;
}

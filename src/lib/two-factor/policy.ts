import prisma from '@/lib/prisma';
import { isTwoFactorConfigured } from '@/lib/two-factor/crypto';

export type TwoFactorRequiredReason = 'global' | 'user' | 'team';

/** Returns why 2FA is required for this user (global, user or team policy), or null if it is not. */
export async function getTwoFactorRequiredReason(
  userId: string,
): Promise<TwoFactorRequiredReason | null> {
  const globalSetting = await prisma.client.appSetting.findUnique({
    where: { key: 'twoFactorRequiredGlobal' },
  });
  if (globalSetting?.value === 'true') {
    return 'global';
  }

  const userRecord = await prisma.client.user.findUnique({
    where: { id: userId },
    select: { twoFactorRequired: true },
  });
  if (userRecord?.twoFactorRequired) {
    return 'user';
  }

  const userTeams = await prisma.client.teamUser.findMany({ where: { userId } });
  const teamIds = userTeams.map(t => t.teamId);
  const teamsWithRequirement = teamIds.length
    ? await prisma.client.team.findMany({
        where: { id: { in: teamIds }, twoFactorRequired: true },
      })
    : [];
  if (teamsWithRequirement.length > 0) {
    return 'team';
  }

  return null;
}

/**
 * True when 2FA is required for this user but not set up yet. A session created in that state is
 * limited to the setup routes until enrollment completes.
 */
export async function isTwoFactorSetupRequired(userId: string): Promise<boolean> {
  // Without an encryption key users cannot set up 2FA, so restricting them would lock them out.
  if (process.env.CLOUD_MODE || !isTwoFactorConfigured()) {
    return false;
  }

  const twoFactor = await prisma.client.twoFactorAuth.findUnique({ where: { userId } });

  if (twoFactor?.isEnabled) {
    return false;
  }

  return !!(await getTwoFactorRequiredReason(userId));
}

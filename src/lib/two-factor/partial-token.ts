import { PARTIAL_AUTH_TOKEN_TYPE } from '@/lib/constants';
import { secret } from '@/lib/crypto';
import { createSecureToken } from '@/lib/jwt';
import type { GroupMappingResult } from '@/lib/oidc-groups';

/** What a provider's groups grant, in the form a token carries. */
interface GrantClaim {
  role?: GroupMappingResult['role'];
  teams: [string, string | null][];
}

/**
 * Issued once the first sign-in step has passed for a user with 2FA enabled. It is exchanged for a
 * session at /api/2fa/verify together with a TOTP or backup code. `providerId` names the external
 * provider of the first step, which the session records, and `grant` what that provider's groups
 * grant, which applies only once the second factor is right.
 */
export function createPartialToken(
  userId: string,
  providerId?: string,
  grant?: GroupMappingResult,
): string {
  const claim: GrantClaim | undefined = grant && { role: grant.role, teams: [...grant.teams] };

  return createSecureToken(
    { userId, providerId, grant: claim, type: PARTIAL_AUTH_TOKEN_TYPE },
    secret(),
    { expiresIn: '5m' },
  );
}

/** The grant of a parsed partial token, or undefined when its first step was no provider sign-in. */
export function readPartialTokenGrant(payload: { grant?: GrantClaim }) {
  const { grant } = payload;

  return (
    grant &&
    ({ allowed: true, role: grant.role, teams: new Map(grant.teams) } as GroupMappingResult)
  );
}

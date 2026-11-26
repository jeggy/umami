import { PARTIAL_AUTH_TOKEN_TYPE } from '@/lib/constants';
import { secret } from '@/lib/crypto';
import { createSecureToken } from '@/lib/jwt';

/**
 * Issued once the first sign-in step has passed for a user with 2FA enabled. It is exchanged for a
 * session at /api/2fa/verify together with a TOTP or backup code. `providerId` names the external
 * provider of the first step, which the session records.
 */
export function createPartialToken(userId: string, providerId?: string): string {
  return createSecureToken({ userId, providerId, type: PARTIAL_AUTH_TOKEN_TYPE }, secret(), {
    expiresIn: '5m',
  });
}

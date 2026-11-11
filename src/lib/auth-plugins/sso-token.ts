import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';
import { secret } from '@/lib/crypto';
import { parseToken } from '@/lib/jwt';
import redis from '@/lib/redis';

export const SSO_TOKEN_TYPE = 'sso';
export const SSO_TOKEN_TTL = 120;

/**
 * Cookie-based SSO token handoff.
 *
 * An app that shares APP_SECRET (for example the cloud app) mints a short-lived
 * JWT `{ userId, type: 'sso', jti }` signed with the same derived secret, then
 * redirects the browser to `/sso?url=<path>&token=<token>`. The SSO page posts
 * the token to `POST /api/auth/sso/verify`, which validates it, enforces
 * one-time use through Redis, and sets the session cookie.
 */
export function ssoToken() {
  return {
    id: 'sso-token',
    endpoints: {
      ssoVerify: createAuthEndpoint(
        '/sso/verify',
        {
          method: 'POST',
          body: z.object({
            token: z.string(),
          }),
        },
        async ctx => {
          if (!redis.enabled) {
            throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Redis is disabled' });
          }

          const payload = parseToken(ctx.body.token, secret()) as {
            userId?: string;
            type?: string;
            jti?: string;
          } | null;

          if (!payload || payload.type !== SSO_TOKEN_TYPE || !payload.userId || !payload.jti) {
            throw new APIError('UNAUTHORIZED', { message: 'Invalid token' });
          }

          // One-time use: a replayed token is rejected.
          const firstUse = await redis.client.setNX(`sso:${payload.jti}`, '1', SSO_TOKEN_TTL);

          if (!firstUse) {
            throw new APIError('UNAUTHORIZED', { message: 'Invalid token' });
          }

          const user = await ctx.context.internalAdapter.findUserById(payload.userId);

          if (!user || (user as any).deletedAt) {
            throw new APIError('UNAUTHORIZED', { message: 'Invalid token' });
          }

          const session = await ctx.context.internalAdapter.createSession(user.id);

          if (!session) {
            throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Failed to create session' });
          }

          await setSessionCookie(ctx, { session, user });

          return ctx.json({ success: true });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}

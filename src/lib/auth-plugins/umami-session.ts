import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';

/**
 * Lets Umami's own login routes start a better-auth session after they have
 * authenticated the user themselves (password or external provider, plus the 2FA step).
 *
 * The endpoint is server-only: it has no URL and can only be called through
 * `auth.api.createUserSession` from server code.
 */
export function umamiSession() {
  return {
    id: 'umami-session',
    endpoints: {
      createUserSession: createAuthEndpoint.serverOnly(
        {
          method: 'POST',
          body: z.object({
            userId: z.string(),
            providerId: z.string().optional(),
          }),
        },
        async ctx => {
          const user = await ctx.context.internalAdapter.findUserById(ctx.body.userId);

          if (!user || (user as any).deletedAt) {
            throw new APIError('UNAUTHORIZED', { message: 'Invalid user' });
          }

          const session = await ctx.context.internalAdapter.createSession(user.id, false, {
            providerId: ctx.body.providerId,
          });

          if (!session) {
            throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Failed to create session' });
          }

          await setSessionCookie(ctx, { session, user });

          return ctx.json({ token: session.token });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}

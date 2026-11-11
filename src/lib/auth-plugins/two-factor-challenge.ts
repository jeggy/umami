import type { BetterAuthPlugin, GenericEndpointContext } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { deleteSessionCookie } from 'better-auth/cookies';
import prisma from '@/lib/prisma';
import { isTwoFactorConfigured } from '@/lib/two-factor/crypto';
import { createPartialToken } from '@/lib/two-factor/partial-token';

const BASE_PATH = process.env.basePath || '';

/**
 * Applies Umami's 2FA step to sign-ins through an external provider.
 *
 * The provider callback has already created a session by the time this runs. For a user with 2FA
 * enabled that session is removed again, and the browser is sent to the two-factor page with the
 * same partial token that the password login returns.
 */
export function twoFactorChallenge() {
  return {
    id: 'two-factor-challenge',
    hooks: {
      after: [
        {
          matcher: context => !!context.path?.startsWith('/callback/'),
          handler: createAuthMiddleware(async ctx => {
            const data = ctx.context.newSession;

            // Linking an account to a signed-in user creates no session.
            if (!data) {
              return;
            }

            const twoFactor = await prisma.client.twoFactorAuth.findUnique({
              where: { userId: data.user.id },
            });

            if (!twoFactor?.isEnabled) {
              return;
            }

            // The cast works around context types that need strictNullChecks, which this project
            // has disabled.
            deleteSessionCookie(ctx as unknown as GenericEndpointContext, true);
            await ctx.context.internalAdapter.deleteSession(data.session.token);
            ctx.context.setNewSession(null);

            if (!isTwoFactorConfigured()) {
              throw ctx.redirect(`${BASE_PATH}/login?error=two_factor_unavailable`);
            }

            // The token travels in the URL fragment, which the browser does not send to a server.
            throw ctx.redirect(
              `${BASE_PATH}/login/two-factor#token=${encodeURIComponent(createPartialToken(data.user.id))}`,
            );
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}

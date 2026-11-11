import { type BetterAuthPlugin, betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { bearer, username } from 'better-auth/plugins';
import { ssoToken } from '@/lib/auth-plugins/sso-token';
import { umamiSession } from '@/lib/auth-plugins/umami-session';
import { AUTH_SESSION_TTL, ROLES } from '@/lib/constants';
import { secret, uuid } from '@/lib/crypto';
import { checkPassword, hashPassword } from '@/lib/password';
import prisma from '@/lib/prisma';
import redis from '@/lib/redis';
import { isTwoFactorSetupRequired } from '@/lib/two-factor/policy';

const BETTER_AUTH = 'better-auth-instance';
const REDIS_PREFIX = 'ba:';

// better-auth stores raw strings and writes some keys without a TTL, so this
// bypasses the JSON encoding and default TTL of the standard redis wrapper.
const secondaryStorage = redis.enabled
  ? {
      get: (key: string) => redis.client.getRaw(`${REDIS_PREFIX}${key}`),
      getAndDelete: (key: string) => redis.client.getDelRaw(`${REDIS_PREFIX}${key}`),
      increment: (key: string, ttl: number) =>
        redis.client.incrWithTtl(`${REDIS_PREFIX}${key}`, ttl),
      set: (key: string, value: string, ttl?: number) =>
        redis.client.setRaw(`${REDIS_PREFIX}${key}`, value, ttl).then(() => undefined),
      delete: (key: string) => redis.client.del(`${REDIS_PREFIX}${key}`).then(() => undefined),
    }
  : undefined;

function createAuth() {
  return betterAuth({
    secret: secret(),
    // The route handler restores the app base path that Next.js strips (see
    // src/app/api/auth/[...all]/route.ts).
    basePath: `${process.env.basePath || ''}/api/auth`,
    trustedOrigins: [process.env.CLOUD_URL].filter(Boolean),
    database: prismaAdapter(prisma.client, { provider: 'postgresql' }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      password: {
        // bcrypt stays the password format, so existing hashes keep verifying.
        hash: async (password: string) => hashPassword(password),
        verify: async ({ hash, password }: { hash: string; password: string }) =>
          checkPassword(password, hash),
      },
    },
    user: {
      modelName: 'user',
      fields: {
        name: 'displayName',
        image: 'logoUrl',
      },
      additionalFields: {
        // Users created by a first sign-in through an external provider.
        role: {
          type: 'string',
          defaultValue: ROLES.user,
          input: false,
        },
      },
    },
    session: {
      // The analytics visitor table owns the "session" name.
      modelName: 'authSession',
      expiresIn: AUTH_SESSION_TTL,
      // A refreshed session would need a new cookie, which a request that is only being
      // authenticated cannot set.
      disableSessionRefresh: true,
      // Unlinking an account is the only exposed endpoint with a session age limit, and Umami
      // has no way to ask the user to sign in again for it.
      freshAge: 0,
      additionalFields: {
        twoFactorSetup: {
          type: 'boolean',
          required: false,
          input: false,
        },
      },
    },
    secondaryStorage,
    databaseHooks: {
      session: {
        create: {
          // Decided once, when the session is created, whichever way the user signed in.
          before: async (session: { userId: string }) => {
            return {
              data: {
                ...session,
                twoFactorSetup: await isTwoFactorSetupRequired(session.userId),
              },
            };
          },
        },
      },
    },
    advanced: {
      database: {
        // Primary keys are generated here: user_id is a uuid column, so the
        // default random ids would not fit it.
        generateId: () => uuid(),
      },
      cookiePrefix: 'umami',
      // Detect https correctly behind a reverse proxy.
      trustedProxyHeaders: true,
      // better-auth marks cookies Secure whenever NODE_ENV is production, which
      // breaks self-hosted installs served over plain http. Opt in with
      // COOKIE_SECURE=1; the default follows CLOUD_URL.
      useSecureCookies: process.env.COOKIE_SECURE
        ? !['0', 'false'].includes(process.env.COOKIE_SECURE)
        : (process.env.CLOUD_URL || '').startsWith('https://'),
    },
    plugins: [
      // The casts work around plugin types that need strictNullChecks, which
      // this project has disabled.
      username({
        // Umami usernames are arbitrary strings of up to 255 characters, so the
        // plugin defaults (3 to 30 alphanumeric characters) are relaxed.
        minUsernameLength: 1,
        maxUsernameLength: 255,
        usernameValidator: () => true,
      }) as unknown as BetterAuthPlugin,
      bearer(),
      ssoToken(),
      umamiSession(),
    ],
  });
}

let auth: ReturnType<typeof createAuth>;

// Created on first use, so importing this module does not open a database connection.
export function getAuth() {
  auth ??= globalThis[BETTER_AUTH] || createAuth();

  if (process.env.NODE_ENV !== 'production') {
    globalThis[BETTER_AUTH] = auth;
  }

  return auth;
}

/**
 * Sets a user's password on their credential account row, creating the row
 * when the user has none yet.
 */
export async function setUserPassword(userId: string, newPassword: string) {
  const ctx = await getAuth().$context;
  const passwordHash = await ctx.password.hash(newPassword);
  const account = await ctx.internalAdapter.findCredentialAccount(userId);

  if (account) {
    await ctx.internalAdapter.updatePassword(userId, passwordHash);
  } else {
    await ctx.internalAdapter.linkAccount({
      userId,
      providerId: 'credential',
      accountId: userId,
      password: passwordHash,
    });
  }
}

/** Revokes every session of a user, in the database and in Redis. */
export async function revokeUserSessions(userId: string) {
  const ctx = await getAuth().$context;

  await ctx.internalAdapter.deleteUserSessions(userId);
}

/**
 * Creates a session for a user that Umami has already authenticated. Returns
 * the session token and the Set-Cookie headers that carry the session cookie.
 */
export async function createUserSession(request: Request, userId: string) {
  // The caller may carry a bearer value that is not a session (the 2FA partial
  // token), so it is not passed on.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete('authorization');

  const { headers, response } = await getAuth().api.createUserSession({
    body: { userId },
    headers: requestHeaders,
    returnHeaders: true,
  });

  return { token: response.token as string, headers };
}

/** Ends the session of the request. Returns the headers that clear the cookie. */
export async function endUserSession(request: Request) {
  const { headers } = await getAuth().api.signOut({
    headers: request.headers,
    returnHeaders: true,
  });

  return headers;
}

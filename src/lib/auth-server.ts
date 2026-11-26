import { type BetterAuthPlugin, betterAuth, getBaseURL } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { bearer, genericOAuth, username } from 'better-auth/plugins';
import { getForcedSecureCookies, withSecureCookies } from '@/lib/auth-cookies';
import { ssoToken } from '@/lib/auth-plugins/sso-token';
import { twoFactorChallenge } from '@/lib/auth-plugins/two-factor-challenge';
import { umamiSession } from '@/lib/auth-plugins/umami-session';
import { AUTH_SESSION_TTL, ROLES } from '@/lib/constants';
import { secret, uuid } from '@/lib/crypto';
import { getIpAddress, stripPort } from '@/lib/ip';
import { getGenericOAuthConfig, getOidcProviders, isUsable, type OidcProvider } from '@/lib/oidc';
import { type GroupMappingResult, mapGroups, readGroups } from '@/lib/oidc-groups';
import { checkPassword, hashPassword } from '@/lib/password';
import prisma from '@/lib/prisma';
import redis from '@/lib/redis';
import { isTwoFactorSetupRequired } from '@/lib/two-factor/policy';
import { applyGroupMapping, saveLastGroups } from '@/queries/prisma/oidcProvider';

const REDIS_PREFIX = 'ba:';

// The error code of a provider sign-in refused because the user is in none of the mapped groups.
export const GROUP_NOT_ALLOWED = 'group_not_allowed';

// better-auth reads the client address only from a single-value X-Forwarded-For, and counts
// every request with a proxy chain in one shared rate-limit bucket. Umami resolves the address
// itself (CLIENT_IP_HEADER, TRUSTED_PROXIES, proxy chains) and passes it on in this header, which
// only the server sets.
const CLIENT_IP_HEADER = 'x-umami-auth-client-ip';

/** Copies request headers for better-auth, with the client address that Umami resolved. */
export function withClientIp(headers: Headers) {
  const result = new Headers(headers);
  const ip = stripPort(getIpAddress(headers));

  result.delete(CLIENT_IP_HEADER);

  if (ip) {
    result.set(CLIENT_IP_HEADER, ip);
  }

  return result;
}

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

const PROVIDER_TOKEN_FIELDS = [
  'accessToken',
  'refreshToken',
  'accessTokenExpiresAt',
  'refreshTokenExpiresAt',
];

// An external account is used to identify the user and nothing else, so the provider's access
// and refresh tokens are not kept. The ID token is: logout sends it to the provider as
// id_token_hint, without which a provider such as Keycloak asks the user to confirm the logout.
function withoutProviderTokens(account: Record<string, any>) {
  const data = { ...account };

  for (const field of PROVIDER_TOKEN_FIELDS) {
    if (field in data) {
      data[field] = null;
    }
  }

  return { data };
}

// What the groups of a provider sign-in grant, kept until its session is created. The key is the
// endpoint context, which better-auth copies for every request (api/dispatch.mjs), so nothing
// carries over to another request.
const pendingMappings = new WeakMap<object, GroupMappingResult>();

/**
 * Lets a user sign in through a provider only when its groups allow it, and keeps what they grant
 * for the session hook. Users who sign in with a password are never checked.
 */
async function checkGroups(
  providers: OidcProvider[],
  source: { oauth?: { providerId: string; profile?: Record<string, unknown> } },
  context: object,
) {
  const provider = providers.find(({ slug }) => slug === source.oauth?.providerId);

  if (!provider) {
    return;
  }

  const groups = readGroups(source.oauth.profile, provider.groupsClaim);
  const result = mapGroups(groups, provider.mappings);

  await saveLastGroups(provider.slug, groups);

  if (!result.allowed) {
    return { error: GROUP_NOT_ALLOWED };
  }

  pendingMappings.set(context, result);
}

function createAuth(providers: OidcProvider[]) {
  return betterAuth({
    secret: secret(),
    // The route handler restores the app base path that Next.js strips (see
    // src/app/api/auth/[...all]/route.ts).
    basePath: `${process.env.basePath || ''}/api/auth`,
    trustedOrigins: [process.env.CLOUD_URL].filter(Boolean),
    // A provider sign-in that fails before better-auth knows where to send the user, such as one
    // with an expired state, lands on the login page with its error code instead of better-auth's
    // own error page.
    onAPIError: { errorURL: `${process.env.basePath || ''}/login` },
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
      // Runs for every sign-in, sign-up and account link through an external provider.
      validateUserInfo: async ({ source }, ctx) => checkGroups(providers, source, ctx.context),
    },
    session: {
      // The analytics visitor table owns the "session" name.
      modelName: 'authSession',
      // A session in use is extended once a day (better-auth's default updateAge), but only
      // by refreshUserSession: checkAuth reads without refreshing, because a request that is
      // only being authenticated cannot set the renewed cookie.
      expiresIn: AUTH_SESSION_TTL,
      // Unlinking an account is the only exposed endpoint with a session age limit, and Umami
      // has no way to ask the user to sign in again for it.
      freshAge: 0,
      additionalFields: {
        twoFactorSetup: {
          type: 'boolean',
          required: false,
          input: false,
        },
        // The external provider the user signed in through, so logout ends the provider's
        // session only when this session came from it. A user can have a password and a linked
        // account at once.
        providerId: {
          type: 'string',
          required: false,
          input: false,
        },
      },
    },
    account: {
      accountLinking: {
        // Existing users have no real email address, so an external account is never matched
        // to them by email. They link it themselves while signed in.
        disableImplicitLinking: true,
        allowDifferentEmails: true,
        // Linking is refused for an untrusted provider unless it reports the email as verified,
        // which not every provider does. The administrator chose these providers.
        trustedProviders: providers.map(({ slug }) => slug),
      },
    },
    secondaryStorage,
    databaseHooks: {
      account: {
        create: { before: async account => withoutProviderTokens(account) },
        update: { before: async account => withoutProviderTokens(account) },
      },
      session: {
        create: {
          // Decided once, when the session is created, whichever way the user signed in.
          before: async (session: { userId: string }, context) => {
            const mapping = context && pendingMappings.get(context.context);

            // A provider sign-in gives the user what its groups grant before the session exists,
            // so a failure leaves the user signed out.
            if (mapping) {
              pendingMappings.delete(context.context);
              await applyGroupMapping(session.userId, mapping);
            }

            return {
              data: {
                ...session,
                twoFactorSetup: await isTwoFactorSetupRequired(session.userId),
                ...(context?.path?.startsWith('/callback/') && { providerId: context.params.id }),
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
      // breaks self-hosted installs served over plain http. Unless COOKIE_SECURE or
      // CLOUD_URL decides, withSecureCookies follows the protocol of each request.
      useSecureCookies: getForcedSecureCookies() ?? false,
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
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
      ...(providers.length
        ? [
            genericOAuth({
              config: providers.map(getGenericOAuthConfig),
            }) as unknown as BetterAuthPlugin,
            twoFactorChallenge(),
          ]
        : []),
    ],
  });
}

let current: { providers: OidcProvider[]; auth: ReturnType<typeof createAuth> } | undefined;

/**
 * The better-auth instance for the current OIDC providers. A change to them builds a new one, which
 * signs nobody out: sessions live in the database. Created on first use, so importing this module
 * does not open a database connection.
 */
export async function getAuth() {
  const providers = await getOidcProviders();

  if (current?.providers !== providers) {
    current = { providers, auth: createAuth(providers.filter(isUsable)) };
  }

  return current.auth;
}

/**
 * Sets a user's password on their credential account row, creating the row
 * when the user has none yet.
 */
export async function setUserPassword(userId: string, newPassword: string) {
  const ctx = await (await getAuth()).$context;
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
  const ctx = await (await getAuth()).$context;

  await ctx.internalAdapter.deleteUserSessions(userId);
}

/**
 * Creates a session for a user that Umami has already authenticated, through the external
 * provider `providerId` when one was the first sign-in step. Returns the session token and the
 * Set-Cookie headers that carry the session cookie.
 */
export async function createUserSession(request: Request, userId: string, providerId?: string) {
  // The caller may carry a bearer value that is not a session (the 2FA partial
  // token), so it is not passed on.
  const requestHeaders = withClientIp(request.headers);
  requestHeaders.delete('authorization');

  const { headers, response } = await (await getAuth()).api.createUserSession({
    body: { userId, providerId },
    headers: requestHeaders,
    returnHeaders: true,
  });

  return { token: response.token as string, headers: withSecureCookies(request, headers) };
}

/**
 * Moves the expiry of the request's session forward when it is due, so an active user stays
 * signed in. Returns the headers that renew the cookie, without Set-Cookie when nothing changed.
 */
export async function refreshUserSession(request: Request) {
  const { headers } = await (await getAuth()).api.getSession({
    headers: request.headers,
    returnHeaders: true,
  });

  return withSecureCookies(request, headers);
}

/**
 * The URL that ends the user's session at the provider the session came from, or undefined when
 * that provider has no end-session endpoint. The provider sends the user back to the login page.
 */
async function getProviderLogoutUrl(request: Request, userId: string, providerId: string) {
  const ctx = await (await getAuth()).$context;
  const provider = ctx.socialProviders.find(({ id }) => id === providerId);
  const account = (await ctx.internalAdapter.findAccounts(userId)).find(
    account => account.providerId === providerId,
  );
  const url = await provider?.createEndSessionURL?.({ idToken: account?.idToken });

  if (!url) {
    return undefined;
  }

  // better-auth resolves a postLogoutRedirectURI against its configured base URL. Umami sets
  // none, because the origin comes from each request, and new URL() rejects the empty base. So
  // the return address is added here. The provider matches it against the ones registered for
  // the client, so its origin is resolved like the one in the sign-in redirect URI.
  const origin = getBaseURL(undefined, '/', request, undefined, true);

  url.searchParams.set(
    'post_logout_redirect_uri',
    new URL(`${process.env.basePath || ''}/login`, origin).toString(),
  );
  url.searchParams.set(
    'client_id',
    (await getOidcProviders()).find(({ slug }) => slug === providerId)?.clientId,
  );

  return url.toString();
}

/**
 * Ends the session of the request. Returns the headers that clear the cookie, and the URL that
 * ends the provider's session too when the user signed in through one that offers it.
 */
export async function endUserSession(request: Request) {
  const auth = await getAuth();
  const current = await auth.api.getSession({
    headers: request.headers,
    query: { disableRefresh: true },
  });

  // better-auth would pick the provider from the user's most recently updated account instead
  // of the session, and answer with a Location header, so its own provider logout is not used.
  // The Umami session ends first, so a failure at the provider step cannot keep the user signed in.
  const { headers } = await auth.api.signOut({
    headers: request.headers,
    body: { disableRedirect: true },
    returnHeaders: true,
  });

  const providerId = current?.session.providerId;
  const redirect = providerId
    ? await getProviderLogoutUrl(request, current.user.id, providerId)
    : undefined;

  return { headers: withSecureCookies(request, headers), redirect };
}

import debug from 'debug';
import {
  API_KEY_LAST_USED_INTERVAL,
  hashApiKey,
  isApiKey,
  isApiKeyBlockedPath,
  isApiKeyEnabled,
} from '@/lib/api-key';
import { getAuth } from '@/lib/auth-server';
import {
  ROLE_PERMISSIONS,
  ROLES,
  SHARE_CONTEXT_HEADER,
  SHARE_TOKEN_HEADER,
  SHARE_TOKEN_TYPE,
} from '@/lib/constants';
import { secret } from '@/lib/crypto';
import { parseToken } from '@/lib/jwt';
import { hasDefaultPassword } from '@/lib/password';
import prisma from '@/lib/prisma';
import { ensureArray } from '@/lib/utils';
import { getApiKeyByHash, updateApiKeyLastUsed } from '@/queries/prisma/apiKey';
import { getShare } from '@/queries/prisma/share';
import { getUser } from '@/queries/prisma/user';

const log = debug('umami:auth');

export function getBearerToken(request: Request) {
  const auth = request.headers.get('authorization');

  return auth?.split(' ')[1];
}

export async function checkApiKeyAuth(request: Request, token: string) {
  const { pathname } = new URL(request.url);

  if (isApiKeyBlockedPath(pathname)) {
    log('API key not allowed for path', pathname);
    return null;
  }

  const apiKey = await getApiKeyByHash(hashApiKey(token));

  if (!apiKey) {
    log('API key not found');
    return null;
  }

  const user: any = await getUser(apiKey.userId);

  if (!user?.id) {
    log('API key user not found');
    return null;
  }

  const lastUsedAt = apiKey.lastUsedAt?.getTime() ?? 0;

  if (Date.now() - lastUsedAt > API_KEY_LAST_USED_INTERVAL) {
    updateApiKeyLastUsed(apiKey.id).catch(e => log(e));
  }

  delete user.password;
  user.isAdmin = user.role === ROLES.admin;

  return {
    token,
    user,
    authType: 'api-key' as const,
    apiKey: { id: apiKey.id, name: apiKey.name },
  };
}

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/**
 * The browser attaches the session cookie by itself, so a request that changes state has to come
 * from Umami's own pages. Browsers report where a request came from in Sec-Fetch-Site. Clients
 * that send the token as a bearer header are not affected.
 */
function isCrossSiteRequest(request: Request) {
  const site = request.headers.get('sec-fetch-site');

  return (
    !getBearerToken(request) &&
    !SAFE_METHODS.includes(request.method) &&
    !!site &&
    site !== 'same-origin' &&
    site !== 'none'
  );
}

/** Reads the better-auth session of a request, from its cookie or bearer token. */
async function getAuthSession(request: Request) {
  if (isCrossSiteRequest(request)) {
    log('Cross-site request rejected');
    return null;
  }

  try {
    return await getAuth().api.getSession({ headers: request.headers });
  } catch (e) {
    log(e);
    return null;
  }
}

export async function checkAuth(request: Request) {
  const token = getBearerToken(request);

  if (isApiKeyEnabled() && isApiKey(token)) {
    return checkApiKeyAuth(request, token);
  }

  const session = await getAuthSession(request);
  const shareToken = await parseShareToken(request);

  let user = null;
  let twoFactorSetup = false;

  if (session?.user?.id) {
    // Re-read through Umami's own query: it filters soft-deleted users and
    // returns the user shape the routes and permissions expect.
    user = await getUser(session.user.id, { includePassword: true });
    twoFactorSetup = !!(session.session as { twoFactorSetup?: boolean }).twoFactorSetup;
  }

  // A session issued while 2FA was required but not set up stays restricted until enrollment
  // completes; after that the same session becomes a full session.
  let twoFactorSetupPending = false;

  if (user && twoFactorSetup) {
    const twoFactor = await prisma.client.twoFactorAuth.findUnique({ where: { userId: user.id } });
    twoFactorSetupPending = !twoFactor?.isEnabled;
  }

  log({
    hasSession: !!session,
    hasShareToken: !!shareToken,
    userId: user?.id,
  });

  if (!user?.id && !shareToken) {
    log('User not authorized');
    return null;
  }

  if (!user?.id && shareToken) {
    const shareContext = request.headers.get(SHARE_CONTEXT_HEADER);
    if (!shareContext) {
      log('Share token used outside share context');
      return null;
    }
  }

  const passwordChangeRequired = hasDefaultPassword(user);

  if (user) {
    delete user.password;
    user.isAdmin = user.role === ROLES.admin;
  }

  return {
    token: user ? session.session.token : undefined,
    shareToken,
    user,
    authType: user ? ('session' as const) : ('share' as const),
    twoFactorSetupPending,
    passwordChangeRequired,
  };
}

export async function hasPermission(role: string, permission: string | string[]) {
  return ensureArray(permission).some(e => ROLE_PERMISSIONS[role]?.includes(e));
}

export async function parseShareToken(request: Request) {
  try {
    const token: any = parseToken(request.headers.get(SHARE_TOKEN_HEADER), secret());

    // Only accept tokens explicitly minted as share tokens. This prevents other
    // tokens signed with the same secret (e.g. the cache token from /api/send)
    // from being replayed as share tokens to gain analytics access.
    if (token?.type !== SHARE_TOKEN_TYPE) {
      return null;
    }

    // Share tokens are stateless and never expire, so the share they were minted
    // from is re-checked on every request. Deleting a share revokes its tokens.
    if (!token.shareId) {
      return null;
    }

    const share = await getShare(token.shareId);
    const entityId = token.boardId ?? token.websiteId;

    if (!share || share.shareType !== token.shareType || share.entityId !== entityId) {
      log('Share token rejected: share not found');
      return null;
    }

    // Use the current parameters rather than the ones captured at mint time, so
    // turning a section off takes effect for tokens that are already issued.
    return { ...token, parameters: share.parameters };
  } catch (e) {
    log(e);
    return null;
  }
}

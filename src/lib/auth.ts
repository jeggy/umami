import debug from 'debug';
import {
  API_KEY_LAST_USED_INTERVAL,
  hashApiKey,
  isApiKey,
  isApiKeyBlockedPath,
  isApiKeyEnabled,
} from '@/lib/api-key';
import { getAuth } from '@/lib/auth-server';
import { getBoardEntityIds } from '@/lib/boards';
import {
  ENTITY_TYPE,
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
 * that send the token as a bearer header are not affected. The login routes check it too, since
 * another site could otherwise sign the browser into an account of its choosing.
 */
export function isCrossSiteRequest(request: Request) {
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
    // The response of an ordinary route carries no renewed cookie, so a cookie session is
    // extended only by /api/auth/verify (refreshUserSession). A bearer token stays the same when
    // its session is extended, so a script that calls the API stays signed in while it does.
    return await (await getAuth()).api.getSession({
      headers: request.headers,
      query: { disableRefresh: !getBearerToken(request) },
    });
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

export function hasPermission(role: string, permission: string | string[]) {
  return ensureArray(permission).some(e => ROLE_PERMISSIONS[role]?.includes(e));
}

type BoardShareEntityIds = { websiteIds: string[]; pixelIds: string[]; linkIds: string[] };

// Board share tokens embed the board's entity ids from when they were minted. Narrow them to
// entities still on the board and still owned by the board's owner or team, matching what
// /api/share/[slug] would mint now. Uses a fixed number of queries regardless of board size.
async function getCurrentBoardShareEntityIds(
  boardId: string,
  token: Partial<BoardShareEntityIds>,
): Promise<BoardShareEntityIds> {
  const none = { websiteIds: [], pixelIds: [], linkIds: [] };
  const board = await prisma.client.board.findUnique({
    where: { id: boardId },
    select: {
      type: true,
      parameters: true,
      userId: true,
      teamId: true,
      user: { select: { id: true, role: true, deletedAt: true } },
    },
  });

  if (!board) {
    return none;
  }

  const onBoard = getBoardEntityIds({ type: board.type, parameters: board.parameters as any });
  const websiteIds = (token.websiteIds ?? []).filter(id => onBoard.websiteIds.includes(id));
  const pixelIds = (token.pixelIds ?? []).filter(id => onBoard.pixelIds.includes(id));
  const linkIds = (token.linkIds ?? []).filter(id => onBoard.linkIds.includes(id));

  const select = { id: true, userId: true, teamId: true };
  const [websites, pixels, links] = await Promise.all([
    websiteIds.length
      ? prisma.client.website.findMany({ where: { id: { in: websiteIds } }, select })
      : [],
    pixelIds.length
      ? prisma.client.pixel.findMany({ where: { id: { in: pixelIds } }, select })
      : [],
    linkIds.length ? prisma.client.link.findMany({ where: { id: { in: linkIds } }, select }) : [],
  ]);

  type Owned = { id: string; userId: string | null; teamId: string | null };
  let isShareable: (entity: Owned) => boolean;

  if (board.teamId) {
    // Team board shares only expose entities the team itself owns.
    isShareable = entity => entity.teamId === board.teamId;
  } else if (board.userId) {
    const owner = board.user;

    if (!owner || owner.deletedAt) {
      return none;
    }

    if (owner.role === ROLES.admin) {
      isShareable = () => true;
    } else {
      // Same rule as canViewWebsite/Pixel/Link for the board's owner.
      const teamIds = [...websites, ...pixels, ...links]
        .filter(entity => !entity.userId && entity.teamId)
        .map(entity => entity.teamId as string);
      const memberships = teamIds.length
        ? await prisma.client.teamUser.findMany({
            where: { userId: owner.id, teamId: { in: [...new Set(teamIds)] } },
            select: { teamId: true },
          })
        : [];
      const memberOf = new Set(memberships.map(({ teamId }) => teamId));

      isShareable = entity =>
        entity.userId ? entity.userId === owner.id : !!entity.teamId && memberOf.has(entity.teamId);
    }
  } else {
    return none;
  }

  const shareable = (entities: Owned[]) => entities.filter(isShareable).map(({ id }) => id);

  return {
    websiteIds: shareable(websites),
    pixelIds: shareable(pixels),
    linkIds: shareable(links),
  };
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
    const current = { ...token, parameters: share.parameters };

    if (share.shareType === ENTITY_TYPE.board) {
      Object.assign(current, await getCurrentBoardShareEntityIds(share.entityId, token));
    }

    return current;
  } catch (e) {
    log(e);
    return null;
  }
}

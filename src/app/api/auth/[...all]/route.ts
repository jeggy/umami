import { toNextJsHandler } from 'better-auth/next-js';
import { checkAuth } from '@/lib/auth';
import { getAuth } from '@/lib/auth-server';
import { OIDC_PROVIDER_ID } from '@/lib/constants';
import prisma from '@/lib/prisma';
import { badRequest, notFound, unauthorized } from '@/lib/response';

const AUTH_PATH = '/api/auth/';
const BASE_PATH = process.env.basePath || '';

// better-auth serves many endpoints of its own. Only these are exposed: the rest would bypass
// the 2FA step and the permission checks of Umami's own routes.
const ALLOWED_PATHS = [
  'sign-in/social',
  'callback',
  'link-social',
  'list-accounts',
  'unlink-account',
  'sso/verify',
  'error',
];

// These act on the signed-in user, so they get the same session checks as Umami's own routes.
const ACCOUNT_PATHS = ['link-social', 'list-accounts', 'unlink-account'];

function isAllowed(path: string) {
  return ALLOWED_PATHS.some(allowed => path === allowed || path.startsWith(`${allowed}/`));
}

async function isAllowedBody(path: string, request: Request) {
  const body = await request.json().catch(() => ({}));

  // An ID token in the body signs the user in directly, without the provider redirect that the
  // 2FA step hooks into.
  if (body?.idToken) {
    return false;
  }

  // Removing the password account would leave the user without a way to pass the password checks.
  if (path === 'unlink-account') {
    const account = await prisma.client.account.findUnique({
      where: { id: String(body?.accountId) },
    });

    return account?.providerId === OIDC_PROVIDER_ID;
  }

  return true;
}

async function handle(request: Request) {
  const url = new URL(request.url);
  const path = url.pathname.slice(AUTH_PATH.length);

  if (!isAllowed(path)) {
    return notFound();
  }

  if (ACCOUNT_PATHS.includes(path)) {
    const auth = await checkAuth(request);

    if (auth?.authType !== 'session' || auth.twoFactorSetupPending) {
      return unauthorized();
    }
  }

  if (request.method === 'POST' && !(await isAllowedBody(path, request.clone()))) {
    return badRequest();
  }

  // Next.js strips the app base path from the request URL. better-auth needs the full path: it
  // builds the callback URL that the external provider redirects back to from it.
  url.pathname = `${BASE_PATH}${url.pathname}`;

  return getAuth().handler(new Request(url, request));
}

export const { GET, POST } = toNextJsHandler(handle);

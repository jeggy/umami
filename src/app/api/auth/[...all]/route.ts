import { toNextJsHandler } from 'better-auth/next-js';
import { getAuth } from '@/lib/auth-server';
import { notFound } from '@/lib/response';

const AUTH_PATH = '/api/auth/';
const BASE_PATH = process.env.basePath || '';

// better-auth serves many endpoints of its own. Only these are exposed: the rest would bypass
// the 2FA step and the permission checks of Umami's own routes.
const ALLOWED_PATHS = ['sso/verify'];

function isAllowed(path: string) {
  return ALLOWED_PATHS.some(allowed => path === allowed || path.startsWith(`${allowed}/`));
}

async function handle(request: Request) {
  const url = new URL(request.url);

  if (!isAllowed(url.pathname.slice(AUTH_PATH.length))) {
    return notFound();
  }

  // Next.js strips the app base path from the request URL, and better-auth matches its routes
  // against the full path.
  url.pathname = `${BASE_PATH}${url.pathname}`;

  return getAuth().handler(new Request(url, request));
}

export const { GET, POST } = toNextJsHandler(handle);

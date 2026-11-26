import { parseBooleanEnv } from '@/lib/env';

/**
 * Whether every session cookie is Secure: COOKIE_SECURE when it is set, otherwise true when
 * CLOUD_URL is https. Undefined leaves the choice to each request (withSecureCookies).
 */
export function getForcedSecureCookies() {
  return (
    parseBooleanEnv(process.env.COOKIE_SECURE) ??
    (process.env.CLOUD_URL?.startsWith('https://') || undefined)
  );
}

function isHttpsRequest(request: Request) {
  // A chain of proxies may list several protocols. The first is the one the client used.
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0].trim();

  return (forwarded || new URL(request.url).protocol.slice(0, -1)) === 'https';
}

/**
 * Marks the cookies of a response Secure when its request arrived over https and nothing forces
 * the choice. better-auth fixes cookie attributes when the instance is built, so this is done
 * per response instead. The cookie names stay the same either way, so a cookie is always read
 * back under the name it was set with.
 */
export function withSecureCookies(request: Request, headers: Headers) {
  if (getForcedSecureCookies() !== undefined || !isHttpsRequest(request)) {
    return headers;
  }

  const secured = new Headers(headers);
  secured.delete('set-cookie');

  for (const cookie of headers.getSetCookie()) {
    secured.append('set-cookie', /;\s*secure\s*(;|$)/i.test(cookie) ? cookie : `${cookie}; Secure`);
  }

  return secured;
}

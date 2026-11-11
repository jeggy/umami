import { SSO_TOKEN_TTL, SSO_TOKEN_TYPE } from '@/lib/auth-plugins/sso-token';
import { secret, uuid } from '@/lib/crypto';
import { createToken } from '@/lib/jwt';
import redis from '@/lib/redis';
import { parseRequest } from '@/lib/request';
import { json, serverError } from '@/lib/response';

export async function POST(request: Request) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  if (!redis.enabled) {
    return serverError('Redis is disabled');
  }

  // A short-lived, single-use token. The /sso page exchanges it for a session
  // at POST /api/auth/sso/verify.
  const token = createToken({ userId: auth.user.id, type: SSO_TOKEN_TYPE, jti: uuid() }, secret(), {
    expiresIn: SSO_TOKEN_TTL,
  });

  return json({ user: auth.user, token });
}

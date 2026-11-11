import { createUserSession } from '@/lib/auth-server';
import { ROLES } from '@/lib/constants';
import { addTeamBillingStatus } from '@/lib/load';
import { checkPassword, hasDefaultPassword } from '@/lib/password';
import prisma from '@/lib/prisma';
import { parseRequest } from '@/lib/request';
import { json, serviceUnavailable, unauthorized } from '@/lib/response';
import { getTwoFactorConfigurationError, isTwoFactorConfigured } from '@/lib/two-factor/crypto';
import { createPartialToken } from '@/lib/two-factor/partial-token';
import { getAllUserTeams, getUserByUsername } from '@/queries/prisma';
import { loginRequestSchema } from './schema';

export async function POST(request: Request) {
  const { body, error } = await parseRequest(request, loginRequestSchema, { skipAuth: true });

  if (error) {
    return error();
  }

  const { username, password } = body;

  const user = await getUserByUsername(username, { includePassword: true });

  // Users without a password sign in through an external provider only.
  if (!user?.password || !checkPassword(password, user.password)) {
    return unauthorized({ code: 'incorrect-username-password' });
  }

  const { id, role, createdAt } = user;
  const passwordChangeRequired = hasDefaultPassword(user);
  const cloudMode = !!process.env.CLOUD_MODE;

  // Check if 2FA is enabled for this user
  const twoFactor = !cloudMode
    ? await prisma.client.twoFactorAuth.findUnique({ where: { userId: id } })
    : null;

  if (twoFactor?.isEnabled) {
    if (!isTwoFactorConfigured()) {
      return serviceUnavailable(getTwoFactorConfigurationError());
    }

    return json({ requiresTwoFactor: true, partialToken: createPartialToken(id) });
  }

  // Browsers use the session cookie; API clients send the token as a bearer token.
  const { token, headers } = await createUserSession(request, id);

  const teams = await addTeamBillingStatus(await getAllUserTeams(id));

  return json(
    {
      token,
      user: {
        id,
        username,
        role,
        createdAt,
        isAdmin: role === ROLES.admin,
        passwordChangeRequired,
        teams,
      },
    },
    { headers },
  );
}

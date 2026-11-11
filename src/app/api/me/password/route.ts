import { z } from 'zod';
import { createUserSession, revokeUserSessions, setUserPassword } from '@/lib/auth-server';
import { checkPassword } from '@/lib/password';
import { parseRequest } from '@/lib/request';
import { badRequest, json, notFound } from '@/lib/response';
import { getUser } from '@/queries/prisma/user';

export async function POST(request: Request) {
  const schema = z.object({
    currentPassword: z.string(),
    newPassword: z.string().min(8),
  });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const userId = auth.user.id;
  const { currentPassword, newPassword } = body;

  const user = await getUser(userId, { includePassword: true });

  if (!user) {
    return notFound();
  }

  if (!user.password || !checkPassword(currentPassword, user.password)) {
    return badRequest({ message: 'Current password is incorrect' });
  }

  await setUserPassword(userId, newPassword);

  // The new password ends every existing session, so keep this user signed in with a new one.
  await revokeUserSessions(userId);

  const { token, headers } = await createUserSession(request, userId);

  const { id, username, role, createdAt } = user;

  return json({ id, username, role, createdAt, token }, { headers });
}

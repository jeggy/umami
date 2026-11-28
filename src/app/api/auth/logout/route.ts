import { endUserSession } from '@/lib/auth-server';
import { parseRequest } from '@/lib/request';
import { json } from '@/lib/response';

export async function POST(request: Request) {
  const { error } = await parseRequest(request, null, { allowTwoFactorSetup: true });

  if (error) {
    return error();
  }

  const { headers, redirect } = await endUserSession(request);

  return json({ ok: true, redirect }, { headers });
}

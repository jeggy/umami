import { removeOidcProvider } from '@/lib/auth-server';
import { getOidcProvider, invalidateOidcProviders } from '@/lib/oidc';
import { oidcProviderSchema, toProviderData, toProviderResponse } from '@/lib/oidc-admin';
import { parseRequest } from '@/lib/request';
import { badRequest, json, notFound, ok, unauthorized } from '@/lib/response';
import { canManageOidcProviders } from '@/permissions';
import {
  createOidcProvider,
  findLinkedUserIds,
  getLastGroups,
  hasMissingTeams,
  updateOidcProvider,
} from '@/queries/prisma';

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  if (process.env.CLOUD_MODE) {
    return notFound();
  }

  const { auth, body, error } = await parseRequest(request, oidcProviderSchema);

  if (error) {
    return error();
  }

  if (!(await canManageOidcProviders(auth))) {
    return unauthorized();
  }

  const { slug } = await params;
  const provider = await getOidcProvider(slug);

  if (!provider) {
    return notFound();
  }

  if (await hasMissingTeams(body.mappings)) {
    return badRequest({ message: 'A mapping names a team that does not exist.' });
  }

  // A linked account is found by the slug and the subject, and a subject is unique only at one
  // issuer. Another issuer's user with the same subject would sign in as the linked user.
  const changesIssuer =
    body.discoveryUrl !== undefined &&
    body.discoveryUrl !== provider.discoveryUrl &&
    !provider.lockedBy.discoveryUrl;

  if (changesIssuer && (await findLinkedUserIds(slug)).length) {
    return badRequest({
      message:
        'Users have linked accounts through this provider, so its discovery URL cannot change. Remove the provider and add it again to use another issuer, and its users link their accounts again.',
    });
  }

  const data = toProviderData(body, provider.lockedBy);

  // Only the environment provider exists without a row, until its first change here.
  if (provider.stored || !(await createOidcProvider(slug, data, body.mappings))) {
    await updateOidcProvider(slug, data, body.mappings);
  }
  invalidateOidcProviders();

  const [updated, lastGroups] = await Promise.all([getOidcProvider(slug), getLastGroups()]);

  return json(toProviderResponse(updated, lastGroups[slug]));
}

export async function DELETE(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  if (process.env.CLOUD_MODE) {
    return notFound();
  }

  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  if (!(await canManageOidcProviders(auth))) {
    return unauthorized();
  }

  const { slug } = await params;

  if (!(await getOidcProvider(slug))?.stored) {
    return notFound();
  }

  await removeOidcProvider(slug);
  invalidateOidcProviders();

  return ok();
}

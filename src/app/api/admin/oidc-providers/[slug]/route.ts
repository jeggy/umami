import { getOidcProviders, invalidateOidcProviders } from '@/lib/oidc';
import { oidcProviderSchema, toProviderData, toProviderResponse } from '@/lib/oidc-admin';
import { parseRequest } from '@/lib/request';
import { badRequest, json, notFound, ok, unauthorized } from '@/lib/response';
import { canManageOidcProviders } from '@/permissions';
import {
  deleteOidcProvider,
  getLastGroups,
  hasMissingTeams,
  saveOidcProvider,
} from '@/queries/prisma';

async function findProvider(slug: string) {
  return (await getOidcProviders()).find(provider => provider.slug === slug);
}

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
  const provider = await findProvider(slug);

  if (!provider) {
    return notFound();
  }

  if (await hasMissingTeams(body.mappings)) {
    return badRequest({ message: 'A mapping names a team that does not exist.' });
  }

  await saveOidcProvider(slug, toProviderData(body, provider.lockedBy), body.mappings);
  invalidateOidcProviders();

  const [updated, lastGroups] = await Promise.all([findProvider(slug), getLastGroups()]);

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

  if (!(await findProvider(slug))?.stored) {
    return notFound();
  }

  await deleteOidcProvider(slug);
  invalidateOidcProviders();

  return ok();
}

import { getOidcProvider, getOidcProviders, invalidateOidcProviders } from '@/lib/oidc';
import {
  oidcProviderSchema,
  oidcProviderSlugSchema,
  toProviderData,
  toProviderResponse,
} from '@/lib/oidc-admin';
import { parseRequest } from '@/lib/request';
import { badRequest, json, notFound, unauthorized } from '@/lib/response';
import { canManageOidcProviders } from '@/permissions';
import { getLastGroups, hasMissingTeams, saveOidcProvider } from '@/queries/prisma';

export async function GET(request: Request) {
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

  const [providers, lastGroups] = await Promise.all([getOidcProviders(), getLastGroups()]);

  return json({
    providers: providers.map(provider => toProviderResponse(provider, lastGroups[provider.slug])),
  });
}

export async function POST(request: Request) {
  if (process.env.CLOUD_MODE) {
    return notFound();
  }

  const schema = oidcProviderSchema.extend({ slug: oidcProviderSlugSchema });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  if (!(await canManageOidcProviders(auth))) {
    return unauthorized();
  }

  const { slug, ...input } = body;

  if (await getOidcProvider(slug)) {
    return badRequest({ message: 'A provider with this name already exists.' });
  }

  if (await hasMissingTeams(input.mappings)) {
    return badRequest({ message: 'A mapping names a team that does not exist.' });
  }

  await saveOidcProvider(slug, toProviderData(input), input.mappings ?? []);
  invalidateOidcProviders();

  return json(toProviderResponse(await getOidcProvider(slug)));
}

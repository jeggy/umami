import type { Prisma } from '@/generated/prisma/client';
import { uuid } from '@/lib/crypto';
import type { GroupMapping, GroupMappingResult } from '@/lib/oidc-groups';
import prisma from '@/lib/prisma';

const LAST_GROUPS_KEY = 'oidc-last-groups:';

export type OidcProviderData = Partial<
  Pick<
    Prisma.OidcProviderCreateInput,
    | 'name'
    | 'discoveryUrl'
    | 'clientId'
    | 'clientSecret'
    | 'scopes'
    | 'groupsClaim'
    | 'disableSignup'
    | 'disableProviderLogout'
  >
>;

export async function findOidcProviders() {
  return prisma.client.oidcProvider.findMany({
    include: { groupMappings: { orderBy: { position: 'asc' } } },
    orderBy: { createdAt: 'asc' },
  });
}

export type OidcProviderRow = Awaited<ReturnType<typeof findOidcProviders>>[number];

async function replaceMappings(
  tx: Prisma.TransactionClient,
  oidcProviderId: string,
  mappings?: GroupMapping[],
) {
  if (!mappings) {
    return;
  }

  await tx.oidcGroupMapping.deleteMany({ where: { oidcProviderId } });
  await tx.oidcGroupMapping.createMany({
    data: mappings.map((mapping, index) => ({
      ...mapping,
      id: uuid(),
      oidcProviderId,
      position: index,
    })),
  });
}

/** Stores a new provider with its mappings. Returns false when another provider has the slug. */
export async function createOidcProvider(
  slug: string,
  data: OidcProviderData,
  mappings: GroupMapping[] = [],
) {
  try {
    await prisma.transaction(async (tx: Prisma.TransactionClient) => {
      const { id } = await tx.oidcProvider.create({ data: { ...data, id: uuid(), slug } });

      await replaceMappings(tx, id, mappings);
    });
  } catch (e: any) {
    if (e?.code === 'P2002') {
      return false;
    }

    throw e;
  }

  return true;
}

/** Changes a stored provider's settings, and its mappings when they are given. */
export async function updateOidcProvider(
  slug: string,
  data: OidcProviderData,
  mappings?: GroupMapping[],
) {
  await prisma.transaction(async (tx: Prisma.TransactionClient) => {
    const { id } = await tx.oidcProvider.update({ where: { slug }, data });

    await replaceMappings(tx, id, mappings);
  });
}

/** Whether one of the mappings names a team that does not exist. */
export async function hasMissingTeams(mappings: GroupMapping[] = []) {
  const teamIds = [...new Set(mappings.map(({ teamId }) => teamId).filter(Boolean))];

  if (!teamIds.length) {
    return false;
  }

  const count = await prisma.client.team.count({
    where: { id: { in: teamIds }, deletedAt: null },
  });

  return count !== teamIds.length;
}

/** The users who linked an account through the provider. */
export async function findLinkedUserIds(slug: string) {
  const accounts = await prisma.client.account.findMany({
    where: { providerId: slug },
    select: { userId: true },
  });

  return [...new Set(accounts.map(({ userId }) => userId))];
}

/**
 * Removes a provider with the accounts linked through it and the sessions it started. better-auth
 * finds a linked account by the slug and the subject alone, so an account left behind would sign
 * in whoever has that subject at the next provider with this slug.
 */
export async function deleteOidcProvider(slug: string) {
  await prisma.transaction(async (tx: Prisma.TransactionClient) => {
    await tx.account.deleteMany({ where: { providerId: slug } });
    await tx.authSession.deleteMany({ where: { providerId: slug } });
    await tx.oidcProvider.deleteMany({ where: { slug } });
  });
}

/**
 * Gives the user the role and the team memberships a sign-in through a provider decided, in one
 * transaction. Teams outside the result keep their members.
 */
export async function applyGroupMapping(userId: string, { role, teams }: GroupMappingResult) {
  await prisma.transaction(async (tx: Prisma.TransactionClient) => {
    if (role) {
      await tx.user.update({ where: { id: userId }, data: { role } });
    }

    const teamIds = [...teams.keys()];
    const memberships = await tx.teamUser.findMany({ where: { userId, teamId: { in: teamIds } } });
    // Another instance can still hold a mapping whose team was deleted a moment ago.
    const existing = await tx.team.findMany({
      where: { id: { in: teamIds }, deletedAt: null },
      select: { id: true },
    });

    for (const [teamId, teamRole] of teams) {
      const current = memberships.filter(membership => membership.teamId === teamId);

      if (!existing.some(({ id }) => id === teamId)) {
        continue;
      }

      if (!teamRole) {
        if (current.length) {
          await tx.teamUser.deleteMany({ where: { userId, teamId } });
        }
      } else if (!current.length) {
        await tx.teamUser.create({ data: { id: uuid(), userId, teamId, role: teamRole } });
      } else if (current.some(membership => membership.role !== teamRole)) {
        await tx.teamUser.updateMany({ where: { userId, teamId }, data: { role: teamRole } });
      }
    }
  });
}

export interface LastGroups {
  groups: string[];
  signedInAt: string;
}

/** Records the groups a provider sent at its latest sign-in, which the settings page shows. */
export async function saveLastGroups(slug: string, groups: string[]) {
  const key = `${LAST_GROUPS_KEY}${slug}`;
  const value = JSON.stringify({ groups, signedInAt: new Date().toISOString() } as LastGroups);

  await prisma.client.appSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

export async function getLastGroups(): Promise<Record<string, LastGroups>> {
  const settings = await prisma.client.appSetting.findMany({
    where: { key: { startsWith: LAST_GROUPS_KEY } },
  });

  return Object.fromEntries(
    settings.map(({ key, value }) => [key.slice(LAST_GROUPS_KEY.length), JSON.parse(value)]),
  );
}

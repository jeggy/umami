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
    include: { groupMappings: { orderBy: { createdAt: 'asc' } } },
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

  // The rows are listed by creation time, and the database would give them all the time the
  // transaction started, so each gets its own to keep the order the administrator chose.
  const now = Date.now();

  await tx.oidcGroupMapping.deleteMany({ where: { oidcProviderId } });
  await tx.oidcGroupMapping.createMany({
    data: mappings.map((mapping, index) => ({
      ...mapping,
      id: uuid(),
      oidcProviderId,
      createdAt: new Date(now + index),
    })),
  });
}

/**
 * Stores a provider's settings, and its mappings when they are given, which replace the old ones.
 * Creates the row when the provider has none yet.
 */
export async function saveOidcProvider(
  slug: string,
  data: OidcProviderData,
  mappings?: GroupMapping[],
) {
  await prisma.transaction(async (tx: Prisma.TransactionClient) => {
    const { id } = await tx.oidcProvider.upsert({
      where: { slug },
      create: { ...data, id: uuid(), slug },
      update: data,
    });

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

export async function deleteOidcProvider(slug: string) {
  await prisma.client.oidcProvider.deleteMany({ where: { slug } });
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

    const memberships = await tx.teamUser.findMany({
      where: { userId, teamId: { in: [...teams.keys()] } },
    });

    for (const [teamId, teamRole] of teams) {
      const current = memberships.filter(membership => membership.teamId === teamId);

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

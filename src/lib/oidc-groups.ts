import { ROLES, TEAM_ROLE_RANK } from '@/lib/constants';

export const USER_ROLES = [ROLES.admin, ROLES.user, ROLES.viewOnly] as const;
export const TEAM_ROLES = [
  ROLES.teamOwner,
  ROLES.teamManager,
  ROLES.teamMember,
  ROLES.teamViewOnly,
] as const;

type UserRole = (typeof USER_ROLES)[number];
type TeamRole = (typeof TEAM_ROLES)[number];

/**
 * One row of a provider's mapping. A group can grant a role, a team membership, both, or only the
 * right to sign in.
 */
export type GroupMapping = { group: string; role: UserRole | null } & (
  | { teamId: string; teamRole: TeamRole }
  | { teamId: null; teamRole: null }
);

export interface GroupMappingResult {
  allowed: boolean;
  /** The role the user gets, or undefined when no mapping of the provider grants a role. */
  role?: UserRole;
  /** The role in each team the mapping names, or null where the user's membership ends. */
  teams: Map<string, TeamRole | null>;
}

const USER_ROLE_RANK: Record<UserRole, number> = {
  [ROLES.viewOnly]: 0,
  [ROLES.user]: 1,
  [ROLES.admin]: 2,
};

/**
 * The groups in a provider's profile. A provider can send the claim as a list or as one value, and
 * Keycloak leaves it out for a user in no group.
 */
export function readGroups(profile: Record<string, unknown>, claim: string): string[] {
  const value = profile?.[claim];

  if (Array.isArray(value)) {
    return value.filter(group => typeof group === 'string');
  }

  return typeof value === 'string' && value ? [value] : [];
}

function highest<T extends string>(roles: T[], rank: Record<T, number>): T | undefined {
  return roles.reduce<T | undefined>(
    (best, role) => (best === undefined || rank[role] > rank[best] ? role : best),
    undefined,
  );
}

/**
 * Decides what a sign-in through a provider grants. Without mappings every user may sign in and
 * nothing changes. With mappings only members of a mapped group may sign in. Where several groups
 * apply, the most privileged role wins, for the Umami role and per team. A user in no group that
 * grants a role gets the default role, and loses the membership of every mapped team that no group
 * grants.
 */
export function mapGroups(groups: string[], mappings: GroupMapping[]): GroupMappingResult {
  const teams = new Map<string, TeamRole | null>();

  if (!mappings.length) {
    return { allowed: true, teams };
  }

  const member = new Set(groups);
  const matched = mappings.filter(({ group }) => member.has(group));

  for (const { teamId } of mappings) {
    if (teamId) {
      teams.set(teamId, null);
    }
  }

  for (const { teamId, teamRole } of matched) {
    if (teamId) {
      teams.set(teamId, highest([teams.get(teamId), teamRole].filter(Boolean), TEAM_ROLE_RANK));
    }
  }

  const grantsRoles = mappings.some(({ role }) => role);
  const role = highest(matched.map(({ role }) => role).filter(Boolean), USER_ROLE_RANK);

  return {
    allowed: matched.length > 0,
    role: grantsRoles ? (role ?? ROLES.user) : undefined,
    teams,
  };
}

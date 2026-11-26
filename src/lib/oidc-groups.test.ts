import { describe, expect, test } from 'vitest';
import { type GroupMapping, mapGroups, readGroups } from './oidc-groups';

const TEAM_A = '00000000-0000-0000-0000-00000000000a';
const TEAM_B = '00000000-0000-0000-0000-00000000000b';

function role(group: string, role: GroupMapping['role']): GroupMapping {
  return { group, role, teamId: null, teamRole: null };
}

function team(group: string, teamId: string, teamRole: any): GroupMapping {
  return { group, role: null, teamId, teamRole };
}

describe('readGroups', () => {
  test('reads a list of groups', () => {
    expect(readGroups({ groups: ['/umami-admins', '/staff/devs'] }, 'groups')).toEqual([
      '/umami-admins',
      '/staff/devs',
    ]);
  });

  test('reads a single group sent as a string', () => {
    expect(readGroups({ roles: 'umami-admins' }, 'roles')).toEqual(['umami-admins']);
  });

  test('reads no groups when the claim is missing, as Keycloak sends it for a user in no group', () => {
    expect(readGroups({ sub: 'subject-1' }, 'groups')).toEqual([]);
  });

  test('ignores values that are not strings', () => {
    expect(readGroups({ groups: ['a', 1, null, { b: 2 }] }, 'groups')).toEqual(['a']);
  });
});

describe('mapGroups', () => {
  test('lets everyone sign in and changes nothing when the provider has no mappings', () => {
    expect(mapGroups(['/anything'], [])).toEqual({ allowed: true, teams: new Map() });
    expect(mapGroups([], [])).toEqual({ allowed: true, teams: new Map() });
  });

  test('refuses a user in none of the mapped groups', () => {
    const mappings = [role('/umami-admins', 'admin'), team('/team-a', TEAM_A, 'team-member')];

    expect(mapGroups(['/other'], mappings).allowed).toBe(false);
  });

  test('refuses a user whose provider sent no groups claim', () => {
    const mappings = [role('/umami-users', 'user')];

    expect(mapGroups(readGroups({ sub: 'subject-1' }, 'groups'), mappings).allowed).toBe(false);
  });

  test('matches a group exactly, so a Keycloak path does not match its last segment', () => {
    expect(mapGroups(['/staff/devs'], [role('devs', 'admin')]).allowed).toBe(false);
    expect(mapGroups(['/staff/devs'], [role('/staff/devs', 'admin')])).toMatchObject({
      allowed: true,
      role: 'admin',
    });
  });

  test.each([
    [['/admins', '/users'], 'admin'],
    [['/users', '/viewers'], 'user'],
    [['/viewers', '/admins'], 'admin'],
    [['/viewers'], 'view-only'],
  ])('gives a user in %j the most privileged role, %s', (groups, expected) => {
    const mappings = [
      role('/viewers', 'view-only'),
      role('/users', 'user'),
      role('/admins', 'admin'),
    ];

    expect(mapGroups(groups, mappings).role).toBe(expected);
  });

  test('gives the default role to a user whose groups grant no role, when other groups do', () => {
    const mappings = [role('/admins', 'admin'), team('/team-a', TEAM_A, 'team-member')];

    expect(mapGroups(['/team-a'], mappings)).toMatchObject({ allowed: true, role: 'user' });
  });

  test('leaves the role alone when no mapping of the provider grants one', () => {
    const result = mapGroups(['/team-a'], [team('/team-a', TEAM_A, 'team-member')]);

    expect(result.allowed).toBe(true);
    expect(result.role).toBeUndefined();
  });

  test('lets a group grant only the right to sign in', () => {
    expect(mapGroups(['/umami'], [role('/umami', null)])).toEqual({
      allowed: true,
      teams: new Map(),
    });
  });

  test.each([
    [['/owners', '/managers', '/members'], 'team-owner'],
    [['/members', '/managers'], 'team-manager'],
    [['/members', '/viewers'], 'team-member'],
    [['/viewers'], 'team-view-only'],
  ])('gives a user in %j the most privileged role in a team, %s', (groups, expected) => {
    const mappings = [
      team('/viewers', TEAM_A, 'team-view-only'),
      team('/members', TEAM_A, 'team-member'),
      team('/managers', TEAM_A, 'team-manager'),
      team('/owners', TEAM_A, 'team-owner'),
    ];

    expect(mapGroups(groups, mappings).teams).toEqual(new Map([[TEAM_A, expected]]));
  });

  test('decides each team on its own, and ends the membership in a mapped team no group grants', () => {
    const mappings = [
      team('/team-a-managers', TEAM_A, 'team-manager'),
      team('/team-b', TEAM_B, 'team-member'),
      { group: '/team-a-admins', role: 'admin', teamId: TEAM_A, teamRole: 'team-owner' },
    ] as GroupMapping[];

    expect(mapGroups(['/team-a-managers'], mappings)).toEqual({
      allowed: true,
      role: 'user',
      teams: new Map([
        [TEAM_A, 'team-manager'],
        [TEAM_B, null],
      ]),
    });
    expect(mapGroups(['/team-a-admins', '/team-a-managers', '/team-b'], mappings)).toEqual({
      allowed: true,
      role: 'admin',
      teams: new Map([
        [TEAM_A, 'team-owner'],
        [TEAM_B, 'team-member'],
      ]),
    });
  });
});

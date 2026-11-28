import { beforeEach, expect, test, vi } from 'vitest';
import { applyGroupMapping, createOidcProvider, updateOidcProvider } from './oidcProvider';

const tx = vi.hoisted(() => ({
  oidcProvider: {
    create: vi.fn(async () => ({ id: 'provider-1' })),
    update: vi.fn(async () => ({ id: 'provider-1' })),
  },
  oidcGroupMapping: { deleteMany: vi.fn(), createMany: vi.fn() },
  user: { update: vi.fn() },
  team: { findMany: vi.fn(async () => [{ id: 'team-kept' }]) },
  teamUser: {
    findMany: vi.fn(async () => []),
    create: vi.fn(),
    deleteMany: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock('@/lib/prisma', () => ({
  default: { transaction: (callback: (client: typeof tx) => Promise<void>) => callback(tx) },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

test('updateOidcProvider keeps the order of the mappings', async () => {
  const groups = ['/c', '/a', '/b'];

  await updateOidcProvider(
    'authentik',
    {},
    groups.map(group => ({ group, role: 'user', teamId: null, teamRole: null })),
  );

  const [{ data }] = tx.oidcGroupMapping.createMany.mock.calls[0] as any;

  expect(tx.oidcGroupMapping.deleteMany).toHaveBeenCalledWith({
    where: { oidcProviderId: 'provider-1' },
  });
  expect(data.map(({ group, position }) => [group, position])).toEqual([
    ['/c', 0],
    ['/a', 1],
    ['/b', 2],
  ]);
});

test('createOidcProvider leaves a provider with the same slug alone', async () => {
  tx.oidcProvider.create.mockRejectedValueOnce(
    Object.assign(new Error('Unique constraint failed on the fields: (`slug`)'), { code: 'P2002' }),
  );

  expect(await createOidcProvider('authentik', { name: 'Authentik' })).toBe(false);
  expect(tx.oidcProvider.update).not.toHaveBeenCalled();
  expect(tx.oidcGroupMapping.deleteMany).not.toHaveBeenCalled();
});

test('applyGroupMapping adds no membership in a team that no longer exists', async () => {
  await applyGroupMapping('user-1', {
    allowed: true,
    teams: new Map([
      ['team-kept', 'team-member'],
      ['team-deleted', 'team-member'],
    ]),
  } as any);

  expect(tx.teamUser.create).toHaveBeenCalledTimes(1);
  expect(tx.teamUser.create).toHaveBeenCalledWith({
    data: expect.objectContaining({ userId: 'user-1', teamId: 'team-kept' }),
  });
});

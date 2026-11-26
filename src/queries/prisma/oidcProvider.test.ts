import { expect, test, vi } from 'vitest';
import { saveOidcProvider } from './oidcProvider';

const tx = vi.hoisted(() => ({
  oidcProvider: { upsert: vi.fn(async () => ({ id: 'provider-1' })) },
  oidcGroupMapping: { deleteMany: vi.fn(), createMany: vi.fn() },
}));

vi.mock('@/lib/prisma', () => ({
  default: { transaction: (callback: (client: typeof tx) => Promise<void>) => callback(tx) },
}));

test('saveOidcProvider keeps the order of the mappings', async () => {
  const groups = ['/c', '/a', '/b'];

  await saveOidcProvider(
    'authentik',
    {},
    groups.map(group => ({ group, role: 'user', teamId: null, teamRole: null })),
  );

  const [{ data }] = tx.oidcGroupMapping.createMany.mock.calls[0] as any;
  const sorted = [...data].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  expect(tx.oidcGroupMapping.deleteMany).toHaveBeenCalledWith({
    where: { oidcProviderId: 'provider-1' },
  });
  expect(sorted.map(({ group }) => group)).toEqual(groups);
});

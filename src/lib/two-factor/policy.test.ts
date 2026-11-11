import { beforeEach, expect, test, vi } from 'vitest';
import { isTwoFactorSetupRequired } from './policy';

const mocks = vi.hoisted(() => ({
  findAppSetting: vi.fn(),
  findUser: vi.fn(),
  findTeamUsers: vi.fn(),
  findTeams: vi.fn(),
  findTwoFactorAuth: vi.fn(),
  isTwoFactorConfigured: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      appSetting: { findUnique: mocks.findAppSetting },
      user: { findUnique: mocks.findUser },
      teamUser: { findMany: mocks.findTeamUsers },
      team: { findMany: mocks.findTeams },
      twoFactorAuth: { findUnique: mocks.findTwoFactorAuth },
    },
  },
}));

vi.mock('@/lib/two-factor/crypto', () => ({
  isTwoFactorConfigured: mocks.isTwoFactorConfigured,
}));

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('CLOUD_MODE', '');
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }

  mocks.isTwoFactorConfigured.mockReturnValue(true);
  mocks.findAppSetting.mockResolvedValue(null);
  mocks.findUser.mockResolvedValue({ twoFactorRequired: false });
  mocks.findTeamUsers.mockResolvedValue([]);
  mocks.findTeams.mockResolvedValue([]);
  mocks.findTwoFactorAuth.mockResolvedValue(null);
});

test('requires setup when 2FA is required but not set up', async () => {
  // Applies to every way of signing in, not only to the UI's setup modal.
  mocks.findUser.mockResolvedValue({ twoFactorRequired: true });

  expect(await isTwoFactorSetupRequired('user-1')).toBe(true);
});

test('requires setup when it was started but not confirmed', async () => {
  mocks.findAppSetting.mockResolvedValue({ value: 'true' });
  mocks.findTwoFactorAuth.mockResolvedValue({ isEnabled: false });

  expect(await isTwoFactorSetupRequired('user-1')).toBe(true);
});

test('does not require setup when 2FA is not required', async () => {
  expect(await isTwoFactorSetupRequired('user-1')).toBe(false);
});

test('does not require setup once 2FA is enabled', async () => {
  mocks.findAppSetting.mockResolvedValue({ value: 'true' });
  mocks.findTwoFactorAuth.mockResolvedValue({ isEnabled: true });

  expect(await isTwoFactorSetupRequired('user-1')).toBe(false);
});

test('does not require setup when 2FA cannot be configured', async () => {
  // Without an encryption key users cannot set up 2FA, so restricting them would lock them out.
  mocks.findAppSetting.mockResolvedValue({ value: 'true' });
  mocks.isTwoFactorConfigured.mockReturnValue(false);

  expect(await isTwoFactorSetupRequired('user-1')).toBe(false);
});

test('does not require setup in cloud mode', async () => {
  vi.stubEnv('CLOUD_MODE', '1');
  mocks.findAppSetting.mockResolvedValue({ value: 'true' });

  expect(await isTwoFactorSetupRequired('user-1')).toBe(false);
});

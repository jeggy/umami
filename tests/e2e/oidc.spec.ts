import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { addUser, loginViaApi, logout, umamiUser } from './helpers';

// Set by `pnpm test:e2e:docker:oidc`, which starts umami with a mock OpenID Connect provider.
const IDP_HOST = process.env.UMAMI_TEST_OIDC_HOST;

test.skip(!IDP_HOST, 'Needs the mock OIDC provider: run pnpm test:e2e:docker:oidc');

// umami calls the provider by its Compose service name, and the provider puts the host it was
// called by into its issuer. Resolving that name to the published port gives the browser the
// same issuer as umami.
test.use(
  IDP_HOST ? { launchOptions: { args: [`--host-resolver-rules=MAP ${IDP_HOST} 127.0.0.1`] } } : {},
);

// better-auth allows 3 sign-in starts per 10 seconds from one client address, and these tests
// start more than that. Each test sends its own address, as users behind a reverse proxy do.
let clients = 0;

test.beforeEach(async ({ page }, testInfo) => {
  clients += 1;
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${testInfo.workerIndex % 256}.${testInfo.retry}.${clients}`,
  });
});

// Unique per run, so a kept stack can run the spec again.
const RUN = Date.now().toString(36);

type Claims = Record<string, unknown>;

async function signInWithIdp(page: Page, subject: string, claims: Claims) {
  await page.goto('/login');
  await page.getByTestId('button-login-external').click();
  await submitIdpForm(page, subject, claims);
  await expect(page).toHaveURL(/\/websites$/);
}

// The provider's interactive login form takes the subject and the extra claims of the tokens.
async function submitIdpForm(page: Page, subject: string, claims: Claims) {
  await expect(page).toHaveURL(new RegExp(`^http://${IDP_HOST}:\\d+/`));
  await page.locator('input[name="username"]').fill(subject);
  await page.locator('textarea[name="claims"]').fill(JSON.stringify(claims));
  await page.getByRole('button', { name: 'Sign-in' }).click();
}

function isIdpRequest(url: string) {
  return url.startsWith(`http://${IDP_HOST}:`);
}

async function currentUser(page: Page) {
  const response = await page.request.get('/api/me');

  expect(response.status()).toBe(200);

  return (await response.json()).user;
}

async function usersNamed(request: APIRequestContext, username: string) {
  const admin = await loginViaApi(request);
  const response = await request.get('/api/admin/users', {
    headers: { Authorization: admin.authorization },
    params: { search: username },
  });

  expect(response.status()).toBe(200);

  const { data } = await response.json();

  return data.filter((user: { username: string }) => user.username === username);
}

test.describe
  .serial('OIDC sign-in', () => {
    const subject = `idp-subject-${RUN}`;
    const username = `idp-user-${RUN}`;
    const claims = {
      preferred_username: username,
      name: 'IdP User',
      email: `${username}@example.com`,
    };
    let userId: string;

    test('creates a user for an unknown IdP account', async ({ page }) => {
      await signInWithIdp(page, subject, claims);

      const user = await currentUser(page);

      expect(user.username).toBe(username);
      expect(user.role).toBe('user');
      userId = user.id;
    });

    test('signs the same IdP account in as the same user again', async ({ page, request }) => {
      await signInWithIdp(page, subject, claims);
      expect((await currentUser(page)).id).toBe(userId);

      // Logout passes through the provider's end-session endpoint, which returns to the login page.
      const endSession = page.waitForRequest(
        request =>
          isIdpRequest(request.url()) && new URL(request.url()).pathname.endsWith('/endsession'),
      );
      await logout(page);

      const params = new URL((await endSession).url()).searchParams;

      expect(params.get('id_token_hint')).toBeTruthy();
      expect(params.get('client_id')).toBe('umami');
      expect(params.get('post_logout_redirect_uri')).toMatch(/^http:\/\/localhost:\d+\/login$/);
      expect((await page.request.get('/api/me')).status()).toBe(401);

      await signInWithIdp(page, subject, claims);
      expect((await currentUser(page)).id).toBe(userId);
      expect(await usersNamed(request, username)).toHaveLength(1);
    });
  });

test('signs a local user in through the IdP account they linked', async ({ page, request }) => {
  const localUsername = `local-user-${RUN}`;
  const localPassword = 'local-user-password';
  // A username unlike the local one shows the sign-in follows the link, not a name match.
  const linkedSubject = `idp-linked-${RUN}`;
  const linkedClaims = {
    preferred_username: `idp-linked-name-${RUN}`,
    email: `linked-${RUN}@example.com`,
  };

  await addUser(request, await loginViaApi(request), localUsername, localPassword, 'user');
  await loginViaApi(page.context().request, localUsername, localPassword);
  const localUser = await currentUser(page);

  await page.goto('/settings/security');
  await page.getByTestId('button-link-account').click();
  await submitIdpForm(page, linkedSubject, linkedClaims);
  await expect(page).toHaveURL(/\/settings\/security$/);
  await expect(page.getByTestId('button-unlink-account')).toBeVisible();

  // This session began with the password, so logout leaves the provider session alone, even
  // though the user now has a linked account.
  const idpRequests: string[] = [];
  page.on('request', request => {
    if (isIdpRequest(request.url())) {
      idpRequests.push(request.url());
    }
  });
  await logout(page);
  expect(idpRequests).toEqual([]);
  page.removeAllListeners('request');

  await signInWithIdp(page, linkedSubject, linkedClaims);
  expect((await currentUser(page)).id).toBe(localUser.id);
  expect(await usersNamed(request, `idp-linked-name-${RUN}`)).toHaveLength(0);
});

test('keeps password sign-in working beside OIDC', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByTestId('button-login-external')).toBeVisible();

  await page.getByTestId('input-username').locator('input').fill(umamiUser.username);
  await page.getByTestId('input-password').locator('input').fill(umamiUser.password);
  await page.getByTestId('button-submit').click();

  await expect(page).toHaveURL(/\/websites$/);
  expect((await currentUser(page)).username).toBe(umamiUser.username);
});

// A second provider, added through the admin API, on another issuer of the same mock server. Its
// group mapping applies only to its own sign-ins, so the tests above stay unmapped.
test.describe
  .serial('group mapping of a provider added by an administrator', () => {
    const slug = `second-${RUN}`;
    const name = `Second IdP ${RUN}`;
    const issuer = `http://${IDP_HOST}:${process.env.UMAMI_TEST_OIDC_PORT || '3390'}/second`;
    let teamId: string;

    async function admin(request: APIRequestContext) {
      return { Authorization: (await loginViaApi(request)).authorization };
    }

    async function signInWithSecond(page: Page, subject: string, claims: Claims) {
      await page.goto('/login');
      await page.getByRole('button', { name: `Sign in with ${name}`, exact: true }).click();
      await submitIdpForm(page, subject, claims);
    }

    async function teamRole(request: APIRequestContext, username: string) {
      const response = await request.get(`/api/teams/${teamId}/users`, {
        headers: await admin(request),
      });
      const { data } = await response.json();

      return data.find((row: Record<string, any>) => row.user?.username === username)?.role ?? null;
    }

    test.beforeAll(async ({ request }) => {
      const headers = await admin(request);
      const team = await request.post('/api/teams', { headers, data: { name: `Mapped ${RUN}` } });

      teamId = (await team.json())[0].id;

      const provider = await request.post('/api/admin/oidc-providers', {
        headers,
        data: {
          slug,
          name,
          discoveryUrl: `${issuer}/.well-known/openid-configuration`,
          clientId: 'umami-second',
          clientSecret: 'umami-second-secret',
          mappings: [
            { group: 'admins', role: 'admin', teamId: null, teamRole: null },
            { group: 'staff', role: 'user', teamId, teamRole: 'team-member' },
            { group: 'leads', role: null, teamId, teamRole: 'team-manager' },
          ],
        },
      });

      expect(provider.status()).toBe(200);
    });

    test.afterAll(async ({ request }) => {
      const headers = await admin(request);

      await request.delete(`/api/admin/oidc-providers/${slug}`, { headers });
      await request.delete(`/api/teams/${teamId}`, { headers });
    });

    test('the groups decide the role and the team role at every sign-in', async ({
      page,
      request,
    }) => {
      const username = `mapped-${RUN}`;
      const claims = { preferred_username: username, email: `${username}@example.com` };

      await signInWithSecond(page, username, { ...claims, groups: ['admins', 'leads'] });
      await expect(page).toHaveURL(/\/websites$/);
      expect((await currentUser(page)).role).toBe('admin');
      expect(await teamRole(request, username)).toBe('team-manager');

      // Logout ends the session at the provider the user signed in through, as its own client.
      const endSession = page.waitForRequest(r => r.url().startsWith(`${issuer}/endsession`));
      await logout(page);
      expect(new URL((await endSession).url()).searchParams.get('client_id')).toBe('umami-second');

      await signInWithSecond(page, username, { ...claims, groups: ['staff'] });
      await expect(page).toHaveURL(/\/websites$/);
      expect((await currentUser(page)).role).toBe('user');
      expect(await teamRole(request, username)).toBe('team-member');
    });

    test('a user in none of the mapped groups is refused with a message', async ({ page }) => {
      const username = `unmapped-${RUN}`;

      await signInWithSecond(page, username, { preferred_username: username, groups: ['other'] });

      await expect(page).toHaveURL(/\/login\?.*error=group_not_allowed/);
      await expect(page.getByText(`Your ${name} account is in none of the groups`)).toBeVisible();
      expect((await page.request.get('/api/me')).status()).toBe(401);
    });
  });

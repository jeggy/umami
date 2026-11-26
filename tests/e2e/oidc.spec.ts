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

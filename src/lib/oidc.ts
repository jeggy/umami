import { OIDC_PROVIDER_ID } from '@/lib/constants';
import { decrypt, md5, secret } from '@/lib/crypto';
import { parseBooleanEnv } from '@/lib/env';
import type { GroupMapping } from '@/lib/oidc-groups';
import { findOidcProviders, type OidcProviderRow } from '@/queries/prisma/oidcProvider';

const DEFAULT_PROVIDER_NAME = 'SSO';
const DEFAULT_SCOPES = 'openid profile email';
const DEFAULT_GROUPS_CLAIM = 'groups';

// Another Umami instance sees a change made in the app within this time.
const CACHE_TTL = 5000;
const OIDC_PROVIDERS = 'umami-oidc-providers';

/** The environment variable behind each setting of the provider with the slug "oidc". */
const OIDC_ENV_VARS = {
  name: 'OIDC_PROVIDER_NAME',
  discoveryUrl: 'OIDC_DISCOVERY_URL',
  clientId: 'OIDC_CLIENT_ID',
  clientSecret: 'OIDC_CLIENT_SECRET',
  scopes: 'OIDC_SCOPES',
  disableSignup: 'OIDC_DISABLE_SIGNUP',
  disableProviderLogout: 'OIDC_DISABLE_PROVIDER_LOGOUT',
} as const;

type OidcEnvField = keyof typeof OIDC_ENV_VARS;

/**
 * A stored client secret is unreadable when it was encrypted with another APP_SECRET. The
 * administrator then enters it again.
 */
type OidcClientSecret =
  | { status: 'set'; value: string }
  | { status: 'missing' }
  | { status: 'unreadable' };

/** A provider's stored settings, with the client secret decrypted. */
export interface StoredOidcProvider {
  slug: string;
  name: string | null;
  discoveryUrl: string | null;
  clientId: string | null;
  clientSecret: OidcClientSecret;
  scopes: string | null;
  groupsClaim: string;
  disableSignup: boolean;
  disableProviderLogout: boolean;
  mappings: GroupMapping[];
}

/** A provider with its defaults filled in and the environment variables applied. */
export interface OidcProvider extends Omit<StoredOidcProvider, 'name' | 'scopes'> {
  name: string;
  scopes: string;
  /** The environment variable behind each setting it sets. Those settings are read-only in the app. */
  lockedBy: Partial<Record<OidcEnvField, string>>;
  /** Whether the provider has a stored row, as every provider not set up by environment does. */
  stored: boolean;
}

type EnvSettings = Partial<Omit<StoredOidcProvider, 'slug' | 'groupsClaim' | 'mappings'>>;

function readEnvSettings(env: Record<string, string | undefined>): EnvSettings {
  const text = (field: OidcEnvField) => env[OIDC_ENV_VARS[field]] || undefined;
  const flag = (field: OidcEnvField) => parseBooleanEnv(env[OIDC_ENV_VARS[field]]);
  const clientSecret = text('clientSecret');

  const settings: EnvSettings = {
    name: text('name'),
    discoveryUrl: text('discoveryUrl'),
    clientId: text('clientId'),
    clientSecret: clientSecret && { status: 'set', value: clientSecret },
    scopes: text('scopes'),
    disableSignup: flag('disableSignup'),
    disableProviderLogout: flag('disableProviderLogout'),
  };

  return Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined));
}

function resolveProvider(
  stored: StoredOidcProvider | undefined,
  slug: string,
  env: EnvSettings = {},
): OidcProvider {
  return {
    slug,
    name: env.name ?? stored?.name ?? DEFAULT_PROVIDER_NAME,
    discoveryUrl: env.discoveryUrl ?? stored?.discoveryUrl ?? null,
    clientId: env.clientId ?? stored?.clientId ?? null,
    clientSecret: env.clientSecret ?? stored?.clientSecret ?? { status: 'missing' },
    scopes: env.scopes ?? stored?.scopes ?? DEFAULT_SCOPES,
    groupsClaim: stored?.groupsClaim || DEFAULT_GROUPS_CLAIM,
    disableSignup: env.disableSignup ?? stored?.disableSignup ?? false,
    disableProviderLogout: env.disableProviderLogout ?? stored?.disableProviderLogout ?? false,
    mappings: stored?.mappings ?? [],
    lockedBy: Object.fromEntries(Object.keys(env).map(field => [field, OIDC_ENV_VARS[field]])),
    stored: !!stored,
  };
}

/**
 * Merges the provider from the OIDC_* environment variables with the stored providers. The
 * environment provider has the slug "oidc", and a stored row with that slug holds its mappings and
 * the settings the environment leaves unset. Where both set a value, the environment wins.
 */
export function resolveProviders(
  env: Record<string, string | undefined>,
  rows: StoredOidcProvider[],
): OidcProvider[] {
  const envSettings = readEnvSettings(env);
  const envRow = rows.find(({ slug }) => slug === OIDC_PROVIDER_ID);
  const envProvider =
    envRow || Object.keys(envSettings).length
      ? [resolveProvider(envRow, OIDC_PROVIDER_ID, envSettings)]
      : [];

  return [
    ...envProvider,
    ...rows.filter(row => row !== envRow).map(row => resolveProvider(row, row.slug)),
  ];
}

/** Sign-in through a provider is offered once its discovery URL and client credentials are set. */
export function isUsable(provider: OidcProvider) {
  return !!provider.discoveryUrl && !!provider.clientId && provider.clientSecret.status === 'set';
}

function decryptSecret(value: string | null): OidcClientSecret {
  if (!value) {
    return { status: 'missing' };
  }

  try {
    return { status: 'set', value: decrypt(value, secret()) };
  } catch {
    return { status: 'unreadable' };
  }
}

function toStoredProvider({ groupMappings, clientSecret, ...row }: OidcProviderRow) {
  return {
    ...row,
    clientSecret: decryptSecret(clientSecret),
    mappings: groupMappings.map(({ group, role, teamId, teamRole }) => ({
      group,
      role,
      teamId,
      teamRole,
    })) as GroupMapping[],
  };
}

// Shared by every copy of this module that Next.js loads, so that a change saved through the API
// reaches the login page and the auth routes at once.
globalThis[OIDC_PROVIDERS] ??= { version: 0 };

const state: {
  cache?: { key: string; providers: OidcProvider[]; checkedAt: number };
  version: number;
} = globalThis[OIDC_PROVIDERS];

/**
 * Every OIDC provider, usable or not. The result is read again at most every few seconds, and it
 * is the same array until the configuration changes.
 */
export async function getOidcProviders(): Promise<OidcProvider[]> {
  if (process.env.CLOUD_MODE) {
    return [];
  }

  const { cache, version } = state;

  if (cache && Date.now() - cache.checkedAt < CACHE_TTL) {
    return cache.providers;
  }

  const rows = await findOidcProviders();
  const key = JSON.stringify(rows);
  const providers =
    cache?.key === key
      ? cache.providers
      : resolveProviders(process.env, rows.map(toStoredProvider));

  // A change saved during the read has made it stale.
  if (state.version === version) {
    state.cache = { key, providers, checkedAt: Date.now() };
  }

  return providers;
}

/** Makes the next read see a change this instance saved. */
export function invalidateOidcProviders() {
  state.cache = undefined;
  state.version++;
}

export async function getOidcProvider(slug: string) {
  return (await getOidcProviders()).find(provider => provider.slug === slug);
}

/** The providers on the login page. */
export async function getLoginProviders() {
  return (await getOidcProviders()).filter(isUsable).map(({ slug, name }) => ({ slug, name }));
}

export function mapProfileToUser(profile: Record<string, any>) {
  // Umami identifies users by username; the email and the subject are the fallbacks for providers
  // that do not send preferred_username.
  const username = String(profile.preferred_username || profile.email || profile.sub).toLowerCase();

  return {
    username,
    displayUsername: username,
    name: profile.name || username,
    // Umami does not use email addresses, so a user without one gets a placeholder like the users
    // created in Umami itself.
    ...(!profile.email && { email: `${md5(String(profile.sub))}@placeholder.local` }),
  };
}

/** The genericOAuth configuration of a usable provider. */
export function getGenericOAuthConfig(provider: OidcProvider) {
  return {
    providerId: provider.slug,
    discoveryUrl: provider.discoveryUrl,
    clientId: provider.clientId,
    clientSecret: provider.clientSecret.status === 'set' ? provider.clientSecret.value : undefined,
    scopes: provider.scopes.split(/\s+/).filter(Boolean),
    pkce: true,
    // Only users who have already linked their account can sign in.
    disableSignUp: provider.disableSignup,
    // Logout also ends the session at the provider, when its discovery document has an
    // end_session_endpoint.
    disableProviderLogout: provider.disableProviderLogout,
    mapProfileToUser,
  };
}

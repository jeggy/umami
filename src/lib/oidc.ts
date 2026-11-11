import { OIDC_PROVIDER_ID } from '@/lib/constants';
import { md5 } from '@/lib/crypto';

const DEFAULT_PROVIDER_NAME = 'SSO';
const DEFAULT_SCOPES = 'openid profile email';

/** OIDC sign-in is offered when the provider's discovery URL and client credentials are set. */
export function isOidcConfigured(): boolean {
  return (
    !process.env.CLOUD_MODE &&
    !!process.env.OIDC_DISCOVERY_URL &&
    !!process.env.OIDC_CLIENT_ID &&
    !!process.env.OIDC_CLIENT_SECRET
  );
}

export function getOidcProviderName(): string {
  return process.env.OIDC_PROVIDER_NAME || DEFAULT_PROVIDER_NAME;
}

export function getOidcConfig() {
  return {
    providerId: OIDC_PROVIDER_ID,
    discoveryUrl: process.env.OIDC_DISCOVERY_URL,
    clientId: process.env.OIDC_CLIENT_ID,
    clientSecret: process.env.OIDC_CLIENT_SECRET,
    scopes: (process.env.OIDC_SCOPES || DEFAULT_SCOPES).split(/\s+/).filter(Boolean),
    pkce: true,
    // Only users who have already linked their account can sign in.
    disableSignUp: !!process.env.OIDC_DISABLE_SIGNUP,
    mapProfileToUser: (profile: Record<string, any>) => {
      // Umami identifies users by username; the email and the subject are the fallbacks for
      // providers that do not send preferred_username.
      const username = String(
        profile.preferred_username || profile.email || profile.sub,
      ).toLowerCase();

      return {
        username,
        displayUsername: username,
        name: profile.name || username,
        // Umami does not use email addresses, so a user without one gets a placeholder like the
        // users created in Umami itself.
        ...(!profile.email && { email: `${md5(String(profile.sub))}@placeholder.local` }),
      };
    },
  };
}

import { isRelationalOnly } from '@/lib/db';
import { getLoginProviders } from '@/lib/oidc';

export type Config = {
  cloudMode: boolean;
  faviconUrl?: string;
  linksUrl?: string;
  /** The OIDC providers a user can sign in through. */
  oidcProviders: { slug: string; name: string }[];
  pixelsUrl?: string;
  privateMode: boolean;
  sessionDeletionEnabled: boolean;
  telemetryDisabled: boolean;
  trackerScriptName?: string;
  updatesDisabled: boolean;
};

/**
 * Server-side only. Reads runtime environment values that the client needs.
 * Must be called at request time (not build time) so Docker/runtime env is honored.
 */
export async function getConfig(): Promise<Config> {
  return {
    cloudMode: !!process.env.CLOUD_MODE,
    faviconUrl: process.env.FAVICON_URL,
    linksUrl: process.env.LINKS_URL,
    oidcProviders: await getLoginProviders(),
    pixelsUrl: process.env.PIXELS_URL,
    privateMode: !!process.env.PRIVATE_MODE,
    sessionDeletionEnabled: isRelationalOnly(),
    telemetryDisabled: !!process.env.DISABLE_TELEMETRY,
    trackerScriptName: process.env.TRACKER_SCRIPT_NAME,
    updatesDisabled: !!process.env.DISABLE_UPDATES,
  };
}

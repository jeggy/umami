import { z } from 'zod';
import { CREDENTIAL_PROVIDER_ID } from '@/lib/constants';
import { encrypt, secret } from '@/lib/crypto';
import type { OidcProvider } from '@/lib/oidc';
import { TEAM_ROLES, USER_ROLES } from '@/lib/oidc-groups';
import type { LastGroups, OidcProviderData } from '@/queries/prisma/oidcProvider';

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const oidcGroupMappingSchema = z
  .object({
    group: z.string().trim().min(1).max(255),
    role: z.enum(USER_ROLES).nullable(),
    teamId: z.uuid().nullable(),
    teamRole: z.enum(TEAM_ROLES).nullable(),
  })
  .refine(({ teamId, teamRole }) => !teamId === !teamRole, {
    message: 'A team needs a team role, and a team role needs a team.',
    path: ['teamRole'],
  });

/** The settings an administrator can change. A field left out keeps its value. */
export const oidcProviderSchema = z.object({
  name: optionalText(100),
  discoveryUrl: z.url().max(2183).nullable().optional(),
  clientId: optionalText(255),
  // Write-only: the API never returns it.
  clientSecret: z.string().min(1).max(1000).nullable().optional(),
  scopes: optionalText(500),
  groupsClaim: z.string().trim().min(1).max(100).optional(),
  disableSignup: z.boolean().optional(),
  disableProviderLogout: z.boolean().optional(),
  mappings: z.array(oidcGroupMappingSchema).max(500).optional(),
});

// The slug becomes better-auth's provider id and a path segment of the callback URL.
export const oidcProviderSlugSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-z0-9-]+$/)
  .refine(slug => slug !== CREDENTIAL_PROVIDER_ID, { message: 'This name is reserved.' });

export type OidcProviderInput = z.infer<typeof oidcProviderSchema>;

/**
 * The stored data for a change. Settings an environment variable sets are left out: the variable
 * wins over them anyway.
 */
export function toProviderData(
  { mappings: _, clientSecret, ...input }: OidcProviderInput,
  lockedBy: OidcProvider['lockedBy'] = {},
): OidcProviderData {
  const data: OidcProviderData = {
    ...input,
    ...(clientSecret !== undefined && {
      clientSecret: clientSecret && encrypt(clientSecret, secret()),
    }),
  };

  return Object.fromEntries(Object.entries(data).filter(([field]) => !(field in lockedBy)));
}

/** A provider as the API shows it: the client secret only as whether one is set. */
export function toProviderResponse(provider: OidcProvider, lastGroups?: LastGroups) {
  const { clientSecret, ...fields } = provider;

  return { ...fields, clientSecret: clientSecret.status, lastGroups: lastGroups ?? null };
}

export type OidcProviderResponse = ReturnType<typeof toProviderResponse>;

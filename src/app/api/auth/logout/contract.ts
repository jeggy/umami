import { z } from 'zod';
import { defineOperation } from '@/openapi/operation';
import { jsonResponse, unauthorizedResponse } from '@/openapi/schemas';

export const logoutResponseSchema = z
  .object({
    ok: z.boolean().describe('Whether the operation succeeded.'),
    redirect: z
      .url()
      .optional()
      .describe(
        "The provider's end-session URL, when the session came from a sign-in through an OpenID Connect provider that offers one. The browser goes there next, and the provider returns it to the login page.",
      ),
  })
  .meta({ id: 'LogoutResponse' });

const logoutOperation = defineOperation({
  method: 'post',
  path: '/api/auth/logout',
  audience: 'public',
  auth: 'bearer',
  operation: {
    operationId: 'logout',
    tags: ['Authentication'],
    responses: {
      '200': jsonResponse(logoutResponseSchema, 'The session has ended.'),
      '401': unauthorizedResponse,
    },
  },
});

export const operations = [logoutOperation] as const;

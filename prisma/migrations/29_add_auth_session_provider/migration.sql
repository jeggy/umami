-- The external provider a session's sign-in went through, null for a password sign-in. Logout
-- ends the provider's session only for sessions that came from it.

-- AlterTable
ALTER TABLE "auth_session" ADD COLUMN "provider_id" TEXT;

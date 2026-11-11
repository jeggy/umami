-- Move authentication to better-auth: extend the user table, add the
-- auth_session, account and verification tables, and copy the bcrypt password
-- hashes into credential account rows.

-- AlterTable
ALTER TABLE "user"
  ADD COLUMN "email" VARCHAR(320),
  ADD COLUMN "email_verified" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "display_username" VARCHAR(255);

-- Existing users have no email. Give each one a stable placeholder derived from
-- the immutable user id, and fill the fields better-auth requires to be set.
UPDATE "user" SET
  "email" = "user_id"::text || '@placeholder.local',
  "display_username" = "username";
UPDATE "user" SET "display_name" = "username" WHERE "display_name" IS NULL;

ALTER TABLE "user" ALTER COLUMN "email" SET NOT NULL;

-- The password now lives in the account table. The column is kept for one
-- release so the migration can be rolled back.
ALTER TABLE "user" ALTER COLUMN "password" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateTable
CREATE TABLE "auth_session" (
    "auth_session_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "ip_address" VARCHAR(100),
    "user_agent" TEXT,
    "two_factor_setup" BOOLEAN,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_session_pkey" PRIMARY KEY ("auth_session_id")
);

-- CreateTable
CREATE TABLE "account" (
    "account_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "access_token_expires_at" TIMESTAMPTZ(6),
    "refresh_token_expires_at" TIMESTAMPTZ(6),
    "scope" TEXT,
    "id_token" TEXT,
    "password" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_pkey" PRIMARY KEY ("account_id")
);

-- CreateTable
CREATE TABLE "verification" (
    "verification_id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("verification_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "auth_session_token_key" ON "auth_session"("token");

-- CreateIndex
CREATE INDEX "auth_session_user_id_idx" ON "auth_session"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_provider_id_provider_account_id_key" ON "account"("provider_id", "provider_account_id");

-- CreateIndex
CREATE INDEX "account_user_id_idx" ON "account"("user_id");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");

-- Copy the existing bcrypt hashes into credential account rows. better-auth is
-- configured to hash with bcrypt, so these keep verifying without a rehash.
-- account_id is derived from the unique user_id, which avoids depending on
-- gen_random_uuid() (PostgreSQL 13+ or pgcrypto).
INSERT INTO "account"
  ("account_id", "user_id", "provider_account_id", "provider_id", "password", "created_at", "updated_at")
SELECT
  md5("user_id"::text || ':credential'),
  "user_id",
  "user_id"::text,
  'credential',
  "password",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "user"
WHERE "password" IS NOT NULL;

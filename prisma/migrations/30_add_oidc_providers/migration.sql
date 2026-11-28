-- OIDC providers that administrators configure in the app, and the mapping from a provider's
-- groups claim to Umami roles and team memberships.

-- CreateTable
CREATE TABLE "oidc_provider" (
    "oidc_provider_id" UUID NOT NULL,
    "slug" VARCHAR(50) NOT NULL,
    "name" VARCHAR(100),
    "discovery_url" VARCHAR(2183),
    "client_id" VARCHAR(255),
    "client_secret" TEXT,
    "scopes" VARCHAR(500),
    "groups_claim" VARCHAR(100) NOT NULL DEFAULT 'groups',
    "disable_signup" BOOLEAN NOT NULL DEFAULT false,
    "disable_provider_logout" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "oidc_provider_pkey" PRIMARY KEY ("oidc_provider_id")
);

-- CreateTable
CREATE TABLE "oidc_group_mapping" (
    "oidc_group_mapping_id" UUID NOT NULL,
    "oidc_provider_id" UUID NOT NULL,
    "group" VARCHAR(255) NOT NULL,
    "role" VARCHAR(50),
    "team_id" UUID,
    "team_role" VARCHAR(50),
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "oidc_group_mapping_pkey" PRIMARY KEY ("oidc_group_mapping_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oidc_provider_slug_key" ON "oidc_provider"("slug");

-- CreateIndex
CREATE INDEX "oidc_group_mapping_oidc_provider_id_idx" ON "oidc_group_mapping"("oidc_provider_id");

-- CreateIndex
CREATE INDEX "oidc_group_mapping_team_id_idx" ON "oidc_group_mapping"("team_id");

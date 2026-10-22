-- CreateEnum
CREATE TYPE "SocialPlatform" AS ENUM ('TIKTOK', 'INSTAGRAM', 'FACEBOOK');

-- CreateEnum
CREATE TYPE "SocialConnectionStatus" AS ENUM ('DISCONNECTED', 'CONNECTING', 'CONNECTED', 'EXPIRED', 'INSUFFICIENT_PERMISSIONS', 'ERROR');

-- CreateTable
CREATE TABLE "SocialAccount" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "externalAccountId" VARCHAR(200) NOT NULL,
    "displayName" VARCHAR(200),
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "SocialConnectionStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "grantedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "connectedAt" TIMESTAMP(3),
    "tokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),
    "lastError" VARCHAR(2000),
    "accessTokenCiphertext" TEXT,
    "refreshTokenCiphertext" TEXT,
    "captionTemplates" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialOAuthState" (
    "id" UUID NOT NULL,
    "state" VARCHAR(128) NOT NULL,
    "projectId" UUID NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "redirectUri" VARCHAR(2048) NOT NULL,
    "codeVerifier" VARCHAR(200),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "SocialOAuthState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SocialAccount_projectId_platform_idx" ON "SocialAccount"("projectId", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "SocialAccount_projectId_platform_externalAccountId_key" ON "SocialAccount"("projectId", "platform", "externalAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "SocialOAuthState_state_key" ON "SocialOAuthState"("state");

-- CreateIndex
CREATE INDEX "SocialOAuthState_expiresAt_idx" ON "SocialOAuthState"("expiresAt");

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialOAuthState" ADD CONSTRAINT "SocialOAuthState_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

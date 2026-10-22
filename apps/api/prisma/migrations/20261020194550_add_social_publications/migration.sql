-- CreateEnum
CREATE TYPE "SocialPublicationStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'READY', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED', 'BLOCKED', 'OUTCOME_UNKNOWN');

-- CreateEnum
CREATE TYPE "SocialPublicationAttemptOutcome" AS ENUM ('SUCCESS', 'FAILED', 'BLOCKED', 'TIMEOUT');

-- CreateTable
CREATE TABLE "SocialPublication" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "quizVideoId" UUID NOT NULL,
    "socialAccountId" UUID NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "language" VARCHAR(10) NOT NULL,
    "caption" VARCHAR(2200) NOT NULL,
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "SocialPublicationStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduledAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "remotePostId" VARCHAR(200),
    "remoteUrl" VARCHAR(2048),
    "lastError" VARCHAR(2000),
    "createdBy" VARCHAR(200) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" VARCHAR(200),
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialPublication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialPublicationAttempt" (
    "id" UUID NOT NULL,
    "publicationId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "outcome" "SocialPublicationAttemptOutcome",
    "remoteStatus" VARCHAR(100),
    "errorCode" VARCHAR(100),
    "errorMessage" VARCHAR(2000),

    CONSTRAINT "SocialPublicationAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SocialPublication_requestId_key" ON "SocialPublication"("requestId");

-- CreateIndex
CREATE INDEX "SocialPublication_projectId_status_idx" ON "SocialPublication"("projectId", "status");

-- CreateIndex
CREATE INDEX "SocialPublication_quizVideoId_idx" ON "SocialPublication"("quizVideoId");

-- CreateIndex
CREATE INDEX "SocialPublication_socialAccountId_status_idx" ON "SocialPublication"("socialAccountId", "status");

-- CreateIndex
CREATE INDEX "SocialPublication_status_scheduledAt_idx" ON "SocialPublication"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "SocialPublication_status_nextAttemptAt_idx" ON "SocialPublication"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "SocialPublicationAttempt_publicationId_idx" ON "SocialPublicationAttempt"("publicationId");

-- AddForeignKey
ALTER TABLE "SocialPublication" ADD CONSTRAINT "SocialPublication_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPublication" ADD CONSTRAINT "SocialPublication_quizVideoId_fkey" FOREIGN KEY ("quizVideoId") REFERENCES "QuizVideo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPublication" ADD CONSTRAINT "SocialPublication_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPublicationAttempt" ADD CONSTRAINT "SocialPublicationAttempt_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "SocialPublication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

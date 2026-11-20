-- Étape 2 : modèle multi-projets et multi-types de vidéos.
-- Renomme les tables propres au quiz en tables génériques (les données existantes sont conservées)
-- et ajoute Brand et Program.

-- Nouvelles plateformes sociales
ALTER TYPE "SocialPlatform" ADD VALUE 'YOUTUBE';
ALTER TYPE "SocialPlatform" ADD VALUE 'SNAPCHAT';

-- Enums renommés
ALTER TYPE "QuizVideoStatus" RENAME TO "VideoStatus";
ALTER TYPE "QuizVideoValidationStatus" RENAME TO "VideoValidationStatus";

-- Brand
CREATE TABLE "Brand" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "websiteUrl" VARCHAR(2048),
    "logoKey" VARCHAR(500),
    "colors" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Brand_slug_key" ON "Brand"("slug");

-- Project
ALTER TABLE "Project" ADD COLUMN "brandId" UUID,
ADD COLUMN "language" VARCHAR(10),
ADD COLUMN "timezone" VARCHAR(64) NOT NULL DEFAULT 'Europe/Brussels',
ADD COLUMN "contentSource" VARCHAR(50),
ADD COLUMN "brandOverrides" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "Project" ADD CONSTRAINT "Project_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Program
CREATE TABLE "Program" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "videoType" VARCHAR(50) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "slots" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "daysOfWeek" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5, 6, 7]::INTEGER[],
    "minDurationSeconds" INTEGER NOT NULL DEFAULT 30,
    "maxDurationSeconds" INTEGER NOT NULL DEFAULT 60,
    "leadDays" INTEGER NOT NULL DEFAULT 1,
    "platforms" "SocialPlatform"[] DEFAULT ARRAY[]::"SocialPlatform"[],
    "params" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Program_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Program_enabled_idx" ON "Program"("enabled");
CREATE UNIQUE INDEX "Program_projectId_name_key" ON "Program"("projectId", "name");
ALTER TABLE "Program" ADD CONSTRAINT "Program_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- QuizVideo -> Video
ALTER TABLE "QuizVideo" RENAME TO "Video";
ALTER TABLE "Video" RENAME CONSTRAINT "QuizVideo_pkey" TO "Video_pkey";
ALTER TABLE "Video" RENAME CONSTRAINT "QuizVideo_projectId_fkey" TO "Video_projectId_fkey";
ALTER INDEX "QuizVideo_fileKey_key" RENAME TO "Video_fileKey_key";
ALTER INDEX "QuizVideo_projectId_createdAt_idx" RENAME TO "Video_projectId_createdAt_idx";
ALTER INDEX "QuizVideo_requestId_key" RENAME TO "Video_requestId_key";
ALTER INDEX "QuizVideo_sourceId_questionId_idx" RENAME TO "Video_sourceId_questionId_idx";
ALTER INDEX "QuizVideo_status_id_idx" RENAME TO "Video_status_id_idx";
ALTER TABLE "Video" ADD COLUMN "programId" UUID,
ADD COLUMN "videoType" VARCHAR(50) NOT NULL DEFAULT 'daily-quiz',
ADD COLUMN "title" VARCHAR(300),
ADD COLUMN "content" JSONB NOT NULL DEFAULT '{}',
ALTER COLUMN "sourceId" DROP NOT NULL,
ALTER COLUMN "origin" DROP NOT NULL,
ALTER COLUMN "questionId" DROP NOT NULL,
ALTER COLUMN "contentHash" DROP NOT NULL,
ALTER COLUMN "snapshotHash" DROP NOT NULL,
ALTER COLUMN "category" DROP NOT NULL,
ALTER COLUMN "snapshot" DROP NOT NULL,
ALTER COLUMN "fetchedAt" DROP NOT NULL;
CREATE INDEX "Video_programId_createdAt_idx" ON "Video"("programId", "createdAt");
CREATE INDEX "Video_projectId_videoType_createdAt_idx" ON "Video"("projectId", "videoType", "createdAt");
ALTER TABLE "Video" ADD CONSTRAINT "Video_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ScheduledQuizSlot -> ScheduledSlot
ALTER TABLE "ScheduledQuizSlot" RENAME TO "ScheduledSlot";
ALTER TABLE "ScheduledSlot" RENAME CONSTRAINT "ScheduledQuizSlot_pkey" TO "ScheduledSlot_pkey";
ALTER TABLE "ScheduledSlot" RENAME CONSTRAINT "ScheduledQuizSlot_projectId_fkey" TO "ScheduledSlot_projectId_fkey";
ALTER TABLE "ScheduledSlot" DROP CONSTRAINT "ScheduledQuizSlot_quizVideoId_fkey";
ALTER TABLE "ScheduledSlot" RENAME COLUMN "quizVideoId" TO "videoId";
-- Plusieurs programmes d'un même projet peuvent partager une heure : l'unicité porte désormais sur le programme.
DROP INDEX "ScheduledQuizSlot_projectId_scheduledDate_slotTime_language_key";
CREATE INDEX "ScheduledSlot_projectId_scheduledDate_idx" ON "ScheduledSlot"("projectId", "scheduledDate");
ALTER INDEX "ScheduledQuizSlot_quizVideoId_key" RENAME TO "ScheduledSlot_videoId_key";
ALTER INDEX "ScheduledQuizSlot_scheduledDate_status_idx" RENAME TO "ScheduledSlot_scheduledDate_status_idx";
ALTER TABLE "ScheduledSlot" ADD COLUMN "programId" UUID;
CREATE UNIQUE INDEX "ScheduledSlot_programId_scheduledDate_slotTime_key" ON "ScheduledSlot"("programId", "scheduledDate", "slotTime");
ALTER TABLE "ScheduledSlot" ADD CONSTRAINT "ScheduledSlot_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScheduledSlot" ADD CONSTRAINT "ScheduledSlot_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- SocialPublication.quizVideoId -> videoId
ALTER TABLE "SocialPublication" DROP CONSTRAINT "SocialPublication_quizVideoId_fkey";
ALTER TABLE "SocialPublication" RENAME COLUMN "quizVideoId" TO "videoId";
ALTER INDEX "SocialPublication_quizVideoId_idx" RENAME TO "SocialPublication_videoId_idx";
ALTER TABLE "SocialPublication" ADD CONSTRAINT "SocialPublication_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- QuizVideoPublicLink -> VideoPublicLink
ALTER TABLE "QuizVideoPublicLink" RENAME TO "VideoPublicLink";
ALTER TABLE "VideoPublicLink" RENAME CONSTRAINT "QuizVideoPublicLink_pkey" TO "VideoPublicLink_pkey";
ALTER TABLE "VideoPublicLink" DROP CONSTRAINT "QuizVideoPublicLink_quizVideoId_fkey";
ALTER TABLE "VideoPublicLink" RENAME COLUMN "quizVideoId" TO "videoId";
ALTER INDEX "QuizVideoPublicLink_expiresAt_idx" RENAME TO "VideoPublicLink_expiresAt_idx";
ALTER INDEX "QuizVideoPublicLink_quizVideoId_idx" RENAME TO "VideoPublicLink_videoId_idx";
ALTER INDEX "QuizVideoPublicLink_tokenHash_key" RENAME TO "VideoPublicLink_tokenHash_key";
ALTER TABLE "VideoPublicLink" ADD CONSTRAINT "VideoPublicLink_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

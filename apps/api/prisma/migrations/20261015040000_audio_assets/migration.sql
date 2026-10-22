-- CreateEnum
CREATE TYPE "AudioStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "ProjectVoice" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "language" VARCHAR(10) NOT NULL,
    "voiceId" VARCHAR(200) NOT NULL,
    "model" VARCHAR(200) NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectVoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudioAsset" (
    "id" UUID NOT NULL,
    "videoJobId" UUID NOT NULL,
    "videoScriptId" UUID NOT NULL,
    "scriptVersion" INTEGER NOT NULL,
    "provider" VARCHAR(50) NOT NULL,
    "language" VARCHAR(10) NOT NULL,
    "voiceId" VARCHAR(200) NOT NULL,
    "model" VARCHAR(200) NOT NULL,
    "voiceSettings" JSONB NOT NULL,
    "status" "AudioStatus" NOT NULL DEFAULT 'PENDING',
    "fileKey" VARCHAR(200),
    "mimeType" VARCHAR(100),
    "durationSeconds" DOUBLE PRECISION,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "errorCode" VARCHAR(100),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AudioAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectVoice_projectId_language_key" ON "ProjectVoice"("projectId", "language");

-- CreateIndex
CREATE UNIQUE INDEX "AudioAsset_videoScriptId_key" ON "AudioAsset"("videoScriptId");

-- CreateIndex
CREATE UNIQUE INDEX "AudioAsset_fileKey_key" ON "AudioAsset"("fileKey");

-- CreateIndex
CREATE INDEX "AudioAsset_status_id_idx" ON "AudioAsset"("status", "id");

-- AddForeignKey
ALTER TABLE "ProjectVoice" ADD CONSTRAINT "ProjectVoice_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioAsset" ADD CONSTRAINT "AudioAsset_videoJobId_fkey" FOREIGN KEY ("videoJobId") REFERENCES "VideoJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioAsset" ADD CONSTRAINT "AudioAsset_videoScriptId_fkey" FOREIGN KEY ("videoScriptId") REFERENCES "VideoScript"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


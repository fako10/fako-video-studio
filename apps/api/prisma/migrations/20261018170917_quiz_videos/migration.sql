-- CreateEnum
CREATE TYPE "QuizVideoStatus" AS ENUM ('PENDING', 'QUEUED', 'PROCESSING', 'WAITING_APPROVAL', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "QuizVideoValidationStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "QuizVideo" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "language" VARCHAR(10) NOT NULL,
    "status" "QuizVideoStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" VARCHAR(2000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "sourceId" VARCHAR(50) NOT NULL,
    "origin" VARCHAR(2048) NOT NULL,
    "questionId" VARCHAR(100) NOT NULL,
    "contentHash" VARCHAR(100) NOT NULL,
    "snapshotHash" VARCHAR(64) NOT NULL,
    "category" VARCHAR(300) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "checkStatus" VARCHAR(20) NOT NULL DEFAULT 'UNCHECKED',
    "checkedAt" TIMESTAMP(3),
    "imageKey" VARCHAR(200),
    "imageHash" VARCHAR(64),
    "imageMimeType" VARCHAR(100),
    "fileKey" VARCHAR(200),
    "durationSeconds" DOUBLE PRECISION,
    "ttsProvider" VARCHAR(50),
    "ttsUsage" JSONB,
    "generatedAt" TIMESTAMP(3),
    "validationStatus" "QuizVideoValidationStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" VARCHAR(200),
    "reviewComment" VARCHAR(2000),

    CONSTRAINT "QuizVideo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QuizVideo_requestId_key" ON "QuizVideo"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "QuizVideo_fileKey_key" ON "QuizVideo"("fileKey");

-- CreateIndex
CREATE INDEX "QuizVideo_projectId_createdAt_idx" ON "QuizVideo"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "QuizVideo_status_id_idx" ON "QuizVideo"("status", "id");

-- CreateIndex
CREATE INDEX "QuizVideo_sourceId_questionId_idx" ON "QuizVideo"("sourceId", "questionId");

-- AddForeignKey
ALTER TABLE "QuizVideo" ADD CONSTRAINT "QuizVideo_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

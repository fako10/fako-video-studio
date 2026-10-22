CREATE TYPE "VideoJobStatus" AS ENUM ('PENDING', 'QUEUED', 'PROCESSING', 'WAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TABLE "VideoJob" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "subject" VARCHAR(500) NOT NULL,
  "language" VARCHAR(10) NOT NULL,
  "format" VARCHAR(20) NOT NULL DEFAULT 'VERTICAL',
  "targetDuration" INTEGER NOT NULL DEFAULT 30,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "fps" INTEGER NOT NULL,
  "status" "VideoJobStatus" NOT NULL DEFAULT 'PENDING',
  "progress" INTEGER NOT NULL DEFAULT 0,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "errorMessage" VARCHAR(2000),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "approvedAt" TIMESTAMP(3),
  "approvedBy" VARCHAR(200),
  CONSTRAINT "VideoJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VideoJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "VideoJob_progress_check" CHECK ("progress" BETWEEN 0 AND 100),
  CONSTRAINT "VideoJob_duration_check" CHECK ("targetDuration" BETWEEN 1 AND 600),
  CONSTRAINT "VideoJob_format_check" CHECK ("format" IN ('VERTICAL', 'LANDSCAPE', 'SQUARE')),
  CONSTRAINT "VideoJob_attempts_check" CHECK ("attempts" >= 0)
);
CREATE INDEX "VideoJob_projectId_createdAt_idx" ON "VideoJob"("projectId", "createdAt");
CREATE INDEX "VideoJob_status_id_idx" ON "VideoJob"("status", "id");

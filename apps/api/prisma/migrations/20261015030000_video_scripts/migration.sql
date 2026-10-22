ALTER TABLE "Project" ADD COLUMN "editorialInstructions" TEXT NOT NULL DEFAULT '', ADD COLUMN "verifiedFacts" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "VideoJob" ADD COLUMN "scriptGenerationRequested" BOOLEAN NOT NULL DEFAULT false;
CREATE TYPE "ScriptGenerationStatus" AS ENUM ('PENDING', 'PROCESSING', 'GENERATED', 'FAILED', 'CANCELLED');
CREATE TYPE "ScriptValidationStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED');
CREATE TABLE "VideoScript" (
  "id" UUID NOT NULL PRIMARY KEY,
  "videoJobId" UUID NOT NULL REFERENCES "VideoJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "requestId" UUID NOT NULL,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "language" VARCHAR(10) NOT NULL,
  "title" VARCHAR(300), "hook" VARCHAR(500), "narration" TEXT,
  "scenes" JSONB, "onScreenTexts" JSONB, "estimatedDuration" INTEGER,
  "generationStatus" "ScriptGenerationStatus" NOT NULL DEFAULT 'PENDING',
  "validationStatus" "ScriptValidationStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
  "editorialSnapshot" JSONB NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "errorMessage" VARCHAR(500), "generationStartedAt" TIMESTAMP(3), "generatedAt" TIMESTAMP(3),
  "reviewedAt" TIMESTAMP(3), "reviewedBy" VARCHAR(200), "reviewComment" VARCHAR(2000),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "VideoScript_requestId_key" ON "VideoScript"("requestId");
CREATE UNIQUE INDEX "VideoScript_videoJobId_version_key" ON "VideoScript"("videoJobId", "version");
CREATE INDEX "VideoScript_generationStatus_id_idx" ON "VideoScript"("generationStatus", "id");
CREATE TABLE "AIRequest" (
  "id" UUID NOT NULL PRIMARY KEY,
  "videoScriptId" UUID NOT NULL REFERENCES "VideoScript"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "attempt" INTEGER NOT NULL,
  "provider" VARCHAR(50) NOT NULL, "model" VARCHAR(200) NOT NULL, "responseId" VARCHAR(200),
  "inputTokens" INTEGER, "outputTokens" INTEGER, "cachedInputTokens" INTEGER,
  "estimatedCostUsd" DECIMAL(18,8), "pricingSnapshot" JSONB, "errorCode" VARCHAR(100),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

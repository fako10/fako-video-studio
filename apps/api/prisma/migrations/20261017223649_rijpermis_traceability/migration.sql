-- CreateTable
CREATE TABLE "VideoScriptSource" (
    "id" UUID NOT NULL,
    "videoScriptId" UUID NOT NULL,
    "sourceId" VARCHAR(50) NOT NULL,
    "origin" VARCHAR(2048) NOT NULL,
    "questionId" VARCHAR(100) NOT NULL,
    "contentHash" VARCHAR(100) NOT NULL,
    "snapshotHash" VARCHAR(64) NOT NULL,
    "language" VARCHAR(10) NOT NULL,
    "category" VARCHAR(300) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "checkedAt" TIMESTAMP(3),
    "checkStatus" VARCHAR(20) NOT NULL DEFAULT 'UNCHECKED',
    "imageKey" VARCHAR(200),
    "imageHash" VARCHAR(64),
    "imageMimeType" VARCHAR(100),

    CONSTRAINT "VideoScriptSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VideoScriptSource_videoScriptId_key" ON "VideoScriptSource"("videoScriptId");

-- CreateIndex
CREATE INDEX "VideoScriptSource_sourceId_questionId_idx" ON "VideoScriptSource"("sourceId", "questionId");

-- AddForeignKey
ALTER TABLE "VideoScriptSource" ADD CONSTRAINT "VideoScriptSource_videoScriptId_fkey" FOREIGN KEY ("videoScriptId") REFERENCES "VideoScript"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

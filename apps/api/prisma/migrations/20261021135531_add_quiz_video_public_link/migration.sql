-- CreateTable
CREATE TABLE "QuizVideoPublicLink" (
    "id" UUID NOT NULL,
    "quizVideoId" UUID NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "QuizVideoPublicLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QuizVideoPublicLink_tokenHash_key" ON "QuizVideoPublicLink"("tokenHash");

-- CreateIndex
CREATE INDEX "QuizVideoPublicLink_quizVideoId_idx" ON "QuizVideoPublicLink"("quizVideoId");

-- CreateIndex
CREATE INDEX "QuizVideoPublicLink_expiresAt_idx" ON "QuizVideoPublicLink"("expiresAt");

-- AddForeignKey
ALTER TABLE "QuizVideoPublicLink" ADD CONSTRAINT "QuizVideoPublicLink_quizVideoId_fkey" FOREIGN KEY ("quizVideoId") REFERENCES "QuizVideo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

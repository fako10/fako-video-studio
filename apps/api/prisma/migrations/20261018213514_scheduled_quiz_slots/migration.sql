-- CreateEnum
CREATE TYPE "ScheduledSlotStatus" AS ENUM ('PENDING', 'DISPATCHED', 'SKIPPED', 'FAILED');

-- CreateTable
CREATE TABLE "ScheduledQuizSlot" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "scheduledDate" DATE NOT NULL,
    "slotTime" VARCHAR(5) NOT NULL,
    "language" VARCHAR(10) NOT NULL,
    "status" "ScheduledSlotStatus" NOT NULL DEFAULT 'PENDING',
    "quizVideoId" UUID,
    "reason" VARCHAR(500),
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "dispatchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduledQuizSlot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledQuizSlot_quizVideoId_key" ON "ScheduledQuizSlot"("quizVideoId");

-- CreateIndex
CREATE INDEX "ScheduledQuizSlot_scheduledDate_status_idx" ON "ScheduledQuizSlot"("scheduledDate", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledQuizSlot_projectId_scheduledDate_slotTime_language_key" ON "ScheduledQuizSlot"("projectId", "scheduledDate", "slotTime", "language");

-- AddForeignKey
ALTER TABLE "ScheduledQuizSlot" ADD CONSTRAINT "ScheduledQuizSlot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledQuizSlot" ADD CONSTRAINT "ScheduledQuizSlot_quizVideoId_fkey" FOREIGN KEY ("quizVideoId") REFERENCES "QuizVideo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

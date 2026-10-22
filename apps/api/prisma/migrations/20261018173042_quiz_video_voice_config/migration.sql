/*
  Warnings:

  - Added the required column `ttsModel` to the `QuizVideo` table without a default value. This is not possible if the table is not empty.
  - Added the required column `voiceId` to the `QuizVideo` table without a default value. This is not possible if the table is not empty.
  - Added the required column `voiceSettings` to the `QuizVideo` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "QuizVideo" ADD COLUMN     "ttsModel" VARCHAR(200) NOT NULL,
ADD COLUMN     "voiceId" VARCHAR(200) NOT NULL,
ADD COLUMN     "voiceSettings" JSONB NOT NULL;

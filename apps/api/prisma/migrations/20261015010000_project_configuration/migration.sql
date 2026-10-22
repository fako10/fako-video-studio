ALTER TABLE "Project"
  ADD COLUMN "slug" VARCHAR(100),
  ADD COLUMN "website" VARCHAR(2048),
  ADD COLUMN "category" VARCHAR(200),
  ADD COLUMN "languages" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "objective" VARCHAR(5000);

CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");

ALTER TABLE "ProjectSettings"
  ADD COLUMN "videosPerDay" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "publicationEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "humanValidationRequired" BOOLEAN NOT NULL DEFAULT true,
  ADD CONSTRAINT "ProjectSettings_videosPerDay_check" CHECK ("videosPerDay" BETWEEN 0 AND 1000);

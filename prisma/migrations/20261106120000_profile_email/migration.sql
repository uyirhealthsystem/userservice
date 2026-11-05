-- Patient email, required when the profile is created (POST /me). Existing
-- profiles keep null until the patient adds one.

-- AlterTable
ALTER TABLE "patient_profiles" ADD COLUMN "email" TEXT;

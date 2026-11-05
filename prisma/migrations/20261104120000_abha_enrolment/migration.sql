-- AlterTable
ALTER TABLE "abha_links" ADD COLUMN     "aadhaarConsentAt" TIMESTAMP(3),
ADD COLUMN     "aadhaarConsentVersion" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'LINKED';

-- CreateTable
CREATE TABLE "abha_enrolments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "step" TEXT,
    "txnId" TEXT,
    "mobile" TEXT,
    "abhaLinkId" TEXT,
    "aadhaarConsentVersion" TEXT,
    "aadhaarConsentAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "lastOtpAt" TIMESTAMP(3),
    "otpWindowStart" TIMESTAMP(3),
    "otpCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abha_enrolments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "abha_enrolments_userId_subject_key" ON "abha_enrolments"("userId", "subject");

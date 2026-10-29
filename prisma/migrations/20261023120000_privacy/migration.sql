-- AlterTable
ALTER TABLE "health_record_attachments" ADD COLUMN     "encrypted" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "privacy_consents" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "familyMemberId" TEXT,
    "purpose" TEXT NOT NULL,
    "noticeVersion" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawnAt" TIMESTAMP(3),
    "requestId" TEXT,

    CONSTRAINT "privacy_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nominees" (
    "userId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nominees_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "privacy_consents_userId_familyMemberId_purpose_idx" ON "privacy_consents"("userId", "familyMemberId", "purpose");

-- CreateIndex
CREATE INDEX "privacy_consents_withdrawnAt_idx" ON "privacy_consents"("withdrawnAt");

-- CreateIndex
CREATE INDEX "access_audit_at_idx" ON "access_audit"("at");

-- AddForeignKey
ALTER TABLE "nominees" ADD CONSTRAINT "nominees_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


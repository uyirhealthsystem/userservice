-- Health Partner referrals: the code a patient gave at signup (an outbox to
-- the HP service, which owns referrals and rewards) and the ABHAs that have
-- earned a reward. See docs/referrals.md.

-- CreateTable
CREATE TABLE "patient_referrals" (
    "userId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "qualifiedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "patient_referrals_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "rewarded_abhas" (
    "abhaHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rewarded_abhas_pkey" PRIMARY KEY ("abhaHash")
);

-- CreateIndex
CREATE INDEX "patient_referrals_status_nextAttemptAt_idx" ON "patient_referrals"("status", "nextAttemptAt");

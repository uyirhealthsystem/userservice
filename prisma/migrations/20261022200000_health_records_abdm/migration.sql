-- CreateTable
CREATE TABLE "health_records" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "familyMemberId" TEXT,
    "source" TEXT NOT NULL,
    "sourceRecordId" TEXT NOT NULL,
    "sourceVersion" INTEGER NOT NULL,
    "encounterId" TEXT NOT NULL,
    "recordType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "facilityName" TEXT,
    "practitionerName" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "health_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health_record_attachments" (
    "id" TEXT NOT NULL,
    "healthRecordId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "content" BYTEA,
    "size" INTEGER,
    "sha256" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "health_record_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health_record_rejections" (
    "id" TEXT NOT NULL,
    "source" TEXT,
    "sourceRecordId" TEXT,
    "channel" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "payload" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "health_record_rejections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "abha_links" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "familyMemberId" TEXT,
    "abhaNumber" TEXT NOT NULL,
    "abhaAddress" TEXT,
    "name" TEXT,
    "gender" TEXT,
    "yearOfBirth" INTEGER,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "linkToken" TEXT,
    "linkTokenAt" TIMESTAMP(3),
    "tokenRequestId" TEXT,
    "tokenRequestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abha_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "abha_otp_verifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "abhaNumber" TEXT NOT NULL,
    "otpMethod" TEXT NOT NULL,
    "txnId" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "abha_otp_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "abdm_care_contexts" (
    "id" TEXT NOT NULL,
    "abhaLinkId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "display" TEXT NOT NULL,
    "hiType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "linkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abdm_care_contexts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "abdm_consents" (
    "consentId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "patientId" TEXT,
    "careContexts" JSONB NOT NULL DEFAULT '[]',
    "hiTypes" TEXT[],
    "dateFrom" TIMESTAMP(3),
    "dateTo" TIMESTAMP(3),
    "dataEraseAt" TIMESTAMP(3),
    "artefact" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abdm_consents_pkey" PRIMARY KEY ("consentId")
);

-- CreateTable
CREATE TABLE "abdm_data_requests" (
    "transactionId" TEXT NOT NULL,
    "consentId" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abdm_data_requests_pkey" PRIMARY KEY ("transactionId")
);

-- CreateIndex
CREATE INDEX "health_records_userId_familyMemberId_recordedAt_idx" ON "health_records"("userId", "familyMemberId", "recordedAt");

-- CreateIndex
CREATE INDEX "health_records_source_encounterId_idx" ON "health_records"("source", "encounterId");

-- CreateIndex
CREATE UNIQUE INDEX "health_records_source_sourceRecordId_key" ON "health_records"("source", "sourceRecordId");

-- CreateIndex
CREATE INDEX "health_record_attachments_healthRecordId_idx" ON "health_record_attachments"("healthRecordId");

-- CreateIndex
CREATE INDEX "health_record_attachments_status_nextAttemptAt_idx" ON "health_record_attachments"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "health_record_rejections_at_idx" ON "health_record_rejections"("at");

-- CreateIndex
CREATE UNIQUE INDEX "abha_links_abhaNumber_key" ON "abha_links"("abhaNumber");

-- CreateIndex
CREATE UNIQUE INDEX "abha_links_tokenRequestId_key" ON "abha_links"("tokenRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "abha_links_userId_subject_key" ON "abha_links"("userId", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "abha_otp_verifications_userId_subject_key" ON "abha_otp_verifications"("userId", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "abdm_care_contexts_reference_key" ON "abdm_care_contexts"("reference");

-- CreateIndex
CREATE INDEX "abdm_care_contexts_status_nextAttemptAt_idx" ON "abdm_care_contexts"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "abdm_care_contexts_requestId_idx" ON "abdm_care_contexts"("requestId");

-- CreateIndex
CREATE INDEX "abdm_data_requests_status_nextAttemptAt_idx" ON "abdm_data_requests"("status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "health_records" ADD CONSTRAINT "health_records_familyMemberId_fkey" FOREIGN KEY ("familyMemberId") REFERENCES "family_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health_record_attachments" ADD CONSTRAINT "health_record_attachments_healthRecordId_fkey" FOREIGN KEY ("healthRecordId") REFERENCES "health_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abha_links" ADD CONSTRAINT "abha_links_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abha_links" ADD CONSTRAINT "abha_links_familyMemberId_fkey" FOREIGN KEY ("familyMemberId") REFERENCES "family_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abdm_care_contexts" ADD CONSTRAINT "abdm_care_contexts_abhaLinkId_fkey" FOREIGN KEY ("abhaLinkId") REFERENCES "abha_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;


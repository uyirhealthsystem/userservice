import { prisma } from "../../lib/prisma";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import { encryptionEnabled, sealBytes } from "../../lib/crypto";

// Data is kept only as long as it is needed (DPDP s.8(7)). Run by the worker;
// a full pass at most once an hour per replica - every delete is idempotent,
// so replicas overlapping does no harm. Windows: env.retentionDays.

const INTERVAL_MS = 3_600_000;
let lastRun = 0;

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

export async function runRetention(force = false): Promise<Record<string, number>> {
  if (!force && Date.now() - lastRun < INTERVAL_MS) return {};
  lastRun = Date.now();
  const days = env.retentionDays;

  const counts: Record<string, number> = {
    // Producer messages we could not store - kept for ops to look at, then gone.
    rejections: (await prisma.healthRecordRejection.deleteMany({ where: { at: { lt: daysAgo(days.rejections) } } })).count,
    expiredOtps: (await prisma.abhaOtpVerification.deleteMany({ where: { expiresAt: { lt: new Date() } } })).count,
    // ABHA creation rows, once nothing is in progress (or it expired) and the
    // day's OTP count no longer matters. They never hold an Aadhaar number.
    abhaEnrolments: (
      await prisma.abhaEnrolment.deleteMany({
        where: {
          AND: [
            { OR: [{ step: null }, { expiresAt: { lt: new Date() } }] },
            { OR: [{ otpWindowStart: null }, { otpWindowStart: { lt: daysAgo(1) } }] },
          ],
        },
      })
    ).count,
    // Finished ABDM transfers, and consents no longer usable.
    abdmDataRequests: (
      await prisma.abdmDataRequest.deleteMany({
        where: { status: { in: ["TRANSFERRED", "FAILED"] }, updatedAt: { lt: daysAgo(days.abdmTransactions) } },
      })
    ).count,
    abdmConsents: (
      await prisma.abdmConsent.deleteMany({
        where: {
          OR: [
            { status: { not: "GRANTED" }, updatedAt: { lt: daysAgo(days.abdmTransactions) } },
            { dataEraseAt: { lt: daysAgo(days.abdmTransactions) } },
          ],
        },
      })
    ).count,
    // Provider records of someone with no account here: never onboarded, or
    // erased their data. Attachments cascade.
    orphanRecords: await prisma.$executeRaw`
      DELETE FROM "health_records" r
      WHERE r."createdAt" < ${daysAgo(days.orphanRecords)}
        AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = r."userId")`,
    // Evidence kept for its window, then removed.
    accessAudit: (await prisma.accessAudit.deleteMany({ where: { at: { lt: daysAgo(days.auditAndConsents) } } })).count,
    withdrawnConsents: (
      await prisma.privacyConsent.deleteMany({ where: { withdrawnAt: { lt: daysAgo(days.auditAndConsents) } } })
    ).count,
  };

  if (Object.values(counts).some((n) => n > 0)) logger.info(counts, "retention: expired data deleted");
  return counts;
}

/**
 * Encrypts files stored before DATA_ENCRYPTION_KEY was set, a batch per run.
 * Returns how many it encrypted.
 */
export async function encryptStoredAttachments(limit = 20): Promise<number> {
  if (!encryptionEnabled()) return 0;
  const rows = await prisma.healthRecordAttachment.findMany({
    where: { encrypted: false, content: { not: null } },
    select: { id: true, content: true },
    take: limit,
  });
  for (const row of rows) {
    // encrypted: false in the where - a replica that got there first wins.
    await prisma.healthRecordAttachment.updateMany({
      where: { id: row.id, encrypted: false },
      data: sealBytes(Buffer.from(row.content!)),
    });
  }
  return rows.length;
}

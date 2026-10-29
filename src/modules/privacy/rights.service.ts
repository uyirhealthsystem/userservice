import { prisma } from "../../lib/prisma";
import { formatPatientNumber } from "../../lib/constants";
import { linkSelect } from "../abdm/abha.service";
import { consentSelect } from "./consent.service";

// The patient's rights under the DPDP Act (s.11-s.14): a summary of what we
// hold and whom it went to, a copy of it, and erasure. These work whether or
// not the patient consented or even created a profile - records providers
// sent before onboarding are theirs too.

/** Who received the patient's records through ABDM: one row per consent. */
export async function dataSharing(userId: string) {
  const shares = await prisma.accessAudit.groupBy({
    by: ["actorId"],
    where: { ownerId: userId, action: "SHARE" },
    _count: { _all: true },
    _max: { at: true },
  });
  const consents = await prisma.abdmConsent.findMany({
    where: { consentId: { in: shares.map((s) => s.actorId) } },
    select: { consentId: true, status: true, hiTypes: true, dateFrom: true, dateTo: true, artefact: true },
  });
  const byId = new Map(consents.map((c) => [c.consentId, c]));
  return shares
    .map((s) => {
      const c = byId.get(s.actorId);
      const detail = (c?.artefact as { notification?: { consentDetail?: Record<string, unknown> } } | undefined)?.notification
        ?.consentDetail;
      return {
        via: "ABDM",
        consentId: s.actorId,
        consentStatus: c?.status ?? null,
        // Who asked and why, as ABDM's consent artefact names them.
        purpose: (detail?.purpose as { text?: string } | undefined)?.text ?? null,
        requester: detail?.requester ?? detail?.hiu ?? null,
        hiTypes: c?.hiTypes ?? [],
        dateRange: c ? { from: c.dateFrom, to: c.dateTo } : null,
        recordsShared: s._count._all,
        lastSharedAt: s._max.at,
      };
    })
    .sort((a, b) => (b.lastSharedAt?.getTime() ?? 0) - (a.lastSharedAt?.getTime() ?? 0));
}

/** Everything held about the account, as one JSON document. */
export async function exportData(userId: string) {
  const omit = { userId: true } as const;
  const [user, familyMembers, consents, conditions, allergies, medications, vitals, healthRecords, abhaLinks, sharing] =
    await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { patientNo: true, status: true, createdAt: true, profile: { omit }, nominee: { omit } },
      }),
      prisma.familyMember.findMany({ where: { userId }, omit, orderBy: { createdAt: "asc" } }),
      prisma.privacyConsent.findMany({ where: { userId }, select: consentSelect, orderBy: { grantedAt: "asc" } }),
      prisma.medicalCondition.findMany({ where: { userId }, omit, orderBy: { createdAt: "asc" } }),
      prisma.allergy.findMany({ where: { userId }, omit, orderBy: { createdAt: "asc" } }),
      prisma.medication.findMany({ where: { userId }, omit, orderBy: { createdAt: "asc" } }),
      prisma.vitalReading.findMany({ where: { userId }, omit, orderBy: { measuredAt: "asc" } }),
      prisma.healthRecord.findMany({
        where: { userId },
        omit: { userId: true, sourceVersion: true },
        include: { attachments: { select: { id: true, fileName: true, contentType: true, size: true, sha256: true, status: true } } },
        orderBy: { recordedAt: "asc" },
      }),
      prisma.abhaLink.findMany({ where: { userId }, select: linkSelect }),
      dataSharing(userId),
    ]);

  return {
    exportedAt: new Date(),
    userId,
    patientNumber: user ? formatPatientNumber(user.patientNo) : null,
    account: user ? { status: user.status, createdAt: user.createdAt } : null,
    profile: user?.profile ?? null,
    nominee: user?.nominee ?? null,
    familyMembers,
    consents,
    medical: { conditions, allergies, medications, vitals },
    // Files: GET /api/v1/users/me/health-records/:id/attachments/:attachmentId
    healthRecords,
    abhaLinks,
    sharing,
  };
}

/**
 * Erases the account's data. Kept: the access audit and the consent rows
 * (withdrawn) - evidence of what was done and agreed, holding no health data,
 * removed by retention.ts later. The erasure itself is audited.
 */
export async function eraseAccount(userId: string, actorRole: string, requestId: string | null) {
  await prisma.$transaction(async (tx) => {
    // Not relations of users: provider records and pending OTPs.
    await tx.healthRecord.deleteMany({ where: { userId } });
    await tx.abhaOtpVerification.deleteMany({ where: { userId } });
    // Cascades to profile, family, medical records, ABHA links (and their
    // care contexts) and nominee.
    await tx.user.deleteMany({ where: { id: userId } });
    await tx.privacyConsent.updateMany({ where: { userId, withdrawnAt: null }, data: { withdrawnAt: new Date() } });
    await tx.accessAudit.create({
      data: { ownerId: userId, actorId: userId, actorRole, action: "DELETE", resource: "account", requestId },
    });
  });
}

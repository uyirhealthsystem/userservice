import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/errors";
import { consentedMember, consentedMemberIds, grantConsent, isMinor } from "../privacy/consent.service";
import { createFamilyMemberSchema, updateFamilyMemberSchema } from "./family.schemas";

// Scoped to the calling patient's own userId, like users.service.ts.

const familyMemberSelect = {
  id: true,
  fullName: true,
  relationship: true,
  dateOfBirth: true,
  gender: true,
  phone: true,
  bloodGroup: true,
  district: true,
  pinCode: true,
  createdAt: true,
  updatedAt: true,
} as const;

// The patient's view: every member, with what has been consented for them -
// a member without CARE consent (added before consent was asked for) is
// shown so the app can ask for it, but their data stays hidden until then.
export async function listFamilyMembers(userId: string) {
  const [members, care, abdm] = await Promise.all([
    prisma.familyMember.findMany({ where: { userId }, select: familyMemberSelect, orderBy: { createdAt: "asc" } }),
    consentedMemberIds(userId, "CARE"),
    consentedMemberIds(userId, "ABDM_SHARING"),
  ]);
  return members.map((m) => ({ ...m, consent: { care: care.includes(m.id), abdmSharing: abdm.includes(m.id) } }));
}

// For other services (homebasedcare bookings): only members whose data may
// be used.
export async function listConsentedFamilyMembers(userId: string) {
  return prisma.familyMember.findMany({
    where: { userId, id: { in: await consentedMemberIds(userId) } },
    select: familyMemberSelect,
    orderBy: { createdAt: "asc" },
  });
}

// The member and the consent for them are stored together, or neither.
export async function createFamilyMember(
  userId: string,
  { consent, ...data }: z.infer<typeof createFamilyMemberSchema>,
  requestId: string | null,
) {
  return prisma.$transaction(async (tx) => {
    const member = await tx.familyMember.create({ data: { userId, ...data }, select: familyMemberSelect });
    const input = { purpose: "CARE" as const, memberId: member.id, noticeVersion: consent.noticeVersion, basis: consent.basis };
    await grantConsent(userId, input, requestId, tx);
    return { ...member, consent: { care: true, abdmSharing: false } };
  });
}

// 404 (not 403) for someone else's member, so ids can't be probed. Also used
// by the medical module to check a record's subject belongs to the caller.
export async function ownedMember(userId: string, id: string) {
  const member = await prisma.familyMember.findFirst({ where: { id, userId }, select: { id: true } });
  if (!member) throw Errors.notFound("Family member");
}

export async function updateFamilyMember(
  userId: string,
  id: string,
  data: z.infer<typeof updateFamilyMemberSchema>,
) {
  await consentedMember(userId, id);
  // A date of birth that makes them a minor needs a parent's / guardian's
  // consent - an adult's own agreement no longer covers it.
  if (isMinor(data.dateOfBirth)) {
    const guardian = await prisma.privacyConsent.findFirst({
      where: { userId, familyMemberId: id, purpose: "CARE", basis: "PARENT_OR_GUARDIAN", withdrawnAt: null },
      select: { id: true },
    });
    if (!guardian) {
      throw Errors.unprocessable(
        "GUARDIAN_CONSENT_REQUIRED",
        "This family member is under 18: consent as their parent or guardian first (POST /me/consents, basis PARENT_OR_GUARDIAN).",
      );
    }
  }
  return prisma.familyMember.update({ where: { id }, data, select: familyMemberSelect });
}

// Also deletes that member's medical records (FK cascade).
export async function deleteFamilyMember(userId: string, id: string) {
  await ownedMember(userId, id);
  await prisma.familyMember.delete({ where: { id } });
}

import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { env } from "../../lib/env";
import { AppError, Errors } from "../../lib/errors";
import { ownedMember } from "../family/family.service";
import { MEMBER_BASES, Purpose } from "./privacy.schemas";

// Consent under the DPDP Act. The account holder consents for themself and,
// as the one entering their data, for each family member - a child's (or an
// adult in their lawful care) as parent / guardian, an adult's by confirming
// that person agreed. Rules:
//
//   - The holder's own consent must be to the CURRENT notice version; bumping
//     PRIVACY_NOTICE_VERSION asks everyone again.
//   - A family member's consent holds across notice versions (it was given
//     for that person; asking again would re-ask every relative).
//   - Under 18 (by date of birth) the holder cannot consent for themself, and
//     a member can only be consented for as PARENT_OR_GUARDIAN.
//   - Withdrawing stops the processing: CARE for a member erases that member,
//     ABDM_SHARING unlinks the ABHA. CARE for the holder is DELETE /me.


type Db = Prisma.TransactionClient | typeof prisma;

const ADULT_AGE = 18;

/** null when the date of birth is unknown. */
export function isMinor(dateOfBirth: Date | null | undefined, now = new Date()): boolean | null {
  if (!dateOfBirth) return null;
  const adultOn = new Date(dateOfBirth);
  adultOn.setUTCFullYear(adultOn.getUTCFullYear() + ADULT_AGE);
  return adultOn > now;
}

const active = { withdrawnAt: null };

export const consentSelect = {
  id: true,
  familyMemberId: true,
  purpose: true,
  noticeVersion: true,
  basis: true,
  grantedAt: true,
  withdrawnAt: true,
} as const;

export async function hasConsent(userId: string, subject: string, purpose: Purpose, db: Db = prisma): Promise<boolean> {
  const row = await db.privacyConsent.findFirst({
    where: {
      userId,
      purpose,
      ...active,
      ...(subject === "self" ? { familyMemberId: null, noticeVersion: env.privacy.noticeVersion } : { familyMemberId: subject }),
    },
    select: { id: true },
  });
  return row !== null;
}

export async function assertConsent(userId: string, subject: string, purpose: Purpose) {
  if (!(await hasConsent(userId, subject, purpose))) throw Errors.consentRequired(purpose, subject);
}

/** ownedMember + the member's CARE consent: their data may be processed. */
export async function consentedMember(userId: string, memberId: string) {
  await ownedMember(userId, memberId);
  await assertConsent(userId, memberId, "CARE");
}

/** Members whose data may be processed for `purpose`. */
export async function consentedMemberIds(userId: string, purpose: Purpose = "CARE"): Promise<string[]> {
  const rows = await prisma.privacyConsent.findMany({
    where: { userId, purpose, ...active, familyMemberId: { not: null } },
    select: { familyMemberId: true },
    distinct: ["familyMemberId"],
  });
  return rows.map((r) => r.familyMemberId!);
}

/** Where-clause: the holder's own rows + rows of members with CARE consent. */
export async function consentedSubjects(userId: string) {
  const ids = await consentedMemberIds(userId);
  return { OR: [{ familyMemberId: null }, { familyMemberId: { in: ids } }] };
}

export interface GrantInput {
  purpose: Purpose;
  memberId: string; // "self" | family member id
  noticeVersion: string;
  basis?: string;
}

/**
 * Records a consent. Idempotent: an active consent with the same purpose,
 * subject and notice version is returned as is (`created` false).
 * `selfDateOfBirth` is passed during onboarding, before the profile exists.
 */
export async function grantConsent(
  userId: string,
  input: GrantInput,
  requestId: string | null,
  db: Db = prisma,
  selfDateOfBirth?: Date | null,
) {
  if (input.noticeVersion !== env.privacy.noticeVersion) {
    throw new AppError(
      409,
      "NOTICE_OUTDATED",
      `Privacy notice version ${env.privacy.noticeVersion} is current - show it and consent to that version.`,
    );
  }

  let familyMemberId: string | null = null;
  let basis: string;
  if (input.memberId === "self") {
    const dob =
      selfDateOfBirth !== undefined
        ? selfDateOfBirth
        : (await db.patientProfile.findUnique({ where: { userId }, select: { dateOfBirth: true } }))?.dateOfBirth;
    if (isMinor(dob)) {
      throw new AppError(
        403,
        "MINOR_ACCOUNT",
        "Under 18s cannot consent for themselves. A parent or guardian adds them as a family member.",
      );
    }
    basis = "SELF";
  } else {
    const member = await db.familyMember.findFirst({ where: { id: input.memberId, userId }, select: { dateOfBirth: true } });
    if (!member) throw Errors.notFound("Family member");
    if (!input.basis || !(MEMBER_BASES as readonly string[]).includes(input.basis)) {
      throw Errors.badRequest("VALIDATION_ERROR", `basis must be one of ${MEMBER_BASES.join(", ")} for a family member.`);
    }
    if (isMinor(member.dateOfBirth) && input.basis !== "PARENT_OR_GUARDIAN") {
      throw Errors.unprocessable(
        "GUARDIAN_CONSENT_REQUIRED",
        "This family member is under 18: only their parent or lawful guardian can consent (basis PARENT_OR_GUARDIAN).",
      );
    }
    familyMemberId = input.memberId;
    basis = input.basis;
  }

  const existing = await db.privacyConsent.findFirst({
    where: { userId, familyMemberId, purpose: input.purpose, noticeVersion: input.noticeVersion, basis, ...active },
    select: consentSelect,
  });
  if (existing) return { consent: existing, created: false };

  const consent = await db.privacyConsent.create({
    data: { userId, familyMemberId, purpose: input.purpose, noticeVersion: input.noticeVersion, basis, requestId },
    select: consentSelect,
  });
  return { consent, created: true };
}

/**
 * Withdraws a consent and stops what it allowed. Returns what was erased.
 * The audit of the erasure is the caller's (it knows the request).
 */
export async function withdrawConsent(userId: string, purpose: Purpose, memberId: string) {
  if (purpose === "CARE" && memberId === "self") {
    throw Errors.conflict(
      "ERASURE_REQUIRED",
      "Withdrawing consent to care means erasing your data: DELETE /api/v1/users/me.",
    );
  }
  if (memberId !== "self") await ownedMember(userId, memberId);
  const familyMemberId = memberId === "self" ? null : memberId;
  const subject = memberId;

  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const { count } = await tx.privacyConsent.updateMany({
      where: { userId, familyMemberId, purpose, ...active },
      data: { withdrawnAt: now },
    });
    if (count === 0) throw Errors.notFound("Active consent");

    if (purpose === "ABDM_SHARING") {
      // No more linking or sharing: the ABHA link (and its care contexts) goes.
      await tx.abhaOtpVerification.deleteMany({ where: { userId, subject } });
      await tx.abhaLink.deleteMany({ where: { userId, subject } });
      return "abha-link";
    }
    // CARE for a member: their data may no longer be held. Every other
    // consent for them ends too; the member row cascades to their records,
    // provider records and ABHA link.
    await tx.privacyConsent.updateMany({ where: { userId, familyMemberId, ...active }, data: { withdrawnAt: now } });
    await tx.abhaOtpVerification.deleteMany({ where: { userId, subject } });
    await tx.familyMember.delete({ where: { id: memberId } });
    return "family-member";
  });
}

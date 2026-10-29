import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/errors";
import { formatPatientNumber } from "../../lib/constants";
import { env } from "../../lib/env";
import { grantConsent, hasConsent, isMinor } from "../privacy/consent.service";
import { selfConsentSchema } from "../privacy/privacy.schemas";
import { profileSchema } from "./users.schemas";

// Every function here is scoped to the caller's own userId (x-user-id from
// the gateway) - a patient can only ever see / change their own rows.

const userSelect = { id: true, patientNo: true, status: true, createdAt: true } as const;

const profileSelect = {
  id: true,
  fullName: true,
  dateOfBirth: true,
  gender: true,
  phone: true,
  bloodGroup: true,
  address: true,
  district: true,
  pinCode: true,
  createdAt: true,
  updatedAt: true,
} as const;

type UserRow = Prisma.UserGetPayload<{ select: typeof userSelect }>;

function publicUser({ patientNo, ...user }: UserRow) {
  return { ...user, patientNumber: formatPatientNumber(patientNo) };
}

// Omitted optional fields are cleared on a replace, not left as they were.
function fullProfile(data: z.infer<typeof profileSchema>) {
  return {
    fullName: data.fullName,
    dateOfBirth: data.dateOfBirth ?? null,
    gender: data.gender ?? null,
    phone: data.phone ?? null,
    bloodGroup: data.bloodGroup ?? null,
    address: data.address ?? null,
    district: data.district ?? null,
    pinCode: data.pinCode ?? null,
  };
}

export async function getMe(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { ...userSelect, profile: { select: profileSelect } },
  });
  // A user row can exist without a profile only for accounts imported from
  // authservice that had family members but no profile - same answer: onboard.
  if (!user?.profile) throw Errors.profileRequired();
  const { profile, ...rest } = user;
  return {
    user: publicUser(rest),
    profile,
    // consentRequired: show the privacy notice (again - it may have changed).
    privacy: { noticeVersion: env.privacy.noticeVersion, consentRequired: !(await hasConsent(userId, "self", "CARE")) },
  };
}

type SelfConsent = z.infer<typeof selfConsentSchema>;

// Onboarding: the patient submits their profile and consent, and that creates
// their user record (+ patient number) in one transaction. 409 if it already
// exists.
export async function createMe(
  userId: string,
  data: z.infer<typeof profileSchema>,
  consent: SelfConsent,
  requestId: string | null,
) {
  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.upsert({ where: { id: userId }, create: { id: userId }, update: {}, select: userSelect });
      const profile = await tx.patientProfile.create({ data: { userId, ...fullProfile(data) }, select: profileSelect });
      // Refuses under-18s (MINOR_ACCOUNT) and an outdated notice - before
      // anything is committed.
      const consentInput = { purpose: "CARE" as const, memberId: "self", noticeVersion: consent.noticeVersion };
      await grantConsent(userId, consentInput, requestId, tx, data.dateOfBirth ?? null);
      return { user: publicUser(user), profile };
    });
  } catch (err) {
    // userId is unique on patient_profiles - covers both "already onboarded"
    // and two concurrent first submissions.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw Errors.profileExists();
    throw err;
  }
}

export async function getProfile(userId: string) {
  const profile = await prisma.patientProfile.findUnique({ where: { userId }, select: profileSelect });
  if (!profile) throw Errors.profileRequired();
  return profile;
}

// Replace the profile. Before onboarding this creates it, exactly like
// POST /me - the deprecated PUT /api/v1/auth/patients/me/profile (rewritten
// here by the gateway) was create-or-replace, and old apps onboard with it.
// Creating needs the consent, exactly like POST /me.
export async function replaceProfile(
  userId: string,
  data: z.infer<typeof profileSchema>,
  consent: SelfConsent | undefined,
  requestId: string | null,
) {
  const existing = await prisma.patientProfile.findUnique({ where: { userId }, select: { id: true } });
  if (!existing) {
    if (!consent) throw Errors.consentRequired("CARE");
    const { profile } = await createMe(userId, data, consent, requestId);
    return { profile, created: true };
  }
  // A date of birth that makes the holder a minor can't stand next to their
  // own consent.
  if (isMinor(data.dateOfBirth)) {
    throw Errors.unprocessable("MINOR_ACCOUNT", "Under 18s cannot hold their own account - a parent adds them as a family member.");
  }
  const profile = await prisma.patientProfile.update({ where: { userId }, data: fullProfile(data), select: profileSelect });
  return { profile, created: false };
}

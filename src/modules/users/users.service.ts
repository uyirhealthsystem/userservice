import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/errors";
import { formatPatientNumber } from "../../lib/constants";
import { env } from "../../lib/env";
import { auditAccess } from "../../lib/audit";
import { grantConsent, hasConsent, isMinor } from "../privacy/consent.service";
import { selfConsentSchema } from "../privacy/privacy.schemas";
import { assertReferralCodeAccepted, recordReferral } from "../referrals/referrals.service";
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
  email: true,
  bloodGroup: true,
  address: true,
  district: true,
  pinCode: true,
  createdAt: true,
  updatedAt: true,
} as const;

type UserRow = Prisma.UserGetPayload<{ select: typeof userSelect }>;
type ProfileRow = Prisma.PatientProfileGetPayload<{ select: typeof profileSelect }>;

function publicUser({ patientNo, ...user }: UserRow) {
  return { ...user, patientNumber: formatPatientNumber(patientNo) };
}

// Every profile we answer with carries `age` (whole years, from dateOfBirth;
// null when unknown) - computed per request so it is never stale.
function publicProfile(profile: ProfileRow) {
  return { ...profile, age: ageFromDob(profile.dateOfBirth) };
}

// Omitted optional fields are cleared on a replace, not left as they were -
// except email: an app that doesn't send it yet must not wipe the one given
// at onboarding, so omitted keeps it (undefined = untouched for Prisma) and
// only an explicit null clears it.
function fullProfile(data: z.infer<typeof profileSchema>) {
  return {
    fullName: data.fullName,
    dateOfBirth: data.dateOfBirth ?? null,
    gender: data.gender ?? null,
    phone: data.phone ?? null,
    email: data.email,
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
    profile: publicProfile(profile),
    // consentRequired: show the privacy notice (again - it may have changed).
    privacy: { noticeVersion: env.privacy.noticeVersion, consentRequired: !(await hasConsent(userId, "self", "CARE")) },
  };
}

type SelfConsent = z.infer<typeof selfConsentSchema>;

// Onboarding: the patient submits their profile and consent, and that creates
// their user record (+ patient number) in one transaction. 409 if it already
// exists. An optional Health Partner referral code is checked with the HP
// service first (a wrong one is refused so it can be corrected) and kept with
// the profile; the HP earns the reward once the patient links their ABHA.
export async function createMe(
  userId: string,
  data: z.infer<typeof profileSchema>,
  consent: SelfConsent,
  requestId: string | null,
  referralCode?: string,
) {
  if (referralCode) await assertReferralCodeAccepted(userId, referralCode);
  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.upsert({ where: { id: userId }, create: { id: userId }, update: {}, select: userSelect });
      const profile = await tx.patientProfile.create({ data: { userId, ...fullProfile(data) }, select: profileSelect });
      // Refuses under-18s (MINOR_ACCOUNT) and an outdated notice - before
      // anything is committed.
      const consentInput = { purpose: "CARE" as const, memberId: "self", noticeVersion: consent.noticeVersion };
      await grantConsent(userId, consentInput, requestId, tx, data.dateOfBirth ?? null);
      if (referralCode) await recordReferral(tx, userId, referralCode);
      return { user: publicUser(user), profile: publicProfile(profile) };
    });
  } catch (err) {
    // userId is unique on patient_profiles - covers both "already onboarded"
    // and two concurrent first submissions.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw Errors.profileExists();
    throw err;
  }
}

/** Whole years on `now` (UTC dates, like isMinor); null when unknown. */
export function ageFromDob(dateOfBirth: Date | null, now = new Date()): number | null {
  if (!dateOfBirth) return null;
  let age = now.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < dateOfBirth.getUTCMonth() ||
    (now.getUTCMonth() === dateOfBirth.getUTCMonth() && now.getUTCDate() < dateOfBirth.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

// Service-to-service: one patient by id, for a service that is about to care
// for them (booking forms etc. no longer need the app to type in name / age /
// gender / phone). Shared only with the patient's CARE consent to the current
// notice (DPDP), and every read is audited with the calling service as actor.
// Fields a service may ask for with ?fields=a,b,c - only those are returned
// (DPDP data minimisation). user.id is always included so the caller can
// correlate. Without ?fields the full { user, profile } is returned.
export const SERVICE_USER_FIELDS = ["patientNumber", "status", "createdAt"] as const;
export const SERVICE_PROFILE_FIELDS = [
  "fullName",
  "dateOfBirth",
  "age",
  "gender",
  "phone",
  "email",
  "bloodGroup",
  "address",
  "district",
  "pinCode",
] as const;
export type ServiceField = (typeof SERVICE_USER_FIELDS)[number] | (typeof SERVICE_PROFILE_FIELDS)[number];

function pick(obj: object, keys: readonly string[]) {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => keys.includes(k)));
}

export async function getUserForService(
  userId: string,
  source: string,
  requestId: string | null,
  fields?: readonly ServiceField[],
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { ...userSelect, profile: { select: profileSelect } },
  });
  if (!user?.profile) throw Errors.notFound("User");
  if (!(await hasConsent(userId, "self", "CARE"))) throw Errors.consentRequired("CARE");

  await auditAccess({ ownerId: userId, actorId: source, actorRole: "SERVICE", action: "READ", resource: "profile", requestId });

  const { profile, ...rest } = user;
  const fullUser = publicUser(rest);
  const fullProfile = publicProfile(profile);
  if (!fields) return { user: fullUser, profile: fullProfile };
  return {
    user: { id: fullUser.id, ...pick(fullUser, SERVICE_USER_FIELDS.filter((f) => fields.includes(f))) },
    profile: pick(fullProfile, SERVICE_PROFILE_FIELDS.filter((f) => fields.includes(f))),
  };
}

export async function getProfile(userId: string) {
  const profile = await prisma.patientProfile.findUnique({ where: { userId }, select: profileSelect });
  if (!profile) throw Errors.profileRequired();
  return publicProfile(profile);
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
  referralCode?: string,
) {
  const existing = await prisma.patientProfile.findUnique({ where: { userId }, select: { id: true } });
  if (!existing) {
    if (!consent) throw Errors.consentRequired("CARE");
    const { profile } = await createMe(userId, data, consent, requestId, referralCode);
    return { profile, created: true };
  }
  if (referralCode) {
    throw Errors.badRequest("REFERRAL_CODE_SIGNUP_ONLY", "A referral code can only be given when the profile is created.");
  }
  // A date of birth that makes the holder a minor can't stand next to their
  // own consent.
  if (isMinor(data.dateOfBirth)) {
    throw Errors.unprocessable("MINOR_ACCOUNT", "Under 18s cannot hold their own account - a parent adds them as a family member.");
  }
  const profile = await prisma.patientProfile.update({ where: { userId }, data: fullProfile(data), select: profileSelect });
  return { profile: publicProfile(profile), created: false };
}

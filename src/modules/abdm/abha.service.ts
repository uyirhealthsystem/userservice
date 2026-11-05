import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/errors";
import { abdmEnabled } from "../../lib/env";
import { assertConsent, consentedMember } from "../privacy/consent.service";
import { AbdmProfile, OtpMethod, getProfile, requestLoginOtp, verifyLoginOtp } from "./abdm.client";
import { backfillCareContexts } from "./careContexts";
import { qualifyReferral } from "../referrals/referrals.service";

// Links a verified ABHA to the patient or one of their family members. The
// OTP goes to the ABHA holder's own mobile, so whoever links it controls that
// ABHA. Once linked, every record of that person is linked to the ABHA in
// ABDM as a care context (careContexts.ts).

const OTP_TTL_MS = 10 * 60_000;
const RESEND_COOLDOWN_MS = 60_000;
const MAX_OTP_ATTEMPTS = 3;

export const normaliseAbha = (abha: string) => abha.replace(/-/g, "");

// Linking shares the subject's records through ABDM: it needs their CARE
// consent (a member) and their ABDM_SHARING consent.
export async function checkSubject(userId: string, subject: string) {
  if (subject !== "self") await consentedMember(userId, subject);
  await assertConsent(userId, subject, "ABDM_SHARING");
}

export const linkSelect = {
  id: true,
  familyMemberId: true,
  abhaNumber: true,
  abhaAddress: true,
  source: true,
  name: true,
  verifiedAt: true,
  createdAt: true,
} as const;

export function listAbhaLinks(userId: string) {
  return prisma.abhaLink.findMany({ where: { userId }, select: linkSelect, orderBy: { createdAt: "asc" } });
}

export async function sendAbhaOtp(userId: string, subject: string, abhaNumberRaw: string, method: OtpMethod) {
  if (!abdmEnabled()) throw Errors.abdmNotConfigured();
  await checkSubject(userId, subject);
  const abhaNumber = normaliseAbha(abhaNumberRaw);

  if (await prisma.abhaLink.findUnique({ where: { userId_subject: { userId, subject } } })) {
    throw Errors.conflict("ABHA_ALREADY_LINKED", "This person already has an ABHA linked. Unlink it first.");
  }
  await assertAbhaFree(abhaNumber);

  const pending = await prisma.abhaOtpVerification.findUnique({ where: { userId_subject: { userId, subject } } });
  if (pending && Date.now() - pending.createdAt.getTime() < RESEND_COOLDOWN_MS) {
    throw Errors.tooManyRequests("Wait a minute before asking for another OTP.");
  }

  const txnId = await requestLoginOtp(abhaNumber, method);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);
  // New request = new verification (and a fresh attempt count).
  await prisma.abhaOtpVerification.upsert({
    where: { userId_subject: { userId, subject } },
    create: { userId, subject, abhaNumber, otpMethod: method, txnId, expiresAt },
    update: { abhaNumber, otpMethod: method, txnId, expiresAt, attempts: 0, createdAt: new Date() },
  });
  return { expiresAt };
}

export async function verifyAbhaOtp(userId: string, subject: string, otp: string) {
  if (!abdmEnabled()) throw Errors.abdmNotConfigured();
  await checkSubject(userId, subject);
  const where = { userId_subject: { userId, subject } };

  const pending = await prisma.abhaOtpVerification.findUnique({ where });
  if (!pending || pending.expiresAt < new Date()) {
    if (pending) await prisma.abhaOtpVerification.delete({ where });
    throw Errors.badRequest("OTP_EXPIRED", "No OTP pending for this person, or it expired. Ask for a new one.");
  }

  const xToken = await verifyLoginOtp(pending.txnId, otp, pending.otpMethod as OtpMethod);
  if (!xToken) {
    const attempts = pending.attempts + 1;
    if (attempts >= MAX_OTP_ATTEMPTS) {
      await prisma.abhaOtpVerification.delete({ where });
      throw Errors.badRequest("OTP_ATTEMPTS_EXCEEDED", "Too many wrong OTPs. Ask for a new one.");
    }
    await prisma.abhaOtpVerification.update({ where, data: { attempts } });
    throw Errors.badRequest("OTP_INVALID", "The OTP is wrong.");
  }

  const profile = await getProfile(xToken);
  const verifiedAbha = normaliseAbha(profile.ABHANumber ?? "");
  if (verifiedAbha !== pending.abhaNumber) {
    throw Errors.conflict("ABHA_MISMATCH", "ABDM verified a different ABHA number than the one the OTP was sent for.");
  }
  await assertAbhaFree(verifiedAbha);
  await assertDemographicsMatch(userId, subject, profile);

  try {
    const link = await prisma.$transaction(async (tx) => {
      await tx.abhaOtpVerification.delete({ where });
      const created = await tx.abhaLink.create({
        data: {
          userId,
          subject,
          familyMemberId: subject === "self" ? null : subject,
          abhaNumber: verifiedAbha,
          abhaAddress: profile.preferredAbhaAddress ?? null,
          name: profileName(profile),
          gender: profile.gender ?? null,
          yearOfBirth: profileYear(profile),
          verifiedAt: new Date(),
        },
        select: linkSelect,
      });
      // The patient's own ABHA, verified: their Health Partner earns the referral.
      await qualifyReferral(tx, userId, subject, verifiedAbha);
      return created;
    });
    await backfillCareContexts(link.id);
    return link;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw Errors.conflict("ABHA_IN_USE", "This ABHA is already linked.");
    }
    throw err;
  }
}

// Removes the link here. Care contexts already linked stay visible in the
// patient's ABHA app, but we no longer serve data for them.
export async function unlinkAbha(userId: string, id: string) {
  const { count } = await prisma.abhaLink.deleteMany({ where: { id, userId } });
  if (count === 0) throw Errors.notFound("ABHA link");
}

export async function assertAbhaFree(abhaNumber: string) {
  if (await prisma.abhaLink.findUnique({ where: { abhaNumber }, select: { id: true } })) {
    throw Errors.conflict("ABHA_IN_USE", "This ABHA is already linked to a patient on Uyir.");
  }
}

export const profileName = (p: AbdmProfile) =>
  p.name ?? ([p.firstName, p.middleName, p.lastName].filter(Boolean).join(" ") || null);

export function profileYear(p: AbdmProfile): number | null {
  const year = Number(p.yearOfBirth ?? p.dateOfBirth?.match(/\d{4}/)?.[0]);
  return Number.isInteger(year) && year > 1900 ? year : null;
}

const GENDER_CODE: Record<string, string> = { MALE: "M", FEMALE: "F", OTHER: "O" };

// The ABHA must be this person's: where both sides know gender and year of
// birth, they have to agree (a parent may hold a child's ABHA OTP, so the OTP
// alone doesn't prove whose record this is).
export async function assertDemographicsMatch(userId: string, subject: string, profile: AbdmProfile) {
  const person =
    subject === "self"
      ? await prisma.patientProfile.findUnique({ where: { userId }, select: { gender: true, dateOfBirth: true } })
      : await prisma.familyMember.findUnique({ where: { id: subject }, select: { gender: true, dateOfBirth: true } });
  const ourGender = person?.gender ? GENDER_CODE[person.gender] : undefined;
  const ourYear = person?.dateOfBirth?.getUTCFullYear();
  const theirYear = profileYear(profile);

  if (ourGender && profile.gender && ourGender !== profile.gender) {
    throw Errors.conflict("ABHA_DEMOGRAPHIC_MISMATCH", "The ABHA's gender does not match this person's profile.");
  }
  if (ourYear && theirYear && ourYear !== theirYear) {
    throw Errors.conflict("ABHA_DEMOGRAPHIC_MISMATCH", "The ABHA's year of birth does not match this person's profile.");
  }
}

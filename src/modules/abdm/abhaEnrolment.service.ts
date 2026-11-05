import { Prisma, AbhaEnrolment } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError, Errors } from "../../lib/errors";
import { abdmEnabled, env } from "../../lib/env";
import { AADHAAR_CONSENT } from "./aadhaarConsent";
import {
  AbdmRejected,
  EnrolProfile,
  abhaAddressSuggestions,
  enrolByAadhaar,
  requestEnrolMobileOtp,
  requestEnrolOtp,
  setAbhaAddress,
  verifyEnrolMobileOtp,
} from "./abdm.client";
import {
  assertAbhaFree,
  assertDemographicsMatch,
  checkSubject,
  linkSelect,
  normaliseAbha,
  profileName,
  profileYear,
} from "./abha.service";
import { backfillCareContexts } from "./careContexts";

// ABHA creation for a patient who has none (docs/abha-creation.md). Optional
// and separate from profile creation: nothing here runs unless the patient
// asks for it, and ABDM being down only fails these calls.
//
// The ABHA exists as soon as ABDM accepts the Aadhaar OTP, so it is linked
// right then (same AbhaLink as the link flow). The mobile and ABHA-address
// steps after that only improve it - abandoning them loses nothing.
//
// The Aadhaar number is never stored or logged: it is encrypted for ABDM in
// abdm.client.ts and dropped.

const ENROL_TTL_MS = 10 * 60_000; // refreshed on every successful step
const RESEND_COOLDOWN_MS = 60_000;
const MAX_OTP_ATTEMPTS = 3;
const DAILY_OTP_CAP = 5; // Aadhaar + mobile OTPs per person per 24 h
const DAY_MS = 86_400_000;

type Step = "AADHAAR_OTP_SENT" | "MOBILE_PENDING" | "MOBILE_OTP_SENT" | "ADDRESS_PENDING";
export type Next = "MOBILE_VERIFY" | "ABHA_ADDRESS" | "DONE";
const AFTER_CREATION: Step[] = ["MOBILE_PENDING", "MOBILE_OTP_SENT", "ADDRESS_PENDING"];

/** "@sbx" in the sandbox, "@abdm" in production. */
export const abhaAddressSuffix = () => (env.abdm.cmId === "sbx" ? "@sbx" : "@abdm");

const key = (userId: string, subject: string) => ({ userId_subject: { userId, subject } });
const ttl = () => new Date(Date.now() + ENROL_TTL_MS);

// Nothing in progress. The OTP counters stay, so cancelling doesn't reset them.
const IDLE = {
  step: null,
  txnId: null,
  mobile: null,
  abhaLinkId: null,
  aadhaarConsentVersion: null,
  aadhaarConsentAt: null,
  attempts: 0,
  expiresAt: null,
} satisfies Prisma.AbhaEnrolmentUpdateInput;

async function guard(userId: string, subject: string) {
  assertSelf(subject);
  if (!abdmEnabled()) throw Errors.abdmNotConfigured();
  await checkSubject(userId, subject);
}

function assertSelf(subject: string) {
  if (subject !== "self") {
    throw Errors.badRequest(
      "ABHA_CREATE_SELF_ONLY",
      "ABHA creation is available for yourself only for now. Link a family member's existing ABHA instead.",
    );
  }
}

// Resend cooldown (same OTP again) and the daily cap. Returns the counters to
// save once the OTP has been sent.
function otpBudget(row: AbhaEnrolment | null, resend: boolean) {
  const now = Date.now();
  if (resend && row?.lastOtpAt && now - row.lastOtpAt.getTime() < RESEND_COOLDOWN_MS) {
    throw Errors.tooManyRequests("Wait a minute before asking for another OTP.");
  }
  const windowOpen = !!row?.otpWindowStart && now - row.otpWindowStart.getTime() < DAY_MS;
  const count = windowOpen ? row!.otpCount : 0;
  if (count >= DAILY_OTP_CAP) throw Errors.tooManyRequests("Too many OTPs today. Try again tomorrow.");
  return { otpCount: count + 1, otpWindowStart: windowOpen ? row!.otpWindowStart : new Date(now), lastOtpAt: new Date(now) };
}

/** The enrolment, if it is at one of `steps` and not expired. */
async function pending(userId: string, subject: string, steps: Step[]) {
  const row = await prisma.abhaEnrolment.findUnique({ where: key(userId, subject) });
  if (!row?.step || !steps.includes(row.step as Step)) {
    throw new AppError(404, "ABHA_ENROLMENT_NOT_FOUND", "No ABHA creation in progress at this step. Start again.");
  }
  if (!row.expiresAt || row.expiresAt < new Date()) {
    await prisma.abhaEnrolment.update({ where: { id: row.id }, data: IDLE });
    if (row.step === "AADHAAR_OTP_SENT") {
      throw Errors.badRequest("OTP_EXPIRED", "The OTP expired. Ask for a new one.");
    }
    throw Errors.badRequest(
      "ABHA_ENROLMENT_EXPIRED",
      "This session expired. Your ABHA is created and linked; you can change its address in the ABHA app.",
    );
  }
  return row as AbhaEnrolment & { txnId: string };
}

// A wrong OTP: counts the attempt; on the last one, `onExhausted` is saved.
async function wrongOtp(row: AbhaEnrolment, onExhausted: Prisma.AbhaEnrolmentUpdateInput): Promise<never> {
  const attempts = row.attempts + 1;
  if (attempts >= MAX_OTP_ATTEMPTS) {
    await prisma.abhaEnrolment.update({ where: { id: row.id }, data: onExhausted });
    throw Errors.badRequest("OTP_ATTEMPTS_EXCEEDED", "Too many wrong OTPs. Ask for a new one.");
  }
  await prisma.abhaEnrolment.update({ where: { id: row.id }, data: { attempts } });
  throw Errors.badRequest("OTP_INVALID", "The OTP is wrong.");
}

export function consentText() {
  return { ...AADHAAR_CONSENT };
}

export async function startEnrolment(userId: string, subject: string, aadhaar: string, consentVersion: string) {
  await guard(userId, subject);
  if (consentVersion !== AADHAAR_CONSENT.version) {
    throw Errors.badRequest(
      "AADHAAR_CONSENT_OUTDATED",
      `The Aadhaar consent changed. Show the current text (version ${AADHAAR_CONSENT.version}) and ask again.`,
    );
  }
  if (await prisma.abhaLink.findUnique({ where: key(userId, subject), select: { id: true } })) {
    throw Errors.conflict("ABHA_ALREADY_LINKED", "This person already has an ABHA linked. Unlink it first.");
  }

  const row = await prisma.abhaEnrolment.findUnique({ where: key(userId, subject) });
  const budget = otpBudget(row, row?.step === "AADHAAR_OTP_SENT");
  const txnId = await requestEnrolOtp(aadhaar);
  const expiresAt = ttl();
  const data = {
    ...IDLE,
    ...budget,
    step: "AADHAAR_OTP_SENT",
    txnId,
    expiresAt,
    aadhaarConsentVersion: consentVersion,
    aadhaarConsentAt: new Date(),
  };
  await prisma.abhaEnrolment.upsert({ where: key(userId, subject), create: { userId, subject, ...data }, update: data });
  return { expiresAt };
}

// ABDM's enrolment profile in the shape the shared ABHA helpers read.
const asProfile = (p: EnrolProfile) => ({ ...p, dateOfBirth: p.dob });
const lastTen = (phone?: string | null) => (phone ?? "").replace(/\D/g, "").slice(-10);

export async function verifyAadhaar(userId: string, subject: string, otp: string, mobileInput?: string) {
  await guard(userId, subject);
  const row = await pending(userId, subject, ["AADHAAR_OTP_SENT"]);

  let mobile = mobileInput;
  if (!mobile) {
    const profile = await prisma.patientProfile.findUnique({ where: { userId }, select: { phone: true } });
    mobile = lastTen(profile?.phone) || undefined;
  }
  if (!mobile || !/^[6-9]\d{9}$/.test(mobile)) {
    throw Errors.badRequest("MOBILE_REQUIRED", "Give a 10-digit mobile number for the ABHA.");
  }

  const result = await enrolByAadhaar(row.txnId, otp, mobile, row.aadhaarConsentVersion ?? AADHAAR_CONSENT.version);
  if (!result) return wrongOtp(row, IDLE);

  // The ABHA now exists at ABDM. Whether it may become this person's here:
  const profile = asProfile(result.profile);
  const abhaNumber = normaliseAbha(String(profile.ABHANumber));
  try {
    await assertAbhaFree(abhaNumber);
    await assertDemographicsMatch(userId, subject, profile);
  } catch (err) {
    await prisma.abhaEnrolment.update({ where: { id: row.id }, data: IDLE });
    throw err;
  }

  const next: Next = !result.isNew ? "DONE" : lastTen(profile.mobile) === mobile ? "ABHA_ADDRESS" : "MOBILE_VERIFY";
  let link;
  try {
    link = await prisma.$transaction(async (tx) => {
      const created = await tx.abhaLink.create({
        data: {
          userId,
          subject,
          familyMemberId: subject === "self" ? null : subject,
          abhaNumber,
          abhaAddress: profile.phrAddress?.[0] ?? null,
          name: profileName(profile),
          gender: profile.gender ?? null,
          yearOfBirth: profileYear(profile),
          verifiedAt: new Date(),
          source: "CREATED",
          aadhaarConsentVersion: row.aadhaarConsentVersion,
          aadhaarConsentAt: row.aadhaarConsentAt,
        },
        select: linkSelect,
      });
      await tx.abhaEnrolment.update({
        where: { id: row.id },
        data:
          next === "DONE"
            ? IDLE
            : {
                step: next === "MOBILE_VERIFY" ? "MOBILE_PENDING" : "ADDRESS_PENDING",
                txnId: result.txnId ?? row.txnId,
                mobile,
                abhaLinkId: created.id,
                attempts: 0,
                expiresAt: ttl(),
              },
      });
      return created;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      await prisma.abhaEnrolment.update({ where: { id: row.id }, data: IDLE });
      throw Errors.conflict("ABHA_IN_USE", "This ABHA is already linked.");
    }
    throw err;
  }
  await backfillCareContexts(link.id);
  return { abhaLink: link, isNew: result.isNew, next };
}

export async function sendMobileOtp(userId: string, subject: string) {
  await guard(userId, subject);
  const row = await pending(userId, subject, ["MOBILE_PENDING", "MOBILE_OTP_SENT"]);
  const budget = otpBudget(row, row.step === "MOBILE_OTP_SENT");
  const txnId = await requestEnrolMobileOtp(row.txnId, row.mobile!);
  const expiresAt = ttl();
  await prisma.abhaEnrolment.update({
    where: { id: row.id },
    data: { ...budget, step: "MOBILE_OTP_SENT", txnId, attempts: 0, expiresAt },
  });
  return { expiresAt };
}

export async function verifyMobile(userId: string, subject: string, otp: string): Promise<{ next: Next }> {
  await guard(userId, subject);
  const row = await pending(userId, subject, ["MOBILE_OTP_SENT"]);
  // Out of attempts: back to asking for a mobile OTP; the ABHA is unaffected.
  if (!(await verifyEnrolMobileOtp(row.txnId, otp))) return wrongOtp(row, { step: "MOBILE_PENDING", attempts: 0 });
  await prisma.abhaEnrolment.update({
    where: { id: row.id },
    data: { step: "ADDRESS_PENDING", attempts: 0, expiresAt: ttl() },
  });
  return { next: "ABHA_ADDRESS" };
}

export async function addressSuggestions(userId: string, subject: string) {
  await guard(userId, subject);
  const row = await pending(userId, subject, AFTER_CREATION);
  return { suggestions: await abhaAddressSuggestions(row.txnId), suffix: abhaAddressSuffix() };
}

export async function chooseAddress(userId: string, subject: string, abhaAddress: string) {
  await guard(userId, subject);
  const row = await pending(userId, subject, AFTER_CREATION);

  let chosen: string | undefined;
  try {
    chosen = await setAbhaAddress(row.txnId, abhaAddress);
  } catch (err) {
    if (err instanceof AbdmRejected) throw Errors.conflict("ABHA_ADDRESS_TAKEN", err.message);
    throw err;
  }
  const full = chosen ?? `${abhaAddress}${abhaAddressSuffix()}`;

  const [{ count }] = await prisma.$transaction([
    prisma.abhaLink.updateMany({ where: { id: row.abhaLinkId ?? "", userId }, data: { abhaAddress: full } }),
    prisma.abhaEnrolment.update({ where: { id: row.id }, data: IDLE }),
  ]);
  // Unlinked in the meantime: the address is set at ABDM, nothing to show here.
  if (count === 0) throw Errors.notFound("ABHA link");
  return prisma.abhaLink.findUniqueOrThrow({ where: { id: row.abhaLinkId! }, select: linkSelect });
}

/** Stops a creation in progress. An ABHA already created stays (unlink it with DELETE /me/abha/:id). */
export async function cancelEnrolment(userId: string, subject: string) {
  assertSelf(subject);
  await prisma.abhaEnrolment.updateMany({ where: { userId, subject }, data: IDLE });
}

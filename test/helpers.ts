import { randomUUID } from "node:crypto";
import supertest from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";

export const api = supertest(app);

export async function resetDb() {
  // health_records / rejections / ABDM consents and requests / referrals
  // don't hang off users, so they are listed too.
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "users", "access_audit", "health_records", "health_record_rejections", ' +
      '"abha_otp_verifications", "abha_enrolments", "abdm_consents", "abdm_data_requests", "privacy_consents", ' +
      '"patient_referrals", "rewarded_abhas" RESTART IDENTITY CASCADE',
  );
}

/** Headers the api-gateway sets after verifying a token. */
export function asUser(userId: string, role = "PATIENT") {
  return {
    "x-user-id": userId,
    "x-user-role": role,
    "x-gateway-secret": process.env.GATEWAY_SECRET!,
  };
}

/** A new patient (fresh token subject) - not onboarded yet. */
export const newPatient = () => asUser(randomUUID());

export const PROFILE = { fullName: "Ravi Kumar", dateOfBirth: "1990-05-14", gender: "MALE", bloodGroup: "O+", email: "ravi.kumar@example.com" };

// Consent to the privacy notice (PRIVACY_NOTICE_VERSION defaults to "1").
export const CONSENT = { noticeVersion: "1", adultDeclaration: true as const };
export const MEMBER_CONSENT = { noticeVersion: "1", basis: "MEMBER_CONSENTED" };
/** POST /me body: profile + consent. */
export const ONBOARDING = { ...PROFILE, consent: CONSENT };

/** A patient who has created their profile. */
export async function onboardedPatient() {
  const headers = newPatient();
  const res = await api.post("/api/v1/users/me").set(headers).send(ONBOARDING);
  if (res.status !== 201) throw new Error(`onboarding failed: ${JSON.stringify(res.body)}`);
  return headers;
}

export async function addFamilyMember(headers: Record<string, string>, body: object = { fullName: "Lakshmi", relationship: "MOTHER" }) {
  const res = await api.post("/api/v1/users/me/family-members").set(headers).send({ consent: MEMBER_CONSENT, ...body });
  return res.body.familyMember.id as string;
}

/** A valid producer payload for the patient behind `headers`. */
export function labReport(headers: Record<string, string>, overrides: Record<string, unknown> = {}) {
  return {
    source: "LABSCAN",
    sourceRecordId: `rep-${randomUUID()}`,
    sourceVersion: 1,
    encounterId: `appt-${randomUUID()}`,
    patient: { userId: headers["x-user-id"] },
    recordType: "DIAGNOSTIC_REPORT",
    title: "Complete blood count",
    summary: "All values within range.",
    recordedAt: "2026-10-01T09:30:00+05:30",
    facilityName: "Uyir Labs, Madurai",
    attachments: [{ fileName: "cbc.pdf", contentType: "application/pdf", contentBase64: Buffer.from("%PDF-1.4 cbc").toString("base64") }],
    ...overrides,
  };
}

export function pushRecord(body: object) {
  return api.post("/internal/v1/health-records").send(body);
}

/** Consent to linking an ABHA / sharing through ABDM, for self or a member. */
export async function consentToSharing(headers: Record<string, string>, memberId = "self") {
  const body =
    memberId === "self"
      ? { purpose: "ABDM_SHARING", ...CONSENT }
      : { purpose: "ABDM_SHARING", memberId, ...MEMBER_CONSENT };
  const res = await api.post("/api/v1/users/me/consents").set(headers).send(body);
  if (res.status !== 201 && res.status !== 200) throw new Error(`consent failed: ${JSON.stringify(res.body)}`);
}

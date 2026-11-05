import { Writable } from "node:stream";
import pino from "pino";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { api, resetDb, onboardedPatient, newPatient, addFamilyMember, consentToSharing, ONBOARDING } from "./helpers";
import { ABHA_PROFILE, ENROL_PROFILE, installFakeAbdm } from "./fakeAbdm";
import { prisma } from "../src/lib/prisma";
import { env } from "../src/lib/env";
import { redact } from "../src/lib/logger";
import { resetAbdmClientCache, ENROL } from "../src/modules/abdm/abdm.client";
import { AADHAAR_CONSENT, isValidAadhaar } from "../src/modules/abdm/aadhaarConsent";
import { runRetention } from "../src/modules/privacy/retention";

const CREATE = "/api/v1/users/me/abha/create";
const CONSENT = { accepted: true, version: AADHAAR_CONSENT.version };

/** A 12-digit number with a valid Verhoeff check digit. */
function aadhaarFrom(prefix11: string) {
  for (let d = 0; d <= 9; d++) if (isValidAadhaar(prefix11 + d)) return prefix11 + d;
  throw new Error("no check digit");
}
const AADHAAR = aadhaarFrom("23412341234");

let abdm: ReturnType<typeof installFakeAbdm>;

/** Onboarded, consented to ABDM sharing, Aadhaar OTP sent. */
async function startedPatient() {
  const headers = await onboardedPatient();
  await consentToSharing(headers);
  const res = await api.post(`${CREATE}/aadhaar/otp`).set(headers).send({ aadhaar: AADHAAR, consent: CONSENT });
  expect(res.status).toBe(200);
  return headers;
}

const verify = (headers: Record<string, string>, body: object = { otp: "123456", mobile: "9876543210" }) =>
  api.post(`${CREATE}/aadhaar/verify`).set(headers).send(body);

const enrolmentOf = (headers: Record<string, string>) =>
  prisma.abhaEnrolment.findUnique({ where: { userId_subject: { userId: headers["x-user-id"], subject: "self" } } });

beforeEach(async () => {
  await resetDb();
  resetAbdmClientCache();
  abdm = installFakeAbdm({ ...ABHA_PROFILE });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("profile creation does not depend on ABHA", () => {
  it("POST /me makes no ABDM call and works with ABDM unconfigured", async () => {
    const saved = env.abdm.clientId;
    env.abdm.clientId = "";
    try {
      const headers = newPatient();
      expect((await api.post("/api/v1/users/me").set(headers).send(ONBOARDING)).status).toBe(201);
      expect(abdm.calls).toHaveLength(0);
      // Only ABHA creation is unavailable.
      await consentToSharing(headers);
      const res = await api.post(`${CREATE}/aadhaar/otp`).set(headers).send({ aadhaar: AADHAAR, consent: CONSENT });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("ABDM_NOT_CONFIGURED");
    } finally {
      env.abdm.clientId = saved;
    }
  });

  it("ABDM down fails ABHA creation only", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connect ECONNREFUSED"); }));
    const headers = await onboardedPatient();
    await consentToSharing(headers);
    const res = await api.post(`${CREATE}/aadhaar/otp`).set(headers).send({ aadhaar: AADHAAR, consent: CONSENT });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("ABDM_UNAVAILABLE");
    expect((await api.get("/api/v1/users/me").set(headers)).status).toBe(200);
  });
});

describe("ABHA creation", () => {
  it("new ABHA: consent text, Aadhaar OTP, linked at once, address chosen", async () => {
    const headers = await onboardedPatient();

    const text = await api.get(`${CREATE}/consent-text`).set(headers);
    expect(text.body).toMatchObject({ code: "abha-enrollment", version: AADHAAR_CONSENT.version });

    // Not without consent to sharing through ABDM.
    const refused = await api.post(`${CREATE}/aadhaar/otp`).set(headers).send({ aadhaar: AADHAAR, consent: CONSENT });
    expect(refused.body.error.code).toBe("CONSENT_REQUIRED");
    await consentToSharing(headers);

    const otp = await api.post(`${CREATE}/aadhaar/otp`).set(headers).send({ aadhaar: AADHAAR.replace(/(\d{4})/g, "$1 ").trim(), consent: CONSENT });
    expect(otp.status).toBe(200);
    // Reached ABDM encrypted, and only there.
    expect(abdm.enrolment.aadhaarsSeen).toEqual([AADHAAR]);
    expect(JSON.stringify(abdm.to(ENROL.requestOtp)[0].body)).not.toContain(AADHAAR);

    const created = await verify(headers);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      isNew: true,
      next: "ABHA_ADDRESS",
      abhaLink: { abhaNumber: "91555566667777", abhaAddress: "91555566667777@sbx", source: "CREATED", familyMemberId: null },
    });
    expect(abdm.to(ENROL.byAadhaar)[0].body.consent).toEqual({ code: "abha-enrollment", version: AADHAAR_CONSENT.version });
    const link = await prisma.abhaLink.findFirstOrThrow({ where: { userId: headers["x-user-id"] } });
    expect(link.aadhaarConsentVersion).toBe(AADHAAR_CONSENT.version);
    expect(link.aadhaarConsentAt).toBeInstanceOf(Date);
    expect((await api.get("/api/v1/users/me/abha").set(headers)).body.abhaLinks).toHaveLength(1);

    const suggestions = await api.get(`${CREATE}/address-suggestions`).set(headers);
    expect(suggestions.body).toEqual({ suggestions: ["ravi.kumar1990", "ravikumar.90"], suffix: "@sbx" });
    expect(abdm.to(ENROL.suggestion)[0].headers.Transaction_Id).toBe("enrol-txn-1");

    const address = await api.post(`${CREATE}/address`).set(headers).send({ abhaAddress: "ravi.kumar1990" });
    expect(address.status).toBe(200);
    expect(address.body.abhaLink.abhaAddress).toBe("ravi.kumar1990@sbx");
    expect((await enrolmentOf(headers))?.step).toBeNull();

    const audits = await prisma.accessAudit.findMany({ where: { ownerId: headers["x-user-id"], resource: "abha-link" } });
    expect(audits.map((a) => a.action).sort()).toEqual(["CREATE", "UPDATE"]);

    // The Aadhaar number is nowhere in our database.
    const dump = JSON.stringify([
      await prisma.abhaEnrolment.findMany(),
      await prisma.abhaLink.findMany(),
      await prisma.accessAudit.findMany(),
    ]);
    expect(dump).not.toContain(AADHAAR);
  });

  it("an Aadhaar that already has an ABHA: that ABHA is linked, no address step", async () => {
    abdm.enrolment.isNew = false;
    const headers = await startedPatient();
    const res = await verify(headers);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ isNew: false, next: "DONE", abhaLink: { source: "CREATED" } });
    expect((await enrolmentOf(headers))?.step).toBeNull();
    expect((await api.get(`${CREATE}/address-suggestions`).set(headers)).body.error.code).toBe("ABHA_ENROLMENT_NOT_FOUND");
  });

  it("a mobile other than the Aadhaar's is verified by OTP, or skipped", async () => {
    const headers = await startedPatient();
    const res = await verify(headers, { otp: "123456", mobile: "9123456789" });
    expect(res.body.next).toBe("MOBILE_VERIFY");

    expect((await api.post(`${CREATE}/mobile/otp`).set(headers).send({})).status).toBe(200);
    expect(abdm.to(ENROL.requestOtp).at(-1)!.body).toMatchObject({ txnId: "enrol-txn-1", loginHint: "mobile", otpSystem: "abdm" });
    expect((await api.post(`${CREATE}/mobile/verify`).set(headers).send({ otp: "000000" })).body.error.code).toBe("OTP_INVALID");
    const ok = await api.post(`${CREATE}/mobile/verify`).set(headers).send({ otp: "123456" });
    expect(ok.body).toEqual({ next: "ABHA_ADDRESS" });
    expect(abdm.to(ENROL.byAbdm).at(-1)!.body.authData.otp.txnId).toBe("enrol-txn-2");

    // Skipping: the address can be chosen straight after creation.
    const other = await startedPatient();
    abdm.enrolment.profile = { ...ENROL_PROFILE, ABHANumber: "91-8888-9999-0000" };
    expect((await verify(other, { otp: "123456", mobile: "9123456789" })).body.next).toBe("MOBILE_VERIFY");
    expect((await api.post(`${CREATE}/address`).set(other).send({ abhaAddress: "ravikumar.90" })).status).toBe(200);
  });

  it("the mobile defaults to the profile's phone", async () => {
    const headers = await startedPatient();
    expect((await verify(headers, { otp: "123456" })).body.error.code).toBe("MOBILE_REQUIRED");
    await prisma.patientProfile.update({ where: { userId: headers["x-user-id"] }, data: { phone: "+91 98765 43210" } });
    const res = await verify(headers, { otp: "123456" });
    expect(res.body.next).toBe("ABHA_ADDRESS");
    expect(abdm.to(ENROL.byAadhaar).at(-1)!.body.authData.otp.mobile).toBe("9876543210");
  });

  it("three wrong Aadhaar OTPs end the attempt", async () => {
    const headers = await startedPatient();
    expect((await verify(headers, { otp: "000000", mobile: "9876543210" })).body.error.code).toBe("OTP_INVALID");
    expect((await verify(headers, { otp: "000000", mobile: "9876543210" })).body.error.code).toBe("OTP_INVALID");
    expect((await verify(headers, { otp: "000000", mobile: "9876543210" })).body.error.code).toBe("OTP_ATTEMPTS_EXCEEDED");
    expect((await verify(headers)).body.error.code).toBe("ABHA_ENROLMENT_NOT_FOUND");
    expect(await prisma.abhaLink.count()).toBe(0);
  });

  it("an expired OTP has to be asked for again", async () => {
    const headers = await startedPatient();
    await prisma.abhaEnrolment.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await verify(headers)).body.error.code).toBe("OTP_EXPIRED");
  });

  it("someone else's Aadhaar (demographics differ) is not linked", async () => {
    abdm.enrolment.profile = { ...ENROL_PROFILE, gender: "F", dob: "01-01-1993" };
    const headers = await startedPatient(); // MALE, 1990
    const res = await verify(headers);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ABHA_DEMOGRAPHIC_MISMATCH");
    expect(await prisma.abhaLink.count()).toBe(0);
    expect((await enrolmentOf(headers))?.step).toBeNull();
  });

  it("an ABHA already on another Uyir account is not linked again", async () => {
    const first = await startedPatient();
    expect((await verify(first)).status).toBe(201);
    const second = await startedPatient();
    const res = await verify(second);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ABHA_IN_USE");
  });

  it("refuses: ABHA already linked, family members, bad input, outdated consent", async () => {
    const headers = await startedPatient();
    await verify(headers);
    const again = await api.post(`${CREATE}/aadhaar/otp`).set(headers).send({ aadhaar: AADHAAR, consent: CONSENT });
    expect(again.body.error.code).toBe("ABHA_ALREADY_LINKED");

    const other = await onboardedPatient();
    const memberId = await addFamilyMember(other);
    await consentToSharing(other, memberId);
    const member = await api.post(`${CREATE}/aadhaar/otp`).set(other).send({ memberId, aadhaar: AADHAAR, consent: CONSENT });
    expect(member.body.error.code).toBe("ABHA_CREATE_SELF_ONLY");

    await consentToSharing(other);
    const badChecksum = AADHAAR.slice(0, 11) + ((Number(AADHAAR[11]) + 1) % 10);
    const bad = await api.post(`${CREATE}/aadhaar/otp`).set(other).send({ aadhaar: badChecksum, consent: CONSENT });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain(badChecksum);

    const notAccepted = await api.post(`${CREATE}/aadhaar/otp`).set(other).send({ aadhaar: AADHAAR, consent: { accepted: false, version: "1.4" } });
    expect(notAccepted.body.error.code).toBe("VALIDATION_ERROR");
    const outdated = await api.post(`${CREATE}/aadhaar/otp`).set(other).send({ aadhaar: AADHAAR, consent: { accepted: true, version: "0.9" } });
    expect(outdated.body.error.code).toBe("AADHAAR_CONSENT_OUTDATED");
    expect(abdm.enrolment.aadhaarsSeen).toHaveLength(1); // only the first patient's
  });

  it("OTP resend cooldown and daily cap", async () => {
    const headers = await startedPatient();
    const resend = () => api.post(`${CREATE}/aadhaar/otp`).set(headers).send({ aadhaar: AADHAAR, consent: CONSENT });
    expect((await resend()).status).toBe(429);
    await prisma.abhaEnrolment.updateMany({ data: { lastOtpAt: new Date(Date.now() - 61_000), otpCount: 5 } });
    const capped = await resend();
    expect(capped.status).toBe(429);
    expect(capped.body.error.message).toMatch(/today/);
    // Cancelling doesn't reset the count.
    expect((await api.delete(CREATE).set(headers)).status).toBe(204);
    expect((await resend()).status).toBe(429);
  });

  it("an address ABDM says is taken; steps out of order", async () => {
    const headers = await startedPatient();
    expect((await api.post(`${CREATE}/address`).set(headers).send({ abhaAddress: "ravi.kumar1990" })).body.error.code).toBe(
      "ABHA_ENROLMENT_NOT_FOUND",
    );
    expect((await api.post(`${CREATE}/mobile/otp`).set(headers).send({})).body.error.code).toBe("ABHA_ENROLMENT_NOT_FOUND");
    await verify(headers);
    abdm.enrolment.takenAddresses.push("ravi.kumar1990");
    const taken = await api.post(`${CREATE}/address`).set(headers).send({ abhaAddress: "ravi.kumar1990" });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe("ABHA_ADDRESS_TAKEN");
    expect((await api.post(`${CREATE}/address`).set(headers).send({ abhaAddress: "r@sbx" })).body.error.code).toBe("VALIDATION_ERROR");
  });

  it("withdrawing ABDM sharing or erasing the account removes the enrolment", async () => {
    const one = await startedPatient();
    expect((await api.delete("/api/v1/users/me/consents/ABDM_SHARING").set(one)).status).toBeLessThan(300);
    expect(await enrolmentOf(one)).toBeNull();

    const two = await startedPatient();
    expect((await api.delete("/api/v1/users/me").set(two).send({ confirm: "DELETE_MY_DATA" })).status).toBe(204);
    expect(await enrolmentOf(two)).toBeNull();
  });

  it("retention removes finished enrolments once the day's OTP count is old", async () => {
    const headers = await startedPatient();
    await api.delete(CREATE).set(headers);
    await runRetention(true);
    expect(await enrolmentOf(headers)).not.toBeNull(); // counts still matter today
    await prisma.abhaEnrolment.updateMany({ data: { otpWindowStart: new Date(Date.now() - 2 * 86_400_000) } });
    await runRetention(true);
    expect(await enrolmentOf(headers)).toBeNull();
  });
});

describe("Aadhaar never reaches the logs", () => {
  it("the logger redacts it", () => {
    const lines: string[] = [];
    const sink = new Writable({ write: (chunk, _enc, done) => (lines.push(String(chunk)), done()) });
    const log = pino({ redact }, sink);
    log.info({ aadhaar: AADHAAR, body: { aadhaar: AADHAAR }, req: { body: { aadhaar: AADHAAR } } }, "x");
    expect(lines.join("")).not.toContain(AADHAAR);
  });
});

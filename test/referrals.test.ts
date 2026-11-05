import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { api, resetDb, newPatient, onboardedPatient, addFamilyMember, consentToSharing, ONBOARDING, CONSENT } from "./helpers";
import { ABHA_PROFILE, installFakeAbdm } from "./fakeAbdm";
import { installFakeHp } from "./fakeHp";
import { prisma } from "../src/lib/prisma";
import { env } from "../src/lib/env";
import { resetAbdmClientCache } from "../src/modules/abdm/abdm.client";
import { AADHAAR_CONSENT, isValidAadhaar } from "../src/modules/abdm/aadhaarConsent";
import { abhaHash, processReferrals } from "../src/modules/referrals/referrals.service";

const ME = "/api/v1/users/me";
const ABHA = `${ME}/abha`;
const CODE = "HPRAVI001";

let hp: ReturnType<typeof installFakeHp>;

const signUp = (headers: Record<string, string>, referralCode?: unknown) =>
  api.post(ME).set(headers).send({ ...ONBOARDING, ...(referralCode === undefined ? {} : { referralCode }) });

/** A new patient who signed up with `code`. */
async function referredPatient(code = CODE) {
  const headers = newPatient();
  const res = await signUp(headers, code);
  expect(res.status).toBe(201);
  return headers;
}

const referralOf = (headers: Record<string, string>) => prisma.patientReferral.findUnique({ where: { userId: headers["x-user-id"] } });

/** Links the patient's (or a member's) existing ABHA by OTP. */
async function linkAbha(headers: Record<string, string>, memberId = "self") {
  await consentToSharing(headers, memberId);
  expect((await api.post(`${ABHA}/otp`).set(headers).send({ memberId, abhaNumber: ABHA_PROFILE.ABHANumber })).status).toBe(200);
  const res = await api.post(`${ABHA}/verify`).set(headers).send({ memberId, otp: "123456" });
  expect(res.status).toBe(201);
  return res.body.abhaLink as { id: string };
}

/** Creates a new ABHA by Aadhaar OTP (docs/abha-creation.md) - linked at once. */
async function createAbha(headers: Record<string, string>) {
  let aadhaar = "";
  for (let d = 0; d <= 9 && !aadhaar; d++) if (isValidAadhaar(`23412341234${d}`)) aadhaar = `23412341234${d}`;
  await consentToSharing(headers);
  const consent = { accepted: true, version: AADHAAR_CONSENT.version };
  expect((await api.post(`${ABHA}/create/aadhaar/otp`).set(headers).send({ aadhaar, consent })).status).toBe(200);
  const res = await api.post(`${ABHA}/create/aadhaar/verify`).set(headers).send({ otp: "123456", mobile: "9876543210" });
  expect(res.status).toBe(201);
}

/** Runs the worker step for rows that are due, even ones backing off. */
async function deliver() {
  await prisma.patientReferral.updateMany({ data: { nextAttemptAt: new Date(0) } });
  await processReferrals();
}

beforeEach(async () => {
  await resetDb();
  resetAbdmClientCache();
  installFakeAbdm({ ...ABHA_PROFILE });
  hp = installFakeHp();
});
afterEach(() => {
  vi.unstubAllGlobals();
  env.hp.serviceUrl = "";
});

describe("referral code at signup", () => {
  it("valid code: profile created, HP told PENDING by the worker, no reward yet", async () => {
    const headers = await referredPatient("hpravi001"); // any case
    expect(await referralOf(headers)).toMatchObject({ code: "hpravi001", status: "UNREGISTERED" });

    await processReferrals();
    expect(await referralOf(headers)).toMatchObject({ status: "PENDING", attempts: 0 });
    expect(hp.referrals.get(headers["x-user-id"])).toEqual({ code: CODE, status: "PENDING" });
    expect(hp.wallet[CODE]).toBeUndefined();

    // Nothing more to send until the ABHA is linked.
    const before = hp.calls.length;
    await deliver();
    expect(hp.calls.length).toBe(before);
  });

  it("is optional - no code, nothing stored and HP never called", async () => {
    const headers = newPatient();
    expect((await signUp(headers)).status).toBe(201);
    expect((await signUp(newPatient(), "")).status).toBe(201); // empty field = no code
    expect((await signUp(newPatient(), null)).status).toBe(201);
    expect(await prisma.patientReferral.count()).toBe(0);
    await linkAbha(headers);
    await deliver();
    expect(hp.calls).toHaveLength(0);
  });

  it("unknown code: 400 INVALID_REFERRAL_CODE and no profile, so it can be corrected", async () => {
    const headers = newPatient();
    const res = await signUp(headers, "HPWRONG");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_REFERRAL_CODE");
    expect((await api.get(ME).set(headers)).body.error.code).toBe("PROFILE_REQUIRED");
    expect(await prisma.patientReferral.count()).toBe(0);

    expect((await signUp(headers, CODE)).status).toBe(201);
  });

  it("an HP's own code is refused", async () => {
    const headers = newPatient();
    hp = installFakeHp({ [CODE]: headers["x-user-id"] });
    const res = await signUp(headers, CODE);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_REFERRAL_CODE");
  });

  it("too long: 400 VALIDATION_ERROR", async () => {
    const res = await signUp(newPatient(), "X".repeat(31));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("HP down: signup still works; the worker retries until HP answers", async () => {
    hp.state.down = true;
    const headers = await referredPatient();
    await processReferrals();
    const failed = await referralOf(headers);
    expect(failed).toMatchObject({ status: "UNREGISTERED", attempts: 1 });
    expect(failed!.lastError).toMatch(/unreachable/);
    expect(failed!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    hp.state.down = false;
    await deliver();
    expect(await referralOf(headers)).toMatchObject({ status: "PENDING", attempts: 0, lastError: null });
  });

  it("a slow HP holds a worker round for one timeout, not one per referral", async () => {
    hp.state.down = true;
    const patients = [];
    for (let i = 0; i < 8; i++) patients.push(await referredPatient());
    hp.state.down = false;
    hp.state.delayMs = 5_000;
    const savedTimeout = env.hp.timeoutMs;
    env.hp.timeoutMs = 300;
    try {
      const started = Date.now();
      await deliver();
      // One after another this would be 8 x 300 ms.
      expect(Date.now() - started).toBeLessThan(1_500);
      for (const p of patients) expect(await referralOf(p)).toMatchObject({ status: "UNREGISTERED", attempts: 1 });

      // HP fast again: the whole batch goes through in one round.
      hp.state.delayMs = 0;
      await deliver();
      for (const p of patients) expect(await referralOf(p)).toMatchObject({ status: "PENDING" });
    } finally {
      env.hp.timeoutMs = savedTimeout;
    }
  });

  it("HP not configured: code kept, sent once it is configured", async () => {
    env.hp.serviceUrl = "";
    const headers = await referredPatient("ANYCODE");
    await processReferrals();
    expect(await referralOf(headers)).toMatchObject({ status: "UNREGISTERED", attempts: 0 });
    expect(hp.calls).toHaveLength(0);

    env.hp.serviceUrl = "https://hp.test";
    await processReferrals();
    // Unchecked at signup, refused now: dropped, never retried.
    expect(await referralOf(headers)).toMatchObject({ status: "INVALID", reason: "INVALID_REFERRAL_CODE" });
  });

  it("only when the profile is created: PUT /me/profile with a code on an existing profile is refused", async () => {
    const headers = await onboardedPatient();
    const res = await api.put(`${ME}/profile`).set(headers).send({ ...ONBOARDING, referralCode: CODE });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("REFERRAL_CODE_SIGNUP_ONLY");

    // ...but PUT creating the profile (old apps) takes it.
    const fresh = newPatient();
    expect((await api.put(`${ME}/profile`).set(fresh).send({ ...ONBOARDING, consent: CONSENT, referralCode: CODE })).status).toBe(201);
    expect(await referralOf(fresh)).toMatchObject({ status: "UNREGISTERED" });
  });
});

describe("reward when the patient's own ABHA is linked", () => {
  it("existing ABHA linked: QUALIFIED, HP completes and pays ₹10 once", async () => {
    const headers = await referredPatient();
    await processReferrals();
    await linkAbha(headers);

    const qualified = await referralOf(headers);
    expect(qualified).toMatchObject({ status: "QUALIFIED" });
    expect(qualified!.qualifiedAt).toBeInstanceOf(Date);

    await processReferrals();
    expect(await referralOf(headers)).toMatchObject({ status: "COMPLETED" });
    expect(hp.referrals.get(headers["x-user-id"])!.status).toBe("COMPLETED");
    expect(hp.wallet[CODE]).toBe(10);

    await deliver();
    expect(hp.callsTo("/internal/v1/referrals/complete")).toHaveLength(1);
    expect(hp.wallet[CODE]).toBe(10);
  });

  it("new ABHA created by Aadhaar qualifies too", async () => {
    const headers = await referredPatient();
    await createAbha(headers);
    expect(await referralOf(headers)).toMatchObject({ status: "QUALIFIED" });
    await processReferrals();
    expect(hp.wallet[CODE]).toBe(10);
  });

  it("linked before HP heard of the signup: completed straight away", async () => {
    hp.state.down = true;
    const headers = await referredPatient();
    await linkAbha(headers);
    hp.state.down = false;
    await deliver();
    expect(await referralOf(headers)).toMatchObject({ status: "COMPLETED" });
    expect(hp.callsTo("/internal/v1/referrals")).toHaveLength(0);
    expect(hp.wallet[CODE]).toBe(10);
  });

  it("HP down when it qualifies: retried, still paid once", async () => {
    const headers = await referredPatient();
    await processReferrals();
    await linkAbha(headers);
    hp.state.down = true;
    await processReferrals();
    expect(await referralOf(headers)).toMatchObject({ status: "QUALIFIED", attempts: 1 });
    hp.state.down = false;
    await deliver();
    await deliver();
    expect(await referralOf(headers)).toMatchObject({ status: "COMPLETED" });
    expect(hp.wallet[CODE]).toBe(10);
  });

  it("a family member's ABHA does not count", async () => {
    const headers = await referredPatient();
    const memberId = await addFamilyMember(headers, { fullName: "Ravi Kumar", relationship: "BROTHER", gender: "MALE", dateOfBirth: "1990-05-14" });
    await linkAbha(headers, memberId);
    await processReferrals();
    expect(await referralOf(headers)).toMatchObject({ status: "PENDING" });
    expect(hp.wallet[CODE]).toBeUndefined();
  });

  it("unlinking afterwards keeps the reward; relinking pays nothing more", async () => {
    const headers = await referredPatient();
    const link = await linkAbha(headers);
    await deliver();
    expect((await api.delete(`${ABHA}/${link.id}`).set(headers)).status).toBe(204);
    await linkAbha(headers);
    await deliver();
    expect(await referralOf(headers)).toMatchObject({ status: "COMPLETED" });
    expect(hp.wallet[CODE]).toBe(10);
  });

  it("one reward per ABHA, ever: the same ABHA on another account cancels that referral", async () => {
    const first = await referredPatient();
    const link = await linkAbha(first);
    await deliver();
    expect((await api.delete(`${ABHA}/${link.id}`).set(first)).status).toBe(204);

    const second = await referredPatient();
    await processReferrals();
    await linkAbha(second); // the link itself still succeeds
    expect(await referralOf(second)).toMatchObject({ status: "CANCELLING", reason: "ABHA_ALREADY_REWARDED" });
    await processReferrals();
    expect(await referralOf(second)).toMatchObject({ status: "INVALID", reason: "ABHA_ALREADY_REWARDED" });
    expect(hp.referrals.get(second["x-user-id"])!.status).toBe("CANCELLED");
    expect(hp.wallet[CODE]).toBe(10);
  });

  it("keeps a hash, never the ABHA number", async () => {
    const headers = await referredPatient();
    await linkAbha(headers);
    const rows = await prisma.rewardedAbha.findMany();
    expect(rows).toEqual([expect.objectContaining({ abhaHash: abhaHash(ABHA_PROFILE.ABHANumber.replace(/-/g, "")) })]);
    expect(rows[0].abhaHash).not.toContain("1111");
  });

  it("HP refuses (already referred elsewhere): dropped, not retried", async () => {
    const headers = await referredPatient();
    hp.referrals.set(headers["x-user-id"], { code: "HPOTHER", status: "COMPLETED" });
    await processReferrals();
    expect(await referralOf(headers)).toMatchObject({ status: "INVALID", reason: "ALREADY_REFERRED" });
    await linkAbha(headers);
    await deliver();
    expect(hp.callsTo("/internal/v1/referrals/complete")).toHaveLength(0);
  });
});

describe("erasure and export", () => {
  const erase = (headers: Record<string, string>) => api.delete(ME).set(headers).send({ confirm: "DELETE_MY_DATA" });

  it("erased before linking: HP's referral cancelled, then our row deleted", async () => {
    const headers = await referredPatient();
    await processReferrals();
    expect((await erase(headers)).status).toBe(204);
    expect(await referralOf(headers)).toMatchObject({ status: "CANCELLING", reason: "ACCOUNT_ERASED" });
    await processReferrals();
    expect(await referralOf(headers)).toBeNull();
    expect(hp.referrals.get(headers["x-user-id"])!.status).toBe("CANCELLED");
  });

  it("erased after qualifying but before HP heard: still paid, then deleted", async () => {
    const headers = await referredPatient();
    await linkAbha(headers);
    hp.state.down = true;
    expect((await erase(headers)).status).toBe(204);
    expect(await referralOf(headers)).toMatchObject({ status: "QUALIFIED" });
    hp.state.down = false;
    await deliver();
    expect(await referralOf(headers)).toBeNull();
    expect(hp.wallet[CODE]).toBe(10);
    // The reward stays tied to the ABHA after erasure.
    expect(await prisma.rewardedAbha.count()).toBe(1);
  });

  it("erased after completion: nothing left here", async () => {
    const headers = await referredPatient();
    await linkAbha(headers);
    await deliver();
    expect((await erase(headers)).status).toBe(204);
    expect(await referralOf(headers)).toBeNull();
  });

  it("the export shows the code and its status", async () => {
    const headers = await referredPatient();
    const res = await api.get(`${ME}/export`).set(headers);
    expect(res.body.referral).toMatchObject({ code: CODE, status: "UNREGISTERED" });
  });
});

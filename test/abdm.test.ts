import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { api, resetDb, onboardedPatient, addFamilyMember, labReport, pushRecord, consentToSharing } from "./helpers";
import { ABHA_PROFILE, HIU_PUSH_URL, flush, installFakeAbdm } from "./fakeAbdm";
import { prisma } from "../src/lib/prisma";
import { env } from "../src/lib/env";
import { resetAbdmClientCache, HIECM } from "../src/modules/abdm/abdm.client";
import { resetAbdmKeys } from "../src/modules/abdm/abdm.callbacks.routes";
import { processCareContexts } from "../src/modules/abdm/careContexts";
import { processDataRequests } from "../src/modules/abdm/dataTransfer";
import { decryptFromHip, generateKeyPair } from "../src/modules/abdm/fidelius";

const ABHA = "/api/v1/users/me/abha";
const BRIDGE = "/abdm/api/v3";

let abdm: ReturnType<typeof installFakeAbdm>;

async function linkAbha(headers: Record<string, string>, memberId = "self") {
  await consentToSharing(headers, memberId);
  expect((await api.post(`${ABHA}/otp`).set(headers).send({ memberId, abhaNumber: ABHA_PROFILE.ABHANumber })).status).toBe(200);
  const res = await api.post(`${ABHA}/verify`).set(headers).send({ memberId, otp: "123456" });
  expect(res.status).toBe(201);
  return res.body.abhaLink as { id: string };
}

/** Drives HIP-initiated linking to the end, playing ABDM's callbacks. */
async function linkCareContexts() {
  await processCareContexts();
  const tokenCall = abdm.to(HIECM.generateLinkToken).at(-1)!;
  await api.post(`${BRIDGE}/hip/token/on-generate-token`).send({
    abhaAddress: ABHA_PROFILE.preferredAbhaAddress,
    linkToken: "link-token-1",
    response: { requestId: tokenCall.headers["REQUEST-ID"] },
  });
  await processCareContexts();
  const linkCall = abdm.to(HIECM.linkCareContext).at(-1)!;
  await api.post(`${BRIDGE}/link/on_carecontext`).send({ status: "Successfully Linked care context", response: { requestId: linkCall.headers["REQUEST-ID"] } });
  return { tokenCall, linkCall };
}

beforeEach(async () => {
  await resetDb();
  resetAbdmClientCache();
  abdm = installFakeAbdm({ ...ABHA_PROFILE });
});
afterEach(() => {
  vi.unstubAllGlobals();
  env.abdm.verifyCallbacks = false;
});

describe("ABHA linking", () => {
  it("OTP, wrong OTP, right OTP, listed", async () => {
    const headers = await onboardedPatient();
    // Linking shares records through ABDM: not without consent to that.
    const refused = await api.post(`${ABHA}/otp`).set(headers).send({ abhaNumber: "91111122223333" });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("CONSENT_REQUIRED");
    await consentToSharing(headers);
    await api.post(`${ABHA}/otp`).set(headers).send({ abhaNumber: "91111122223333" });

    const wrong = await api.post(`${ABHA}/verify`).set(headers).send({ otp: "000000" });
    expect(wrong.body.error.code).toBe("OTP_INVALID");

    const ok = await api.post(`${ABHA}/verify`).set(headers).send({ otp: "123456" });
    expect(ok.status).toBe(201);
    expect(ok.body.abhaLink).toMatchObject({ abhaNumber: "91111122223333", abhaAddress: "ravi@sbx", familyMemberId: null });

    expect((await api.get(ABHA).set(headers)).body.abhaLinks).toHaveLength(1);
    expect((await api.get("/api/v1/users/me/medical-history").set(headers)).body.abha.abhaNumber).toBe("91111122223333");
  });

  it("an ABHA can be linked once; resend has a cooldown", async () => {
    const owner = await onboardedPatient();
    await linkAbha(owner);
    const other = await onboardedPatient();
    await consentToSharing(other);
    const res = await api.post(`${ABHA}/otp`).set(other).send({ abhaNumber: ABHA_PROFILE.ABHANumber });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ABHA_IN_USE");

    const third = await onboardedPatient();
    await consentToSharing(third);
    await prisma.abhaLink.deleteMany();
    await api.post(`${ABHA}/otp`).set(third).send({ abhaNumber: ABHA_PROFILE.ABHANumber });
    expect((await api.post(`${ABHA}/otp`).set(third).send({ abhaNumber: ABHA_PROFILE.ABHANumber })).status).toBe(429);
  });

  it("refuses an ABHA whose demographics don't match the person", async () => {
    const headers = await onboardedPatient(); // MALE, born 1990
    const memberId = await addFamilyMember(headers, { fullName: "Lakshmi", relationship: "MOTHER", gender: "FEMALE", dateOfBirth: "1960-01-01" });
    await consentToSharing(headers, memberId);
    await api.post(`${ABHA}/otp`).set(headers).send({ memberId, abhaNumber: ABHA_PROFILE.ABHANumber });
    const res = await api.post(`${ABHA}/verify`).set(headers).send({ memberId, otp: "123456" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ABHA_DEMOGRAPHIC_MISMATCH");
  });
});

describe("care-context linking (HIP-initiated)", () => {
  it("existing and new records of the person are linked to their ABHA", async () => {
    const headers = await onboardedPatient();
    const before = labReport(headers);
    await pushRecord(before);
    await linkAbha(headers);
    await pushRecord(labReport(headers, { recordType: "PRESCRIPTION", title: "Rx" }));
    // Another person on the account has no ABHA: nothing for them.
    const memberId = await addFamilyMember(headers);
    await pushRecord(labReport(headers, { patient: { userId: headers["x-user-id"], familyMemberId: memberId } }));

    expect(await prisma.abdmCareContext.count()).toBe(2);
    const { tokenCall, linkCall } = await linkCareContexts();

    expect(tokenCall.headers).toMatchObject({ "X-HIP-ID": "UYIR-HIP-TEST", "X-CM-ID": "sbx", Authorization: "Bearer gateway-token" });
    expect(tokenCall.body).toMatchObject({ abhaNumber: "91-1111-2222-3333", abhaAddress: "ravi@sbx", gender: "M", yearOfBirth: 1990 });

    expect(linkCall.headers["X-LINK-TOKEN"]).toBe("link-token-1");
    expect(linkCall.body.patient.map((p: { hiType: string }) => p.hiType).sort()).toEqual(["DiagnosticReport", "Prescription"]);
    expect(linkCall.body.patient[0].referenceNumber).toBe(headers["x-user-id"]);
    const references = linkCall.body.patient.flatMap((p: { careContexts: { referenceNumber: string }[] }) => p.careContexts.map((c) => c.referenceNumber));
    expect(references).toContain(`LABSCAN:DIAGNOSTIC_REPORT:${before.encounterId}`);

    const statuses = await prisma.abdmCareContext.findMany({ select: { status: true } });
    expect(statuses.every((s) => s.status === "LINKED")).toBe(true);

    // Nothing left to do.
    abdm.calls.length = 0;
    await processCareContexts();
    expect(abdm.calls).toHaveLength(0);
  });

  it("a linking error from ABDM drops the link token and retries later", async () => {
    const headers = await onboardedPatient();
    await linkAbha(headers);
    await pushRecord(labReport(headers));
    await processCareContexts();
    const tokenCall = abdm.to(HIECM.generateLinkToken)[0];
    await api.post(`${BRIDGE}/hip/token/on-generate-token`).send({ linkToken: "t", response: { requestId: tokenCall.headers["REQUEST-ID"] } });
    await processCareContexts();
    const linkCall = abdm.to(HIECM.linkCareContext)[0];
    await api.post(`${BRIDGE}/link/on_carecontext`).send({ error: { code: 1400, message: "Invalid link token" }, response: { requestId: linkCall.headers["REQUEST-ID"] } });

    const context = await prisma.abdmCareContext.findFirstOrThrow({ include: { abhaLink: true } });
    expect(context).toMatchObject({ status: "PENDING", lastError: expect.stringContaining("Invalid link token") });
    expect(context.abhaLink.linkToken).toBeNull();
    expect(context.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("consent and health-information transfer", () => {
  async function linkedPatientWithReport(overrides: Record<string, unknown> = {}) {
    const headers = await onboardedPatient();
    await linkAbha(headers);
    const report = labReport(headers, overrides);
    await pushRecord(report);
    await linkCareContexts();
    return { headers, reference: `LABSCAN:DIAGNOSTIC_REPORT:${report.encounterId}`, patientReference: headers["x-user-id"] };
  }

  function consent(careContexts: object[], { status = "GRANTED", hiTypes = ["DiagnosticReport"], from = "2020-01-01T00:00:00Z" } = {}) {
    const consentId = randomUUID();
    return {
      consentId,
      body: {
        notification: {
          status,
          consentId,
          consentDetail: {
            consentId,
            patient: { id: "ravi@sbx" },
            careContexts,
            hiTypes,
            permission: { dateRange: { from, to: "2030-01-01T00:00:00Z" }, dataEraseAt: "2030-01-01T00:00:00Z" },
          },
        },
      },
    };
  }

  function hiRequest(consentId: string) {
    const hiu = generateKeyPair();
    const nonce = randomBytes(32).toString("base64");
    const transactionId = randomUUID();
    return {
      hiu,
      nonce,
      transactionId,
      body: {
        transactionId,
        hiRequest: {
          consent: { id: consentId },
          dateRange: { from: "2020-01-01T00:00:00Z", to: "2030-01-01T00:00:00Z" },
          dataPushUrl: HIU_PUSH_URL,
          keyMaterial: { cryptoAlg: "ECDH", curve: "Curve25519", dhPublicKey: { expiry: "2030-01-01T00:00:00Z", keyValue: hiu.publicKey }, nonce },
        },
      },
    };
  }

  it("sends the consented records as encrypted FHIR, then notifies ABDM", async () => {
    const { headers, reference, patientReference } = await linkedPatientWithReport();
    const c = consent([{ patientReference, careContextReference: reference }]);

    const notified = await api.post(`${BRIDGE}/consent/request/hip/notify`).set("REQUEST-ID", "abdm-req-1").send(c.body);
    expect(notified.status).toBe(202);
    await flush();
    expect(abdm.to(HIECM.consentOnNotify)[0].body).toEqual({ acknowledgement: { status: "ok", consentId: c.consentId }, response: { requestId: "abdm-req-1" } });

    const r = hiRequest(c.consentId);
    expect((await api.post(`${BRIDGE}/hip/health-information/request`).set("REQUEST-ID", "abdm-req-2").send(r.body)).status).toBe(202);
    await flush();
    expect(abdm.to(HIECM.healthInfoOnRequest)[0].body).toMatchObject({
      hiRequest: { transactionId: r.transactionId, sessionStatus: "ACKNOWLEDGED" },
      response: { requestId: "abdm-req-2" },
    });

    await processDataRequests();

    const pushes = abdm.to(HIU_PUSH_URL);
    expect(pushes).toHaveLength(1);
    const page = pushes[0].body;
    expect(page).toMatchObject({ pageNumber: 1, pageCount: 1, transactionId: r.transactionId });
    expect(pushes[0].headers.Authorization).toBeUndefined(); // our ABDM token never goes to an HIU
    const [entry] = page.entries;
    expect(entry.careContextReference).toBe(reference);

    const bundle = JSON.parse(decryptFromHip(entry.content, page.keyMaterial.dhPublicKey.keyValue, page.keyMaterial.nonce, r.hiu.privateKey, r.nonce));
    expect(bundle).toMatchObject({ resourceType: "Bundle", type: "document" });
    const resources = bundle.entry.map((e: { resource: { resourceType: string } }) => e.resource);
    const composition = resources.find((x: { resourceType: string }) => x.resourceType === "Composition");
    expect(composition.type.coding[0].code).toBe("721981007");
    const report = resources.find((x: { resourceType: string }) => x.resourceType === "DiagnosticReport");
    expect(report.conclusion).toBe("All values within range.");
    expect(Buffer.from(report.presentedForm[0].data, "base64").toString()).toBe("%PDF-1.4 cbc");
    const patient = resources.find((x: { resourceType: string }) => x.resourceType === "Patient");
    expect(patient).toMatchObject({ name: [{ text: "Ravi Kumar" }], gender: "male", birthDate: "1990-05-14" });

    const notify = abdm.to(HIECM.healthInfoNotify)[0].body.notification;
    expect(notify.statusNotification).toMatchObject({
      sessionStatus: "TRANSFERRED",
      statusResponses: [{ careContextReference: reference, hiStatus: "DELIVERED" }],
    });
    expect(await prisma.abdmDataRequest.findUniqueOrThrow({ where: { transactionId: r.transactionId } })).toMatchObject({ status: "TRANSFERRED" });
    expect(await prisma.accessAudit.count({ where: { ownerId: headers["x-user-id"], action: "SHARE", actorId: c.consentId } })).toBe(1);
  });

  it("sends only what the consent covers", async () => {
    const { reference, patientReference } = await linkedPatientWithReport({ recordedAt: "2021-01-01T00:00:00Z" });
    const other = await linkedOtherPatient();

    // Wrong HI type, a date range after the record, and someone else's care
    // context under this patient's reference.
    const c = consent(
      [
        { patientReference, careContextReference: reference },
        { patientReference, careContextReference: other.reference },
      ],
      { hiTypes: ["Prescription"], from: "2025-01-01T00:00:00Z" },
    );
    await api.post(`${BRIDGE}/consent/request/hip/notify`).send(c.body);
    const r = hiRequest(c.consentId);
    await api.post(`${BRIDGE}/hip/health-information/request`).send(r.body);
    await processDataRequests();

    const pages = abdm.to(HIU_PUSH_URL);
    expect(pages).toHaveLength(1);
    expect(pages[0].body.entries).toEqual([]);
    const statuses = abdm.to(HIECM.healthInfoNotify)[0].body.notification.statusNotification.statusResponses;
    expect(statuses).toEqual([
      { careContextReference: reference, hiStatus: "DELIVERED", description: "No records in the consented range" },
      { careContextReference: other.reference, hiStatus: "ERRORED", description: "Unknown care context" },
    ]);
  });

  async function linkedOtherPatient() {
    abdm = installFakeAbdm({ ...ABHA_PROFILE, ABHANumber: "91-9999-8888-7777", preferredAbhaAddress: "other@sbx" });
    resetAbdmClientCache();
    const headers = await onboardedPatient();
    await api.post(`${ABHA}/otp`).set(headers).send({ abhaNumber: "91-9999-8888-7777" });
    await api.post(`${ABHA}/verify`).set(headers).send({ otp: "123456" });
    const report = labReport(headers);
    await pushRecord(report);
    return { reference: `LABSCAN:DIAGNOSTIC_REPORT:${report.encounterId}` };
  }

  it("a revoked consent stops everything", async () => {
    const { reference, patientReference } = await linkedPatientWithReport();
    const c = consent([{ patientReference, careContextReference: reference }]);
    await api.post(`${BRIDGE}/consent/request/hip/notify`).send(c.body);

    // Request queued while granted, consent revoked before the worker runs.
    const queued = hiRequest(c.consentId);
    await api.post(`${BRIDGE}/hip/health-information/request`).send(queued.body);
    await api.post(`${BRIDGE}/consent/request/hip/notify`).send({ notification: { status: "REVOKED", consentId: c.consentId } });
    await processDataRequests();
    expect(abdm.to(HIU_PUSH_URL)).toHaveLength(0);
    expect(await prisma.abdmDataRequest.findUniqueOrThrow({ where: { transactionId: queued.transactionId } })).toMatchObject({ status: "FAILED" });

    // A request after revocation is refused at once.
    const late = hiRequest(c.consentId);
    await api.post(`${BRIDGE}/hip/health-information/request`).set("REQUEST-ID", "abdm-req-9").send(late.body);
    await flush();
    expect(abdm.to(HIECM.healthInfoOnRequest).at(-1)!.body.hiRequest.sessionStatus).toBe("ERRORED");
    expect(await prisma.abdmDataRequest.findUnique({ where: { transactionId: late.transactionId } })).toBeNull();
  });
});

describe("ABDM callback authentication", () => {
  it("accepts only ABDM-signed, unexpired tokens", async () => {
    env.abdm.verifyCallbacks = true;
    resetAbdmKeys();
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "abdm-1", alg: "RS256", use: "sig" };
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) =>
      String(url).endsWith("/api/hiecm/gateway/v3/certs") ? new Response(JSON.stringify({ keys: [jwk] })) : realFetch(url, init),
    ));

    const jwt = (exp: number, key = privateKey) => {
      const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: "abdm-1" })).toString("base64url");
      const p = Buffer.from(JSON.stringify({ exp })).toString("base64url");
      return `${h}.${p}.${sign("RSA-SHA256", Buffer.from(`${h}.${p}`), key).toString("base64url")}`;
    };
    const send = (token?: string) => {
      const req = api.post(`${BRIDGE}/link/on_carecontext`);
      if (token) req.set("authorization", `Bearer ${token}`);
      return req.send({ response: { requestId: randomUUID() } });
    };
    const now = Math.floor(Date.now() / 1000);

    expect((await send()).status).toBe(401);
    expect((await send(jwt(now - 10))).status).toBe(401); // expired
    expect((await send(jwt(now + 300, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey))).status).toBe(401); // forged
    expect((await send(jwt(now + 300))).status).toBe(202);
  });
});

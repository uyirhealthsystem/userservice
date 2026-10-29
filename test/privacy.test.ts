import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  api,
  resetDb,
  newPatient,
  onboardedPatient,
  addFamilyMember,
  labReport,
  pushRecord,
  CONSENT,
  MEMBER_CONSENT,
  ONBOARDING,
  SERVICE_TOKENS,
} from "./helpers";
import { prisma } from "../src/lib/prisma";
import { env } from "../src/lib/env";
import { openBytes, sealBytes } from "../src/lib/crypto";
import { encryptStoredAttachments, runRetention } from "../src/modules/privacy/retention";

const ME = "/api/v1/users/me";
const FAMILY = `${ME}/family-members`;
const CONSENTS = `${ME}/consents`;
const CONDITIONS = `${ME}/medical/conditions`;
const RECORDS = `${ME}/health-records`;
const INTERNAL_FAMILY = "/api/v1/users/family-members";

const userIdOf = (h: Record<string, string>) => h["x-user-id"];
const yearsAgo = (n: number) => `${new Date().getUTCFullYear() - n}-01-01`;

/** A patient onboarded before consent was asked for: profile, no consent. */
async function legacyPatient() {
  const headers = newPatient();
  await prisma.user.create({ data: { id: userIdOf(headers), profile: { create: { fullName: "Old Patient" } } } });
  return headers;
}

beforeEach(resetDb);

describe("consent at onboarding", () => {
  it("nothing is stored without consent to the current notice", async () => {
    const headers = newPatient();
    const { consent: _omitted, ...profileOnly } = ONBOARDING;
    expect((await api.post(ME).set(headers).send(profileOnly)).status).toBe(400);

    const outdated = await api.post(ME).set(headers).send({ ...ONBOARDING, consent: { ...CONSENT, noticeVersion: "0" } });
    expect(outdated.status).toBe(409);
    expect(outdated.body.error.code).toBe("NOTICE_OUTDATED");
    expect((await api.get(ME).set(headers)).body.error.code).toBe("PROFILE_REQUIRED");

    const ok = await api.post(ME).set(headers).send(ONBOARDING);
    expect(ok.status).toBe(201);
    const me = await api.get(ME).set(headers);
    expect(me.body.privacy).toEqual({ noticeVersion: "1", consentRequired: false });
    const privacy = await api.get(`${ME}/privacy`).set(headers);
    expect(privacy.body.consents).toHaveLength(1);
    expect(privacy.body.consents[0]).toMatchObject({ purpose: "CARE", basis: "SELF", noticeVersion: "1", familyMemberId: null });
  });

  it("an under-18 cannot hold their own account", async () => {
    const headers = newPatient();
    const res = await api.post(ME).set(headers).send({ ...ONBOARDING, dateOfBirth: yearsAgo(10) });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("MINOR_ACCOUNT");
    expect(await prisma.patientProfile.count()).toBe(0);
  });

  it("PUT /me/profile creates only with consent", async () => {
    const headers = newPatient();
    const { consent: _omitted, ...profileOnly } = ONBOARDING;
    const refused = await api.put(`${ME}/profile`).set(headers).send(profileOnly);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("CONSENT_REQUIRED");
    expect((await api.put(`${ME}/profile`).set(headers).send(ONBOARDING)).status).toBe(201);
  });
});

describe("consent gate", () => {
  it("a patient without consent can't reach medical data until they consent", async () => {
    const headers = await legacyPatient();
    const blocked = await api.get(CONDITIONS).set(headers);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("CONSENT_REQUIRED");
    expect((await api.get(ME).set(headers)).body.privacy.consentRequired).toBe(true);
    // The privacy controls still work.
    expect((await api.get(`${ME}/privacy`).set(headers)).status).toBe(200);
    expect((await api.get(`${ME}/export`).set(headers)).status).toBe(200);

    const given = await api.post(CONSENTS).set(headers).send({ purpose: "CARE", ...CONSENT });
    expect(given.status).toBe(201);
    // Idempotent.
    expect((await api.post(CONSENTS).set(headers).send({ purpose: "CARE", ...CONSENT })).status).toBe(200);
    expect((await api.get(CONDITIONS).set(headers)).status).toBe(200);
  });

  it("a new notice version asks everyone again", async () => {
    const headers = await onboardedPatient();
    env.privacy.noticeVersion = "2";
    try {
      expect((await api.get(CONDITIONS).set(headers)).body.error.code).toBe("CONSENT_REQUIRED");
      const old = await api.post(CONSENTS).set(headers).send({ purpose: "CARE", ...CONSENT });
      expect(old.body.error.code).toBe("NOTICE_OUTDATED");
      expect((await api.post(CONSENTS).set(headers).send({ purpose: "CARE", ...CONSENT, noticeVersion: "2" })).status).toBe(201);
      expect((await api.get(CONDITIONS).set(headers)).status).toBe(200);
    } finally {
      env.privacy.noticeVersion = "1";
    }
  });

  it("self consent needs the adult declaration", async () => {
    const headers = await legacyPatient();
    const res = await api.post(CONSENTS).set(headers).send({ purpose: "CARE", noticeVersion: "1" });
    expect(res.status).toBe(400);
  });
});

describe("family members", () => {
  it("a child can only be consented for by a parent or guardian", async () => {
    const headers = await onboardedPatient();
    const child = { fullName: "Anu", relationship: "DAUGHTER", dateOfBirth: yearsAgo(8) };
    const refused = await api.post(FAMILY).set(headers).send({ ...child, consent: MEMBER_CONSENT });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe("GUARDIAN_CONSENT_REQUIRED");
    expect(await prisma.familyMember.count()).toBe(0);

    const ok = await api.post(FAMILY).set(headers).send({ ...child, consent: { ...MEMBER_CONSENT, basis: "PARENT_OR_GUARDIAN" } });
    expect(ok.status).toBe(201);
    expect(ok.body.familyMember.consent).toEqual({ care: true, abdmSharing: false });
  });

  it("a date of birth that makes an adult-consented member a child needs a guardian's consent", async () => {
    const headers = await onboardedPatient();
    const id = await addFamilyMember(headers, { fullName: "Kid", relationship: "SON" });
    const res = await api.patch(`${FAMILY}/${id}`).set(headers).send({ dateOfBirth: yearsAgo(5) });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("GUARDIAN_CONSENT_REQUIRED");

    await api.post(CONSENTS).set(headers).send({ purpose: "CARE", memberId: id, noticeVersion: "1", basis: "PARENT_OR_GUARDIAN" });
    expect((await api.patch(`${FAMILY}/${id}`).set(headers).send({ dateOfBirth: yearsAgo(5) })).status).toBe(200);
  });

  it("a member without consent is listed but their data is hidden from the patient and other services", async () => {
    const headers = await onboardedPatient();
    const userId = userIdOf(headers);
    const member = await prisma.familyMember.create({ data: { userId, fullName: "Legacy", relationship: "FATHER" } });
    await prisma.medicalCondition.create({ data: { userId, familyMemberId: member.id, name: "Diabetes", status: "ACTIVE" } });
    await pushRecord(labReport(headers, { patient: { userId, familyMemberId: member.id } }));

    const list = await api.get(FAMILY).set(headers);
    expect(list.body.familyMembers[0].consent).toEqual({ care: false, abdmSharing: false });
    expect((await api.get(CONDITIONS).set(headers)).body.conditions).toHaveLength(0);
    expect((await api.get(RECORDS).set(headers)).body.healthRecords).toHaveLength(0);
    const direct = await api.get(`${CONDITIONS}?memberId=${member.id}`).set(headers);
    expect(direct.status).toBe(403);
    expect(direct.body.error.code).toBe("CONSENT_REQUIRED");
    const internal = await api.get(INTERNAL_FAMILY).set({ "X-User-Id": userId, Authorization: `Bearer ${SERVICE_TOKENS.LABSCAN}` });
    expect(internal.body.familyMembers).toHaveLength(0);

    await api.post(CONSENTS).set(headers).send({ purpose: "CARE", memberId: member.id, ...MEMBER_CONSENT });
    expect((await api.get(CONDITIONS).set(headers)).body.conditions).toHaveLength(1);
    expect((await api.get(RECORDS).set(headers)).body.healthRecords).toHaveLength(1);
    const after = await api.get(INTERNAL_FAMILY).set({ "X-User-Id": userId, Authorization: `Bearer ${SERVICE_TOKENS.LABSCAN}` });
    expect(after.body.familyMembers).toHaveLength(1);
  });
});

describe("withdrawing consent", () => {
  it("CARE for a member erases that member and their records", async () => {
    const headers = await onboardedPatient();
    const userId = userIdOf(headers);
    const id = await addFamilyMember(headers);
    await api.post(CONDITIONS).set(headers).send({ name: "Asthma", status: "ACTIVE", familyMemberId: id });
    await pushRecord(labReport(headers, { patient: { userId, familyMemberId: id } }));

    expect((await api.delete(`${CONSENTS}/CARE?memberId=${id}`).set(headers)).status).toBe(204);
    expect(await prisma.familyMember.count()).toBe(0);
    expect(await prisma.medicalCondition.count()).toBe(0);
    expect(await prisma.healthRecord.count()).toBe(0);
    const consents = await prisma.privacyConsent.findMany({ where: { familyMemberId: id } });
    expect(consents.every((c) => c.withdrawnAt !== null)).toBe(true);
  });

  it("ABDM_SHARING removes the ABHA link", async () => {
    const headers = await onboardedPatient();
    const userId = userIdOf(headers);
    await api.post(CONSENTS).set(headers).send({ purpose: "ABDM_SHARING", ...CONSENT });
    await prisma.abhaLink.create({ data: { userId, subject: "self", abhaNumber: "91111122223333", verifiedAt: new Date() } });

    expect((await api.delete(`${CONSENTS}/ABDM_SHARING`).set(headers)).status).toBe(204);
    expect(await prisma.abhaLink.count()).toBe(0);
    expect((await api.get(CONDITIONS).set(headers)).status).toBe(200); // CARE untouched
  });

  it("CARE for oneself is erasure, and nothing to withdraw is a 404", async () => {
    const headers = await onboardedPatient();
    const res = await api.delete(`${CONSENTS}/CARE`).set(headers);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ERASURE_REQUIRED");
    expect((await api.delete(`${CONSENTS}/ABDM_SHARING`).set(headers)).status).toBe(404);
  });
});

describe("access log, sharing summary, export", () => {
  it("lists accesses newest first, paged", async () => {
    const headers = await onboardedPatient();
    for (let i = 0; i < 3; i++) await api.get(CONDITIONS).set(headers);

    const first = await api.get(`${ME}/access-log?limit=2`).set(headers);
    expect(first.body.entries).toHaveLength(2);
    expect(first.body.entries[0]).toMatchObject({ action: "READ", resource: "conditions", actorRole: "PATIENT" });
    const second = await api
      .get(`${ME}/access-log?limit=2&before=${first.body.next.before}&beforeId=${first.body.next.beforeId}`)
      .set(headers);
    expect(second.body.entries).toHaveLength(1);
    expect(second.body.next).toBeNull();
    // Only the caller's own trail.
    const stranger = await onboardedPatient();
    expect((await api.get(`${ME}/access-log`).set(stranger)).body.entries).toHaveLength(0);
  });

  it("summarises what was shared through ABDM, per consent", async () => {
    const headers = await onboardedPatient();
    const ownerId = userIdOf(headers);
    await prisma.abdmConsent.create({
      data: {
        consentId: "c-1",
        status: "GRANTED",
        hiTypes: ["DiagnosticReport"],
        artefact: { notification: { consentDetail: { purpose: { text: "Care management" }, hiu: { id: "HOSP-1" } } } },
      },
    });
    for (const recordId of ["r1", "r2"]) {
      await prisma.accessAudit.create({ data: { ownerId, actorId: "c-1", actorRole: "ABDM", action: "SHARE", resource: "health-records", resourceId: recordId } });
    }
    const res = await api.get(`${ME}/data-sharing`).set(headers);
    expect(res.body.sharing).toEqual([
      expect.objectContaining({ consentId: "c-1", consentStatus: "GRANTED", purpose: "Care management", requester: { id: "HOSP-1" }, recordsShared: 2 }),
    ]);
  });

  it("exports everything held, and audits the export", async () => {
    const headers = await onboardedPatient();
    const id = await addFamilyMember(headers);
    await api.post(CONDITIONS).set(headers).send({ name: "Asthma", status: "ACTIVE" });
    await pushRecord(labReport(headers));
    await api.put(`${ME}/nominee`).set(headers).send({ fullName: "Meena", relationship: "SPOUSE", phone: "9876543210" });

    const res = await api.get(`${ME}/export`).set(headers);
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="?uyir-data-/);
    const data = JSON.parse(res.text);
    expect(data.profile.fullName).toBe("Ravi Kumar");
    expect(data.nominee.fullName).toBe("Meena");
    expect(data.familyMembers.map((m: { id: string }) => m.id)).toEqual([id]);
    expect(data.medical.conditions).toHaveLength(1);
    expect(data.healthRecords[0].attachments[0]).toMatchObject({ fileName: "cbc.pdf", status: "STORED" });
    expect(data.consents.map((c: { purpose: string }) => c.purpose)).toEqual(["CARE", "CARE"]);
    expect(await prisma.accessAudit.count({ where: { resource: "export" } })).toBe(1);
  });
});

describe("erasure", () => {
  it("needs explicit confirmation", async () => {
    const headers = await onboardedPatient();
    expect((await api.delete(ME).set(headers)).status).toBe(400);
    expect((await api.delete(ME).set(headers).send({ confirm: "yes" })).status).toBe(400);
    expect(await prisma.user.count()).toBe(1);
  });

  it("erases the account's data, keeps the evidence", async () => {
    const headers = await onboardedPatient();
    const userId = userIdOf(headers);
    await addFamilyMember(headers);
    await api.post(CONDITIONS).set(headers).send({ name: "Asthma", status: "ACTIVE" });
    await pushRecord(labReport(headers));
    await prisma.abhaOtpVerification.create({
      data: { userId, subject: "self", abhaNumber: "91111122223333", otpMethod: "abdm", txnId: "t", expiresAt: new Date(Date.now() + 60_000) },
    });
    const other = await onboardedPatient();
    await pushRecord(labReport(other));

    expect((await api.delete(ME).set(headers).send({ confirm: "DELETE_MY_DATA" })).status).toBe(204);

    expect((await api.get(ME).set(headers)).body.error.code).toBe("PROFILE_REQUIRED");
    for (const count of [
      prisma.user.count({ where: { id: userId } }),
      prisma.familyMember.count({ where: { userId } }),
      prisma.medicalCondition.count({ where: { userId } }),
      prisma.healthRecord.count({ where: { userId } }),
      prisma.healthRecordAttachment.count({ where: { healthRecord: { userId } } }),
      prisma.abhaOtpVerification.count({ where: { userId } }),
      prisma.privacyConsent.count({ where: { userId, withdrawnAt: null } }),
    ]) {
      expect(await count).toBe(0);
    }
    expect(await prisma.accessAudit.count({ where: { ownerId: userId, resource: "account", action: "DELETE" } })).toBe(1);
    expect(await prisma.healthRecord.count()).toBe(1); // the other patient's
  });

  it("covers records a provider sent before the patient ever onboarded", async () => {
    const headers = newPatient();
    await pushRecord(labReport(headers));
    expect((await api.delete(ME).set(headers).send({ confirm: "DELETE_MY_DATA" })).status).toBe(204);
    expect(await prisma.healthRecord.count()).toBe(0);
  });
});

describe("nominee", () => {
  it("set, read, replace, remove", async () => {
    const headers = await onboardedPatient();
    const NOMINEE = `${ME}/nominee`;
    expect((await api.get(NOMINEE).set(headers)).status).toBe(404);
    expect((await api.put(NOMINEE).set(headers).send({ fullName: "Meena", relationship: "SPOUSE", phone: "9876543210" })).status).toBe(200);
    await api.put(NOMINEE).set(headers).send({ fullName: "Meena R", relationship: "SPOUSE", phone: "9876543210", email: "meena@example.com" });
    expect((await api.get(NOMINEE).set(headers)).body.nominee).toMatchObject({ fullName: "Meena R", email: "meena@example.com" });
    expect((await api.delete(NOMINEE).set(headers)).status).toBe(204);
    expect((await api.get(NOMINEE).set(newPatient())).body.error.code).toBe("PROFILE_REQUIRED");
  });
});

describe("retention", () => {
  const old = (days: number) => new Date(Date.now() - days * 86_400_000);

  it("deletes what has outlived its window, and only that", async () => {
    const headers = await onboardedPatient();
    await prisma.healthRecordRejection.createMany({
      data: [
        { channel: "HTTP", reason: "old", at: old(31) },
        { channel: "HTTP", reason: "new" },
      ],
    });
    await prisma.abhaOtpVerification.create({
      data: { userId: randomUUID(), subject: "self", abhaNumber: "1", otpMethod: "abdm", txnId: "t", expiresAt: old(1) },
    });
    // A never-onboarded patient's record: old one goes, recent one stays.
    const stranger = newPatient();
    await pushRecord(labReport(stranger, { sourceRecordId: "orphan-old" }));
    await pushRecord(labReport(stranger, { sourceRecordId: "orphan-new" }));
    await pushRecord(labReport(headers, { sourceRecordId: "kept" }));
    await prisma.healthRecord.updateMany({ where: { sourceRecordId: { in: ["orphan-old", "kept"] } }, data: { createdAt: old(400) } });
    await prisma.accessAudit.createMany({
      data: [
        { ownerId: "x", actorId: "x", actorRole: "PATIENT", action: "READ", resource: "conditions", at: old(1100) },
        { ownerId: "x", actorId: "x", actorRole: "PATIENT", action: "READ", resource: "conditions", at: old(400) },
      ],
    });
    await prisma.privacyConsent.create({
      data: { userId: "x", purpose: "CARE", noticeVersion: "1", basis: "SELF", withdrawnAt: old(1100) },
    });

    const counts = await runRetention(true);
    expect(counts).toMatchObject({ rejections: 1, expiredOtps: 1, orphanRecords: 1, accessAudit: 1, withdrawnConsents: 1 });
    expect((await prisma.healthRecord.findMany({ select: { sourceRecordId: true } })).map((r) => r.sourceRecordId).sort()).toEqual([
      "kept",
      "orphan-new",
    ]);
    expect(await prisma.privacyConsent.count({ where: { userId: userIdOf(headers) } })).toBe(1);
  });
});

describe("encryption at rest", () => {
  afterEach(() => {
    env.dataEncryptionKey = Buffer.alloc(32, 7);
  });

  it("stores files encrypted and serves them decrypted", async () => {
    const headers = await onboardedPatient();
    await pushRecord(labReport(headers));
    const row = await prisma.healthRecordAttachment.findFirstOrThrow();
    expect(row.encrypted).toBe(true);
    expect(Buffer.from(row.content!).includes(Buffer.from("%PDF"))).toBe(false);

    const res = await api.get(`${RECORDS}/${row.healthRecordId}/attachments/${row.id}`).set(headers).buffer(true);
    expect(Buffer.from(res.body).toString()).toBe("%PDF-1.4 cbc");
  });

  it("encrypts files stored before the key was set", async () => {
    const headers = await onboardedPatient();
    env.dataEncryptionKey = undefined;
    await pushRecord(labReport(headers));
    expect((await prisma.healthRecordAttachment.findFirstOrThrow()).encrypted).toBe(false);

    env.dataEncryptionKey = Buffer.alloc(32, 7);
    expect(await encryptStoredAttachments()).toBe(1);
    const row = await prisma.healthRecordAttachment.findFirstOrThrow();
    expect(row.encrypted).toBe(true);
    expect(openBytes(row.content!, true).toString()).toBe("%PDF-1.4 cbc");
    expect(await encryptStoredAttachments()).toBe(0);
  });

  it("rejects a tampered file", () => {
    const { content } = sealBytes(Buffer.from("secret"));
    content[content.length - 1] ^= 1;
    expect(() => openBytes(content, true)).toThrow();
  });
});

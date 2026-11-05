import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { api, resetDb, newPatient, onboardedPatient, addFamilyMember, labReport, pushRecord, CONSENT } from "./helpers";
import { prisma } from "../src/lib/prisma";
import { handleHealthRecordMessage } from "../src/modules/records/records.consumer";
import { fetchPendingAttachments } from "../src/modules/records/attachments.fetcher";

const RECORDS = "/api/v1/users/me/health-records";
const HISTORY = "/api/v1/users/me/medical-history";

describe("health record ingestion (internal)", () => {
  beforeEach(resetDb);

  it("needs no token - the record's own source names the producer", async () => {
    const headers = await onboardedPatient();
    expect((await pushRecord(labReport(headers))).status).toBe(201);
    expect((await pushRecord(labReport(headers, { source: "ECG" }))).status).toBe(201);
  });

  it("is not reachable under the gateway-forwarded prefix", async () => {
    const headers = await onboardedPatient();
    const res = await api.post("/api/v1/users/internal/v1/health-records").set(headers).send(labReport(headers));
    expect(res.status).toBe(404);
  });

  it("create, re-deliver, newer version, older version", async () => {
    const headers = await onboardedPatient();
    const body = labReport(headers);

    const created = await pushRecord(body);
    expect(created.status).toBe(201);
    expect(created.body.outcome).toBe("created");

    const again = await pushRecord(body);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ outcome: "unchanged", recordId: created.body.recordId });

    const v2 = await pushRecord({ ...body, sourceVersion: 2, status: "AMENDED", summary: "Haemoglobin low.", attachments: [] });
    expect(v2.body.outcome).toBe("updated");

    const stale = await pushRecord({ ...body, sourceVersion: 1, summary: "stale" });
    expect(stale.body.outcome).toBe("unchanged");

    const stored = await prisma.healthRecord.findUniqueOrThrow({ where: { id: created.body.recordId }, include: { attachments: true } });
    expect(stored).toMatchObject({ sourceVersion: 2, status: "AMENDED", summary: "Haemoglobin low." });
    expect(stored.attachments).toHaveLength(0);

    const audits = await prisma.accessAudit.findMany({ where: { resourceId: created.body.recordId }, orderBy: { at: "asc" } });
    expect(audits.map((a) => [a.actorId, a.actorRole, a.action])).toEqual([
      ["LABSCAN", "SERVICE", "CREATE"],
      ["LABSCAN", "SERVICE", "UPDATE"],
    ]);
  });

  it("concurrent deliveries of one record store it once", async () => {
    const headers = await onboardedPatient();
    const body = labReport(headers);
    const results = await Promise.all([1, 2, 3, 4].map((v) => pushRecord({ ...body, sourceVersion: v })));
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    const rows = await prisma.healthRecord.findMany({ where: { sourceRecordId: body.sourceRecordId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceVersion).toBe(4);
  });

  it("rejects an unknown or foreign family member, and a subject change", async () => {
    const owner = await onboardedPatient();
    const other = await onboardedPatient();
    const othersMember = await addFamilyMember(other);

    const foreign = await pushRecord(labReport(owner, { patient: { userId: owner["x-user-id"], familyMemberId: othersMember } }));
    expect(foreign.status).toBe(422);
    expect(foreign.body.error.code).toBe("UNKNOWN_FAMILY_MEMBER");

    const body = labReport(owner);
    await pushRecord(body);
    const moved = await pushRecord({ ...body, sourceVersion: 2, patient: { userId: other["x-user-id"] } });
    expect(moved.status).toBe(422);
    expect(moved.body.error.code).toBe("SUBJECT_CHANGED");

    const rejections = await prisma.healthRecordRejection.findMany({ orderBy: { at: "asc" } });
    expect(rejections.map((r) => r.reason.split(":")[0])).toEqual(["UNKNOWN_FAMILY_MEMBER", "SUBJECT_CHANGED"]);
    // Inline file bytes are not kept in the rejection log.
    expect(JSON.stringify(rejections[0].payload)).toContain("<omitted>");
  });

  it("validates the payload", async () => {
    const headers = await onboardedPatient();
    const res = await pushRecord(labReport(headers, { recordType: "XRAY", attachments: [{ fileName: "a.pdf" }] }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("keeps records of a patient who has not created a profile yet", async () => {
    const headers = newPatient();
    expect((await pushRecord(labReport(headers))).status).toBe(201);

    await api.post("/api/v1/users/me").set(headers).send({ fullName: "Late Onboarder", email: "late@example.com", consent: CONSENT });
    const list = await api.get(RECORDS).set(headers);
    expect(list.body.healthRecords).toHaveLength(1);
  });
});

describe("health records over Kafka", () => {
  beforeEach(resetDb);

  const envelope = (data: object) =>
    Buffer.from(JSON.stringify({ eventType: "HealthRecordPublished", eventVersion: 1, occurredAt: new Date().toISOString(), data }));

  it("stores a valid event; logs and skips a bad one", async () => {
    const headers = await onboardedPatient();
    const ecg = labReport(headers, { source: "ECG", recordType: "DIAGNOSTIC_REPORT", title: "12-lead ECG", attachments: [] });
    await handleHealthRecordMessage(envelope(ecg));
    expect(await prisma.healthRecord.count({ where: { source: "ECG" } })).toBe(1);

    // None of these throw - a bad message must not block the partition.
    await handleHealthRecordMessage(Buffer.from("not json"));
    await handleHealthRecordMessage(envelope({ ...ecg, recordType: "NOPE" }));
    await handleHealthRecordMessage(envelope({ ...ecg, sourceRecordId: "x1", patient: { userId: headers["x-user-id"], familyMemberId: crypto.randomUUID() } }));
    expect(await prisma.healthRecordRejection.count({ where: { channel: "KAFKA" } })).toBe(3);
  });
});

describe("attachments sent by URL", () => {
  beforeEach(resetDb);
  afterEach(() => vi.unstubAllGlobals());

  it("are fetched by the worker, then downloadable", async () => {
    const headers = await onboardedPatient();
    const url = "http://labscan.internal/files/r1.pdf";
    const created = await pushRecord(labReport(headers, { attachments: [{ fileName: "r1.pdf", contentType: "application/pdf", url }] }));
    const record = (await api.get(`${RECORDS}/${created.body.recordId}`).set(headers)).body.healthRecord;
    const attachmentId = record.attachments[0].id;
    expect(record.attachments[0].status).toBe("PENDING");

    const download = `${RECORDS}/${record.id}/attachments/${attachmentId}`;
    expect((await api.get(download).set(headers)).body.error.code).toBe("ATTACHMENT_NOT_READY");

    vi.stubGlobal("fetch", vi.fn(async (u: string) => (u === url ? new Response("%PDF-1.4 r1") : new Response("", { status: 404 }))));
    expect(await fetchPendingAttachments()).toBe(1);

    const file = await api.get(download).set(headers);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toBe("application/pdf");
    expect(file.headers["content-disposition"]).toContain("r1.pdf");
    expect(Buffer.from(file.body).toString()).toBe("%PDF-1.4 r1");
  });

  it("a producer that can't serve the file is retried, not lost", async () => {
    const headers = await onboardedPatient();
    await pushRecord(labReport(headers, { attachments: [{ fileName: "r.pdf", url: "http://labscan.internal/missing.pdf" }] }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    await fetchPendingAttachments();
    const row = await prisma.healthRecordAttachment.findFirstOrThrow();
    expect(row).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(row.lastError).toContain("503");
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("patient reads", () => {
  beforeEach(resetDb);

  it("lists own records, newest first, hiding retracted ones; filters by member and type", async () => {
    const headers = await onboardedPatient();
    const memberId = await addFamilyMember(headers);
    await pushRecord(labReport(headers, { recordedAt: "2026-01-01T00:00:00Z", title: "Old" }));
    await pushRecord(labReport(headers, { recordedAt: "2026-06-01T00:00:00Z", title: "New" }));
    await pushRecord(labReport(headers, { title: "Mother's", patient: { userId: headers["x-user-id"], familyMemberId: memberId } }));
    await pushRecord(labReport(headers, { title: "Retracted", status: "ENTERED_IN_ERROR" }));
    await pushRecord(labReport(headers, { title: "Rx", recordType: "PRESCRIPTION", recordedAt: "2026-09-01T00:00:00Z" }));

    const all = await api.get(RECORDS).set(headers);
    expect(all.status).toBe(200);
    expect(all.body.healthRecords.map((r: { title: string }) => r.title)).toEqual(["Mother's", "Rx", "New", "Old"]);
    expect(all.body.healthRecords[0].userId).toBeUndefined();

    const self = await api.get(`${RECORDS}?memberId=self&recordType=DIAGNOSTIC_REPORT`).set(headers);
    expect(self.body.healthRecords.map((r: { title: string }) => r.title)).toEqual(["New", "Old"]);
    const mother = await api.get(`${RECORDS}?memberId=${memberId}`).set(headers);
    expect(mother.body.healthRecords.map((r: { title: string }) => r.title)).toEqual(["Mother's"]);
  });

  it("pages with before / beforeId", async () => {
    const headers = await onboardedPatient();
    for (const day of ["01", "02", "03"]) await pushRecord(labReport(headers, { recordedAt: `2026-03-${day}T00:00:00Z`, title: day }));
    const first = await api.get(`${RECORDS}?limit=2`).set(headers);
    expect(first.body.healthRecords.map((r: { title: string }) => r.title)).toEqual(["03", "02"]);
    const { before, beforeId } = first.body.next;
    const second = await api.get(`${RECORDS}?limit=2&before=${encodeURIComponent(before)}&beforeId=${beforeId}`).set(headers);
    expect(second.body.healthRecords.map((r: { title: string }) => r.title)).toEqual(["01"]);
    expect(second.body.next).toBeNull();
  });

  it("another patient's record or file is a 404", async () => {
    const owner = await onboardedPatient();
    const other = await onboardedPatient();
    const { body } = await pushRecord(labReport(owner));
    const record = (await api.get(`${RECORDS}/${body.recordId}`).set(owner)).body.healthRecord;
    expect((await api.get(`${RECORDS}/${body.recordId}`).set(other)).status).toBe(404);
    expect((await api.get(`${RECORDS}/${body.recordId}/attachments/${record.attachments[0].id}`).set(other)).status).toBe(404);
    expect((await api.get(`${RECORDS}?memberId=${crypto.randomUUID()}`).set(other)).status).toBe(404);
  });

  it("medical history joins self-recorded and provider data, per person", async () => {
    const headers = await onboardedPatient();
    const memberId = await addFamilyMember(headers);
    const MEDICAL = "/api/v1/users/me/medical";
    await api.post(`${MEDICAL}/conditions`).set(headers).send({ name: "Hypertension" });
    await api.post(`${MEDICAL}/allergies`).set(headers).send({ allergen: "Penicillin", category: "DRUG" });
    await api.post(`${MEDICAL}/medications`).set(headers).send({ name: "Amlodipine" });
    await api.post(`${MEDICAL}/medications`).set(headers).send({ name: "Old course", startDate: "2020-01-01", endDate: "2020-02-01" });
    await api.post(`${MEDICAL}/vitals`).set(headers).send({ type: "HEART_RATE", value: 70, measuredAt: "2026-01-01T00:00:00Z" });
    await api.post(`${MEDICAL}/vitals`).set(headers).send({ type: "HEART_RATE", value: 82, measuredAt: "2026-02-01T00:00:00Z" });
    await api.post(`${MEDICAL}/conditions`).set(headers).send({ name: "Asthma", familyMemberId: memberId });
    await pushRecord(labReport(headers));

    const self = await api.get(HISTORY).set(headers);
    expect(self.status).toBe(200);
    expect(self.body.memberId).toBe("self");
    expect(self.body.abha).toBeNull();
    expect(self.body.conditions.map((c: { name: string }) => c.name)).toEqual(["Hypertension"]);
    expect(self.body.allergies).toHaveLength(1);
    expect(self.body.currentMedications.map((m: { name: string }) => m.name)).toEqual(["Amlodipine"]);
    expect(self.body.latestVitals).toEqual([expect.objectContaining({ type: "HEART_RATE", value: 82 })]);
    expect(self.body.recentHealthRecords).toHaveLength(1);

    const mother = await api.get(`${HISTORY}?memberId=${memberId}`).set(headers);
    expect(mother.body.conditions.map((c: { name: string }) => c.name)).toEqual(["Asthma"]);
    expect(mother.body.recentHealthRecords).toEqual([]);

    expect(await prisma.accessAudit.count({ where: { resource: "medical-history" } })).toBe(2);
  });

  it("needs a profile", async () => {
    expect((await api.get(HISTORY).set(newPatient())).body.error.code).toBe("PROFILE_REQUIRED");
  });
});

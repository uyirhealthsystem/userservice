import { describe, it, expect, beforeEach } from "vitest";
import { api, resetDb, newPatient, onboardedPatient, MEMBER_CONSENT } from "./helpers";
import { prisma } from "../src/lib/prisma";

const MEDICAL = "/api/v1/users/me/medical";
const FAMILY = "/api/v1/users/me/family-members";

async function addMember(headers: Record<string, string>) {
  const res = await api.post(FAMILY).set(headers).send({ fullName: "Lakshmi", relationship: "MOTHER", consent: MEMBER_CONSENT });
  return res.body.familyMember.id as string;
}

describe("medical records", () => {
  beforeEach(resetDb);

  it("404 PROFILE_REQUIRED before onboarding", async () => {
    expect((await api.get(`${MEDICAL}/conditions`).set(newPatient())).body.error.code).toBe("PROFILE_REQUIRED");
  });

  it("conditions: create (defaults ACTIVE), update, delete", async () => {
    const headers = await onboardedPatient();
    const created = await api.post(`${MEDICAL}/conditions`).set(headers).send({ name: "Type 2 diabetes", diagnosedOn: "2019-03-01" });
    expect(created.status).toBe(201);
    expect(created.body.condition).toMatchObject({ name: "Type 2 diabetes", status: "ACTIVE", familyMemberId: null });
    expect(created.body.condition.userId).toBeUndefined();
    const id = created.body.condition.id;

    const updated = await api.patch(`${MEDICAL}/conditions/${id}`).set(headers).send({ status: "RESOLVED" });
    expect(updated.body.condition.status).toBe("RESOLVED");

    expect((await api.delete(`${MEDICAL}/conditions/${id}`).set(headers)).status).toBe(204);
    expect((await api.get(`${MEDICAL}/conditions`).set(headers)).body.conditions).toEqual([]);
  });

  it("records for self vs a family member, filtered by memberId", async () => {
    const headers = await onboardedPatient();
    const memberId = await addMember(headers);

    await api.post(`${MEDICAL}/allergies`).set(headers).send({ allergen: "Penicillin", category: "DRUG", severity: "SEVERE" });
    await api.post(`${MEDICAL}/allergies`).set(headers).send({ allergen: "Peanut", category: "FOOD", familyMemberId: memberId });

    const all = await api.get(`${MEDICAL}/allergies`).set(headers);
    expect(all.body.allergies).toHaveLength(2);
    const self = await api.get(`${MEDICAL}/allergies?memberId=self`).set(headers);
    expect(self.body.allergies.map((a: { allergen: string }) => a.allergen)).toEqual(["Penicillin"]);
    const mother = await api.get(`${MEDICAL}/allergies?memberId=${memberId}`).set(headers);
    expect(mother.body.allergies.map((a: { allergen: string }) => a.allergen)).toEqual(["Peanut"]);
  });

  it("deleting a family member deletes their records", async () => {
    const headers = await onboardedPatient();
    const memberId = await addMember(headers);
    await api.post(`${MEDICAL}/medications`).set(headers).send({ name: "Metformin", familyMemberId: memberId });
    await api.delete(`${FAMILY}/${memberId}`).set(headers);
    expect((await api.get(`${MEDICAL}/medications`).set(headers)).body.medications).toEqual([]);
  });

  it("can't attach a record to, or list, another patient's family member", async () => {
    const owner = await onboardedPatient();
    const other = await onboardedPatient();
    const memberId = await addMember(owner);

    const res = await api.post(`${MEDICAL}/conditions`).set(other).send({ name: "Asthma", familyMemberId: memberId });
    expect(res.status).toBe(404);
    expect((await api.get(`${MEDICAL}/conditions?memberId=${memberId}`).set(other)).status).toBe(404);
  });

  it("another patient's record is 404", async () => {
    const owner = await onboardedPatient();
    const other = await onboardedPatient();
    const id = (await api.post(`${MEDICAL}/conditions`).set(owner).send({ name: "Asthma" })).body.condition.id;
    expect((await api.patch(`${MEDICAL}/conditions/${id}`).set(other).send({ notes: "x" })).status).toBe(404);
    expect((await api.delete(`${MEDICAL}/conditions/${id}`).set(other)).status).toBe(404);
  });

  it("medications: endDate cannot be before startDate", async () => {
    const headers = await onboardedPatient();
    const res = await api
      .post(`${MEDICAL}/medications`)
      .set(headers)
      .send({ name: "Amoxicillin", startDate: "2026-10-10", endDate: "2026-10-01" });
    expect(res.status).toBe(400);
  });

  it("vitals: unit set from type, BP needs diastolic, no PATCH", async () => {
    const headers = await onboardedPatient();
    const bp = await api.post(`${MEDICAL}/vitals`).set(headers).send({ type: "BLOOD_PRESSURE", value: 120, secondaryValue: 80 });
    expect(bp.status).toBe(201);
    expect(bp.body.vital).toMatchObject({ unit: "mmHg", value: 120, secondaryValue: 80 });

    expect((await api.post(`${MEDICAL}/vitals`).set(headers).send({ type: "BLOOD_PRESSURE", value: 120 })).status).toBe(400);
    expect((await api.post(`${MEDICAL}/vitals`).set(headers).send({ type: "SPO2", value: 97, secondaryValue: 1 })).status).toBe(400);
    expect((await api.post(`${MEDICAL}/vitals`).set(headers).send({ type: "SPO2", value: 97, unit: "x" })).body.vital.unit).toBe("%");

    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect((await api.post(`${MEDICAL}/vitals`).set(headers).send({ type: "WEIGHT", value: 70, measuredAt: future })).status).toBe(400);

    expect((await api.patch(`${MEDICAL}/vitals/${bp.body.vital.id}`).set(headers).send({ value: 1 })).status).toBe(404);
  });

  it("every access is audited", async () => {
    const headers = await onboardedPatient();
    const id = (await api.post(`${MEDICAL}/conditions`).set(headers).set("x-request-id", "req-1").send({ name: "Asthma" })).body.condition.id;
    await api.get(`${MEDICAL}/conditions`).set(headers);
    await api.delete(`${MEDICAL}/conditions/${id}`).set(headers);

    const rows = await prisma.accessAudit.findMany({ where: { ownerId: headers["x-user-id"] }, orderBy: { at: "asc" } });
    expect(rows.map((r) => [r.action, r.resource])).toEqual([
      ["CREATE", "conditions"],
      ["READ", "conditions"],
      ["DELETE", "conditions"],
    ]);
    expect(rows[0]).toMatchObject({ resourceId: id, actorRole: "PATIENT", requestId: "req-1" });
  });
});

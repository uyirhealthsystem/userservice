import { describe, it, expect, beforeEach } from "vitest";
import pino from "pino";
import { redact } from "../src/lib/logger";
import { api, resetDb, newPatient, onboardedPatient, SERVICE_TOKENS, MEMBER_CONSENT } from "./helpers";

const FAMILY = "/api/v1/users/me/family-members";
const INTERNAL = "/api/v1/users/family-members";
const MEMBER = { fullName: "Lakshmi", relationship: "MOTHER", dateOfBirth: "1962-01-20", gender: "FEMALE", consent: MEMBER_CONSENT };

describe("family members", () => {
  beforeEach(resetDb);

  it("404 PROFILE_REQUIRED before onboarding", async () => {
    const res = await api.get(FAMILY).set(newPatient());
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("PROFILE_REQUIRED");
  });

  it("create, list, update, delete", async () => {
    const headers = await onboardedPatient();

    const created = await api.post(FAMILY).set(headers).send(MEMBER);
    expect(created.status).toBe(201);
    const id = created.body.familyMember.id;

    const list = await api.get(FAMILY).set(headers);
    expect(list.body.familyMembers).toHaveLength(1);
    expect(list.body.familyMembers[0]).toMatchObject({ id, fullName: "Lakshmi", relationship: "MOTHER" });

    const updated = await api.patch(`${FAMILY}/${id}`).set(headers).send({ phone: "9876543210" });
    expect(updated.status).toBe(200);
    expect(updated.body.familyMember).toMatchObject({ phone: "9876543210", fullName: "Lakshmi" });

    expect((await api.delete(`${FAMILY}/${id}`).set(headers)).status).toBe(204);
    expect((await api.get(FAMILY).set(headers)).body.familyMembers).toHaveLength(0);
  });

  it("another patient's member is 404, not 403", async () => {
    const owner = await onboardedPatient();
    const other = await onboardedPatient();
    const id = (await api.post(FAMILY).set(owner).send(MEMBER)).body.familyMember.id;

    expect((await api.patch(`${FAMILY}/${id}`).set(other).send({ phone: "12345" })).status).toBe(404);
    expect((await api.delete(`${FAMILY}/${id}`).set(other)).status).toBe(404);
    expect((await api.get(FAMILY).set(other)).body.familyMembers).toHaveLength(0);
  });

  it("validates input", async () => {
    const headers = await onboardedPatient();
    expect((await api.post(FAMILY).set(headers).send({ fullName: "X", relationship: "COUSIN" })).status).toBe(400);
    expect((await api.patch(`${FAMILY}/not-a-uuid`).set(headers).send({ phone: "12345" })).status).toBe(400);
  });
});

// homebasedcare's AuthServiceFamilyMembers: GET with X-User-Id and its
// service token.
describe("internal GET /family-members", () => {
  beforeEach(resetDb);

  const asService = (userId: string) => ({ "X-User-Id": userId, Authorization: `Bearer ${SERVICE_TOKENS.LABSCAN}` });

  it("returns the user's members to a service token", async () => {
    const headers = await onboardedPatient();
    await api.post(FAMILY).set(headers).send(MEMBER);

    const res = await api.get(INTERNAL).set(asService(headers["x-user-id"]));
    expect(res.status).toBe(200);
    expect(res.body.familyMembers[0]).toMatchObject({ fullName: "Lakshmi", relationship: "MOTHER", gender: "FEMALE", dateOfBirth: "1962-01-20T00:00:00.000Z" });
  });

  it("returns them through the gateway (gateway secret)", async () => {
    const headers = await onboardedPatient();
    await api.post(FAMILY).set(headers).send(MEMBER);

    const res = await api.get(INTERNAL).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.familyMembers).toHaveLength(1);
  });

  it("empty list for a patient who never onboarded", async () => {
    const res = await api.get(INTERNAL).set(asService(crypto.randomUUID()));
    expect(res.status).toBe(200);
    expect(res.body.familyMembers).toEqual([]);
  });

  it("401 with only X-User-Id (no service token, no gateway secret)", async () => {
    const headers = await onboardedPatient();
    await api.post(FAMILY).set(headers).send(MEMBER);

    expect((await api.get(INTERNAL).set({ "X-User-Id": headers["x-user-id"] })).status).toBe(401);
  });

  it("401 with an unknown service token", async () => {
    const res = await api.get(INTERNAL).set({ "X-User-Id": crypto.randomUUID(), Authorization: `Bearer ${"x".repeat(48)}` });
    expect(res.status).toBe(401);
  });

  it("401 without X-User-Id", async () => {
    expect((await api.get(INTERNAL).set({ Authorization: `Bearer ${SERVICE_TOKENS.LABSCAN}` })).status).toBe(401);
  });
});

describe("request logging", () => {
  it("redacts credentials from logged request headers", () => {
    const lines: string[] = [];
    const log = pino({ redact }, { write: (s: string) => void lines.push(s) });
    log.info({ req: { headers: { authorization: "Bearer secret-1", "x-gateway-secret": "secret-2", cookie: "c=secret-3", "x-user-id": "u1" } } }, "req");
    const out = lines.join("");
    expect(out).not.toMatch(/secret-[123]/);
    expect(out).toContain("[REDACTED]");
    expect(out).toContain('"x-user-id":"u1"');
  });
});

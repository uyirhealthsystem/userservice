import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../src/lib/prisma";
import { ageFromDob } from "../src/modules/users/users.service";
import { api, resetDb, newPatient, onboardedPatient, SERVICE_TOKENS } from "./helpers";

const userUrl = (id: string) => `/internal/v1/users/${id}`;
const asService = (token = SERVICE_TOKENS.ECG) => ({ authorization: `Bearer ${token}` });

describe("GET /internal/v1/users/:userId", () => {
  beforeEach(resetDb);

  it("returns the user and profile with age, and audits the read", async () => {
    const headers = await onboardedPatient();
    const userId = headers["x-user-id"];

    const res = await api.get(userUrl(userId)).set(asService());
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: userId, status: "ACTIVE", patientNumber: expect.stringMatching(/^UYR-\d{7}$/) });
    expect(res.body.profile).toMatchObject({
      fullName: "Ravi Kumar",
      gender: "MALE",
      bloodGroup: "O+",
      age: ageFromDob(new Date("1990-05-14")),
    });

    const audit = await prisma.accessAudit.findMany({ where: { ownerId: userId, resource: "profile" } });
    expect(audit).toMatchObject([{ actorId: "ECG", actorRole: "SERVICE", action: "READ" }]);
  });

  it("?fields returns only the requested fields (plus user.id)", async () => {
    const headers = await onboardedPatient();
    const userId = headers["x-user-id"];

    const res = await api.get(`${userUrl(userId)}?fields=fullName,age, gender,patientNumber`).set(asService());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: { id: userId, patientNumber: expect.stringMatching(/^UYR-\d{7}$/) },
      profile: { fullName: "Ravi Kumar", age: ageFromDob(new Date("1990-05-14")), gender: "MALE" },
    });

    const profileOnly = await api.get(`${userUrl(userId)}?fields=phone`).set(asService());
    expect(profileOnly.status).toBe(200);
    expect(profileOnly.body.user).toEqual({ id: userId });
    expect(Object.keys(profileOnly.body.profile)).toEqual(["phone"]);
  });

  it("400 for an unknown or empty ?fields", async () => {
    const headers = await onboardedPatient();
    const url = userUrl(headers["x-user-id"]);
    expect((await api.get(`${url}?fields=fullName,ssn`).set(asService())).status).toBe(400);
    expect((await api.get(`${url}?fields=`).set(asService())).status).toBe(400);
    expect((await api.get(`${url}?fields=id`).set(asService())).status).toBe(400);
  });

  it("401 without a service token, with a wrong one, or with only the gateway secret", async () => {
    const headers = await onboardedPatient();
    const url = userUrl(headers["x-user-id"]);
    expect((await api.get(url)).status).toBe(401);
    expect((await api.get(url).set(asService("wrong"))).status).toBe(401);
    expect((await api.get(url).set(headers)).status).toBe(401);
  });

  it("not reachable through the gateway prefix", async () => {
    const headers = await onboardedPatient();
    const res = await api.get(`/api/v1/users/internal/v1/users/${headers["x-user-id"]}`).set(headers);
    expect(res.status).toBe(404);
  });

  it("400 for a non-uuid id, 404 for an unknown or not-onboarded user", async () => {
    expect((await api.get(userUrl("nope")).set(asService())).status).toBe(400);
    expect((await api.get(userUrl(randomUUID())).set(asService())).status).toBe(404);
    expect((await api.get(userUrl(newPatient()["x-user-id"])).set(asService())).status).toBe(404);
  });

  it("403 CONSENT_REQUIRED once the patient's CARE consent is withdrawn", async () => {
    const headers = await onboardedPatient();
    const userId = headers["x-user-id"];
    await prisma.privacyConsent.updateMany({ where: { userId }, data: { withdrawnAt: new Date() } });
    const res = await api.get(userUrl(userId)).set(asService());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CONSENT_REQUIRED");
  });
});

describe("ageFromDob", () => {
  const now = new Date("2026-11-03T00:00:00Z");
  it("counts whole years, birthday inclusive", () => {
    expect(ageFromDob(new Date("1990-11-03"), now)).toBe(36);
    expect(ageFromDob(new Date("1990-11-04"), now)).toBe(35);
    expect(ageFromDob(new Date("1990-05-14"), now)).toBe(36);
    expect(ageFromDob(null, now)).toBeNull();
  });
});

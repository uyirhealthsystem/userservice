import { describe, it, expect, beforeEach } from "vitest";
import { api, resetDb, asUser, newPatient, onboardedPatient, PROFILE, ONBOARDING } from "./helpers";

const ME = "/api/v1/users/me";
const PROFILE_PATH = "/api/v1/users/me/profile";

describe("gateway identity", () => {
  beforeEach(resetDb);

  it("401 without the gateway secret, or with a wrong one", async () => {
    const { "x-gateway-secret": _secret, ...noSecret } = newPatient();
    expect((await api.get(ME).set(noSecret)).status).toBe(401);
    expect((await api.get(ME).set({ ...noSecret, "x-gateway-secret": "wrong" })).status).toBe(401);
  });

  it("401 without a (uuid) x-user-id", async () => {
    expect((await api.get(ME).set(asUser("not-a-uuid"))).status).toBe(401);
  });

  it("403 for a non-patient role", async () => {
    const res = await api.get(ME).set(asUser(crypto.randomUUID(), "DOCTOR"));
    expect(res.status).toBe(403);
  });
});

describe("onboarding: POST /me", () => {
  beforeEach(resetDb);

  it("GET /me is 404 PROFILE_REQUIRED until the patient creates their profile", async () => {
    const res = await api.get(ME).set(newPatient());
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("PROFILE_REQUIRED");
  });

  it("creates the user (id = x-user-id) + patient number + profile", async () => {
    const headers = newPatient();
    const created = await api.post(ME).set(headers).send({ ...ONBOARDING, district: "Chennai", pinCode: "600001" });
    expect(created.status).toBe(201);
    expect(created.body.user).toMatchObject({ id: headers["x-user-id"], status: "ACTIVE" });
    expect(created.body.user.patientNumber).toMatch(/^UYR-\d{7}$/);
    expect(created.body.profile).toMatchObject({ fullName: "Ravi Kumar", gender: "MALE", pinCode: "600001" });

    const me = await api.get(ME).set(headers);
    expect(me.status).toBe(200);
    expect(me.body.user.patientNumber).toBe(created.body.user.patientNumber);
  });

  it("patient numbers are distinct and sequential", async () => {
    const a = await api.post(ME).set(newPatient()).send(ONBOARDING);
    const b = await api.post(ME).set(newPatient()).send(ONBOARDING);
    expect(a.body.user.patientNumber).toBe("UYR-0000001");
    expect(b.body.user.patientNumber).toBe("UYR-0000002");
  });

  it("409 PROFILE_EXISTS the second time", async () => {
    const headers = await onboardedPatient();
    const res = await api.post(ME).set(headers).send(ONBOARDING);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PROFILE_EXISTS");
  });

  it("validates input", async () => {
    expect((await api.post(ME).set(newPatient()).send({ fullName: "" })).status).toBe(400);
    expect((await api.post(ME).set(newPatient()).send({ fullName: "A", pinCode: "60001" })).status).toBe(400);
    expect((await api.post(ME).set(newPatient()).send({ fullName: "A", bloodGroup: "Z+" })).status).toBe(400);
  });

  it("ignores an id in the body - the user is always the caller", async () => {
    const headers = newPatient();
    const res = await api.post(ME).set(headers).send({ ...ONBOARDING, id: crypto.randomUUID(), userId: crypto.randomUUID() });
    expect(res.status).toBe(201);
    expect(res.body.user.id).toBe(headers["x-user-id"]);
  });
});

describe("profile: GET / PUT /me/profile", () => {
  beforeEach(resetDb);

  it("PUT replaces the profile, clearing omitted fields", async () => {
    const headers = await onboardedPatient();
    const res = await api.put(PROFILE_PATH).set(headers).send({ fullName: "Ravi K" });
    expect(res.status).toBe(200);
    expect(res.body.profile).toMatchObject({ fullName: "Ravi K", gender: null, bloodGroup: null });
    expect((await api.get(PROFILE_PATH).set(headers)).body.profile.fullName).toBe("Ravi K");
  });

  it("PUT before onboarding creates the profile (old create-or-replace clients)", async () => {
    const headers = newPatient();
    expect((await api.get(PROFILE_PATH).set(headers)).status).toBe(404);
    const res = await api.put(PROFILE_PATH).set(headers).send(ONBOARDING);
    expect(res.status).toBe(201);
    expect((await api.get(ME).set(headers)).body.user.patientNumber).toMatch(/^UYR-/);
  });
});

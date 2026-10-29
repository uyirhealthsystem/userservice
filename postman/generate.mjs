// Builds userservice.postman_collection.json + userservice.local.postman_environment.json.
//
//   node postman/generate.mjs
//
// The collection calls userservice DIRECTLY (default http://localhost:8089),
// sending the headers the api-gateway would: x-user-id, x-user-role and
// x-gateway-secret (= GATEWAY_SECRET in userservice/.env). Every run starts as
// a brand-new patient, so it can be re-run without cleanup.
//
// api-gateway/postman/generate-all-services.mjs adopts these requests BY NAME
// for its "10 · User Service" folder - rename one here and that generator
// throws until it is updated too.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const U = "/api/v1/users";

const H = {
  userId: { key: "x-user-id", value: "{{userId}}" },
  role: { key: "x-user-role", value: "PATIENT" },
  secret: { key: "x-gateway-secret", value: "{{gatewaySecret}}" },
};
const PATIENT = [H.userId, H.role, H.secret];

function url(raw) {
  const [path, query] = raw.split("?");
  return {
    raw: `{{baseUrl}}${raw}`,
    host: ["{{baseUrl}}"],
    path: path.split("/").filter(Boolean),
    ...(query ? { query: query.split("&").map((kv) => { const [key, value = ""] = kv.split("="); return { key, value }; }) } : {}),
  };
}

/** One request. opts: body, headers (default: patient identity), desc, tests, pre. */
function req(name, method, path, opts = {}) {
  const r = { method, header: opts.headers ?? PATIENT, url: url(path) };
  if (opts.body !== undefined) {
    r.body = { mode: "raw", raw: JSON.stringify(opts.body, null, 2), options: { raw: { language: "json" } } };
  }
  if (opts.desc) r.description = opts.desc;
  const event = [];
  if (opts.pre) event.push({ listen: "prerequest", script: { type: "text/javascript", exec: opts.pre } });
  if (opts.tests) event.push({ listen: "test", script: { type: "text/javascript", exec: opts.tests } });
  return { name, ...(event.length ? { event } : {}), request: r };
}
const folder = (name, description, item) => ({ name, description, item });

const status = (code) => [`pm.test("status ${code}", () => pm.response.to.have.status(${code}));`];
const errorCode = (code, errCode) => [
  ...status(code),
  `pm.test("error ${errCode}", () => pm.expect(pm.response.json().error.code).to.eql("${errCode}"));`,
];
/** 2xx + save `<key>.id` from the response into a variable. */
const saveId = (code, key, variable) => [
  ...status(code),
  `const j = pm.response.json() || {};`,
  `if (j.${key} && j.${key}.id) pm.collectionVariables.set("${variable}", j.${key}.id);`,
];

const PROFILE = {
  fullName: "Ravi Kumar",
  dateOfBirth: "1990-05-14",
  gender: "MALE",
  phone: "9876543210",
  bloodGroup: "O+",
  address: "12, Anna Nagar",
  district: "Chennai",
  pinCode: "600040",
};

// Consent to the privacy notice (PRIVACY_NOTICE_VERSION, default "1").
const CONSENT = { noticeVersion: "1", adultDeclaration: true };
const MEMBER_CONSENT = { noticeVersion: "1", basis: "MEMBER_CONSENTED" };

const PRODUCER = [{ key: "authorization", value: "Bearer {{labscanToken}}" }];

const onboarding = folder(
  "Onboarding & profile",
  "Signup does not touch userservice. After login the app calls `GET /me`; `404 PROFILE_REQUIRED` means show the *Create your profile* screen with the privacy notice (`GET /me/privacy`), which submits `POST /me` with the profile and `consent`. That creates the user (id = token `sub`), its patient number, the profile and the consent record in one go. Under-18s are refused (`403 MINOR_ACCOUNT`) - a parent adds them as a family member.",
  [
    req("Get me before onboarding (404 PROFILE_REQUIRED)", "GET", `${U}/me`, {
      // A fresh patient per run, so the collection can be re-run as is.
      pre: [`pm.collectionVariables.set("userId", crypto.randomUUID());`],
      tests: errorCode(404, "PROFILE_REQUIRED"),
      desc: "Starts the run as a brand-new patient (`userId` = a new uuid, standing in for the token `sub`).",
    }),
    req("Privacy notice before onboarding", "GET", `${U}/me/privacy`, {
      desc: "The notice version (and URL, grievance officer) the app shows and the patient consents to. Works before onboarding.",
      tests: [...status(200), `pm.test("consent required", () => pm.expect(pm.response.json().consentRequired).to.eql(true));`],
    }),
    req("Create profile with invalid PIN (400)", "POST", `${U}/me`, {
      body: { fullName: "Ravi Kumar", pinCode: "60004", consent: CONSENT },
      tests: errorCode(400, "VALIDATION_ERROR"),
    }),
    req("Create profile without consent (400)", "POST", `${U}/me`, {
      body: PROFILE,
      desc: "Nothing is stored without consent to the privacy notice (DPDP Act).",
      tests: errorCode(400, "VALIDATION_ERROR"),
    }),
    req("Create my profile (onboarding)", "POST", `${U}/me`, {
      body: { ...PROFILE, consent: CONSENT },
      desc: "`201 { user: { id, status, createdAt, patientNumber }, profile }`. `fullName` and `consent` ({ noticeVersion, adultDeclaration: true }) are required. The user id is always the caller's - an `id` in the body is ignored.",
      tests: [
        ...status(201),
        `const j = pm.response.json();`,
        `pm.test("user id is the caller", () => pm.expect(j.user.id).to.eql(pm.collectionVariables.get("userId")));`,
        `pm.test("patient number", () => pm.expect(j.user.patientNumber).to.match(/^UYR-\\d{7}$/));`,
        `pm.collectionVariables.set("patientNumber", j.user.patientNumber);`,
      ],
    }),
    req("Create my profile again (409 PROFILE_EXISTS)", "POST", `${U}/me`, {
      body: { ...PROFILE, consent: CONSENT },
      tests: errorCode(409, "PROFILE_EXISTS"),
    }),
    req("Get me", "GET", `${U}/me`, {
      tests: [
        ...status(200),
        `pm.test("same patient number", () => pm.expect(pm.response.json().user.patientNumber).to.eql(pm.collectionVariables.get("patientNumber")));`,
        `pm.test("consent on record", () => pm.expect(pm.response.json().privacy.consentRequired).to.eql(false));`,
      ],
      desc: "`privacy.consentRequired` true = show the notice again (it changed) and POST /me/consents.",
    }),
    req("Get profile", "GET", `${U}/me/profile`, { tests: status(200) }),
    req("Replace profile", "PUT", `${U}/me/profile`, {
      body: { fullName: "Ravi Kumar", dateOfBirth: "1990-05-14", gender: "MALE", bloodGroup: "O+", district: "Chennai", pinCode: "600040" },
      desc: "Full replace - optional fields left out (here `phone`, `address`) are cleared. Before onboarding a PUT creates the profile instead (`201`), like the old authservice endpoint.",
      tests: [...status(200), `pm.test("omitted field cleared", () => pm.expect(pm.response.json().profile.phone).to.eql(null));`],
    }),
  ],
);

const family = folder(
  "Family members",
  "Records under the patient's account - they cannot log in. `relationship`: SPOUSE · FATHER · MOTHER · SON · DAUGHTER · BROTHER · SISTER · GRANDPARENT · GRANDCHILD · OTHER.\n\nAdding one needs `consent` for that person: `basis` MEMBER_CONSENTED (an adult who agreed) or PARENT_OR_GUARDIAN (required for an under-18). A member without consent is listed with `consent.care: false` and their data stays hidden.",
  [
    req("Add family member", "POST", `${U}/me/family-members`, {
      body: { fullName: "Lakshmi", relationship: "MOTHER", dateOfBirth: "1962-01-02", gender: "FEMALE", bloodGroup: "B+", district: "Madurai", pinCode: "625001", consent: MEMBER_CONSENT },
      tests: saveId(201, "familyMember", "familyMemberId"),
    }),
    req("Add a child without a guardian's consent (422)", "POST", `${U}/me/family-members`, {
      body: { fullName: "Anu", relationship: "DAUGHTER", dateOfBirth: "2018-06-01", consent: MEMBER_CONSENT },
      tests: errorCode(422, "GUARDIAN_CONSENT_REQUIRED"),
    }),
    req("Add family member with unknown relationship (400)", "POST", `${U}/me/family-members`, {
      body: { fullName: "Arun", relationship: "COUSIN", consent: MEMBER_CONSENT },
      tests: errorCode(400, "VALIDATION_ERROR"),
    }),
    req("List family members", "GET", `${U}/me/family-members`, {
      tests: [...status(200), `pm.test("one member", () => pm.expect(pm.response.json().familyMembers).to.have.length(1));`],
    }),
    req("Update family member", "PATCH", `${U}/me/family-members/{{familyMemberId}}`, {
      body: { phone: "9876500000" },
      desc: "Any subset of the create fields.",
      tests: status(200),
    }),
    req("List family members (internal, X-User-Id only - 401)", "GET", `${U}/family-members`, {
      headers: [{ key: "X-User-Id", value: "{{userId}}" }],
      desc: "Without a service token (or the gateway secret) anyone on the network could read any patient's family.",
      tests: errorCode(401, "NOT_AUTHENTICATED"),
    }),
    req("List family members (internal, service token)", "GET", `${U}/family-members`, {
      headers: [{ key: "X-User-Id", value: "{{userId}}" }, ...PRODUCER],
      desc: "Service-to-service read used by homebasedcare while it creates a FAMILY_MEMBER booking: `X-User-Id` + the service's `INTERNAL_SERVICE_TOKENS` bearer token. Only members with consent are returned. A patient who never onboarded gets `[]`.",
      tests: [...status(200), `pm.test("one member", () => pm.expect(pm.response.json().familyMembers).to.have.length(1));`],
    }),
  ],
);

const medical = folder(
  "Medical records",
  [
    "Each record belongs to the patient (`familyMemberId: null`) or one of their family members. Create takes an optional `familyMemberId`; lists take `?memberId=self` or `?memberId=<family member id>` - without it you get the whole account.",
    "",
    "Every read and change is written to the `access_audit` table.",
  ].join("\n"),
  [
    folder("Conditions", "`status`: ACTIVE (default) · RESOLVED.", [
      req("Add condition", "POST", `${U}/me/medical/conditions`, {
        body: { name: "Type 2 diabetes", diagnosedOn: "2019-03-01", notes: "Diet controlled" },
        tests: saveId(201, "condition", "conditionId"),
      }),
      req("List conditions", "GET", `${U}/me/medical/conditions`, { tests: status(200) }),
      req("List conditions (self only)", "GET", `${U}/me/medical/conditions?memberId=self`, { tests: status(200) }),
      req("Resolve condition", "PATCH", `${U}/me/medical/conditions/{{conditionId}}`, {
        body: { status: "RESOLVED" },
        tests: [...status(200), `pm.test("resolved", () => pm.expect(pm.response.json().condition.status).to.eql("RESOLVED"));`],
      }),
    ]),
    folder("Allergies", "`category`: FOOD · DRUG · ENVIRONMENT · OTHER. `severity`: MILD · MODERATE · SEVERE.", [
      req("Add allergy for family member", "POST", `${U}/me/medical/allergies`, {
        body: { allergen: "Penicillin", category: "DRUG", severity: "SEVERE", reaction: "Rash", familyMemberId: "{{familyMemberId}}" },
        tests: saveId(201, "allergy", "allergyId"),
      }),
      req("List family member's allergies", "GET", `${U}/me/medical/allergies?memberId={{familyMemberId}}`, {
        tests: [...status(200), `pm.test("one allergy", () => pm.expect(pm.response.json().allergies).to.have.length(1));`],
      }),
      req("Update allergy", "PATCH", `${U}/me/medical/allergies/{{allergyId}}`, { body: { severity: "MODERATE" }, tests: status(200) }),
    ]),
    folder("Medications", "`dosage` and `frequency` are free text. `endDate` may not be before `startDate`.", [
      req("Add medication", "POST", `${U}/me/medical/medications`, {
        body: { name: "Metformin", dosage: "500 mg", frequency: "twice daily after food", startDate: "2026-01-01", prescribedBy: "Dr. Priya" },
        tests: saveId(201, "medication", "medicationId"),
      }),
      req("Add medication ending before it starts (400)", "POST", `${U}/me/medical/medications`, {
        body: { name: "Amoxicillin", startDate: "2026-10-10", endDate: "2026-10-01" },
        tests: errorCode(400, "VALIDATION_ERROR"),
      }),
      req("List medications", "GET", `${U}/me/medical/medications`, { tests: status(200) }),
      req("Stop medication", "PATCH", `${U}/me/medical/medications/{{medicationId}}`, { body: { endDate: "2026-10-31" }, tests: status(200) }),
    ]),
    folder(
      "Vitals",
      "`type`: BLOOD_PRESSURE (`value` = systolic, `secondaryValue` = diastolic) · HEART_RATE · BLOOD_SUGAR · SPO2 · TEMPERATURE · WEIGHT · HEIGHT. The service sets `unit` from the type. `measuredAt` (ISO 8601, not in the future) defaults to now. Readings can't be edited - delete and add again.",
      [
        req("Add blood pressure reading", "POST", `${U}/me/medical/vitals`, {
          body: { type: "BLOOD_PRESSURE", value: 120, secondaryValue: 80, notes: "Morning, seated" },
          tests: [...saveId(201, "vital", "vitalId"), `pm.test("unit from type", () => pm.expect(pm.response.json().vital.unit).to.eql("mmHg"));`],
        }),
        req("Add blood pressure without diastolic (400)", "POST", `${U}/me/medical/vitals`, {
          body: { type: "BLOOD_PRESSURE", value: 120 },
          tests: errorCode(400, "VALIDATION_ERROR"),
        }),
        req("Add heart rate reading", "POST", `${U}/me/medical/vitals`, {
          body: { type: "HEART_RATE", value: 72, measuredAt: "2026-10-20T07:30:00+05:30" },
          tests: status(201),
        }),
        req("List vitals", "GET", `${U}/me/medical/vitals`, {
          desc: "Newest `measuredAt` first.",
          tests: [...status(200), `pm.test("two readings", () => pm.expect(pm.response.json().vitals).to.have.length(2));`],
        }),
      ],
    ),
  ],
);

// A producer's request: its own bearer token, no patient headers.
const LAB_REPORT = {
  source: "LABSCAN",
  sourceRecordId: "{{sourceRecordId}}",
  sourceVersion: 1,
  encounterId: "{{sourceRecordId}}-appt",
  patient: { userId: "{{userId}}" },
  recordType: "DIAGNOSTIC_REPORT",
  title: "Complete blood count",
  summary: "Haemoglobin 10.2 g/dL (low).",
  recordedAt: "2026-10-01T09:30:00+05:30",
  facilityName: "Uyir Labs, Madurai",
  attachments: [{ fileName: "cbc.txt", contentType: "text/plain", contentBase64: Buffer.from("CBC report").toString("base64") }],
};

const healthRecords = folder(
  "Health records",
  [
    "Records other services push (see `docs/health-records.md`), and the patient's combined medical history.",
    "",
    "The producer requests send `Authorization: Bearer {{labscanToken}}` - the `labscan:` entry of `INTERNAL_SERVICE_TOKENS` in userservice/.env.",
  ].join("\n"),
  [
    req("Push lab report (as labscan)", "POST", "/internal/v1/health-records", {
      headers: PRODUCER,
      body: LAB_REPORT,
      pre: [`pm.collectionVariables.set("sourceRecordId", "rep-" + crypto.randomUUID());`],
      desc: "`201 { outcome: \"created\", recordId }`. Kafka producers publish the same record to `health-records.events` instead.",
      tests: [...status(201), `pm.collectionVariables.set("healthRecordId", pm.response.json().recordId);`],
    }),
    req("Push the same report again (unchanged)", "POST", "/internal/v1/health-records", {
      headers: PRODUCER,
      body: LAB_REPORT,
      desc: "Same `sourceVersion` - ignored, so re-delivery is harmless. A higher version replaces the record.",
      tests: [...status(200), `pm.test("unchanged", () => pm.expect(pm.response.json().outcome).to.eql("unchanged"));`],
    }),
    req("Push without a token (401)", "POST", "/internal/v1/health-records", {
      headers: [],
      body: LAB_REPORT,
      tests: errorCode(401, "NOT_AUTHENTICATED"),
    }),
    req("List my health records", "GET", `${U}/me/health-records?memberId=self`, {
      desc: "Filters: `memberId`, `recordType`, `source`, `from`, `to`, `limit`. Paged with `next.before` + `next.beforeId`.",
      tests: [
        ...status(200),
        `const j = pm.response.json();`,
        `pm.test("the pushed report", () => pm.expect(j.healthRecords.map((r) => r.id)).to.include(pm.collectionVariables.get("healthRecordId")));`,
        `pm.collectionVariables.set("attachmentId", j.healthRecords[0].attachments[0].id);`,
      ],
    }),
    req("Get health record", "GET", `${U}/me/health-records/{{healthRecordId}}`, { tests: status(200) }),
    req("Download attachment", "GET", `${U}/me/health-records/{{healthRecordId}}/attachments/{{attachmentId}}`, {
      tests: [...status(200), `pm.test("the file", () => pm.expect(pm.response.text()).to.eql("CBC report"));`],
    }),
    req("Medical history (self)", "GET", `${U}/me/medical-history`, {
      desc: "Conditions, allergies, current medications, latest vital per type, recent provider records and the linked ABHA - one person at a time (`?memberId=self|<id>`).",
      tests: [...status(200), `pm.test("includes the report", () => pm.expect(pm.response.json().recentHealthRecords).to.have.length(1));`],
    }),
    req("Medical history (family member)", "GET", `${U}/me/medical-history?memberId={{familyMemberId}}`, {
      tests: [...status(200), `pm.test("their allergy", () => pm.expect(pm.response.json().allergies).to.have.length(1));`],
    }),
    req("My ABHA links", "GET", `${U}/me/abha`, {
      desc: "Linking (`POST /me/abha/otp`, `POST /me/abha/verify`) needs ABDM credentials and a real ABHA, so it is not part of this run.",
      tests: [...status(200), `pm.test("none yet", () => pm.expect(pm.response.json().abhaLinks).to.have.length(0));`],
    }),
  ],
);

const privacy = folder(
  "Privacy (DPDP Act)",
  [
    "The patient's controls under the DPDP Act. Notice, consents, access log, sharing summary, export and erasure work whether or not the patient has consented or onboarded; the nominee needs the profile.",
    "",
    "Consent purposes: `CARE` (store and use health data - required) · `ABDM_SHARING` (link an ABHA, share through ABDM). Withdrawing `CARE` for a family member erases them; `ABDM_SHARING` unlinks the ABHA; `CARE` for oneself is `DELETE /me`.",
  ].join("\n"),
  [
    req("Privacy notice and my consents", "GET", `${U}/me/privacy`, {
      tests: [...status(200), `pm.test("consented", () => pm.expect(pm.response.json().consentRequired).to.eql(false));`],
    }),
    req("Consent to ABDM sharing", "POST", `${U}/me/consents`, {
      body: { purpose: "ABDM_SHARING", ...CONSENT },
      desc: "Needed before `POST /me/abha/otp`. For a family member add `memberId` and `basis` instead of `adultDeclaration`. `409 NOTICE_OUTDATED` when `noticeVersion` is not the current one.",
      tests: status(201),
    }),
    req("Withdraw ABDM sharing", "DELETE", `${U}/me/consents/ABDM_SHARING`, {
      desc: "Unlinks the ABHA (if any). `?memberId=<id>` for a family member.",
      tests: status(204),
    }),
    req("Withdraw my own CARE consent (409 ERASURE_REQUIRED)", "DELETE", `${U}/me/consents/CARE`, {
      tests: errorCode(409, "ERASURE_REQUIRED"),
    }),
    req("Who accessed my data", "GET", `${U}/me/access-log?limit=20`, {
      desc: "Newest first. `next` = `{ before, beforeId }` for the following page.",
      tests: [...status(200), `pm.test("has entries", () => pm.expect(pm.response.json().entries.length).to.be.above(0));`],
    }),
    req("Whom my records were shared with", "GET", `${U}/me/data-sharing`, {
      desc: "One row per ABDM consent our HIP served: purpose, requester, HI types, how many records, last time.",
      tests: status(200),
    }),
    req("Export my data", "GET", `${U}/me/export`, {
      desc: "Everything held about the account as one JSON download. Attachment files are fetched separately.",
      tests: [...status(200), `pm.test("profile included", () => pm.expect(pm.response.json().profile.fullName).to.eql("Ravi Kumar"));`],
    }),
    req("Set nominee", "PUT", `${U}/me/nominee`, {
      body: { fullName: "Meena", relationship: "SPOUSE", phone: "9876543210", email: "meena@example.com" },
      desc: "Whom the patient nominates to exercise their rights on death or incapacity (DPDP s.14).",
      tests: status(200),
    }),
    req("Get nominee", "GET", `${U}/me/nominee`, { tests: status(200) }),
  ],
);

const cleanup = folder("Cleanup", "Deletes what this run created. Deleting a family member also deletes their medical records. Ends by erasing the whole account.", [
  req("Delete condition", "DELETE", `${U}/me/medical/conditions/{{conditionId}}`, { tests: status(204) }),
  req("Delete medication", "DELETE", `${U}/me/medical/medications/{{medicationId}}`, { tests: status(204) }),
  req("Delete vital reading", "DELETE", `${U}/me/medical/vitals/{{vitalId}}`, { tests: status(204) }),
  req("Delete family member (and their records)", "DELETE", `${U}/me/family-members/{{familyMemberId}}`, { tests: status(204) }),
  req("Family member's allergy went with them (404)", "PATCH", `${U}/me/medical/allergies/{{allergyId}}`, {
    body: { severity: "MILD" },
    tests: errorCode(404, "NOT_FOUND"),
  }),
  req("Erase without confirmation (400)", "DELETE", `${U}/me`, { body: {}, tests: errorCode(400, "VALIDATION_ERROR") }),
  req("Erase my account", "DELETE", `${U}/me`, {
    body: { confirm: "DELETE_MY_DATA" },
    desc: "Erases profile, family, medical and provider records, ABHA links and nominee. The access audit and (withdrawn) consent rows stay as evidence until retention removes them. The login itself is authservice's.",
    tests: status(204),
  }),
  req("Gone (404 PROFILE_REQUIRED)", "GET", `${U}/me`, { tests: errorCode(404, "PROFILE_REQUIRED") }),
]);

const access = folder(
  "Identity checks",
  "What happens to callers that did not come through the gateway, or are not patients.",
  [
    req("No gateway secret (401)", "GET", `${U}/me`, { headers: [H.userId, H.role], tests: errorCode(401, "NOT_AUTHENTICATED") }),
    req("Wrong gateway secret (401)", "GET", `${U}/me`, {
      headers: [H.userId, H.role, { key: "x-gateway-secret", value: "not-the-secret" }],
      tests: errorCode(401, "NOT_AUTHENTICATED"),
    }),
    req("User id is not a uuid (401)", "GET", `${U}/me`, {
      headers: [{ key: "x-user-id", value: "12345" }, H.role, H.secret],
      tests: errorCode(401, "NOT_AUTHENTICATED"),
    }),
    req("Non-patient role (403)", "GET", `${U}/me`, {
      headers: [H.userId, { key: "x-user-role", value: "DOCTOR" }, H.secret],
      tests: errorCode(403, "FORBIDDEN"),
    }),
    req("Another patient's family member (404)", "PATCH", `${U}/me/family-members/{{familyMemberId}}`, {
      headers: [{ key: "x-user-id", value: "{{otherUserId}}" }, H.role, H.secret],
      // Onboard a second patient first, so the 404 is the ownership check and not PROFILE_REQUIRED.
      pre: [
        `const other = crypto.randomUUID();`,
        `pm.collectionVariables.set("otherUserId", other);`,
        `pm.sendRequest({`,
        `  url: pm.variables.get("baseUrl") + "${U}/me",`,
        `  method: "POST",`,
        `  header: { "content-type": "application/json", "x-user-id": other, "x-user-role": "PATIENT", "x-gateway-secret": pm.variables.get("gatewaySecret") },`,
        `  body: { mode: "raw", raw: JSON.stringify({ fullName: "Other Patient", consent: ${JSON.stringify(CONSENT)} }) },`,
        `});`,
      ],
      body: { phone: "12345" },
      desc: "A second (onboarded) patient tries to change the first one's family member: 404, not 403, so ids can't be probed.",
      tests: errorCode(404, "NOT_FOUND"),
    }),
  ],
);

const health = folder("Health", "", [
  req("Health", "GET", "/health", { headers: [], tests: status(200) }),
]);

const collection = {
  info: {
    _postman_id: "5d1f0c2e-7b3a-4e8f-9a61-uyiruserservice1",
    name: "Uyir User Service",
    description: [
      "userservice called **directly** (`{{baseUrl}}`, default http://localhost:8089) - patient profile, family members, medical records, health records from other services.",
      "",
      "Requests send the identity headers the api-gateway sets after verifying the access token:",
      "",
      "| Header | Value |",
      "|---|---|",
      "| `x-user-id` | `{{userId}}` - the token `sub`; a new uuid per run |",
      "| `x-user-role` | `PATIENT` |",
      "| `x-gateway-secret` | `{{gatewaySecret}}` - `GATEWAY_SECRET` from userservice/.env |",
      "",
      "Run top to bottom. Errors are `{ error: { code, message } }`.",
      "",
      "Through the gateway (bearer token instead of these headers) the same requests live in `api-gateway/postman/uyir-all-services.postman_collection.json` › *10 · User Service*.",
      "",
      "Generated by `postman/generate.mjs` - edit that and re-run instead of editing this file.",
    ].join("\n"),
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  item: [health, onboarding, family, medical, healthRecords, privacy, access, cleanup],
  variable: [
    { key: "baseUrl", value: "http://localhost:8089" },
    { key: "gatewaySecret", value: "" },
    { key: "labscanToken", value: "" },
    ...["userId", "otherUserId", "patientNumber", "familyMemberId", "conditionId", "allergyId", "medicationId", "vitalId", "sourceRecordId", "healthRecordId", "attachmentId"].map(
      (key) => ({ key, value: "" }),
    ),
  ],
};

// Only the values a person sets. Environment scope beats collection scope, so
// ids the scripts save are deliberately not listed here.
const environment = {
  id: "5d1f0c2e-7b3a-4e8f-9a61-uyiruserenv01",
  name: "Uyir User Service - local",
  values: [
    { key: "baseUrl", value: "http://localhost:8089", type: "default", enabled: true },
    { key: "gatewaySecret", value: "", type: "secret", enabled: true },
    { key: "labscanToken", value: "", type: "secret", enabled: true },
  ],
  _postman_variable_scope: "environment",
};

writeFileSync(join(here, "userservice.postman_collection.json"), JSON.stringify(collection, null, 2) + "\n");
writeFileSync(join(here, "userservice.local.postman_environment.json"), JSON.stringify(environment, null, 2) + "\n");

const count = (items) => items.reduce((n, i) => n + (i.item ? count(i.item) : 1), 0);
console.log(`wrote ${count(collection.item)} requests`);

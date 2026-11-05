# userservice

Owns everything about a patient: profile, family members and medical records.
Records the other services produce (lab reports, ECGs, consultations...) are
pushed here too, and shared through ABDM once the patient links an ABHA - see
[docs/health-records.md](docs/health-records.md). authservice keeps only login data.

Express 5 + Prisma 6 + Postgres (its own database). Port **8089**. Reached
through the api-gateway at `/api/v1/users` (forwarded unchanged).

## Identity

The service never sees a JWT. The gateway verifies the token and forwards
`x-user-id` (= token `sub`), `x-user-role` and `x-gateway-secret`; the
identity headers are believed only with the secret (`GATEWAY_SECRET`, same
value as the gateway's `USER_GATEWAY_SECRET`). The user id here **is** the
authservice user id - every service already stores it, so nothing is mapped.

Only `PATIENT` callers are allowed (403 otherwise).

No CORS here - browsers reach the service only through the gateway, which
owns the origin allowlist. Credentials in request headers (`authorization`,
`x-gateway-secret`, `cookie`) are redacted from the logs.

## Onboarding

Signup does not touch this service. After login the app calls:

1. `GET /api/v1/users/me` → `404 PROFILE_REQUIRED` = show "Create your profile"
   with the privacy notice (`GET /api/v1/users/me/privacy` gives its version).
2. `POST /api/v1/users/me` with the profile and
   `consent: { noticeVersion, adultDeclaration: true }` → `201 { user, profile }`.
   Creates the user record (with `patientNumber`, e.g. `UYR-0000001`), the
   profile and the consent record in one transaction. `409 PROFILE_EXISTS` the
   second time; `403 MINOR_ACCOUNT` for an under-18.

Family members and medical records answer `404 PROFILE_REQUIRED` until then,
and `403 CONSENT_REQUIRED` while the patient has not consented to the current
notice (`GET /me` → `privacy.consentRequired`). See
[docs/privacy.md](docs/privacy.md) for consent, rights and retention (DPDP Act).

## API

All under `/api/v1/users`. Errors: `{ "error": { "code", "message" } }`.

| Method | Path | |
|---|---|---|
| GET | `/me` | `{ user, profile, privacy }` - every profile response also has `age` (whole years from `dateOfBirth`, `null` if unknown; read-only) |
| POST | `/me` | onboarding (body = profile + `consent`; `fullName` and `consent` required) |
| DELETE | `/me` | erase the account's data - body `{ "confirm": "DELETE_MY_DATA" }` |
| GET / PUT | `/me/profile` | read / full replace (PUT before onboarding creates it, with `consent` - the old authservice behaviour) |
| GET | `/me/privacy` | notice (version, URL, grievance officer) + the patient's consents |
| POST / DELETE | `/me/consents`, `/me/consents/:purpose?memberId=` | give / withdraw consent (`CARE`, `ABDM_SHARING`) |
| GET | `/me/access-log`, `/me/data-sharing`, `/me/export` | who accessed the data; whom it was shared with; everything as JSON |
| GET / PUT / DELETE | `/me/nominee` | the patient's nominee |
| GET / POST | `/me/family-members` | create needs `consent: { noticeVersion, basis }`; list shows each member's `consent` |
| PATCH / DELETE | `/me/family-members/:id` | delete also removes that member's medical records |
| GET / POST | `/me/medical/{conditions,allergies,medications,vitals}` | list takes `?memberId=self` or `?memberId=<family member id>`; create takes optional `familyMemberId` |
| PATCH / DELETE | `/me/medical/{type}/:id` | vitals have no PATCH (measurements: delete and re-add) |
| GET | `/me/health-records`, `/me/health-records/:id`, `.../attachments/:attachmentId` | records from providers (read-only) |
| GET | `/me/medical-history` | `?memberId=self\|<id>` - self-recorded + provider records in one view |
| GET / POST / DELETE | `/me/abha`, `/me/abha/otp`, `/me/abha/verify`, `/me/abha/:id` | link an ABHA to self or a family member |
| GET / POST / DELETE | `/me/abha/create/...` | create an ABHA by Aadhaar OTP and link it (self only; optional, never part of profile creation) - [docs/abha-creation.md](docs/abha-creation.md) |
| GET | `/family-members` | **internal**, for homebasedcare: `X-User-Id` only, no token (anyone who can reach the service can call it); consented members only |
| GET | `/internal/v1/users/:userId` | **internal**, any service, no token (not via the gateway); optional `X-Service-Name: <caller>` for the audit, else `UNKNOWN`. `{ user, profile }` with `profile.age`; `?fields=fullName,age,gender,phone` returns only those (plus `user.id`) - any of `patientNumber status createdAt fullName dateOfBirth age gender phone bloodGroup address district pinCode`, unknown → `400`; `404` not onboarded, `403 CONSENT_REQUIRED` without CARE consent; audited |
| POST | `/internal/v1/health-records` | **internal**, producers only (no token; not via the gateway) |
| POST | `/abdm/api/v3/...` | ABDM bridge callbacks (ABDM-signed JWT) |

Field values: `gender` MALE · FEMALE · OTHER; `bloodGroup` A± B± AB± O±;
`pinCode` 6-digit PIN; `relationship` SPOUSE · FATHER · MOTHER · SON ·
DAUGHTER · BROTHER · SISTER · GRANDPARENT · GRANDCHILD · OTHER; condition
`status` ACTIVE · RESOLVED; allergy `category` FOOD · DRUG · ENVIRONMENT ·
OTHER, `severity` MILD · MODERATE · SEVERE; vital `type` BLOOD_PRESSURE
(`value` systolic + `secondaryValue` diastolic) · HEART_RATE · BLOOD_SUGAR ·
SPO2 · TEMPERATURE · WEIGHT · HEIGHT - `unit` is set by the service.

Every medical-record read or change, every record a producer writes and every
record shared with ABDM is written to `access_audit`.

## Background work

An in-process worker (`src/worker.ts`, every `ABDM_WORKER_INTERVAL_MS`)
downloads attachments sent by URL, links care contexts in ABDM, runs ABDM
data transfers, encrypts files stored before `DATA_ENCRYPTION_KEY` was set and,
hourly, deletes data past its retention window (docs/privacy.md). Jobs are rows claimed with `FOR UPDATE SKIP LOCKED`, so any
number of replicas is safe. The Kafka consumer (`health-records.events`) starts
when `KAFKA_BROKERS` is set.

## Run

```sh
cp .env.example .env          # DATABASE_URL, GATEWAY_SECRET, DATA_ENCRYPTION_KEY
npm install
npm run prisma:deploy
npm run dev
```

Tests use a real Postgres: copy `.env.test.example` to `.env.test`, then
`npm test`.

In the root `docker-compose.yml` the service runs with its own
`user-postgres` and applies migrations on start.

## Moving data out of authservice

```sh
AUTH_DATABASE_URL=<authservice db> npm run import:authservice -- --dry-run
AUTH_DATABASE_URL=<authservice db> npm run import:authservice
```

Copies `patient_profiles` and `family_members` with their ids (homebasedcare
bookings reference family member ids), creates a user row for every patient
that has either, then checks every source id is present. Safe to re-run.
Only after a clean run should authservice drop its two tables.

## Postman

`postman/userservice.postman_collection.json` calls the service directly with
the headers the gateway would send - set `gatewaySecret` (= `GATEWAY_SECRET`)
in the environment, then run it top to bottom; each run is a new patient.

```sh
node postman/generate.mjs     # rebuild after a route change
postman collection run postman/userservice.postman_collection.json \
  -e postman/userservice.local.postman_environment.json --env-var gatewaySecret=<GATEWAY_SECRET>
```

The gateway's all-services collection (*10 · User Service*) copies these
requests by name - re-run `api-gateway/postman/generate-all-services.mjs`
after changing them.



data Ecryption:wIp/ULvriuEBTpK42Gc3/RzP16MqpqfE1CAmQydyvE0=
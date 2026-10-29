# Health records: producer contract and ABDM sharing

userservice is the one place a patient's medical history lives. Each service
that produces clinical data (lab reports, ECGs, consultations, ...) **pushes**
a copy here. userservice then shows it in the app and shares it through ABDM
when the patient has linked an ABHA.

```
labscan ─┐                       ┌─> GET /api/v1/users/me/health-records, /me/medical-history (app)
ecg ─────┤  health-records.events│
hospital ┼──────── Kafka ────────┤ userservice ──> ABDM (HIP): care contexts in the patient's
hbc ─────┤  or POST /internal/v1/│                 ABHA app; FHIR bundles to doctors on consent
         ┘  health-records       └─> access_audit (every write, read and share)
```

## Sending a record

Pick one channel. Both run the same code and give the same result.

**Kafka** (preferred). Topic `health-records.events`, key = `patient.userId`
(keeps one patient's records in order). The envelope is the same as for
`auth.events` / `hospital.events`:

```json
{ "eventType": "HealthRecordPublished", "eventVersion": 1, "occurredAt": "2026-10-22T10:00:00Z", "data": { ...record } }
```

Kafka messages are too small for files: send attachments as `url`.

**HTTP**: `POST http://userservice:8089/internal/v1/health-records` with
`Authorization: Bearer <your token>` and the record as the body. The token is
your entry in userservice's `INTERNAL_SERVICE_TOKENS`
(`labscan:<token>,...`), and it can only write records with your own
`source`. This path is not reachable through the api-gateway.

| Answer | Meaning | Retry? |
|---|---|---|
| 201 `{ outcome: "created", recordId }` | stored | - |
| 200 `{ outcome: "updated" \| "unchanged", recordId }` | newer version stored / already had this or a newer one | - |
| 400 `VALIDATION_ERROR` | payload breaks the contract | no, fix the producer |
| 422 `UNKNOWN_FAMILY_MEMBER` / `SUBJECT_CHANGED` / `SOURCE_MISMATCH` | see below | no |
| 401 | token missing or wrong | no |
| 5xx / no answer | userservice or its DB is down | **yes**, with backoff |

On Kafka the same rejections are logged to `health_record_rejections` and the
message is skipped. Infrastructure errors are retried and the offset is not
committed.

### The record

```json
{
  "source": "LABSCAN",
  "sourceRecordId": "8b1c...",
  "sourceVersion": 1,
  "encounterId": "appointment-id",
  "patient": { "userId": "<authservice user id>", "familyMemberId": null },
  "recordType": "DIAGNOSTIC_REPORT",
  "status": "FINAL",
  "title": "Complete blood count",
  "summary": "Haemoglobin 10.2 g/dL (low).",
  "recordedAt": "2026-10-01T09:30:00+05:30",
  "facilityName": "Uyir Labs, Madurai",
  "practitionerName": "Dr. S. Meena",
  "details": { "any": "structured, type-specific fields" },
  "attachments": [
    { "fileName": "cbc.pdf", "contentType": "application/pdf", "url": "http://labscan:8082/internal/files/reports/cbc.pdf" }
  ]
}
```

| Field | Rule |
|---|---|
| `source` | `LABSCAN` · `ECG` · `HOSPITAL` · `HOMEBASEDCARE` · `AMBULANCE` |
| `sourceRecordId` | your id, stable for the life of the record. Letters, digits, `.` `_` `-` (no `:`) |
| `sourceVersion` | integer ≥ 1. **Increase it on every change.** A version not above the stored one is ignored, so re-sends and out-of-order delivery are safe |
| `encounterId` | the booking / appointment / visit. Records sharing it form one ABDM care context. Defaults to `sourceRecordId` |
| `patient.userId` | the authservice user id (`x-user-id` / token `sub`) of the **account that booked**. Must be a uuid |
| `patient.familyMemberId` | set when the care was for a family member of that account (the id from userservice). **Do not send** records for people outside the account (e.g. ECG `OTHER_PERSON`) |
| `recordType` | `DIAGNOSTIC_REPORT` · `PRESCRIPTION` · `OP_CONSULTATION` · `DISCHARGE_SUMMARY` · `IMMUNIZATION` · `WELLNESS` · `HEALTH_DOCUMENT` (shared with ABDM as the HI type of the same name) |
| `status` | `FINAL` (default) · `AMENDED` · `ENTERED_IN_ERROR` |
| `recordedAt` | when the care happened (ISO 8601 with offset), not when you send it |
| `attachments` | up to 10 files of at most 10 MB each, each with **either** `url` (a URL userservice can GET inside the private network; downloaded in the background and retried) **or** `contentBase64` (HTTP only). Sending a new version replaces the whole set |

**Corrections.** Send the same `sourceRecordId` with a higher
`sourceVersion`. **Retraction.** Send `status: ENTERED_IN_ERROR` (higher
version). The record is hidden and no longer shared. Nothing is ever deleted
by a producer. **Wrong patient.** A record cannot move between patients
(`SUBJECT_CHANGED`): retract it, then send it again with a new
`sourceRecordId` for the right patient.

A patient who has not created their profile yet still gets their records.
They appear once the profile exists.

## What each service should send

Based on each service's current data model:

| Service | When | recordType | sourceRecordId / encounterId | Patient | Gaps to close first |
|---|---|---|---|---|---|
| **ecg** | report `uploadStatus = UPLOADED`; again (version+1) when the `DoctorReview` is `REVIEWED` | `DIAGNOSTIC_REPORT` (title "12-lead ECG", summary = interpretation, practitioner = reviewing doctor) | `EcgReport.reportId` / `EcgBooking.bookingId` | `citizenId`, `familyMemberId`; skip `OTHER_PERSON` | files are on local disk (`/uploads/reports/...`). Serve them on an internal URL or send `contentBase64` |
| **labscan** | `Report.status` becomes `UPLOADED` / `SENT` | `DIAGNOSTIC_REPORT`, one per report, title from the tests / scans | `reportId` / `appointmentId` | **missing**: `Patient` has no authservice user id | store the booking account's `userId` (+ `familyMemberId`) on `Appointment`. Files are local (`reports/...`) |
| **hospitalservice** | `DoctorAppointmentBooking` → `COMPLETED` | `OP_CONSULTATION` (reason / symptoms in `details`); `PRESCRIPTION` once doctors upload one | booking `id` / booking `id` | `patientId`; for `FAMILY_MEMBER` bookings **missing** `familyMemberId` (only `relationship`) | add `familyMemberId` to the booking; nothing clinical is captured yet beyond reason / symptoms |
| **homebasedcare** | `ServiceVisit` → `COMPLETED`; prescriptions attached to a booking | `WELLNESS` (visit) / `HEALTH_DOCUMENT` (prescription) | visit id / booking id | `Booking.userId`, `familyMemberId` | visit notes are not stored yet. It already has an outbox (`OutboxEvent`) that can publish to Kafka |
| **ambulance** | - | - | - | - | no clinical data today. Nothing to send |

## Patient API (through the gateway, `/api/v1/users`)

| Method | Path | |
|---|---|---|
| GET | `/me/health-records` | `?memberId=self\|<id>&recordType=&source=&from=&to=&limit=` (≤100). Newest first, paged with `next.before` + `next.beforeId` |
| GET | `/me/health-records/:id` | one record with its attachment list |
| GET | `/me/health-records/:id/attachments/:attachmentId` | the file; `409 ATTACHMENT_NOT_READY` while still being fetched |
| GET | `/me/medical-history` | `?memberId=self\|<id>`: conditions, allergies, current medications, latest vital of each type, 20 latest provider records, linked ABHA |
| GET | `/me/abha` | ABHAs linked on this account |
| POST | `/me/abha/otp` | `{ abhaNumber, memberId?, otpMethod?: "abdm"\|"aadhaar" }`: OTP to the ABHA's mobile |
| POST | `/me/abha/verify` | `{ otp, memberId? }`: links the ABHA (201) |
| DELETE | `/me/abha/:id` | unlinks it here |

Provider records are read-only for the patient. ABHA rules: OTP valid 10 min,
60 s between OTP requests, 3 wrong OTPs and it is discarded. One ABHA per
person, and an ABHA can belong to only one person on Uyir (`409 ABHA_IN_USE`).
If the person's profile has a gender or year of birth, the ABHA's must match
(`409 ABHA_DEMOGRAPHIC_MISMATCH`).

## ABDM: what happens

userservice acts as a **Health Information Provider (HIP)**:

1. **Linking.** When a person has an ABHA, each of their encounters
   (`source:recordType:encounterId`) becomes a care context. The worker gets a
   link token (`generate-token`, answered on our bridge) and links the
   contexts (`link/carecontext`). They then appear in the patient's ABHA app.
   Records that arrive later are linked as they come. Retries back off and
   stop after 10 attempts (`abdm_care_contexts.status = FAILED`).
2. **Consent.** ABDM notifies us of consents (`consent/request/hip/notify`).
   We store them and acknowledge, including revocations.
3. **Transfer.** On a health-information request, only what the consent
   allows is sent: its care contexts, HI types, date range, and only while
   granted and before `dataEraseAt`. Each record goes as an NRCeS FHIR R4
   document bundle with its files embedded. Each bundle is encrypted for the
   requesting doctor's key (ECDH Curve25519 + AES-GCM, ABDM's "Fidelius"
   scheme) and pushed to their `dataPushUrl` as one page per record, each
   page with fresh key material. ABDM is then notified per care context.
   Every shared record is audited as `SHARE` with the consent id.

Bridge endpoints (`/abdm/...`, forwarded by the gateway without a user
token). Each call must carry ABDM's RS256 JWT, verified against
`<gateway>/api/hiecm/gateway/v3/certs`:

| Path | |
|---|---|
| `POST /abdm/api/v3/hip/token/on-generate-token` | link token |
| `POST /abdm/api/v3/link/on_carecontext` | link result |
| `POST /abdm/api/v3/consent/request/hip/notify` | consent granted / revoked / expired |
| `POST /abdm/api/v3/hip/health-information/request` | data request |

### Go-live checklist

- Register the facility in the HFR as a HIP and set `ABDM_HIP_ID`. Use the
  same `ABDM_CLIENT_ID` / `ABDM_CLIENT_SECRET` as pro.
- Register the bridge URL `https://<gateway host>/abdm` for that client.
- **Check against the ABDM sandbox before production.** These were written
  from ABDM's v3 documentation and tested here against a fake ABDM, not yet
  against the real sandbox:
  - the HIE-CM paths and body shapes (all in `HIECM` in `src/modules/abdm/abdm.client.ts`), and the certs URL;
  - the ABHA number format in `generate-token` (dashed);
  - Fidelius interop: our ECDH is proven equal to X25519 under the standard
    curve mapping, but decrypt one transfer with ABDM's `fidelius-cli`
    (X.509 key encoding, nonce order, HKDF parameters);
  - the entry `checksum` (we send the MD5 of the unencrypted bundle).
- Not implemented yet: **user-initiated discovery and linking** (a patient
  finding Uyir records from inside the ABHA app: `care-context/discover`,
  `link/init`, `link/confirm`). HIP-initiated linking above covers records
  we hold, but ABDM's M2 certification also asks for these.

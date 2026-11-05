# ABHA creation

Status: **phase 1 implemented (account holder only).** It is tested against a
fake ABDM. The ABDM enrolment paths and shapes still need checking in the
sandbox (see the end of this doc).

A patient who has no ABHA can create one in the Uyir app, next to the
existing "link an ABHA you already have" flow (`/me/abha/otp`,
`/me/abha/verify`, see [health-records.md](health-records.md)).

## Principles

1. **Profile creation is not blocked.** `POST /api/v1/users/me` never calls
   ABDM, never asks for an ABHA or Aadhaar, and works when ABDM is down or not
   configured (tested). ABHA creation is a separate, optional step the app
   offers *after* the profile exists. The patient can skip it and come back
   later.
2. **It is voluntary and needs consent.** Each step that reaches ABDM needs
   the `ABDM_SHARING` consent (`403 CONSENT_REQUIRED`), the same check as
   linking.
3. **Aadhaar is never stored.** It exists in memory for one request, is
   RSA-encrypted with ABDM's public key and discarded. It never goes to the DB,
   logs (redacted in `lib/logger.ts`), audit rows, errors or responses
   (tested).
4. **Creation ends in a link.** Once ABDM accepts the Aadhaar OTP, the ABHA
   exists, and we store it right away as an `AbhaLink` (`source: "CREATED"`).
   Care-context linking then starts. The mobile and address steps that follow
   only improve it. Abandoning them loses nothing.
   If the patient signed up with a Health Partner's referral code, this link
   (like the link flow's) earns that HP the referral -
   [referrals.md](referrals.md).

## Flow

```
App (after profile exists)                      userservice                         ABDM ABHA v3
"Share records via ABDM?" ── POST /me/consents {ABDM_SHARING}
"Do you have an ABHA?"
  ├─ yes ──────────────────── /me/abha/otp → /me/abha/verify (link flow)
  └─ no
     show Aadhaar consent ─── GET  /me/abha/create/consent-text
     enter Aadhaar ────────── POST /me/abha/create/aadhaar/otp ────── enrollment/request/otp (aadhaar)
     enter OTP (+ mobile) ─── POST /me/abha/create/aadhaar/verify ─── enrollment/enrol/byAadhar
                                  └ AbhaLink created (201, next)
     [next = MOBILE_VERIFY]   POST /me/abha/create/mobile/otp ─────── enrollment/request/otp (mobile)
                              POST /me/abha/create/mobile/verify ──── enrollment/auth/byAbdm
     pick ABHA address ────── GET  /me/abha/create/address-suggestions  enrollment/enrol/suggestion
                              POST /me/abha/create/address ─────────── enrollment/enrol/abha-address
```

`next` from verify:

| `next` | Meaning |
|---|---|
| `ABHA_ADDRESS` | New ABHA, mobile accepted. Offer an address |
| `MOBILE_VERIFY` | The mobile isn't the Aadhaar-linked one. Verify it by OTP, or skip straight to the address |
| `DONE` | The Aadhaar already had an ABHA. The OTP proves control, so that ABHA is linked. No address step |

## Patient API (through the gateway, `/api/v1/users`)

The routes are in `abhaEnrolment.routes.ts`, mounted behind `requireUser` +
`requireConsent`. **Phase 1 is self only.** A `memberId` other than `self`
gets `400 ABHA_CREATE_SELF_ONLY`.

| Method | Path | Body / query | Success |
|---|---|---|---|
| GET | `/me/abha/create/consent-text` | | `200 { code, version, language, text }` |
| POST | `/me/abha/create/aadhaar/otp` | `{ aadhaar, consent: { accepted: true, version } }` | `200 { message, expiresAt }` |
| POST | `/me/abha/create/aadhaar/verify` | `{ otp, mobile? }` (mobile defaults to the profile phone) | `201 { abhaLink, isNew, next }` |
| POST | `/me/abha/create/mobile/otp` | `{}` | `200 { message, expiresAt }` |
| POST | `/me/abha/create/mobile/verify` | `{ otp }` | `200 { next: "ABHA_ADDRESS" }` |
| GET | `/me/abha/create/address-suggestions` | | `200 { suggestions, suffix }` (`@sbx` / `@abdm`) |
| POST | `/me/abha/create/address` | `{ abhaAddress }` (without suffix) | `200 { abhaLink }` |
| DELETE | `/me/abha/create` | | `204` (an ABHA already created stays linked) |

Input rules:
- `aadhaar`: 12 digits, not starting with 0 or 1, with a valid Verhoeff check
  digit. Spaces and dashes are allowed.
- `consent.version`: must be the current version (`AADHAAR_CONSENT` in
  `aadhaarConsent.ts`).
- `abhaAddress`: 8–18 letters or digits, with at most one `.` or `_`, not at
  either end.

Errors:

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | bad input (the Aadhaar value is never echoed) |
| 400 | `AADHAAR_CONSENT_OUTDATED` | consent version isn't the current one |
| 400 | `ABHA_CREATE_SELF_ONLY` | `memberId` is a family member |
| 400 | `MOBILE_REQUIRED` | no `mobile` and no usable phone on the profile |
| 400 | `OTP_INVALID` / `OTP_ATTEMPTS_EXCEEDED` | wrong OTP / 3rd wrong OTP. Aadhaar: the attempt ends. Mobile: back to asking for a mobile OTP |
| 400 | `OTP_EXPIRED` / `ABHA_ENROLMENT_EXPIRED` | 10 min passed (refreshed on every successful step), before / after the ABHA was created |
| 400 | `ABHA_ENROLMENT_FAILED` | ABDM refused the OTP request (its message passed through) |
| 403 | `CONSENT_REQUIRED` | no `ABDM_SHARING` consent |
| 404 | `ABHA_ENROLMENT_NOT_FOUND` | nothing in progress at this step (e.g. address before verify) |
| 409 | `ABHA_ALREADY_LINKED` | this person already has an ABHA linked |
| 409 | `ABHA_IN_USE` | the ABHA is linked to another person on Uyir. Not linked |
| 409 | `ABHA_DEMOGRAPHIC_MISMATCH` | profile gender / year of birth disagrees with Aadhaar (likely someone else's Aadhaar). Not linked |
| 409 | `ABHA_ADDRESS_TAKEN` | ABDM refused the address |
| 429 | `TOO_MANY_REQUESTS` | resending the same OTP within 60 s, or more than 5 OTPs (Aadhaar + mobile) in 24 h. Cancelling doesn't reset the count |
| 502 / 503 | `ABDM_UNAVAILABLE` / `ABDM_NOT_CONFIGURED` | only these endpoints fail. Profile and all other APIs are unaffected |

Audit: `CREATE abha-link` on verify, `UPDATE abha-link` on address.

## Data

- `abha_enrolments`: one row per subject, holding the step, ABDM's `txnId`,
  the chosen mobile, the link id, attempts, expiry and OTP counters. The row
  is kept between attempts (`step = null` when idle) so the daily cap survives
  a cancel. Retention deletes it once idle or expired *and* the OTP window is
  older than 24 h. Erasure and withdrawing `ABDM_SHARING` delete it.
- `abha_links` gained `source` (`LINKED | CREATED`), `aadhaarConsentVersion`
  and `aadhaarConsentAt`, which record which consent text the patient
  accepted and when.

## Code

| File | |
|---|---|
| `src/modules/abdm/abhaEnrolment.service.ts` | the flow |
| `src/modules/abdm/abhaEnrolment.routes.ts` | validation, routes, audit |
| `src/modules/abdm/aadhaarConsent.ts` | consent text + version, Verhoeff check |
| `src/modules/abdm/abdm.client.ts` (`ENROL`) | ABDM enrolment calls |
| `test/abhaEnrolment.test.ts` | 16 scenarios against the fake ABDM in `test/fakeAbdm.ts` |
| `postman/generate.mjs` › *ABHA creation* | offline checks always run. The real steps run only when `aadhaar` (and the OTPs) are set in the environment |

## Before production

- **Sandbox check** of everything in `ENROL` (`abdm.client.ts`): the paths,
  request bodies, and response fields (`isNew`, `ABHAProfile.mobile`,
  `phrAddress`, `abhaAddressList`, `preferredAbhaAddress`) and the
  `Transaction_Id` header on suggestions.
- **Consent text:** replace `AADHAAR_CONSENT` with ABDM's current text and
  version, verbatim. Certification compares it.
- Confirm against ABDM's current M1 checklist which steps are mandatory.

## Later (not in phase 1)

1. **Family members:** adults by their own Aadhaar OTP. Children (<18) use
   ABDM's child-enrolment flow under a parent's ABHA.
2. **ABHA card download** (`profile/account/abha-card`, needs the enrolment
   X-token).
3. **Profile prefill** from Aadhaar-verified details, only into empty fields
   and only after the patient confirms.
4. **Non-Aadhaar enrolment** (driving licence etc.) if certification needs
   it.

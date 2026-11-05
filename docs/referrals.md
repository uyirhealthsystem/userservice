# Health Partner referrals

Status: **implemented** in userservice and the HP (Health Partner) service,
tested against a fake HP and end to end against the real HP service locally.
The ABHA link step is tested against the fake ABDM only.

A Health Partner (HP) is an Uyir member who gets the people of their assigned
village onto the app. Each HP has a referral code (HP service). A villager
enters it when creating their profile. **The HP earns ₹10 only once that
villager has a profile _and_ has linked their own ABHA** - the point at which
ABDM has verified them as a real person. A profile alone earns nothing.

## How it works

```
Villager app                      userservice                               HP service
POST /api/v1/users/me
  { ..., referralCode }  ── check code ─────────────────────────────────►  GET  /internal/v1/referral-codes/:code
                         ◄─ 400 INVALID_REFERRAL_CODE (wrong code: fix it) │
  201 profile created       patient_referrals: UNREGISTERED
                            worker ── register ─────────────────────────►  POST /internal/v1/referrals
                                      PENDING                              referral PENDING, no reward

Link own ABHA (either flow)
  /me/abha/verify  or       AbhaLink created + in the same transaction:
  /me/abha/create/aadhaar/verify   patient_referrals: QUALIFIED
                            worker ── complete ─────────────────────────►  POST /internal/v1/referrals/complete
                                      COMPLETED                            referral COMPLETED, wallet +₹10 (once)
```

| What happens | Referral at HP | HP gets |
|---|---|---|
| Profile created with the code | `PENDING` | nothing yet |
| Patient links **their own** ABHA - an existing one (`/me/abha/verify`) or one created in the app (`/me/abha/create/aadhaar/verify`) | `COMPLETED` | ₹10 |
| Profile created, ABHA never linked | stays `PENDING` (never expires) | nothing |
| ABHA linked for a **family member** | unchanged | nothing |
| The same ABHA was rewarded before (unlinked, then linked on another account) | `CANCELLED` | nothing |
| Patient unlinks their ABHA later | stays `COMPLETED` | keeps the ₹10 |
| Patient erases their account before linking | `CANCELLED` | nothing |
| No code at signup | none | nothing |

There is no village check: any patient who signs up with the code counts.

## Patient API

`referralCode` (optional, at most 30 characters, any letter case) on
`POST /api/v1/users/me`, or on `PUT /api/v1/users/me/profile` when that call
creates the profile. Empty or `null` = no code.

| Status | Code | When |
|---|---|---|
| 400 | `INVALID_REFERRAL_CODE` | HP doesn't know the code (or it is the patient's own HP code). Nothing is created, so the patient can correct it or leave it empty |
| 400 | `REFERRAL_CODE_SIGNUP_ONLY` | a code on `PUT /me/profile` for a profile that already exists |
| 400 | `VALIDATION_ERROR` | longer than 30 characters |

If the HP service is down or `HP_SERVICE_URL` is not set, the code is accepted
**unchecked** - signup never waits on another service. The worker sends it
later; if HP then refuses it, it is dropped (`INVALID`).

The code and its status are in the data export (`GET /me/export` → `referral`).

## userservice

`src/modules/referrals/`:

- `referrals.service.ts` - check at signup, `qualifyReferral` (called inside
  both ABHA link transactions), erasure, and the worker step.
- `hp.client.ts` - the HP internal API. 5xx / 429 / no answer → retry later;
  4xx → HP's final answer, not retried.

`patient_referrals` is an outbox, one row per patient, retried by the worker
(`src/worker.ts`, every `ABDM_WORKER_INTERVAL_MS`, exponential backoff up to
an hour, forever). Up to 20 rows a round (about 3.4 lakh a day per replica at
the default 5 s), sent to HP in parallel: a slow HP holds a round for one
`HP_TIMEOUT_MS`, not one per row, so it never stalls the worker's ABDM steps.
Rows are claimed with `SKIP LOCKED` under a lease of at least 4 × the timeout,
so any number of replicas is safe:

| `status` | Meaning | Worker |
|---|---|---|
| `UNREGISTERED` | code kept, HP not told yet | `register` → `PENDING` |
| `PENDING` | HP has the PENDING referral | nothing until the ABHA is linked |
| `QUALIFIED` | own ABHA linked, HP not told yet | `complete` → `COMPLETED` |
| `COMPLETED` | HP has paid | - |
| `CANCELLING` | HP must cancel (`reason`: `ACCOUNT_ERASED`, `ABHA_ALREADY_REWARDED`) | `cancel` → `INVALID` |
| `INVALID` | HP refused (`reason` = its code) or cancelled | - |

**One reward per ABHA, ever.** `rewarded_abhas` holds an HMAC-SHA256 of each
ABHA number that has earned a reward (keyed with `DATA_ENCRYPTION_KEY`), never
the number. It is not tied to an account, so it survives unlinking and
erasure. A key rotation must keep using the old key here, or rewarded ABHAs
could earn again.

**Erasure** (`DELETE /me`): a `PENDING` referral is cancelled at HP; a
`QUALIFIED` one is still delivered (the HP earned it). Either way the row is
deleted once HP has been told. `COMPLETED` / `INVALID` rows are deleted at once.

Config:

| Variable | Default | |
|---|---|---|
| `HP_SERVICE_URL` | unset | e.g. `http://hp:8088`. Unset = codes accepted unchecked and held until it is set |
| `HP_TIMEOUT_MS` | `5000` | per call |

## HP service

See its README (*Citizen referrals*). The internal API is mounted at
`/internal/v1`, which the gateway never forwards; like every internal API on
the platform it has no token, so the HP service's port must stay closed to the
internet. Every call is idempotent; `complete` credits the wallet at most once
per user (row lock + unique `referred_user_id`), checked with 10 concurrent
calls. The old HP-called `POST /api/v1/referrals` (an HP could claim ₹10 for
any user id) is removed.

## Privacy

HP receives only the patient's auth user id - no name, phone, ABHA or health
data - and keeps it with the referral for its accounts after an erasure. The
privacy notice should say that a referral code given at signup tells that
Health Partner when the patient joins and links an ABHA; bump
`PRIVACY_NOTICE_VERSION` when the notice text changes.

## Tests

- `test/referrals.test.ts` - 22 cases against `test/fakeHp.ts` (and the fake ABDM).
- userservice Postman collection (`postman/generate.mjs`): onboarding sends the
  environment's `referralCode`. Leave it empty for a plain run. Set it to a real
  HP's code, with userservice started with `HP_SERVICE_URL`, to also run the
  unknown-code `400` check and see the referral in the export.
- HP Postman collection: folder *4. Referrals* plays userservice against the
  internal API (saved example responses document each call); *7. Validation
  Checks* covers the error codes.
- api-gateway `uyir-all-services` collection: the patient in *10 · User
  Service* onboards with the code of the HP created in *07 · Health Partner
  Service* (`hpReferralCode`), so a full run goes through the referral flow.

# Privacy - DPDP Act 2023

What userservice does to comply with India's Digital Personal Data Protection
Act 2023 and the DPDP Rules 2025, and what it leaves to the rest of Uyir.
This is an engineering record, not legal advice. Have counsel review the
privacy notice text, consent wording and retention periods.

## Consent (s.5, s.6, s.9)

Nothing about a patient is processed without consent to the **current**
privacy notice (`PRIVACY_NOTICE_VERSION`).

| Purpose | Covers | Needed for |
|---|---|---|
| `CARE` | storing and using health data to provide Uyir's services | everything under `/me/family-members`, `/me/medical`, `/me/health-records`, `/me/medical-history`, `/me/abha` |
| `ABDM_SHARING` | linking an ABHA and sharing records through ABDM | `POST /me/abha/otp`, `/me/abha/verify` |

Each consent is a row in `privacy_consents` with the purpose, the notice
version, the basis, when it was granted and when it was withdrawn. The row is
not a relation of the user, so it outlives an erased account as evidence.

**The account holder** consents at onboarding (`POST /me` with
`consent: { noticeVersion, adultDeclaration: true }`) or later with
`POST /me/consents`. Their consent must be to the current notice version.
Bumping `PRIVACY_NOTICE_VERSION` makes every data route answer
`403 CONSENT_REQUIRED` until they consent again. `GET /me` tells the app with
`privacy.consentRequired`.

**Children.** Under-18s (by date of birth) cannot hold their own account
(`403 MINOR_ACCOUNT`). A parent adds them as a family member instead.

**Family members** are separate data principals. Adding one needs
`consent: { noticeVersion, basis }`:

- `MEMBER_CONSENTED`: the member is an adult and agreed. The account holder
  attests to this.
- `PARENT_OR_GUARDIAN`: the member is a child, or an adult the holder is the
  lawful guardian of. This is required when the date of birth shows they are
  under 18 (`422 GUARDIAN_CONSENT_REQUIRED`), including when a later PATCH sets
  such a date.

A member's consent holds across notice versions. A member without CARE consent,
for example one added before this existed, is still listed
(`consent.care: false`), but their data is hidden from every list and read,
from homebasedcare (internal `/family-members`) and from ABHA linking until
consent is given.

**Withdrawal** (`DELETE /me/consents/:purpose?memberId=`) stops what the
consent allowed:

- `ABDM_SHARING`: the ABHA link and its care contexts are removed, so nothing
  more is linked or shared.
- `CARE` for a family member: the member and all their data are erased.
- `CARE` for the account holder: `409 ERASURE_REQUIRED`. Use `DELETE /me`.

## Rights (s.11 - s.14)

| Right | Endpoint |
|---|---|
| Summary of data held, and processing | `GET /me/export` (everything held, as JSON), `GET /me/access-log` (every read, change and share, newest first) |
| Whom it was shared with | `GET /me/data-sharing`: one row per ABDM consent, with purpose, requester, HI types, record count and last share |
| Correction | `PUT /me/profile`, `PATCH /me/family-members/:id`, `PATCH /me/medical/...`. Provider records are corrected by the provider (it re-sends a new version). |
| Erasure | `DELETE /me` with `{ "confirm": "DELETE_MY_DATA" }` |
| Nomination | `GET / PUT / DELETE /me/nominee` |
| Grievance | `GET /me/privacy` returns the grievance officer (`GRIEVANCE_OFFICER_*`) and the notice URL |

These work without consent and before onboarding: provider records sent before
the patient signed up are theirs too.

**Erasure** deletes the profile, family members, every medical and provider
record with its files, ABHA links (with their care contexts), pending ABHA OTPs
and the nominee. It keeps the `access_audit` rows and the (now withdrawn)
consent rows, which hold no health data, as evidence until retention removes
them. Records a producer sends after the erasure have no account, so they are
treated as orphans (see below).

## Retention (s.8(7))

`src/modules/privacy/retention.ts` runs from the worker, at most once an hour:

| Data | Deleted after | Setting |
|---|---|---|
| `health_record_rejections` | 30 days | `RETENTION_REJECTIONS_DAYS` |
| expired ABHA OTP verifications | at expiry | - |
| finished ABDM data requests; ABDM consents revoked, denied or expired, or past `dataEraseAt` | 30 days | `RETENTION_ABDM_DAYS` |
| provider records of someone with no account (never onboarded, or erased) | 365 days after receipt | `RETENTION_ORPHAN_RECORDS_DAYS` |
| `access_audit`, withdrawn `privacy_consents` | 1095 days (minimum 365, per the DPDP Rules' one-year log retention) | `RETENTION_AUDIT_DAYS` |

## Security safeguards (s.8(5))

- Health-record files are encrypted at rest with AES-256-GCM
  (`DATA_ENCRYPTION_KEY`, required in production). Files stored before the key
  was set are encrypted by the worker. Losing the key makes the files
  unreadable: back it up in a secrets manager.
- Credentials are redacted from logs. There is no CORS here (the gateway owns
  it).
- Identity headers are trusted only with the gateway secret. Service-to-service
  routes (`/internal/v1/*`, `GET /api/v1/users/family-members`) take no token:
  only the private network keeps other callers away from patient data.
- Every access to medical data is audited, and an access that cannot be audited
  fails.

## Not done here

- **Database / disk encryption.** Profile, medical and record text fields are
  plain columns. Run Postgres on an encrypted volume and encrypt backups.
- **Breach notification (s.8(6)).** This is an organisational process: notify
  the Data Protection Board and affected patients within 72 hours. Use
  `access_audit` to find who was affected.
- **The privacy notice itself.** Its text, languages (the Eighth Schedule
  languages on request) and `PRIVACY_NOTICE_URL` are set up outside this
  service.
- **The rest of Uyir.** authservice still holds the login account, and each
  producer (labscan, ecg, hospitalservice, homebasedcare, ambulance) holds its
  own copy of the records. Full erasure needs those services too. The app
  should call authservice's account deletion after `DELETE /me`.
- **ABDM.** Care contexts already linked stay visible in the patient's PHR app
  after unlinking or erasure (we stop serving data for them). HIP-initiated
  de-linking is not implemented.
- **Significant Data Fiduciary duties** (DPO in India, DPIA, periodic audit)
  apply if the government notifies Uyir as one.

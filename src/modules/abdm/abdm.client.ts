import { constants, publicEncrypt, randomUUID } from "node:crypto";
import { env } from "../../lib/env";
import { Errors } from "../../lib/errors";
import { logger } from "../../lib/logger";

// ABDM client. Two API families:
//
//   ABHA v3 (abhaUrl)      - verify a patient's ABHA by OTP and read its
//                            profile. Same calls as pro/src/lib/abdm/client.ts,
//                            which runs against the sandbox today.
//   HIE-CM v3 (gatewayUrl) - our side of being a Health Information Provider:
//                            link care contexts, acknowledge consents and
//                            health-information requests, report transfers.
//                            These answer 202 and reply later on our bridge
//                            callbacks (abdm.callbacks.routes.ts).

export type OtpMethod = "abdm" | "aadhaar";

export interface AbdmProfile {
  ABHANumber?: string;
  preferredAbhaAddress?: string;
  name?: string;
  firstName?: string;
  middleName?: string;
  lastName?: string;
  gender?: string;
  dateOfBirth?: string;
  yearOfBirth?: string;
  [key: string]: unknown;
}

// Every HIE-CM path in one place.
export const HIECM = {
  generateLinkToken: "/api/hiecm/v3/token/generate-token",
  linkCareContext: "/api/hiecm/hip/v3/link/carecontext",
  consentOnNotify: "/api/hiecm/consent/v3/request/hip/on-notify",
  healthInfoOnRequest: "/api/hiecm/data-flow/v3/health-information/hip/on-request",
  healthInfoNotify: "/api/hiecm/data-flow/v3/health-information/notify",
} as const;

const REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_SKEW_MS = 60_000; // refresh the gateway token this long before it expires

let session: { token: string; expiresAt: number } | undefined;
let publicKeyPem: string | undefined;

// Exported for tests, which swap fetch and need a clean cache.
export function resetAbdmClientCache() {
  session = undefined;
  publicKeyPem = undefined;
}

function baseHeaders(requestId: string = randomUUID()): Record<string, string> {
  return { "Content-Type": "application/json", "REQUEST-ID": requestId, TIMESTAMP: new Date().toISOString() };
}

/** Pull a human-readable message out of ABDM's assorted error shapes. */
function abdmMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const nested = b.error as Record<string, unknown> | undefined;
  const msg = nested?.message ?? b.message ?? b.details;
  if (typeof msg === "string") return msg;
  const firstString = Object.values(b).find((v) => typeof v === "string");
  return typeof firstString === "string" ? firstString : undefined;
}

// Thrown for a 4xx from ABDM that is about the request (wrong OTP, unknown
// ABHA...), as opposed to ABDM / our credentials failing (502).
export class AbdmRejected extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "AbdmRejected";
  }
}

async function call<T>(url: string, init: RequestInit, what: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    logger.error({ err, what }, "ABDM request failed");
    throw Errors.abdmUnavailable();
  }

  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }

  if (!res.ok) {
    const message = abdmMessage(body);
    logger.warn({ what, status: res.status, message }, "ABDM request rejected");
    // Our credentials/session or ABDM itself - not the caller's fault.
    if (res.status >= 500 || res.status === 401 || res.status === 403) throw Errors.abdmUnavailable();
    throw new AbdmRejected(res.status, message ?? `ABDM ${what} failed`);
  }
  return body as T;
}

async function getSessionToken(): Promise<string> {
  if (session && session.expiresAt > Date.now()) return session.token;
  if (!env.abdm.clientId || !env.abdm.clientSecret) throw Errors.abdmNotConfigured();

  const body = await call<{ accessToken: string; expiresIn: number }>(
    `${env.abdm.gatewayUrl}/api/hiecm/gateway/v3/sessions`,
    {
      method: "POST",
      headers: { ...baseHeaders(), "X-CM-ID": env.abdm.cmId },
      body: JSON.stringify({ clientId: env.abdm.clientId, clientSecret: env.abdm.clientSecret, grantType: "client_credentials" }),
    },
    "session",
  );
  session = { token: body.accessToken, expiresAt: Date.now() + body.expiresIn * 1000 - TOKEN_SKEW_MS };
  return session.token;
}

async function authHeaders(requestId?: string): Promise<Record<string, string>> {
  return { ...baseHeaders(requestId), Authorization: `Bearer ${await getSessionToken()}` };
}

// ── ABHA verification ───────────────────────────────────────────────────────

async function getPublicKey(): Promise<string> {
  if (publicKeyPem) return publicKeyPem;
  const body = await call<{ publicKey: string }>(
    `${env.abdm.abhaUrl}/abha/api/v3/profile/public/certificate`,
    { method: "GET", headers: await authHeaders() },
    "certificate",
  );
  const b64 = body.publicKey.replace(/\s+/g, "");
  publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----\n`;
  return publicKeyPem;
}

/** RSA/ECB/OAEPWithSHA-1AndMGF1Padding, base64 - the encryption ABDM expects. */
async function encrypt(value: string): Promise<string> {
  return publicEncrypt(
    { key: await getPublicKey(), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
    Buffer.from(value, "utf8"),
  ).toString("base64");
}

const scopeFor = (method: OtpMethod) => ["abha-login", method === "aadhaar" ? "aadhaar-verify" : "mobile-verify"];

/** Sends an OTP to the ABHA holder; returns ABDM's transaction id. */
export async function requestLoginOtp(abhaNumber: string, method: OtpMethod): Promise<string> {
  let body: { txnId?: string };
  try {
    body = await call(
      `${env.abdm.abhaUrl}/abha/api/v3/profile/login/request/otp`,
      {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({ scope: scopeFor(method), loginHint: "abha-number", loginId: await encrypt(abhaNumber), otpSystem: method }),
      },
      "OTP request",
    );
  } catch (err) {
    if (err instanceof AbdmRejected && err.status === 404) throw Errors.notFound("ABHA account");
    if (err instanceof AbdmRejected) throw Errors.badRequest("ABHA_OTP_FAILED", err.message);
    throw err;
  }
  if (!body?.txnId) throw Errors.abdmUnavailable("ABDM did not return a transaction id.");
  return body.txnId;
}

/** The holder's X-token, or undefined when ABDM says the OTP is wrong. */
export async function verifyLoginOtp(txnId: string, otp: string, method: OtpMethod): Promise<string | undefined> {
  let body: { authResult?: string; token?: string };
  try {
    body = await call(
      `${env.abdm.abhaUrl}/abha/api/v3/profile/login/verify`,
      {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({
          scope: scopeFor(method),
          authData: { authMethods: ["otp"], otp: { txnId, otpValue: await encrypt(otp) } },
        }),
      },
      "OTP verification",
    );
  } catch (err) {
    if (err instanceof AbdmRejected) return undefined; // wrong / expired OTP
    throw err;
  }
  return body?.authResult === "success" && body.token ? body.token : undefined;
}

export async function getProfile(xToken: string): Promise<AbdmProfile> {
  return call<AbdmProfile>(
    `${env.abdm.abhaUrl}/abha/api/v3/profile/account`,
    { method: "GET", headers: { ...(await authHeaders()), "X-token": `Bearer ${xToken}` } },
    "profile fetch",
  );
}

// ── ABHA enrolment (creation by Aadhaar OTP) ────────────────────────────────
//
// Written from ABDM's ABHA v3 enrolment docs and tested against a fake ABDM:
// check these paths and shapes in the sandbox before production.

export const ENROL = {
  requestOtp: "/abha/api/v3/enrollment/request/otp",
  byAadhaar: "/abha/api/v3/enrollment/enrol/byAadhar",
  byAbdm: "/abha/api/v3/enrollment/auth/byAbdm",
  suggestion: "/abha/api/v3/enrollment/enrol/suggestion",
  abhaAddress: "/abha/api/v3/enrollment/enrol/abha-address",
} as const;

export interface EnrolProfile {
  ABHANumber?: string;
  firstName?: string;
  middleName?: string;
  lastName?: string;
  name?: string;
  gender?: string;
  dob?: string; // dd-mm-yyyy
  mobile?: string | null;
  phrAddress?: string[];
  [key: string]: unknown;
}

export interface EnrolResult {
  txnId?: string;
  isNew: boolean;
  profile: EnrolProfile;
}

const enrolUrl = (path: string) => `${env.abdm.abhaUrl}${path}`;

async function enrolPost<T>(path: string, body: unknown, what: string): Promise<T> {
  return call<T>(enrolUrl(path), { method: "POST", headers: await authHeaders(), body: JSON.stringify(body) }, what);
}

/** OTP to the Aadhaar-linked mobile. The Aadhaar number only leaves here encrypted. */
export async function requestEnrolOtp(aadhaar: string): Promise<string> {
  let body: { txnId?: string };
  try {
    body = await enrolPost(
      ENROL.requestOtp,
      { txnId: "", scope: ["abha-enrol"], loginHint: "aadhaar", loginId: await encrypt(aadhaar), otpSystem: "aadhaar" },
      "enrolment OTP request",
    );
  } catch (err) {
    if (err instanceof AbdmRejected) throw Errors.badRequest("ABHA_ENROLMENT_FAILED", err.message);
    throw err;
  }
  if (!body?.txnId) throw Errors.abdmUnavailable("ABDM did not return a transaction id.");
  return body.txnId;
}

/** Creates (or finds) the ABHA for the Aadhaar; undefined when ABDM refuses the OTP. */
export async function enrolByAadhaar(txnId: string, otp: string, mobile: string, consentVersion: string): Promise<EnrolResult | undefined> {
  let body: { txnId?: string; isNew?: boolean; ABHAProfile?: EnrolProfile };
  try {
    body = await enrolPost(
      ENROL.byAadhaar,
      {
        authData: { authMethods: ["otp"], otp: { txnId, otpValue: await encrypt(otp), mobile } },
        consent: { code: "abha-enrollment", version: consentVersion },
      },
      "enrolment by Aadhaar",
    );
  } catch (err) {
    if (err instanceof AbdmRejected) return undefined; // wrong / expired OTP
    throw err;
  }
  if (!body?.ABHAProfile?.ABHANumber) throw Errors.abdmUnavailable("ABDM did not return the ABHA.");
  return { txnId: body.txnId, isNew: body.isNew !== false, profile: body.ABHAProfile };
}

/** OTP to the communication mobile; returns the transaction id to continue with. */
export async function requestEnrolMobileOtp(txnId: string, mobile: string): Promise<string> {
  let body: { txnId?: string };
  try {
    body = await enrolPost(
      ENROL.requestOtp,
      { txnId, scope: ["abha-enrol", "mobile-verify"], loginHint: "mobile", loginId: await encrypt(mobile), otpSystem: "abdm" },
      "enrolment mobile OTP request",
    );
  } catch (err) {
    if (err instanceof AbdmRejected) throw Errors.badRequest("ABHA_ENROLMENT_FAILED", err.message);
    throw err;
  }
  return body?.txnId ?? txnId;
}

/** True when ABDM accepted the mobile OTP. */
export async function verifyEnrolMobileOtp(txnId: string, otp: string): Promise<boolean> {
  let body: { authResult?: string };
  try {
    body = await enrolPost(
      ENROL.byAbdm,
      { scope: ["abha-enrol", "mobile-verify"], authData: { authMethods: ["otp"], otp: { txnId, otpValue: await encrypt(otp) } } },
      "enrolment mobile verification",
    );
  } catch (err) {
    if (err instanceof AbdmRejected) return false;
    throw err;
  }
  return body?.authResult === "success";
}

export async function abhaAddressSuggestions(txnId: string): Promise<string[]> {
  const body = await call<{ abhaAddressList?: string[] }>(
    enrolUrl(ENROL.suggestion),
    { method: "GET", headers: { ...(await authHeaders()), Transaction_Id: txnId } },
    "ABHA address suggestions",
  );
  return Array.isArray(body?.abhaAddressList) ? body.abhaAddressList : [];
}

/** Sets the ABHA address; returns it with ABDM's suffix. AbdmRejected when unavailable. */
export async function setAbhaAddress(txnId: string, abhaAddress: string): Promise<string | undefined> {
  const body = await enrolPost<{ preferredAbhaAddress?: string }>(
    ENROL.abhaAddress,
    { txnId, abhaAddress, preferred: 1 },
    "ABHA address",
  );
  return body?.preferredAbhaAddress;
}

// ── HIE-CM (we are the HIP) ─────────────────────────────────────────────────

/**
 * POSTs to the HIE-CM as our HIP. ABDM echoes the REQUEST-ID as
 * response.requestId in its callback - pass one in when it has to be stored
 * before the call (the callback can beat the response). Throws AbdmRejected
 * for a 4xx about the request, AppError 502/503 for ABDM / config trouble.
 */
export async function hiecmPost(
  path: string,
  body: unknown,
  { requestId = randomUUID(), headers: extraHeaders = {} }: { requestId?: string; headers?: Record<string, string> } = {},
): Promise<string> {
  await call(
    `${env.abdm.gatewayUrl}${path}`,
    {
      method: "POST",
      headers: { ...(await authHeaders(requestId)), "X-CM-ID": env.abdm.cmId, "X-HIP-ID": env.abdm.hipId, ...extraHeaders },
      body: JSON.stringify(body),
    },
    path,
  );
  return requestId;
}

/**
 * POST encrypted bundles to the HIU's dataPushUrl. A third party's endpoint:
 * our ABDM session token is never sent there.
 */
export async function pushHealthData(dataPushUrl: string, body: unknown): Promise<void> {
  await call(dataPushUrl, { method: "POST", headers: baseHeaders(), body: JSON.stringify(body) }, "data push");
}

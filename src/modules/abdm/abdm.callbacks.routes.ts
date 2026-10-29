import { createPublicKey, verify } from "node:crypto";
import { NextFunction, Request, Response, Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/asyncHandler";
import { env } from "../../lib/env";
import { Errors } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { onCareContextsLinked, onLinkToken } from "./careContexts";
import {
  acceptDataRequest,
  acknowledgeConsent,
  acknowledgeDataRequest,
  consentNotifySchema,
  healthInfoRequestSchema,
  storeConsent,
} from "./dataTransfer";

// Our ABDM bridge: the URLs ABDM calls back. Registered with ABDM as the
// bridge URL https://<public gateway host>/abdm; the api-gateway forwards
// /abdm/* here without a user token. Every call must carry ABDM's own signed
// JWT (RS256, keys from ABDM's certs endpoint).
//
// ABDM expects 202 at once; replies that go back to ABDM (acknowledgements)
// are sent after responding and carry ABDM's REQUEST-ID as response.requestId.
export const abdmCallbacksRouter = Router();

// ── Caller verification ─────────────────────────────────────────────────────

type Jwk = { kid?: string; [field: string]: unknown };
let jwks: { keys: Jwk[]; fetchedAt: number } | undefined;
const JWKS_TTL_MS = 60 * 60_000;

async function abdmKeys(force = false) {
  if (!force && jwks && Date.now() - jwks.fetchedAt < JWKS_TTL_MS) return jwks.keys;
  const url = env.abdm.certsUrl || `${env.abdm.gatewayUrl}/api/hiecm/gateway/v3/certs`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`ABDM certs answered ${res.status}`);
  jwks = { keys: ((await res.json()) as { keys: Jwk[] }).keys ?? [], fetchedAt: Date.now() };
  return jwks.keys;
}

export const resetAbdmKeys = () => {
  jwks = undefined;
};

async function verifyAbdmToken(token: string): Promise<boolean> {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return false;
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as { alg?: string; kid?: string };
  if (header.alg !== "RS256") return false;

  let key = (await abdmKeys()).find((k) => k.kid === header.kid);
  if (!key) key = (await abdmKeys(true)).find((k) => k.kid === header.kid); // ABDM rotated its keys
  if (!key) return false;

  const ok = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey({ key: key as never, format: "jwk" }), Buffer.from(s, "base64url"));
  if (!ok) return false;
  const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as { exp?: number };
  return typeof claims.exp === "number" && claims.exp * 1000 > Date.now();
}

async function abdmCaller(req: Request, _res: Response, next: NextFunction) {
  if (!env.abdm.verifyCallbacks) return next(); // dev / test only - env.ts refuses this in production
  const auth = req.header("authorization") ?? "";
  try {
    if (auth.startsWith("Bearer ") && (await verifyAbdmToken(auth.slice(7).trim()))) return next();
  } catch (err) {
    logger.warn({ err }, "ABDM callback token could not be verified");
  }
  next(Errors.notAuthenticated());
}

abdmCallbacksRouter.use(abdmCaller);

// After the 202: an acknowledgement that fails is logged - ABDM re-sends a
// request it got no acknowledgement for.
function afterResponse(what: string, fn: () => Promise<unknown>) {
  setImmediate(() => fn().catch((err) => logger.error({ err, what }, "ABDM acknowledgement failed")));
}

const responseRef = z.object({ requestId: z.string() });
const abdmError = z.object({ code: z.unknown().optional(), message: z.string().optional() }).nullish();

// ── Linking ─────────────────────────────────────────────────────────────────

abdmCallbacksRouter.post(
  "/api/v3/hip/token/on-generate-token",
  asyncHandler(async (req, res) => {
    const body = z.object({ linkToken: z.string().optional(), error: abdmError, response: responseRef }).parse(req.body);
    await onLinkToken(body.response.requestId, body.linkToken, body.error?.message ?? (body.error ? "error" : undefined));
    res.status(202).end();
  }),
);

abdmCallbacksRouter.post(
  "/api/v3/link/on_carecontext",
  asyncHandler(async (req, res) => {
    const body = z.object({ status: z.string().optional(), error: abdmError, response: responseRef }).parse(req.body);
    await onCareContextsLinked(body.response.requestId, body.error ? (body.error.message ?? "error") : undefined);
    res.status(202).end();
  }),
);

// ── Consent and data flow ───────────────────────────────────────────────────

abdmCallbacksRouter.post(
  "/api/v3/consent/request/hip/notify",
  asyncHandler(async (req, res) => {
    const consentId = await storeConsent(consentNotifySchema.parse(req.body));
    const requestId = req.header("request-id") ?? "";
    res.status(202).end();
    afterResponse("consent on-notify", () => acknowledgeConsent(consentId, requestId));
  }),
);

abdmCallbacksRouter.post(
  "/api/v3/hip/health-information/request",
  asyncHandler(async (req, res) => {
    const body = healthInfoRequestSchema.parse(req.body);
    const sessionStatus = await acceptDataRequest(body);
    const requestId = req.header("request-id") ?? "";
    res.status(202).end();
    afterResponse("health-information on-request", () => acknowledgeDataRequest(body.transactionId, sessionStatus, requestId));
  }),
);

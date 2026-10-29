import { timingSafeEqual } from "node:crypto";
import { NextFunction, Request, Response } from "express";
import { env } from "../lib/env";
import { Errors } from "../lib/errors";
import { PATIENT_ROLE } from "../lib/constants";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function secretMatches(presented: string | undefined): boolean {
  if (!env.gatewaySecret) return true; // dev / test only - env.ts refuses this in production
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(env.gatewaySecret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The service (LABSCAN, HOMEBASEDCARE...) whose INTERNAL_SERVICE_TOKENS token this is. */
export function serviceSource(presented: string): string | undefined {
  const given = Buffer.from(presented);
  for (const [token, source] of env.serviceTokens) {
    const expected = Buffer.from(token);
    if (given.length === expected.length && timingSafeEqual(given, expected)) return source;
  }
  return undefined;
}

function bearerSource(req: Request): string | undefined {
  const header = req.header("authorization") ?? "";
  return header.startsWith("Bearer ") ? serviceSource(header.slice(7).trim()) : undefined;
}

// This service never sees the JWT itself. The gateway verifies it, strips any
// x-user-* a client sent, and forwards x-user-id (= token sub), x-user-role
// and x-gateway-secret. We believe the identity headers only alongside the
// secret, so a caller that skips the gateway cannot act as anyone.
export function gatewayIdentity(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!secretMatches(req.header("x-gateway-secret"))) return next(Errors.notAuthenticated());

    const userId = req.header("x-user-id");
    const role = req.header("x-user-role") ?? "";
    if (!userId || !UUID.test(userId)) return next(Errors.notAuthenticated());
    if (roles.length > 0 && !roles.includes(role)) {
      return next(Errors.forbidden("This endpoint requires a different role."));
    }

    req.auth = { userId, role };
    next();
  };
}

// Service-to-service read of a patient's family members. homebasedcare calls
// it directly, inside the private network, with X-User-Id and its
// INTERNAL_SERVICE_TOKENS bearer token; through the gateway the
// x-gateway-secret vouches for X-User-Id instead. One of the two is required,
// so a peer on the network cannot read any patient's family by naming their
// id. Read-only and family members only.
export function internalUserId(req: Request, _res: Response, next: NextFunction) {
  if (!bearerSource(req) && !secretMatches(req.header("x-gateway-secret"))) return next(Errors.notAuthenticated());
  const userId = req.header("x-user-id");
  if (!userId || !UUID.test(userId)) return next(Errors.notAuthenticated());
  req.auth = { userId, role: req.header("x-user-role") ?? PATIENT_ROLE };
  next();
}

import { Request } from "express";
import { prisma } from "./prisma";
import { logger } from "./logger";

export type AuditAction = "READ" | "CREATE" | "UPDATE" | "DELETE" | "SHARE";

export interface AuditEntry {
  ownerId: string; // the patient account the data belongs to
  actorId: string; // a user id, a producing service, or an ABDM HIU / consent id
  actorRole: string; // PATIENT | SERVICE | ABDM
  action: AuditAction;
  resource: string;
  resourceId?: string | null;
  requestId?: string | null;
}

// Records an access to medical data. Awaited so a request that could not be
// audited does not silently succeed - medical data is only served with a trail.
export async function auditAccess(entry: AuditEntry) {
  try {
    await prisma.accessAudit.create({
      data: { ...entry, resourceId: entry.resourceId ?? null, requestId: entry.requestId ?? null },
    });
  } catch (err) {
    logger.error({ err, resource: entry.resource, action: entry.action }, "failed to write access audit");
    throw err;
  }
}

// The patient themself, through the gateway.
export function audit(req: Request, action: AuditAction, resource: string, resourceId?: string) {
  return auditAccess({
    ownerId: req.auth!.userId,
    actorId: req.auth!.userId,
    actorRole: req.auth!.role,
    action,
    resource,
    resourceId,
    requestId: req.header("x-request-id") ?? null,
  });
}

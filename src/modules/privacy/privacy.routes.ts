import { NextFunction, Request, Response, Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import { audit } from "../../lib/audit";
import { env } from "../../lib/env";
import { Errors } from "../../lib/errors";
import { prisma } from "../../lib/prisma";
import { consentSelect, grantConsent, hasConsent, withdrawConsent } from "./consent.service";
import { dataSharing, eraseAccount, exportData } from "./rights.service";
import {
  accessLogQuerySchema,
  eraseSchema,
  grantConsentSchema,
  nomineeSchema,
  withdrawConsentSchema,
} from "./privacy.schemas";

// The patient's privacy controls (DPDP Act). Mounted behind
// gatewayIdentity(PATIENT). Notice, consents, access log, sharing summary,
// export and erasure need neither a profile nor consent - a patient can
// always see and remove what is held about them. The nominee needs the
// profile (requireUser, app.ts).
export const privacyRouter = Router();

const requestId = (req: Request) => req.header("x-request-id") ?? null;

// For routes that work on medical data: the holder has consented to the
// current notice. Runs after requireUser.
export async function requireConsent(req: Request, _res: Response, next: NextFunction) {
  try {
    if (!(await hasConsent(req.auth!.userId, "self", "CARE"))) throw Errors.consentRequired("CARE");
    next();
  } catch (err) {
    next(err);
  }
}

export function privacyNotice() {
  return {
    version: env.privacy.noticeVersion,
    url: env.privacy.noticeUrl || null,
    grievanceOfficer: env.privacy.grievanceOfficer,
    // Escalation if the grievance officer does not resolve it (DPDP s.13(3)).
    dataProtectionBoard: "Data Protection Board of India",
  };
}

privacyRouter.get(
  "/me/privacy",
  asyncHandler(async (req, res) => {
    const userId = req.auth!.userId;
    const consents = await prisma.privacyConsent.findMany({
      where: { userId },
      select: consentSelect,
      orderBy: { grantedAt: "desc" },
    });
    res.status(200).json({
      notice: privacyNotice(),
      consentRequired: !(await hasConsent(userId, "self", "CARE")),
      consents,
    });
  }),
);

privacyRouter.post(
  "/me/consents",
  asyncHandler(async (req, res) => {
    const body = grantConsentSchema.parse(req.body);
    const { consent, created } = await grantConsent(req.auth!.userId, body, requestId(req));
    res.status(created ? 201 : 200).json({ consent });
  }),
);

privacyRouter.delete(
  "/me/consents/:purpose",
  asyncHandler(async (req, res) => {
    const { purpose, memberId } = withdrawConsentSchema.parse({ ...req.query, purpose: req.params.purpose });
    const erased = await withdrawConsent(req.auth!.userId, purpose, memberId);
    await audit(req, "DELETE", erased === "family-member" ? "family-members" : "abha-links", memberId);
    res.status(204).end();
  }),
);

// Who read, changed or received the patient's data, and when (DPDP s.11).
privacyRouter.get(
  "/me/access-log",
  asyncHandler(async (req, res) => {
    const q = accessLogQuerySchema.parse(req.query);
    const rows = await prisma.accessAudit.findMany({
      where: {
        ownerId: req.auth!.userId,
        ...(q.before && { OR: [{ at: { lt: q.before } }, { at: q.before, id: { lt: q.beforeId } }] }),
      },
      select: { id: true, at: true, action: true, resource: true, resourceId: true, actorRole: true, actorId: true },
      orderBy: [{ at: "desc" }, { id: "desc" }],
      take: q.limit + 1,
    });
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    res.status(200).json({
      entries: page,
      next: rows.length > q.limit ? { before: last.at.toISOString(), beforeId: last.id } : null,
    });
  }),
);

privacyRouter.get(
  "/me/data-sharing",
  asyncHandler(async (req, res) => {
    res.status(200).json({ sharing: await dataSharing(req.auth!.userId) });
  }),
);

privacyRouter.get(
  "/me/export",
  asyncHandler(async (req, res) => {
    const data = await exportData(req.auth!.userId);
    await audit(req, "READ", "export");
    res
      .status(200)
      .attachment(`uyir-data-${new Date().toISOString().slice(0, 10)}.json`)
      .set("Cache-Control", "private, no-store")
      .json(data);
  }),
);

// Erasure (DPDP s.12). The login account itself lives in authservice.
privacyRouter.delete(
  "/me",
  asyncHandler(async (req, res) => {
    eraseSchema.parse(req.body ?? {});
    await eraseAccount(req.auth!.userId, req.auth!.role, requestId(req));
    res.status(204).end();
  }),
);

// ── Nominee (DPDP s.14) ─────────────────────────────────────────────────────

const nomineeSelect = { fullName: true, relationship: true, phone: true, email: true, updatedAt: true } as const;

privacyRouter.get(
  "/me/nominee",
  asyncHandler(async (req, res) => {
    const nominee = await prisma.nominee.findUnique({ where: { userId: req.auth!.userId }, select: nomineeSelect });
    if (!nominee) throw Errors.notFound("Nominee");
    res.status(200).json({ nominee });
  }),
);

privacyRouter.put(
  "/me/nominee",
  asyncHandler(async (req, res) => {
    const userId = req.auth!.userId;
    const body = nomineeSchema.parse(req.body);
    const data = { ...body, email: body.email ?? null };
    const nominee = await prisma.nominee.upsert({ where: { userId }, create: { userId, ...data }, update: data, select: nomineeSelect });
    res.status(200).json({ nominee });
  }),
);

privacyRouter.delete(
  "/me/nominee",
  asyncHandler(async (req, res) => {
    const { count } = await prisma.nominee.deleteMany({ where: { userId: req.auth!.userId } });
    if (count === 0) throw Errors.notFound("Nominee");
    res.status(204).end();
  }),
);

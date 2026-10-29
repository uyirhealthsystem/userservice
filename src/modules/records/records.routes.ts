import { Router } from "express";
import { Prisma } from "@prisma/client";
import { asyncHandler } from "../../lib/asyncHandler";
import { audit } from "../../lib/audit";
import { prisma } from "../../lib/prisma";
import { AppError, Errors } from "../../lib/errors";
import { openBytes } from "../../lib/crypto";
import { consentedMember, consentedSubjects } from "../privacy/consent.service";
import { idParamSchema } from "../family/family.schemas";
import { attachmentParamsSchema, historyQuerySchema, listRecordsQuerySchema } from "./records.schemas";

// Records the providers sent for the patient (and their family members),
// plus the combined medical history. Read-only for the patient: a provider's
// record is corrected by the provider. Mounted behind gatewayIdentity(PATIENT)
// + requireUser + requireConsent; a family member's records only show with
// consent for them. Every read is audited.
export const recordsRouter = Router();

// Never returned: whose account it is (the caller), the producer's internal
// bookkeeping, and file bytes (downloaded separately).
const recordSelect = {
  id: true,
  familyMemberId: true,
  source: true,
  encounterId: true,
  recordType: true,
  status: true,
  title: true,
  summary: true,
  recordedAt: true,
  facilityName: true,
  practitionerName: true,
  details: true,
  createdAt: true,
  updatedAt: true,
  attachments: {
    select: { id: true, fileName: true, contentType: true, size: true, status: true },
    orderBy: { createdAt: "asc" },
  },
} satisfies Prisma.HealthRecordSelect;

// Retracted records are kept (and audited) but never shown.
const visible = { status: { not: "ENTERED_IN_ERROR" } };

const subjectWhere = (memberId: string) => ({ familyMemberId: memberId === "self" ? null : memberId });

recordsRouter.get(
  "/me/health-records",
  asyncHandler(async (req, res) => {
    const userId = req.auth!.userId;
    const q = listRecordsQuerySchema.parse(req.query);
    if (q.memberId && q.memberId !== "self") await consentedMember(userId, q.memberId);
    if ((q.before === undefined) !== (q.beforeId === undefined)) {
      throw Errors.badRequest("VALIDATION_ERROR", "before and beforeId go together.");
    }

    const where: Prisma.HealthRecordWhereInput = {
      userId,
      ...visible,
      ...(q.recordType && { recordType: q.recordType }),
      ...(q.source && { source: q.source }),
      recordedAt: { ...(q.from && { gte: q.from }), ...(q.to && { lte: q.to }) },
      AND: [
        q.memberId ? subjectWhere(q.memberId) : await consentedSubjects(userId),
        // Keyset pagination on (recordedAt, id), newest first.
        q.before ? { OR: [{ recordedAt: { lt: q.before } }, { recordedAt: q.before, id: { lt: q.beforeId } }] } : {},
      ],
    };
    const rows = await prisma.healthRecord.findMany({
      where,
      select: recordSelect,
      orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
    });
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    await audit(req, "READ", "health-records");
    res.status(200).json({
      healthRecords: page,
      next: rows.length > q.limit ? { before: last.recordedAt.toISOString(), beforeId: last.id } : null,
    });
  }),
);

recordsRouter.get(
  "/me/health-records/:id",
  asyncHandler(async (req, res) => {
    const { id } = idParamSchema.parse(req.params);
    const userId = req.auth!.userId;
    const record = await prisma.healthRecord.findFirst({
      where: { id, userId, ...visible, ...(await consentedSubjects(userId)) },
      select: recordSelect,
    });
    if (!record) throw Errors.notFound("Health record");
    await audit(req, "READ", "health-records", id);
    res.status(200).json({ healthRecord: record });
  }),
);

recordsRouter.get(
  "/me/health-records/:id/attachments/:attachmentId",
  asyncHandler(async (req, res) => {
    const { id, attachmentId } = attachmentParamsSchema.parse(req.params);
    const userId = req.auth!.userId;
    const file = await prisma.healthRecordAttachment.findFirst({
      where: { id: attachmentId, healthRecord: { id, userId, ...visible, ...(await consentedSubjects(userId)) } },
      select: { fileName: true, contentType: true, content: true, encrypted: true, status: true },
    });
    if (!file) throw Errors.notFound("Attachment");
    if (file.status !== "STORED" || !file.content) {
      throw new AppError(409, "ATTACHMENT_NOT_READY", "This file is still being fetched from the provider.");
    }
    await audit(req, "READ", "health-record-attachments", attachmentId);
    res
      .status(200)
      .type(file.contentType)
      .attachment(file.fileName)
      .set("Cache-Control", "private, no-store")
      .send(openBytes(file.content, file.encrypted));
  }),
);

// One person's history in one call: what the patient recorded themselves
// (conditions, allergies, medicines, vitals) next to what providers sent.
recordsRouter.get(
  "/me/medical-history",
  asyncHandler(async (req, res) => {
    const userId = req.auth!.userId;
    const { memberId } = historyQuerySchema.parse(req.query);
    if (memberId !== "self") await consentedMember(userId, memberId);
    const where = { userId, ...subjectWhere(memberId) };
    const today = new Date(new Date().toISOString().slice(0, 10));
    const omit = { userId: true } as const;

    const [conditions, allergies, medications, vitals, healthRecords, abha] = await Promise.all([
      prisma.medicalCondition.findMany({ where, omit, orderBy: [{ status: "asc" }, { createdAt: "desc" }] }),
      prisma.allergy.findMany({ where, omit, orderBy: { createdAt: "desc" } }),
      prisma.medication.findMany({
        where: { ...where, OR: [{ endDate: null }, { endDate: { gte: today } }] },
        omit,
        orderBy: { createdAt: "desc" },
      }),
      // Latest reading of each type.
      prisma.vitalReading.findMany({
        where,
        omit,
        orderBy: [{ type: "asc" }, { measuredAt: "desc" }],
        distinct: ["type"],
      }),
      prisma.healthRecord.findMany({
        where: { ...where, ...visible },
        select: recordSelect,
        orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
        take: 20,
      }),
      prisma.abhaLink.findUnique({
        where: { userId_subject: { userId, subject: memberId } },
        select: { abhaNumber: true, abhaAddress: true, verifiedAt: true },
      }),
    ]);

    await audit(req, "READ", "medical-history");
    res.status(200).json({
      memberId,
      abha,
      conditions,
      allergies,
      currentMedications: medications,
      latestVitals: vitals,
      recentHealthRecords: healthRecords,
    });
  }),
);

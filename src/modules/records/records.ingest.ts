import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { sealBytes } from "../../lib/crypto";
import { syncCareContext } from "../abdm/careContexts";
import type { HealthRecordInput } from "./records.schemas";

// Stores a record pushed by a producing service. Shared by the Kafka consumer
// and the internal HTTP endpoint, so both channels behave identically.
//
//   new (source, sourceRecordId)       -> created
//   higher sourceVersion               -> updated (attachments replaced)
//   same or lower sourceVersion        -> unchanged (re-delivery / out of order)
//
// A record can't move to another patient: the producer retracts it
// (ENTERED_IN_ERROR) and sends a new sourceRecordId instead - otherwise a
// record already linked to one ABHA would silently change hands.

export type IngestOutcome = "created" | "updated" | "unchanged";

// The message is well-formed but can't be stored. Not retried.
export class IngestRejected extends Error {
  constructor(
    public code: "UNKNOWN_FAMILY_MEMBER" | "SUBJECT_CHANGED" | "INVALID",
    message: string,
  ) {
    super(message);
    this.name = "IngestRejected";
  }
}

function attachmentRows(input: HealthRecordInput) {
  return input.attachments.map((a) => {
    if (a.contentBase64 === undefined) {
      return { fileName: a.fileName, contentType: a.contentType, sourceUrl: a.url!, status: "PENDING" };
    }
    const content = Buffer.from(a.contentBase64, "base64");
    return {
      fileName: a.fileName,
      contentType: a.contentType,
      ...sealBytes(content),
      size: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      status: "STORED",
    };
  });
}

export async function ingestHealthRecord(
  input: HealthRecordInput,
  channel: "KAFKA" | "HTTP",
): Promise<{ outcome: IngestOutcome; recordId: string }> {
  const userId = input.patient.userId;
  const familyMemberId = input.patient.familyMemberId ?? null;

  if (familyMemberId) {
    const member = await prisma.familyMember.findFirst({ where: { id: familyMemberId, userId }, select: { id: true } });
    if (!member) {
      throw new IngestRejected("UNKNOWN_FAMILY_MEMBER", "familyMemberId is not a family member of patient.userId.");
    }
  }

  const fields = {
    sourceVersion: input.sourceVersion,
    encounterId: input.encounterId ?? input.sourceRecordId,
    recordType: input.recordType,
    status: input.status,
    title: input.title,
    summary: input.summary ?? null,
    recordedAt: input.recordedAt,
    facilityName: input.facilityName ?? null,
    practitionerName: input.practitionerName ?? null,
    details: (input.details ?? Prisma.DbNull) as Prisma.InputJsonValue | typeof Prisma.DbNull,
  };
  const key = { source: input.source, sourceRecordId: input.sourceRecordId };

  // Two attempts: a concurrent first delivery of the same record can win the
  // insert race (unique violation), after which this is an ordinary update.
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await prisma.$transaction(async (tx) => {
        const existing = await tx.healthRecord.findUnique({
          where: { source_sourceRecordId: key },
          select: { id: true, userId: true, familyMemberId: true, sourceVersion: true },
        });

        if (!existing) {
          const row = await tx.healthRecord.create({
            data: { ...key, userId, familyMemberId, ...fields, attachments: { create: attachmentRows(input) } },
            select: { id: true },
          });
          await tx.accessAudit.create({ data: serviceAudit(input.source, userId, "CREATE", row.id) });
          return { outcome: "created" as const, recordId: row.id };
        }

        if (existing.userId !== userId || existing.familyMemberId !== familyMemberId) {
          throw new IngestRejected(
            "SUBJECT_CHANGED",
            "This record belongs to another patient. Send ENTERED_IN_ERROR for it and a new sourceRecordId.",
          );
        }
        if (existing.sourceVersion >= input.sourceVersion) return { outcome: "unchanged" as const, recordId: existing.id };

        // Conditional on the version, so of two concurrent updates the
        // newer always wins (Postgres re-checks the WHERE after the row lock).
        const { count } = await tx.healthRecord.updateMany({
          where: { id: existing.id, sourceVersion: { lt: input.sourceVersion } },
          data: fields,
        });
        if (count === 0) return { outcome: "unchanged" as const, recordId: existing.id };

        await tx.healthRecordAttachment.deleteMany({ where: { healthRecordId: existing.id } });
        await tx.healthRecordAttachment.createMany({
          data: attachmentRows(input).map((a) => ({ ...a, healthRecordId: existing.id })),
        });
        await tx.accessAudit.create({ data: serviceAudit(input.source, userId, "UPDATE", existing.id) });
        return { outcome: "updated" as const, recordId: existing.id };
      });

      // Also on "unchanged": if this failed after an earlier commit, the
      // producer's retry is what gets the record linked. It is idempotent.
      if (input.status !== "ENTERED_IN_ERROR") {
        await syncCareContext({ userId, familyMemberId, source: input.source, ...fields });
      }
      logger.info({ ...key, version: input.sourceVersion, channel, outcome: result.outcome }, "health record ingested");
      return result;
    } catch (err) {
      const raceLost = err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
      if (raceLost && attempt < 2) continue;
      throw err;
    }
  }
}

// Written in the same transaction as the record: stored implies audited.
function serviceAudit(source: string, ownerId: string, action: "CREATE" | "UPDATE", resourceId: string) {
  return { ownerId, actorId: source, actorRole: "SERVICE", action, resource: "health-records", resourceId };
}

export async function recordRejection(
  channel: "KAFKA" | "HTTP",
  reason: string,
  payload: unknown,
): Promise<void> {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 200) : null);
  try {
    await prisma.healthRecordRejection.create({
      data: {
        channel,
        reason: reason.slice(0, 2000),
        source: str(p.source),
        sourceRecordId: str(p.sourceRecordId),
        // Inline file bytes are not kept - the reason is what matters.
        payload: stripFileContent(payload) as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    logger.error({ err, channel, reason }, "failed to store health record rejection");
  }
  logger.warn({ channel, reason, source: str(p.source), sourceRecordId: str(p.sourceRecordId) }, "health record rejected");
}

function stripFileContent(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload ?? null;
  const p = payload as Record<string, unknown>;
  if (!Array.isArray(p.attachments)) return p;
  return {
    ...p,
    attachments: p.attachments.map((a) =>
      a && typeof a === "object" && "contentBase64" in a ? { ...a, contentBase64: "<omitted>" } : a,
    ),
  };
}

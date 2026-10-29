import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { auditAccess } from "../../lib/audit";
import { openBytes } from "../../lib/crypto";
import { abdmEnabled, env } from "../../lib/env";
import { backoff, claimDue } from "../../lib/jobs";
import { RECORD_TYPES, RecordType } from "../records/records.schemas";
import { HIECM, hiecmPost, pushHealthData } from "./abdm.client";
import { parseCareContextReference } from "./careContexts";
import { buildDocumentBundle } from "./fhir";
import { encryptForHiu } from "./fidelius";

// Consents and health-information requests, HIP side.
//
//   ABDM --consent/request/hip/notify--> storeConsent (GRANTED / REVOKED / ...)
//   ABDM --hip/health-information/request--> acceptDataRequest (queued)
//   worker --> processDataRequests: for each care context in the consent,
//              the records in the consented date range and HI types, as
//              FHIR bundles encrypted for the HIU, POSTed to its dataPushUrl;
//              then health-information/notify with a status per care context.
//
// Only what the consent names leaves: its care contexts, its HI types, its
// date range, and nothing once it is revoked, expired or past dataEraseAt.

const MAX_ATTEMPTS = 5;

// ── Consent notification ────────────────────────────────────────────────────

export const consentNotifySchema = z.object({
  notification: z.object({
    status: z.string(),
    consentId: z.string().optional(),
    consentDetail: z
      .object({
        consentId: z.string(),
        patient: z.object({ id: z.string() }).partial().optional(),
        careContexts: z.array(z.object({ patientReference: z.string(), careContextReference: z.string() })).default([]),
        hiTypes: z.array(z.string()).default([]),
        permission: z
          .object({
            dateRange: z.object({ from: z.string(), to: z.string() }).partial().optional(),
            dataEraseAt: z.string().optional(),
          })
          .partial()
          .optional(),
      })
      .optional(),
  }),
});

const toDate = (s: string | undefined) => (s && !Number.isNaN(Date.parse(s)) ? new Date(s) : null);

/** Stores / updates the consent; returns its id (for the acknowledgement). */
export async function storeConsent(body: z.infer<typeof consentNotifySchema>): Promise<string> {
  const { status, consentDetail } = body.notification;
  const consentId = consentDetail?.consentId ?? body.notification.consentId;
  if (!consentId) throw new Error("consent notification without a consentId");

  const detail = consentDetail
    ? {
        patientId: consentDetail.patient?.id ?? null,
        careContexts: consentDetail.careContexts,
        hiTypes: consentDetail.hiTypes,
        dateFrom: toDate(consentDetail.permission?.dateRange?.from),
        dateTo: toDate(consentDetail.permission?.dateRange?.to),
        dataEraseAt: toDate(consentDetail.permission?.dataEraseAt),
      }
    : {};
  const artefact = body as unknown as Prisma.InputJsonValue;
  await prisma.abdmConsent.upsert({
    where: { consentId },
    create: { consentId, status, artefact, ...detail },
    // A revocation carries no detail - keep what the grant said.
    update: { status, artefact, ...detail },
  });
  return consentId;
}

export async function acknowledgeConsent(consentId: string, abdmRequestId: string) {
  await hiecmPost(HIECM.consentOnNotify, {
    acknowledgement: { status: "ok", consentId },
    response: { requestId: abdmRequestId },
  });
}

// ── Health-information request ──────────────────────────────────────────────

const hiRequestSchema = z.object({
  consent: z.object({ id: z.string() }),
  dateRange: z.object({ from: z.string(), to: z.string() }),
  dataPushUrl: z.url(),
  keyMaterial: z.object({
    cryptoAlg: z.string(),
    curve: z.string(),
    dhPublicKey: z.object({ expiry: z.string().optional(), parameters: z.string().optional(), keyValue: z.string() }),
    nonce: z.string(),
  }),
});
export const healthInfoRequestSchema = z.object({ transactionId: z.string(), hiRequest: hiRequestSchema });
type HiRequest = z.infer<typeof hiRequestSchema>;

/** Queues the request. Returns the session status to acknowledge with. */
export async function acceptDataRequest(body: z.infer<typeof healthInfoRequestSchema>): Promise<"ACKNOWLEDGED" | "ERRORED"> {
  const consent = await prisma.abdmConsent.findUnique({ where: { consentId: body.hiRequest.consent.id } });
  if (!consentUsable(consent)) return "ERRORED";
  // ABDM may deliver the same request twice.
  await prisma.abdmDataRequest.createMany({
    data: [{ transactionId: body.transactionId, consentId: body.hiRequest.consent.id, request: body.hiRequest as Prisma.InputJsonValue }],
    skipDuplicates: true,
  });
  return "ACKNOWLEDGED";
}

export async function acknowledgeDataRequest(transactionId: string, sessionStatus: string, abdmRequestId: string) {
  await hiecmPost(HIECM.healthInfoOnRequest, {
    hiRequest: { transactionId, sessionStatus },
    ...(sessionStatus === "ERRORED" && { error: { code: "ABDM-1000", message: "Consent is not granted or has expired." } }),
    response: { requestId: abdmRequestId },
  });
}

function consentUsable(consent: { status: string; dataEraseAt: Date | null } | null) {
  return consent?.status === "GRANTED" && (!consent.dataEraseAt || consent.dataEraseAt > new Date());
}

// ── Worker ──────────────────────────────────────────────────────────────────

export async function processDataRequests(): Promise<number> {
  if (!abdmEnabled()) return 0;
  const ids = await claimDue("dataRequests", ["RECEIVED", "PROCESSING"], 5, 300);
  for (const transactionId of ids) {
    const row = await prisma.abdmDataRequest.findUniqueOrThrow({ where: { transactionId } });
    const attempts = row.attempts + 1;
    try {
      await prisma.abdmDataRequest.update({ where: { transactionId }, data: { status: "PROCESSING", attempts } });
      const status = await transfer(transactionId, row.consentId, row.request as unknown as HiRequest);
      await prisma.abdmDataRequest.update({
        where: { transactionId },
        data: { status, completedAt: new Date(), lastError: status === "FAILED" ? "consent no longer granted" : null },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failed = attempts >= MAX_ATTEMPTS;
      logger.warn({ transactionId, attempts, failed, err: message }, "ABDM data transfer failed");
      await prisma.abdmDataRequest.update({
        where: { transactionId },
        data: { lastError: message.slice(0, 1000), status: failed ? "FAILED" : "PROCESSING", nextAttemptAt: backoff(attempts) },
      });
      if (failed) await notifyFailure(transactionId, row.consentId).catch((e) => logger.error({ err: e, transactionId }, "notify failed"));
    }
  }
  return ids.length;
}

type StatusResponse = { careContextReference: string; hiStatus: "DELIVERED" | "ERRORED"; description: string };

async function transfer(transactionId: string, consentId: string, req: HiRequest): Promise<"TRANSFERRED" | "FAILED"> {
  const consent = await prisma.abdmConsent.findUnique({ where: { consentId } });
  if (!consent || !consentUsable(consent)) {
    // Revoked / expired since the request: nothing may be sent.
    await notify(transactionId, consentId, "FAILED", []);
    return "FAILED";
  }

  // The narrower of what the HIU asked for and what the patient consented to.
  const from = latest(toDate(req.dateRange.from), consent.dateFrom);
  const to = earliest(toDate(req.dateRange.to), consent.dateTo);
  const keyExpiry = toDate(req.keyMaterial.dhPublicKey.expiry) ?? new Date(Date.now() + 3_600_000);

  const pages: { entry?: object; keyMaterial: object }[] = [];
  const statuses: StatusResponse[] = [];
  const shared: { ownerId: string; recordId: string }[] = [];

  for (const cc of consent.careContexts as { patientReference: string; careContextReference: string }[]) {
    const reference = cc.careContextReference;
    const parsed = parseCareContextReference(reference);
    const context = await prisma.abdmCareContext.findUnique({ where: { reference }, include: { abhaLink: true } });
    const link = context?.abhaLink;
    if (!parsed || !link || (link.familyMemberId ?? link.userId) !== cc.patientReference) {
      statuses.push({ careContextReference: reference, hiStatus: "ERRORED", description: "Unknown care context" });
      continue;
    }

    const hiType = RECORD_TYPES[parsed.recordType as RecordType];
    const records = consent.hiTypes.includes(hiType)
      ? await prisma.healthRecord.findMany({
          where: {
            source: parsed.source,
            recordType: parsed.recordType,
            encounterId: parsed.encounterId,
            userId: link.userId,
            familyMemberId: link.familyMemberId,
            status: { not: "ENTERED_IN_ERROR" },
            recordedAt: { ...(from && { gte: from }), ...(to && { lte: to }) },
          },
          include: { attachments: { where: { status: "STORED" }, orderBy: { createdAt: "asc" } } },
        })
      : [];

    const patient = await patientDetails(link);
    for (const record of records) {
      const bundle = JSON.stringify(
        buildDocumentBundle({
          record,
          files: record.attachments.map((a) => ({ fileName: a.fileName, contentType: a.contentType, content: openBytes(a.content!, a.encrypted) })),
          patient,
          hip: { id: env.abdm.hipId, name: env.abdm.hipName },
        }),
      );
      const sealed = encryptForHiu(bundle, req.keyMaterial, keyExpiry);
      pages.push({
        entry: {
          content: sealed.content,
          media: "application/fhir+json",
          checksum: createHash("md5").update(bundle).digest("hex"),
          careContextReference: reference,
        },
        keyMaterial: sealed.keyMaterial,
      });
      shared.push({ ownerId: link.userId, recordId: record.id });
    }
    statuses.push({
      careContextReference: reference,
      hiStatus: "DELIVERED",
      description: records.length > 0 ? `${records.length} record(s)` : "No records in the consented range",
    });
  }

  // One entry per page: each page carries its own key material (see
  // encryptForHiu). An empty transfer is still one (empty) page.
  if (pages.length === 0) {
    const { keyMaterial } = encryptForHiu("", req.keyMaterial, keyExpiry);
    pages.push({ keyMaterial });
  }
  for (const [i, page] of pages.entries()) {
    await pushHealthData(req.dataPushUrl, {
      pageNumber: i + 1,
      pageCount: pages.length,
      transactionId,
      entries: page.entry ? [page.entry] : [],
      keyMaterial: page.keyMaterial,
    });
  }

  for (const s of shared) {
    await auditAccess({
      ownerId: s.ownerId,
      actorId: consentId,
      actorRole: "ABDM",
      action: "SHARE",
      resource: "health-records",
      resourceId: s.recordId,
      requestId: transactionId,
    });
  }
  await notify(transactionId, consentId, "TRANSFERRED", statuses);
  return "TRANSFERRED";
}

async function patientDetails(link: { userId: string; familyMemberId: string | null; abhaNumber: string; name: string | null }) {
  const person = link.familyMemberId
    ? await prisma.familyMember.findUnique({ where: { id: link.familyMemberId }, select: { fullName: true, gender: true, dateOfBirth: true } })
    : await prisma.patientProfile.findUnique({ where: { userId: link.userId }, select: { fullName: true, gender: true, dateOfBirth: true } });
  return {
    reference: link.familyMemberId ?? link.userId,
    name: person?.fullName ?? link.name ?? "Patient",
    gender: person?.gender ?? null,
    birthDate: person?.dateOfBirth ?? null,
    abhaNumber: link.abhaNumber,
  };
}

async function notify(transactionId: string, consentId: string, sessionStatus: "TRANSFERRED" | "FAILED", statusResponses: StatusResponse[]) {
  await hiecmPost(HIECM.healthInfoNotify, {
    notification: {
      consentId,
      transactionId,
      doneAt: new Date().toISOString(),
      notifier: { type: "HIP", id: env.abdm.hipId },
      statusNotification: { sessionStatus, hipId: env.abdm.hipId, statusResponses },
    },
  });
}

async function notifyFailure(transactionId: string, consentId: string) {
  const consent = await prisma.abdmConsent.findUnique({ where: { consentId } });
  const contexts = (consent?.careContexts ?? []) as { careContextReference: string }[];
  await notify(
    transactionId,
    consentId,
    "FAILED",
    contexts.map((c) => ({ careContextReference: c.careContextReference, hiStatus: "ERRORED", description: "Transfer failed" })),
  );
}

const latest = (a: Date | null, b: Date | null) => (a && b ? (a > b ? a : b) : (a ?? b));
const earliest = (a: Date | null, b: Date | null) => (a && b ? (a < b ? a : b) : (a ?? b));

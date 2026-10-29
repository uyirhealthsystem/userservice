import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { abdmEnabled } from "../../lib/env";
import { backoff, claimDue } from "../../lib/jobs";
import { RECORD_TYPES, RecordType } from "../records/records.schemas";
import { AbdmRejected, HIECM, hiecmPost } from "./abdm.client";

// HIP-initiated linking. Every encounter of a person who has an ABHA becomes a
// care context, linked to that ABHA so it shows in their PHR app and can be
// requested by a doctor (HIU) with the patient's consent.
//
//   PENDING --worker--> (no link token yet: generate-token, wait for
//                        on-generate-token callback)
//           --worker--> link/carecontext --> REQUESTED
//   REQUESTED --on_carecontext ok--> LINKED
//             --on_carecontext error / no answer in 10 min--> PENDING (retry)
//   after MAX_ATTEMPTS failures --> FAILED
//
// A care context is one (source, record type, encounter): ABDM links each
// care context under a single HI type.

const MAX_ATTEMPTS = 10;
const CALLBACK_WAIT_MS = 10 * 60_000;
const TOKEN_WAIT_MS = 2 * 60_000;

export const careContextReference = (source: string, recordType: string, encounterId: string) =>
  `${source}:${recordType}:${encounterId}`;

export function parseCareContextReference(reference: string) {
  const [source, recordType, encounterId, ...rest] = reference.split(":");
  if (!source || !recordType || !encounterId || rest.length > 0) return undefined;
  return { source, recordType, encounterId };
}

// ABDM shows ABHA numbers as 91-1234-5678-9012.
export const dashedAbha = (n: string) => `${n.slice(0, 2)}-${n.slice(2, 6)}-${n.slice(6, 10)}-${n.slice(10)}`;

interface RecordForContext {
  userId: string;
  familyMemberId: string | null;
  source: string;
  encounterId: string;
  recordType: string;
  title: string;
  facilityName: string | null;
  recordedAt: Date;
}

function contextRow(abhaLinkId: string, r: RecordForContext) {
  const display = [r.title, r.facilityName, r.recordedAt.toISOString().slice(0, 10)].filter(Boolean).join(" · ");
  return {
    abhaLinkId,
    reference: careContextReference(r.source, r.recordType, r.encounterId),
    display: display.slice(0, 250),
    hiType: RECORD_TYPES[r.recordType as RecordType],
  };
}

/** Queues the record's care context for linking, if its subject has an ABHA. Idempotent. */
export async function syncCareContext(r: RecordForContext): Promise<void> {
  const link = await prisma.abhaLink.findUnique({
    where: { userId_subject: { userId: r.userId, subject: r.familyMemberId ?? "self" } },
    select: { id: true },
  });
  if (!link) return;
  await prisma.abdmCareContext.createMany({ data: [contextRow(link.id, r)], skipDuplicates: true });
}

/** A new ABHA link: queue every existing encounter of that person. */
export async function backfillCareContexts(abhaLinkId: string): Promise<void> {
  const link = await prisma.abhaLink.findUniqueOrThrow({ where: { id: abhaLinkId } });
  const records = await prisma.healthRecord.findMany({
    where: { userId: link.userId, familyMemberId: link.familyMemberId, status: { not: "ENTERED_IN_ERROR" } },
    orderBy: { recordedAt: "asc" },
  });
  if (records.length === 0) return;
  await prisma.abdmCareContext.createMany({ data: records.map((r) => contextRow(link.id, r)), skipDuplicates: true });
}

// ── Worker ──────────────────────────────────────────────────────────────────

export async function processCareContexts(): Promise<number> {
  if (!abdmEnabled()) return 0;
  const ids = await claimDue("careContexts", ["PENDING", "REQUESTED"], 50, 120);
  if (ids.length === 0) return 0;

  const rows = await prisma.abdmCareContext.findMany({ where: { id: { in: ids } }, include: { abhaLink: true } });
  const byLink = new Map<string, typeof rows>();
  for (const row of rows) byLink.set(row.abhaLinkId, [...(byLink.get(row.abhaLinkId) ?? []), row]);

  for (const contexts of byLink.values()) {
    try {
      await linkContexts(contexts);
    } catch (err) {
      await failAttempt(contexts.map((c) => c), err);
    }
  }
  return ids.length;
}

type ContextWithLink = Awaited<ReturnType<typeof prisma.abdmCareContext.findMany<{ include: { abhaLink: true } }>>>[number];

async function linkContexts(contexts: ContextWithLink[]) {
  const link = contexts[0].abhaLink;
  const ids = contexts.map((c) => c.id);

  if (!link.linkToken) {
    // One token request at a time per ABHA; its callback stores the token
    // and makes these contexts due again at once. Counted as an attempt, so
    // a callback that never comes (bridge URL wrong) ends in FAILED.
    if (link.tokenRequestedAt && Date.now() - link.tokenRequestedAt.getTime() < TOKEN_WAIT_MS) {
      await prisma.abdmCareContext.updateMany({ where: { id: { in: ids } }, data: { status: "PENDING", nextAttemptAt: new Date(Date.now() + 30_000) } });
      return;
    }
    const requestId = randomUUID();
    // Saved before the call: the callback can arrive before the call returns.
    await prisma.abhaLink.update({ where: { id: link.id }, data: { tokenRequestId: requestId, tokenRequestedAt: new Date() } });
    for (const c of contexts) {
      await prisma.abdmCareContext.update({
        where: { id: c.id },
        data: c.attempts + 1 >= MAX_ATTEMPTS
          ? { status: "FAILED", attempts: c.attempts + 1, lastError: "no link token from ABDM" }
          : { status: "PENDING", attempts: c.attempts + 1, nextAttemptAt: backoff(c.attempts + 1) },
      });
    }
    await hiecmPost(
      HIECM.generateLinkToken,
      { abhaNumber: dashedAbha(link.abhaNumber), abhaAddress: link.abhaAddress, name: link.name, gender: link.gender, yearOfBirth: link.yearOfBirth },
      { requestId },
    );
    return;
  }

  const byHiType = new Map<string, ContextWithLink[]>();
  for (const c of contexts) byHiType.set(c.hiType, [...(byHiType.get(c.hiType) ?? []), c]);

  const requestId = randomUUID();
  await prisma.abdmCareContext.updateMany({
    where: { id: { in: ids } },
    data: { status: "REQUESTED", requestId, attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + CALLBACK_WAIT_MS) },
  });
  await hiecmPost(
    HIECM.linkCareContext,
    {
      abhaNumber: dashedAbha(link.abhaNumber),
      abhaAddress: link.abhaAddress,
      patient: [...byHiType].map(([hiType, ccs]) => ({
        // Our patient id for this person: the family member id, or the
        // account's user id for the account holder.
        referenceNumber: link.familyMemberId ?? link.userId,
        display: link.name ?? "Patient",
        careContexts: ccs.map((c) => ({ referenceNumber: c.reference, display: c.display })),
        hiType,
        count: ccs.length,
      })),
    },
    { requestId, headers: { "X-LINK-TOKEN": link.linkToken } },
  );
}

async function failAttempt(contexts: { id: string; attempts: number; abhaLinkId: string }[], err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  // A 4xx on linking is most often an expired link token: get a new one.
  if (err instanceof AbdmRejected) {
    await prisma.abhaLink.update({ where: { id: contexts[0].abhaLinkId }, data: { linkToken: null, linkTokenAt: null } });
  }
  for (const c of contexts) {
    const attempts = c.attempts + 1;
    await prisma.abdmCareContext.update({
      where: { id: c.id },
      data: {
        attempts,
        lastError: message.slice(0, 1000),
        status: attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING",
        nextAttemptAt: backoff(attempts),
      },
    });
  }
  logger.warn({ abhaLinkId: contexts[0].abhaLinkId, count: contexts.length, err: message }, "care context linking failed");
}

// ── Callbacks (from abdm.callbacks.routes.ts) ───────────────────────────────

export async function onLinkToken(requestId: string, linkToken: string | undefined, error: string | undefined) {
  const link = await prisma.abhaLink.findUnique({ where: { tokenRequestId: requestId }, select: { id: true } });
  if (!link) return logger.warn({ requestId }, "on-generate-token for an unknown request");

  if (!linkToken) {
    await prisma.abhaLink.update({ where: { id: link.id }, data: { tokenRequestId: null, tokenRequestedAt: null } });
    const contexts = await prisma.abdmCareContext.findMany({ where: { abhaLinkId: link.id, status: "PENDING" } });
    return failAttempt(contexts, new Error(`generate-token: ${error ?? "no link token"}`));
  }
  await prisma.abhaLink.update({
    where: { id: link.id },
    data: { linkToken, linkTokenAt: new Date(), tokenRequestId: null, tokenRequestedAt: null },
  });
  // Link now rather than at the next backoff.
  await prisma.abdmCareContext.updateMany({ where: { abhaLinkId: link.id, status: "PENDING" }, data: { nextAttemptAt: new Date() } });
}

export async function onCareContextsLinked(requestId: string, error: string | undefined) {
  const contexts = await prisma.abdmCareContext.findMany({ where: { requestId, status: "REQUESTED" } });
  if (contexts.length === 0) return logger.warn({ requestId }, "on_carecontext for an unknown request");
  if (error) return failAttempt(contexts, new AbdmRejected(400, `link/carecontext: ${error}`));
  await prisma.abdmCareContext.updateMany({
    where: { requestId, status: "REQUESTED" },
    data: { status: "LINKED", linkedAt: new Date(), lastError: null },
  });
}

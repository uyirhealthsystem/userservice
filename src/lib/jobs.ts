import { prisma } from "./prisma";

// The background work (fetching attachments, ABDM linking, ABDM data
// transfers, Health Partner referrals) is queued in ordinary tables with
// status + nextAttemptAt. A worker claims due rows by pushing their
// nextAttemptAt out by a lease: with
// SKIP LOCKED two replicas never claim the same row, and a row whose worker
// died becomes due again when the lease runs out.

const QUEUES = {
  attachments: { table: "health_record_attachments", key: "id" },
  careContexts: { table: "abdm_care_contexts", key: "id" },
  dataRequests: { table: "abdm_data_requests", key: "transactionId" },
  referrals: { table: "patient_referrals", key: "userId" },
} as const;

export async function claimDue(
  queue: keyof typeof QUEUES,
  statuses: string[],
  limit: number,
  leaseSeconds: number,
): Promise<string[]> {
  const { table, key } = QUEUES[queue];
  const rows = await prisma.$queryRawUnsafe<{ key: string }[]>(
    `UPDATE "${table}" SET "nextAttemptAt" = now() + make_interval(secs => $3)
     WHERE "${key}" IN (
       SELECT "${key}" FROM "${table}"
       WHERE status = ANY($1::text[]) AND "nextAttemptAt" <= now()
       ORDER BY "nextAttemptAt" LIMIT $2
       FOR UPDATE SKIP LOCKED)
     RETURNING "${key}" AS key`,
    statuses,
    limit,
    leaseSeconds,
  );
  return rows.map((r) => r.key);
}

// Exponential backoff from 30s, capped at 1h.
export const backoff = (attempts: number) => new Date(Date.now() + Math.min(30_000 * 2 ** (attempts - 1), 3_600_000));

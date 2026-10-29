import { createHash } from "node:crypto";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { sealBytes } from "../../lib/crypto";
import { backoff, claimDue } from "../../lib/jobs";
import { MAX_ATTACHMENT_BYTES } from "./records.schemas";

// Copies attachments sent by URL into health_record_attachments. A file the
// producer can't serve is retried with backoff, then marked FAILED.

const MAX_ATTEMPTS = 8;
const FETCH_TIMEOUT_MS = 30_000;

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} answered ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_ATTACHMENT_BYTES) throw new Error(`file is ${declared} bytes, over the ${MAX_ATTACHMENT_BYTES} limit`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_ATTACHMENT_BYTES) throw new Error(`file is ${body.length} bytes, over the ${MAX_ATTACHMENT_BYTES} limit`);
  return body;
}

export async function fetchPendingAttachments(limit = 5): Promise<number> {
  const ids = await claimDue("attachments", ["PENDING"], limit, 120);
  for (const id of ids) {
    const row = await prisma.healthRecordAttachment.findUnique({ where: { id }, select: { sourceUrl: true, attempts: true } });
    if (!row?.sourceUrl) continue;
    const attempts = row.attempts + 1;
    try {
      const content = await download(row.sourceUrl);
      // updateMany: the row may be gone (newer record version) - then a no-op.
      await prisma.healthRecordAttachment.updateMany({
        where: { id },
        data: {
          ...sealBytes(content),
          size: content.length,
          sha256: createHash("sha256").update(content).digest("hex"),
          status: "STORED",
          attempts,
          lastError: null,
        },
      });
    } catch (err) {
      const failed = attempts >= MAX_ATTEMPTS;
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ id, attempts, failed, err: message }, "attachment fetch failed");
      await prisma.healthRecordAttachment.updateMany({
        where: { id },
        data: { attempts, lastError: message.slice(0, 1000), status: failed ? "FAILED" : "PENDING", nextAttemptAt: backoff(attempts) },
      });
    }
  }
  return ids.length;
}

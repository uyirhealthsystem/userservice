import { env } from "./lib/env";
import { logger } from "./lib/logger";
import { fetchPendingAttachments } from "./modules/records/attachments.fetcher";
import { processCareContexts } from "./modules/abdm/careContexts";
import { processDataRequests } from "./modules/abdm/dataTransfer";
import { encryptStoredAttachments, runRetention } from "./modules/privacy/retention";

// Background jobs, run in-process on an interval (retention itself at most
// hourly). Each step claims its rows with SKIP LOCKED (lib/jobs.ts) or is
// idempotent, so any number of replicas can run this.
const steps = [
  ["attachments", fetchPendingAttachments],
  ["care-contexts", processCareContexts],
  ["data-transfers", processDataRequests],
  ["encrypt-attachments", () => encryptStoredAttachments()],
  ["retention", () => runRetention()],
] as const;

export async function runWorkerOnce(): Promise<void> {
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (err) {
      logger.error({ err, step: name }, "worker step failed");
    }
  }
}

export function startWorker(): () => Promise<void> {
  let running: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (running) return; // previous round still busy
    running = runWorkerOnce().finally(() => {
      running = undefined;
    });
  }, env.abdm.workerIntervalMs);
  return async () => {
    clearInterval(timer);
    await running;
  };
}

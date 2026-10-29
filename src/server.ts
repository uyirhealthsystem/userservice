import { app } from "./app";
import { abdmEnabled, env } from "./lib/env";
import { logger } from "./lib/logger";
import { prisma } from "./lib/prisma";
import { startHealthRecordConsumer } from "./modules/records/records.consumer";
import { startWorker } from "./worker";

const server = app.listen(env.port, () => {
  logger.info(`userservice listening on port ${env.port} (${env.nodeEnv})`);
});

if (!env.gatewaySecret) {
  logger.warn("GATEWAY_SECRET is not set - x-user-id / x-user-role are trusted from any caller (development only)");
}
if (env.serviceTokens.size === 0) {
  logger.warn("INTERNAL_SERVICE_TOKENS is not set - POST /internal/v1/health-records accepts no producer");
}
if (!abdmEnabled()) {
  logger.warn("ABDM_CLIENT_ID / ABDM_CLIENT_SECRET / ABDM_HIP_ID not set - ABHA linking and ABDM sharing are off");
}
if (!env.dataEncryptionKey) {
  logger.warn("DATA_ENCRYPTION_KEY is not set - health-record files are stored unencrypted (development only)");
}
if (!env.privacy.noticeUrl || !env.privacy.grievanceOfficer.email) {
  logger.warn("PRIVACY_NOTICE_URL / GRIEVANCE_OFFICER_EMAIL not set - patients are not told where the notice is or whom to complain to (DPDP Act)");
}

const stopWorker = startWorker();
let stopConsumer: (() => Promise<void>) | undefined;
startHealthRecordConsumer()
  .then((stop) => {
    stopConsumer = stop;
  })
  .catch((err) => {
    // Without the consumer records published to Kafka would wait unread -
    // fail loudly so the orchestrator restarts us.
    logger.fatal({ err }, "health record consumer failed to start");
    process.exit(1);
  });

// Graceful shutdown: stop taking work, then close the DB pool.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutdown initiated");
  setTimeout(() => process.exit(1), 10_000).unref();
  await Promise.allSettled([stopConsumer?.(), stopWorker()]);
  server.close(async () => {
    await prisma.$disconnect();
    logger.info("shutdown complete");
    process.exit(0);
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

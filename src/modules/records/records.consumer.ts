import { Kafka, logLevel } from "kafkajs";
import { ZodError } from "zod";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import { healthRecordEnvelopeSchema, healthRecordInputSchema } from "./records.schemas";
import { IngestRejected, ingestHealthRecord, recordRejection } from "./records.ingest";

// Consumes health-records.events. A message that can never be stored (bad
// shape, unknown family member...) is recorded in health_record_rejections
// and skipped, so it can't block its partition. Anything else (database
// down) is thrown: kafkajs retries it and does not commit the offset, so no
// record is lost.
export async function handleHealthRecordMessage(value: Buffer | null): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(value?.toString("utf8") ?? "");
  } catch {
    return recordRejection("KAFKA", "INVALID: message is not JSON", null);
  }

  const envelope = healthRecordEnvelopeSchema.safeParse(raw);
  if (!envelope.success) return recordRejection("KAFKA", `INVALID: ${envelope.error.message}`, raw);

  try {
    await ingestHealthRecord(healthRecordInputSchema.parse(envelope.data.data), "KAFKA");
  } catch (err) {
    if (err instanceof ZodError) return recordRejection("KAFKA", `VALIDATION_ERROR: ${err.message}`, envelope.data.data);
    if (err instanceof IngestRejected) return recordRejection("KAFKA", `${err.code}: ${err.message}`, envelope.data.data);
    throw err;
  }
}

export async function startHealthRecordConsumer(): Promise<(() => Promise<void>) | undefined> {
  if (env.kafka.brokers.length === 0) {
    logger.warn("KAFKA_BROKERS is not set - health records arrive over HTTP only");
    return undefined;
  }

  const kafka = new Kafka({ clientId: env.kafka.clientId, brokers: env.kafka.brokers, logLevel: logLevel.WARN });
  const consumer = kafka.consumer({ groupId: env.kafka.groupId });
  await consumer.connect();
  // From the beginning the first time this group starts: records published
  // before userservice was deployed are still taken in.
  await consumer.subscribe({ topics: [env.kafka.healthRecordsTopic], fromBeginning: true });
  await consumer.run({ eachMessage: ({ message }) => handleHealthRecordMessage(message.value) });
  logger.info({ topic: env.kafka.healthRecordsTopic }, "health record consumer running");
  return () => consumer.disconnect();
}

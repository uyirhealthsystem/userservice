import { z } from "zod";

// The contract every producing service writes to - over Kafka
// (health-records.events, eventType HealthRecordPublished v1) or
// POST /internal/v1/health-records. docs/health-records.md documents it for
// producers; keep the two in step.

export const HEALTH_RECORD_SOURCES = ["LABSCAN", "ECG", "HOSPITAL", "HOMEBASEDCARE", "AMBULANCE"] as const;
export type HealthRecordSource = (typeof HEALTH_RECORD_SOURCES)[number];

// Our record types and the ABDM health-information type each is shared as.
export const RECORD_TYPES = {
  DIAGNOSTIC_REPORT: "DiagnosticReport",
  PRESCRIPTION: "Prescription",
  OP_CONSULTATION: "OPConsultation",
  DISCHARGE_SUMMARY: "DischargeSummary",
  IMMUNIZATION: "ImmunizationRecord",
  WELLNESS: "WellnessRecord",
  HEALTH_DOCUMENT: "HealthDocumentRecord",
} as const;
export type RecordType = keyof typeof RECORD_TYPES;
const RECORD_TYPE_KEYS = Object.keys(RECORD_TYPES) as [RecordType, ...RecordType[]];

// ENTERED_IN_ERROR is how a producer retracts a record: it stays stored (and
// audited) but is no longer shown or shared.
export const RECORD_STATUSES = ["FINAL", "AMENDED", "ENTERED_IN_ERROR"] as const;

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;

const text = (max: number) => z.string().trim().min(1).max(max);
// No ":" - it separates the parts of an ABDM care context reference.
const id = text(100).regex(/^[A-Za-z0-9._-]+$/, "ids may only contain letters, digits and . _ -");

const attachmentSchema = z
  .object({
    fileName: text(255),
    contentType: text(100).default("application/octet-stream"),
    // Either where we can GET the file inside the private network...
    url: z.url({ protocol: /^https?$/ }).optional(),
    // ...or the bytes themselves (HTTP channel only - Kafka messages are too
    // small for files).
    contentBase64: z.base64().optional(),
  })
  .refine((a) => (a.url === undefined) !== (a.contentBase64 === undefined), {
    message: "Send exactly one of url or contentBase64.",
  })
  .refine((a) => !a.contentBase64 || Buffer.byteLength(a.contentBase64, "base64") <= MAX_ATTACHMENT_BYTES, {
    message: `An attachment can be at most ${MAX_ATTACHMENT_BYTES} bytes.`,
  });

export const healthRecordInputSchema = z.object({
  source: z.enum(HEALTH_RECORD_SOURCES),
  // The producer's own id for this record, stable across versions.
  sourceRecordId: id,
  // Increment on every change; a version not above the stored one is ignored
  // (so re-delivery and out-of-order delivery are harmless).
  sourceVersion: z.number().int().min(1),
  // The booking / appointment / visit the record came from. Records sharing
  // it form one ABDM care context. Defaults to sourceRecordId.
  encounterId: id.optional(),
  patient: z.object({
    // authservice user id (token sub) of the account that booked.
    userId: z.uuid(),
    // Set when the care was for one of that account's family members.
    // Records for people outside the account must not be sent.
    familyMemberId: z.uuid().nullish(),
  }),
  recordType: z.enum(RECORD_TYPE_KEYS),
  status: z.enum(RECORD_STATUSES).default("FINAL"),
  title: text(200),
  summary: z.string().trim().max(5000).nullish(),
  recordedAt: z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
  facilityName: text(200).nullish(),
  practitionerName: text(200).nullish(),
  details: z.record(z.string(), z.unknown()).nullish(),
  attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS).default([]),
});
export type HealthRecordInput = z.infer<typeof healthRecordInputSchema>;

// Kafka envelope, same shape as auth.events / hospital.events.
export const HEALTH_RECORD_EVENT = "HealthRecordPublished";
export const healthRecordEnvelopeSchema = z.object({
  eventId: z.string().optional(),
  eventType: z.literal(HEALTH_RECORD_EVENT),
  eventVersion: z.literal(1),
  occurredAt: z.string(),
  data: z.unknown(),
});

// ── Patient reads ───────────────────────────────────────────────────────────

export const listRecordsQuerySchema = z.object({
  memberId: z
    .union([z.literal("self"), z.uuid("memberId must be 'self' or a family member uuid.")])
    .optional(),
  recordType: z.enum(RECORD_TYPE_KEYS).optional(),
  source: z.enum(HEALTH_RECORD_SOURCES).optional(),
  from: z.iso.datetime({ offset: true }).transform((s) => new Date(s)).optional(),
  to: z.iso.datetime({ offset: true }).transform((s) => new Date(s)).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  // recordedAt of the last item of the previous page (ISO), with its id.
  before: z.iso.datetime({ offset: true }).transform((s) => new Date(s)).optional(),
  beforeId: z.uuid().optional(),
});

export const historyQuerySchema = z.object({
  memberId: z.union([z.literal("self"), z.uuid("memberId must be 'self' or a family member uuid.")]).default("self"),
});

export const attachmentParamsSchema = z.object({ id: z.uuid(), attachmentId: z.uuid() });

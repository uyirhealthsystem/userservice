import { z } from "zod";
import { pastDate } from "../users/users.schemas";

// Request bodies for the medical-record resources. Every create takes an
// optional familyMemberId: omitted / null = the patient themself. The subject
// of a record can't be changed afterwards, so updates never take it.

const subject = { familyMemberId: z.string().uuid("familyMemberId must be a uuid.").nullish() };
const notes = z.string().trim().max(2000).nullish();
const text = (max = 200) => z.string().trim().min(1).max(max);

// "YYYY-MM-DD", any valid date (a course of medicine can start tomorrow).
const calendarDate = (field: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${field} must be YYYY-MM-DD.`)
    .transform((s) => new Date(`${s}T00:00:00.000Z`))
    .refine((d) => !Number.isNaN(d.getTime()), `${field} must be a valid date.`);

const nonEmpty = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) =>
  schema.partial().refine((b) => Object.keys(b).length > 0, "Send at least one field to update.");

// GET ?memberId=self | <family member uuid>. Omitted = every record on the
// account (self + family), each carrying its familyMemberId.
export const listQuerySchema = z.object({
  memberId: z
    .union([z.literal("self"), z.string().uuid("memberId must be 'self' or a family member uuid.")])
    .optional(),
});

// ── Conditions ──────────────────────────────────────────────────────────────
export const CONDITION_STATUSES = ["ACTIVE", "RESOLVED"] as const;
const conditionFields = z.object({
  name: text(),
  status: z.enum(CONDITION_STATUSES),
  diagnosedOn: pastDate("diagnosedOn").nullish(),
  notes,
});
export const createConditionSchema = conditionFields.extend({
  ...subject,
  status: z.enum(CONDITION_STATUSES).default("ACTIVE"),
});
export const updateConditionSchema = nonEmpty(conditionFields);

// ── Allergies ───────────────────────────────────────────────────────────────
export const ALLERGY_CATEGORIES = ["FOOD", "DRUG", "ENVIRONMENT", "OTHER"] as const;
export const ALLERGY_SEVERITIES = ["MILD", "MODERATE", "SEVERE"] as const;
const allergyFields = z.object({
  allergen: text(),
  category: z.enum(ALLERGY_CATEGORIES),
  severity: z.enum(ALLERGY_SEVERITIES).nullish(),
  reaction: text(500).nullish(),
  notes,
});
export const createAllergySchema = allergyFields.extend(subject);
export const updateAllergySchema = nonEmpty(allergyFields);

// ── Medications ─────────────────────────────────────────────────────────────
const medicationFields = z.object({
  name: text(),
  dosage: text(100).nullish(), // free text, e.g. "500 mg"
  frequency: text(200).nullish(), // free text, e.g. "twice daily after food"
  startDate: calendarDate("startDate").nullish(),
  endDate: calendarDate("endDate").nullish(),
  prescribedBy: text().nullish(),
  notes,
});
// On a PATCH this only sees the fields sent - a new endDate is not checked
// against a startDate already stored.
const endNotBeforeStart = (b: { startDate?: Date | null; endDate?: Date | null }) =>
  !b.startDate || !b.endDate || b.endDate >= b.startDate;
const endDateMessage = { message: "endDate cannot be before startDate.", path: ["endDate"] };
export const createMedicationSchema = medicationFields.extend(subject).refine(endNotBeforeStart, endDateMessage);
export const updateMedicationSchema = nonEmpty(medicationFields).refine(endNotBeforeStart, endDateMessage);

// ── Vitals ──────────────────────────────────────────────────────────────────
// A reading is a measurement: recorded once, deleted if wrong, never edited.
// The unit is fixed per type so readings stay comparable over time.
export const VITAL_UNITS = {
  BLOOD_PRESSURE: "mmHg",
  HEART_RATE: "bpm",
  BLOOD_SUGAR: "mg/dL",
  SPO2: "%",
  TEMPERATURE: "°C",
  WEIGHT: "kg",
  HEIGHT: "cm",
} as const;
export type VitalType = keyof typeof VITAL_UNITS;
const VITAL_TYPES = Object.keys(VITAL_UNITS) as [VitalType, ...VitalType[]];

export const createVitalSchema = z
  .object({
    ...subject,
    type: z.enum(VITAL_TYPES),
    value: z.number().positive().max(1000),
    // Diastolic, for BLOOD_PRESSURE only.
    secondaryValue: z.number().positive().max(1000).nullish(),
    // ISO 8601 with offset; defaults to now.
    measuredAt: z.iso
      .datetime({ offset: true })
      .transform((s) => new Date(s))
      .refine((d) => d <= new Date(), "measuredAt cannot be in the future.")
      .optional(),
    notes,
  })
  .refine((b) => (b.type === "BLOOD_PRESSURE") === (b.secondaryValue != null), {
    message: "secondaryValue (diastolic) is required for BLOOD_PRESSURE and not allowed for other types.",
    path: ["secondaryValue"],
  })
  .transform((b) => ({ ...b, unit: VITAL_UNITS[b.type], measuredAt: b.measuredAt ?? new Date() }));

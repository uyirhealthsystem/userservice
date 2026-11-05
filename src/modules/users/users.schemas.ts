import { z } from "zod";
import { selfConsentSchema } from "../privacy/privacy.schemas";

export const GENDERS = ["MALE", "FEMALE", "OTHER"] as const;
export const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"] as const;

// "YYYY-MM-DD", not in the future. Stored in a DATE column.
export const pastDate = (field: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${field} must be YYYY-MM-DD.`)
    .transform((s) => new Date(`${s}T00:00:00.000Z`))
    .refine((d) => !Number.isNaN(d.getTime()) && d <= new Date(), `${field} must be a valid past date.`);

// Fields shared by the patient's own profile and a family member.
export const personFields = {
  fullName: z.string().trim().min(1, "fullName is required.").max(200),
  dateOfBirth: pastDate("dateOfBirth").nullish(),
  gender: z.enum(GENDERS).nullish(),
  phone: z.string().trim().min(5).max(20).nullish(),
  bloodGroup: z.enum(BLOOD_GROUPS).nullish(),
  district: z.string().trim().min(1).max(100).nullish(),
  pinCode: z
    .string()
    .trim()
    .regex(/^[1-9]\d{5}$/, "pinCode must be a 6-digit PIN code.")
    .nullish(),
};

// Stored trimmed and lower-cased so one address is one value.
const email = z.preprocess(
  (v) => (typeof v === "string" ? v.trim().toLowerCase() : v),
  z
    .email({ error: (iss) => (iss.input == null ? "email is required." : "email must be a valid email address.") })
    .max(200),
);

// POST /api/v1/users/me (create) and PUT /api/v1/users/me/profile (replace).
// email is optional here; POST /me requires it (onboardingSchema).
export const profileSchema = z.object({
  ...personFields,
  email: email.nullish(),
  address: z.string().trim().max(500).nullish(),
});

// A Health Partner's referral code (docs/referrals.md), only when the profile
// is created. Optional: empty or null = none. Matched case-insensitively by
// the HP service.
export const referralCodeSchema = z.preprocess(
  (v) => (typeof v === "string" ? v.trim() || undefined : (v ?? undefined)),
  z.string().max(30, "referralCode is at most 30 characters.").optional(),
);

// POST /api/v1/users/me: the profile plus consent to the privacy notice -
// nothing is stored without it (DPDP Act). PUT /me/profile takes the same
// consent when it creates the profile (old apps onboard that way).
// email is required here: every new profile has one.
export const onboardingSchema = profileSchema.extend({
  email: z.preprocess((v) => v ?? undefined, email),
  consent: selfConsentSchema,
  referralCode: referralCodeSchema,
});
export const replaceProfileSchema = profileSchema.extend({
  consent: selfConsentSchema.optional(),
  referralCode: referralCodeSchema,
});

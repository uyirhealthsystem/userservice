import { z } from "zod";
import { personFields } from "../users/users.schemas";
import { memberConsentSchema } from "../privacy/privacy.schemas";

export const RELATIONSHIPS = [
  "SPOUSE",
  "FATHER",
  "MOTHER",
  "SON",
  "DAUGHTER",
  "BROTHER",
  "SISTER",
  "GRANDPARENT",
  "GRANDCHILD",
  "OTHER",
] as const;

const memberFields = z.object({
  ...personFields,
  relationship: z.enum(RELATIONSHIPS),
});

// POST /api/v1/users/me/family-members - with the consent for this person
// (DPDP Act): their own, or a parent's / guardian's for a child.
export const createFamilyMemberSchema = memberFields.extend({ consent: memberConsentSchema });

// PATCH /api/v1/users/me/family-members/:id - any subset of fields.
export const updateFamilyMemberSchema = memberFields
  .partial()
  .refine((b) => Object.keys(b).length > 0, "Send at least one field to update.");

export const idParamSchema = z.object({
  id: z.string().uuid("An id (uuid) is required."),
});

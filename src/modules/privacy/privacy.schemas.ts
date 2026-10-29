import { z } from "zod";

export const PURPOSES = ["CARE", "ABDM_SHARING"] as const;
export type Purpose = (typeof PURPOSES)[number];
export const MEMBER_BASES = ["MEMBER_CONSENTED", "PARENT_OR_GUARDIAN"] as const;

const memberId = z.union([z.literal("self"), z.uuid("memberId must be 'self' or a family member uuid.")]).default("self");
const noticeVersion = z.string().trim().min(1, "noticeVersion is required.").max(50);

// The holder's own consent, also sent inside POST /me (onboarding).
export const selfConsentSchema = z.object({
  noticeVersion,
  // The holder confirms they are 18 or older (DPDP s.9 - a child's data needs
  // a parent's consent instead).
  adultDeclaration: z.literal(true, "Confirm you are 18 or older (adultDeclaration: true)."),
});

// Sent inside POST /me/family-members.
export const memberConsentSchema = z.object({
  noticeVersion,
  basis: z.enum(MEMBER_BASES),
});

// POST /me/consents
export const grantConsentSchema = z
  .object({
    purpose: z.enum(PURPOSES),
    memberId,
    noticeVersion,
    basis: z.enum(MEMBER_BASES).optional(),
    adultDeclaration: z.literal(true).optional(),
  })
  .refine((b) => b.memberId !== "self" || b.adultDeclaration === true, {
    message: "Confirm you are 18 or older (adultDeclaration: true).",
    path: ["adultDeclaration"],
  })
  .refine((b) => b.memberId === "self" || b.basis !== undefined, {
    message: `basis (${MEMBER_BASES.join(" | ")}) is required for a family member.`,
    path: ["basis"],
  });

// DELETE /me/consents/:purpose?memberId=
export const withdrawConsentSchema = z.object({ purpose: z.enum(PURPOSES), memberId });

// GET /me/access-log - newest first, keyset pagination on (at, id).
export const accessLogQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before: z.coerce.date().optional(),
    beforeId: z.uuid().optional(),
  })
  .refine((q) => (q.before === undefined) === (q.beforeId === undefined), "before and beforeId go together.");

// DELETE /me
export const eraseSchema = z.object({
  confirm: z.literal("DELETE_MY_DATA", 'Send { "confirm": "DELETE_MY_DATA" } to erase your data.'),
});

// PUT /me/nominee
export const nomineeSchema = z.object({
  fullName: z.string().trim().min(1, "fullName is required.").max(200),
  relationship: z.string().trim().min(1).max(50),
  phone: z.string().trim().min(5).max(20),
  email: z.email().max(200).nullish(),
});

import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/asyncHandler";
import { audit } from "../../lib/audit";
import { isValidAadhaar } from "./aadhaarConsent";
import {
  addressSuggestions,
  cancelEnrolment,
  chooseAddress,
  consentText,
  sendMobileOtp,
  startEnrolment,
  verifyAadhaar,
  verifyMobile,
} from "./abhaEnrolment.service";

// ABHA creation by Aadhaar OTP (docs/abha-creation.md). Optional, after the
// profile exists - profile creation never depends on it. Mounted behind
// gatewayIdentity(PATIENT) + requireUser + requireConsent, ahead of
// abhaRouter so "/me/abha/create" is not taken for an ABHA link id.
export const abhaEnrolmentRouter = Router();

const BASE = "/me/abha/create";

// Phase 1: "self" only; anything else is refused by the service with a clear code.
const memberId = z.union([z.literal("self"), z.uuid("memberId must be 'self' or a family member uuid.")]).default("self");
const otp = z.string().trim().regex(/^\d{6}$/, "otp must be 6 digits.");

const aadhaarOtpSchema = z.object({
  memberId,
  // Messages never include the value - zod reports the path and message only.
  aadhaar: z
    .string()
    .transform((s) => s.replace(/[\s-]/g, ""))
    .refine(isValidAadhaar, "aadhaar must be a valid 12-digit Aadhaar number."),
  consent: z.object({
    accepted: z.literal(true, "The Aadhaar consent must be accepted."),
    version: z.string().trim().min(1),
  }),
});

const aadhaarVerifySchema = z.object({
  memberId,
  otp,
  // Defaults to the profile's phone.
  mobile: z
    .string()
    .trim()
    .regex(/^[6-9]\d{9}$/, "mobile must be a 10-digit Indian mobile number.")
    .optional(),
});

const memberOnlySchema = z.object({ memberId });
const mobileVerifySchema = z.object({ memberId, otp });

// ABDM's ABHA address rules: 8-18 characters, letters and digits, at most one
// "." or "_" and not at either end. Without the "@sbx" / "@abdm" suffix.
const addressSchema = z.object({
  memberId,
  abhaAddress: z
    .string()
    .trim()
    .regex(
      /^(?=.{8,18}$)[a-zA-Z0-9]+(?:[._][a-zA-Z0-9]+)?$/,
      "abhaAddress must be 8-18 letters or digits, with at most one '.' or '_' (not at the start or end), without the @ suffix.",
    ),
});

abhaEnrolmentRouter.get(`${BASE}/consent-text`, (_req, res) => {
  res.status(200).json(consentText());
});

abhaEnrolmentRouter.post(
  `${BASE}/aadhaar/otp`,
  asyncHandler(async (req, res) => {
    const body = aadhaarOtpSchema.parse(req.body);
    const { expiresAt } = await startEnrolment(req.auth!.userId, body.memberId, body.aadhaar, body.consent.version);
    res.status(200).json({ message: "OTP sent to the mobile number linked with this Aadhaar.", expiresAt });
  }),
);

abhaEnrolmentRouter.post(
  `${BASE}/aadhaar/verify`,
  asyncHandler(async (req, res) => {
    const body = aadhaarVerifySchema.parse(req.body);
    const result = await verifyAadhaar(req.auth!.userId, body.memberId, body.otp, body.mobile);
    await audit(req, "CREATE", "abha-link", result.abhaLink.id);
    res.status(201).json(result);
  }),
);

abhaEnrolmentRouter.post(
  `${BASE}/mobile/otp`,
  asyncHandler(async (req, res) => {
    const body = memberOnlySchema.parse(req.body ?? {});
    const { expiresAt } = await sendMobileOtp(req.auth!.userId, body.memberId);
    res.status(200).json({ message: "OTP sent to the mobile number for this ABHA.", expiresAt });
  }),
);

abhaEnrolmentRouter.post(
  `${BASE}/mobile/verify`,
  asyncHandler(async (req, res) => {
    const body = mobileVerifySchema.parse(req.body);
    res.status(200).json(await verifyMobile(req.auth!.userId, body.memberId, body.otp));
  }),
);

abhaEnrolmentRouter.get(
  `${BASE}/address-suggestions`,
  asyncHandler(async (req, res) => {
    const { memberId: subject } = memberOnlySchema.parse(req.query);
    res.status(200).json(await addressSuggestions(req.auth!.userId, subject));
  }),
);

abhaEnrolmentRouter.post(
  `${BASE}/address`,
  asyncHandler(async (req, res) => {
    const body = addressSchema.parse(req.body);
    const abhaLink = await chooseAddress(req.auth!.userId, body.memberId, body.abhaAddress);
    await audit(req, "UPDATE", "abha-link", abhaLink.id);
    res.status(200).json({ abhaLink });
  }),
);

abhaEnrolmentRouter.delete(
  BASE,
  asyncHandler(async (req, res) => {
    const { memberId: subject } = memberOnlySchema.parse(req.query);
    await cancelEnrolment(req.auth!.userId, subject);
    res.status(204).end();
  }),
);

import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/asyncHandler";
import { idParamSchema } from "../family/family.schemas";
import { listAbhaLinks, sendAbhaOtp, unlinkAbha, verifyAbhaOtp } from "./abha.service";

// The patient links an ABHA to themself or a family member by OTP. Mounted
// behind gatewayIdentity(PATIENT) + requireUser.
export const abhaRouter = Router();

const memberId = z.union([z.literal("self"), z.uuid("memberId must be 'self' or a family member uuid.")]).default("self");

const otpRequestSchema = z.object({
  memberId,
  // 14 digits, with or without the dashes (91-1234-5678-9012).
  abhaNumber: z.string().trim().regex(/^\d{2}-?\d{4}-?\d{4}-?\d{4}$/, "abhaNumber must be 14 digits."),
  otpMethod: z.enum(["abdm", "aadhaar"]).default("abdm"),
});

const otpVerifySchema = z.object({ memberId, otp: z.string().trim().regex(/^\d{6}$/, "otp must be 6 digits.") });

abhaRouter.get(
  "/me/abha",
  asyncHandler(async (req, res) => {
    res.status(200).json({ abhaLinks: await listAbhaLinks(req.auth!.userId) });
  }),
);

abhaRouter.post(
  "/me/abha/otp",
  asyncHandler(async (req, res) => {
    const body = otpRequestSchema.parse(req.body);
    const { expiresAt } = await sendAbhaOtp(req.auth!.userId, body.memberId, body.abhaNumber, body.otpMethod);
    res.status(200).json({ message: "OTP sent to the mobile number registered with this ABHA.", expiresAt });
  }),
);

abhaRouter.post(
  "/me/abha/verify",
  asyncHandler(async (req, res) => {
    const body = otpVerifySchema.parse(req.body);
    res.status(201).json({ abhaLink: await verifyAbhaOtp(req.auth!.userId, body.memberId, body.otp) });
  }),
);

abhaRouter.delete(
  "/me/abha/:id",
  asyncHandler(async (req, res) => {
    const { id } = idParamSchema.parse(req.params);
    await unlinkAbha(req.auth!.userId, id);
    res.status(204).end();
  }),
);

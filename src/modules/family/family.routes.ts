import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import { internalUserId } from "../../middleware/gatewayIdentity";
import { createFamilyMemberSchema, updateFamilyMemberSchema, idParamSchema } from "./family.schemas";
import {
  listFamilyMembers,
  listConsentedFamilyMembers,
  createFamilyMember,
  updateFamilyMember,
  deleteFamilyMember,
} from "./family.service";

// The caller's family members. Mounted behind gatewayIdentity(PATIENT) +
// requireUser, so the patient has created their profile first.
export const familyRouter = Router();

familyRouter.get(
  "/me/family-members",
  asyncHandler(async (req, res) => {
    res.status(200).json({ familyMembers: await listFamilyMembers(req.auth!.userId) });
  }),
);

familyRouter.post(
  "/me/family-members",
  asyncHandler(async (req, res) => {
    const body = createFamilyMemberSchema.parse(req.body);
    res.status(201).json({ familyMember: await createFamilyMember(req.auth!.userId, body, req.header("x-request-id") ?? null) });
  }),
);

familyRouter.patch(
  "/me/family-members/:id",
  asyncHandler(async (req, res) => {
    const { id } = idParamSchema.parse(req.params);
    const body = updateFamilyMemberSchema.parse(req.body);
    res.status(200).json({ familyMember: await updateFamilyMember(req.auth!.userId, id, body) });
  }),
);

familyRouter.delete(
  "/me/family-members/:id",
  asyncHandler(async (req, res) => {
    const { id } = idParamSchema.parse(req.params);
    await deleteFamilyMember(req.auth!.userId, id);
    res.status(204).end();
  }),
);

// Service-to-service: homebasedcare reads a patient's family members while
// creating a FAMILY_MEMBER booking (AuthServiceFamilyMembers.java). Same
// member shape as GET /me/family-members. A patient who has not onboarded simply
// has none, so no requireUser. Only members with CARE consent are shared.
export const internalFamilyRouter = Router();

internalFamilyRouter.get(
  "/family-members",
  internalUserId,
  asyncHandler(async (req, res) => {
    res.status(200).json({ familyMembers: await listConsentedFamilyMembers(req.auth!.userId) });
  }),
);

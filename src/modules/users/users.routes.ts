import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import { onboardingSchema, replaceProfileSchema } from "./users.schemas";
import { getMe, createMe, getProfile, replaceProfile } from "./users.service";

// The patient's own user record + profile. "me" = the caller; a patient never
// addresses another patient's data. Mounted behind gatewayIdentity(PATIENT).
export const usersRouter = Router();

const requestId = (header: string | undefined) => header ?? null;

usersRouter.get(
  "/me",
  asyncHandler(async (req, res) => {
    res.status(200).json(await getMe(req.auth!.userId));
  }),
);

usersRouter.post(
  "/me",
  asyncHandler(async (req, res) => {
    const { consent, ...profile } = onboardingSchema.parse(req.body);
    res.status(201).json(await createMe(req.auth!.userId, profile, consent, requestId(req.header("x-request-id"))));
  }),
);

usersRouter.get(
  "/me/profile",
  asyncHandler(async (req, res) => {
    res.status(200).json({ profile: await getProfile(req.auth!.userId) });
  }),
);

usersRouter.put(
  "/me/profile",
  asyncHandler(async (req, res) => {
    const { consent, ...body } = replaceProfileSchema.parse(req.body);
    const { profile, created } = await replaceProfile(req.auth!.userId, body, consent, requestId(req.header("x-request-id")));
    res.status(created ? 201 : 200).json({ profile });
  }),
);

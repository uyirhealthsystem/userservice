import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/asyncHandler";
import { serviceAuth } from "../../middleware/gatewayIdentity";
import { getUserForService } from "./users.service";

// GET /internal/v1/users/:userId - other services (hospital, ecg, labscan,
// homebasedcare...) read one patient by their authservice user id. Mounted at
// /internal/v1, which the api-gateway never forwards, and only with the
// caller's own INTERNAL_SERVICE_TOKENS bearer token - a patient cannot use it
// to read someone else.
export const internalUsersRouter = Router();

const params = z.object({ userId: z.string().uuid() });

internalUsersRouter.get(
  "/users/:userId",
  serviceAuth,
  asyncHandler(async (req, res) => {
    const { userId } = params.parse(req.params);
    res.status(200).json(await getUserForService(userId, res.locals.source as string, req.header("x-request-id") ?? null));
  }),
);

import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/asyncHandler";
import { serviceName } from "../../middleware/gatewayIdentity";
import { getUserForService, SERVICE_PROFILE_FIELDS, SERVICE_USER_FIELDS } from "./users.service";

// GET /internal/v1/users/:userId - other services (hospital, ecg, labscan,
// homebasedcare...) read one patient by their authservice user id. Mounted at
// /internal/v1, which the api-gateway never forwards. No token - only the
// network keeps outsiders away. X-Service-Name names the caller in the audit.
export const internalUsersRouter = Router();

const params = z.object({ userId: z.string().uuid() });

// ?fields=fullName,age,gender,phone - comma-separated; an unknown name or an
// empty list is a 400. Omitted: every field.
const fieldName = z.enum([...SERVICE_USER_FIELDS, ...SERVICE_PROFILE_FIELDS]);
const query = z.object({
  fields: z
    .string()
    .transform((v) => [...new Set(v.split(",").map((f) => f.trim()).filter(Boolean))])
    .pipe(z.array(fieldName).min(1))
    .optional(),
});

internalUsersRouter.get(
  "/users/:userId",
  serviceName,
  asyncHandler(async (req, res) => {
    const { userId } = params.parse(req.params);
    const { fields } = query.parse(req.query);
    const requestId = req.header("x-request-id") ?? null;
    res.status(200).json(await getUserForService(userId, res.locals.source as string, requestId, fields));
  }),
);

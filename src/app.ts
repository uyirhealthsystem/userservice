import express, { Router } from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { logger } from "./lib/logger";
import { USERS_API_PREFIX, PATIENT_ROLE, INTERNAL_API_PREFIX, ABDM_BRIDGE_PREFIX } from "./lib/constants";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { gatewayIdentity } from "./middleware/gatewayIdentity";
import { requireUser } from "./middleware/requireUser";
import { healthRouter } from "./modules/health/health.routes";
import { usersRouter } from "./modules/users/users.routes";
import { familyRouter, internalFamilyRouter } from "./modules/family/family.routes";
import { medicalRouter } from "./modules/medical/medical.routes";
import { recordsRouter } from "./modules/records/records.routes";
import { internalRecordsRouter } from "./modules/records/records.internal.routes";
import { internalUsersRouter } from "./modules/users/users.internal.routes";
import { abhaRouter } from "./modules/abdm/abha.routes";
import { abhaEnrolmentRouter } from "./modules/abdm/abhaEnrolment.routes";
import { abdmCallbacksRouter } from "./modules/abdm/abdm.callbacks.routes";
import { privacyRouter, requireConsent } from "./modules/privacy/privacy.routes";

export const app = express();

app.use(helmet());
// No CORS here: browsers only reach us through the api-gateway, which owns
// the origin allowlist (CORS_ALLOWED_ORIGINS).
app.use(pinoHttp({ logger }));

// Producing services push health records here (service token, own body
// limit) - ahead of the app-wide JSON parser.
app.use(INTERNAL_API_PREFIX, internalRecordsRouter);
// ...and read a patient by id (same service tokens).
app.use(INTERNAL_API_PREFIX, internalUsersRouter);

app.use(express.json({ limit: "1mb" }));

app.use(healthRouter);

// ABDM calls us back here (ABDM-signed JWT, no user).
app.use(ABDM_BRIDGE_PREFIX, abdmCallbacksRouter);

// Service-to-service reads (other services call these with only X-User-Id) -
// mounted ahead of the patient guard.
app.use(USERS_API_PREFIX, internalFamilyRouter);

// Patient API. /me and /me/profile work before onboarding - that is how a
// patient creates their profile. The privacy controls (notice, consents,
// access log, export, erasure) work at any time. Medical data needs the
// profile and consent to the current privacy notice (DPDP Act).
const DATA_PATHS = ["/me/family-members", "/me/medical", "/me/health-records", "/me/medical-history", "/me/abha"];
const patientApi = Router();
patientApi.use(gatewayIdentity(PATIENT_ROLE));
patientApi.use(usersRouter);
patientApi.use("/me/nominee", requireUser);
patientApi.use(privacyRouter);
patientApi.use(DATA_PATHS, requireUser, requireConsent);
patientApi.use(familyRouter, medicalRouter, recordsRouter, abhaEnrolmentRouter, abhaRouter);
app.use(USERS_API_PREFIX, patientApi);

app.use(notFoundHandler);
app.use(errorHandler);

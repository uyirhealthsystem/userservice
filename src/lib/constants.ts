// Every userservice route (except /health) lives under this prefix. The
// gateway forwards /api/v1/users/* unchanged, and rewrites the deprecated
// /api/v1/auth/patients/* paths onto it (see api-gateway services.ts).
export const USERS_API_PREFIX = "/api/v1/users";

// Service-to-service writes (health records from other services). Not under
// /api/v1/users, so the gateway never forwards anything here.
export const INTERNAL_API_PREFIX = "/internal/v1";

// ABDM's callbacks. The gateway forwards /abdm/* here without a user token;
// the bridge URL registered with ABDM is https://<gateway host>/abdm.
export const ABDM_BRIDGE_PREFIX = "/abdm";

// Only patients have a user record today. Other roles get 403.
export const PATIENT_ROLE = "PATIENT";

export const formatPatientNumber = (patientNo: number) => `UYR-${String(patientNo).padStart(7, "0")}`;

import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

const nodeEnv = optional("NODE_ENV", "development");

export const env = {
  nodeEnv,
  port: Number(optional("PORT", "8089")),
  logLevel: optional("LOG_LEVEL", "info"),

  databaseUrl: required("DATABASE_URL"),

  // Sent by the api-gateway as x-gateway-secret (its USER_GATEWAY_SECRET).
  // Only with it do we believe x-user-id / x-user-role. Required in
  // production; when unset elsewhere the headers are trusted as-is so the
  // service can be run and tested without the gateway.
  gatewaySecret: process.env.GATEWAY_SECRET || undefined,

  // Unset = no Kafka consumer (records then arrive over HTTP only).
  kafka: {
    brokers: (process.env.KAFKA_BROKERS ?? "").split(",").map((b) => b.trim()).filter(Boolean),
    clientId: optional("KAFKA_CLIENT_ID", "userservice"),
    groupId: optional("KAFKA_GROUP_ID", "userservice"),
    healthRecordsTopic: optional("HEALTH_RECORDS_TOPIC", "health-records.events"),
  },

  // ABDM: ABHA verification (ABHA v3 APIs) and our Health Information
  // Provider bridge (HIE-CM v3 APIs). Defaults point at the sandbox; same
  // client credentials as pro's. Enabled only with credentials and a HIP id.
  abdm: {
    gatewayUrl: optional("ABDM_GATEWAY_URL", "https://dev.abdm.gov.in"),
    abhaUrl: optional("ABDM_ABHA_URL", "https://abhasbx.abdm.gov.in"),
    cmId: optional("ABDM_CM_ID", "sbx"),
    clientId: process.env.ABDM_CLIENT_ID ?? "",
    clientSecret: process.env.ABDM_CLIENT_SECRET ?? "",
    // Our facility's id in the Health Facility Registry, registered as a HIP.
    hipId: process.env.ABDM_HIP_ID ?? "",
    hipName: optional("ABDM_HIP_NAME", "Uyir"),
    // JWKS ABDM signs its callbacks with. "off" disables verification
    // (refused in production).
    certsUrl: process.env.ABDM_CERTS_URL ?? "",
    verifyCallbacks: process.env.ABDM_VERIFY_CALLBACKS !== "off",
    // Background linking / data-transfer worker poll interval.
    workerIntervalMs: Number(optional("ABDM_WORKER_INTERVAL_MS", "5000")),
  },

  // DPDP Act: the privacy notice the patient consents to, and whom they
  // complain to. Bump PRIVACY_NOTICE_VERSION whenever the notice changes -
  // every patient is then asked to consent again.
  privacy: {
    noticeVersion: optional("PRIVACY_NOTICE_VERSION", "1"),
    noticeUrl: process.env.PRIVACY_NOTICE_URL ?? "",
    grievanceOfficer: {
      name: process.env.GRIEVANCE_OFFICER_NAME ?? "",
      email: process.env.GRIEVANCE_OFFICER_EMAIL ?? "",
      phone: process.env.GRIEVANCE_OFFICER_PHONE ?? "",
    },
  },

  // AES-256 key (base64, 32 bytes) health-record files are encrypted with.
  // Required in production; unset elsewhere = files stored as received.
  dataEncryptionKey: parseKey(process.env.DATA_ENCRYPTION_KEY),

  // How long data is kept once it has no further use (retention.ts).
  retentionDays: {
    rejections: Number(optional("RETENTION_REJECTIONS_DAYS", "30")),
    abdmTransactions: Number(optional("RETENTION_ABDM_DAYS", "30")),
    // Provider records of someone who never created a profile (or erased it).
    orphanRecords: Number(optional("RETENTION_ORPHAN_RECORDS_DAYS", "365")),
    // Access audit and withdrawn consents - kept as evidence, at least the
    // year the DPDP Rules ask for.
    auditAndConsents: Number(optional("RETENTION_AUDIT_DAYS", "1095")),
  },
};

export const isProduction = env.nodeEnv === "production";

export const abdmEnabled = () => Boolean(env.abdm.clientId && env.abdm.clientSecret && env.abdm.hipId);

function parseKey(raw: string | undefined): Buffer | undefined {
  if (!raw) return undefined;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must be 32 bytes, base64 (openssl rand -base64 32)");
  return key;
}

if (isProduction && !env.dataEncryptionKey) {
  throw new Error("Missing required env var: DATA_ENCRYPTION_KEY (required when NODE_ENV=production)");
}
if (env.retentionDays.auditAndConsents < 365) {
  throw new Error("RETENTION_AUDIT_DAYS must be at least 365 (DPDP Rules keep logs for a year)");
}
if (isProduction && !env.gatewaySecret) {
  throw new Error("Missing required env var: GATEWAY_SECRET (required when NODE_ENV=production)");
}
if (isProduction && !env.abdm.verifyCallbacks) {
  throw new Error("ABDM_VERIFY_CALLBACKS=off is not allowed when NODE_ENV=production");
}

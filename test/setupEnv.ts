import { existsSync } from "node:fs";
import { config } from "dotenv";
import { afterAll } from "vitest";

// Load .env.test when present (local runs). CI injects the vars directly.
// Never override an already-set var.
if (existsSync(".env.test")) {
  config({ path: ".env.test" });
}

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL ??= "silent";
// The suite plays the gateway: it sends this as x-gateway-secret.
process.env.GATEWAY_SECRET ??= "test-gateway-secret-test-gateway-secret";
// ...and ABDM (test/fakeAbdm.ts answers on these hosts). Callback signatures
// are switched on per test.
process.env.ABDM_GATEWAY_URL = "https://abdm.test";
process.env.ABDM_ABHA_URL = "https://abha.test";
process.env.ABDM_CLIENT_ID = "test-client";
process.env.ABDM_CLIENT_SECRET = "test-secret";
process.env.ABDM_HIP_ID = "UYIR-HIP-TEST";
process.env.ABDM_VERIFY_CALLBACKS = "off";
// Health-record files are encrypted at rest.
process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
delete process.env.KAFKA_BROKERS;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Create .env.test (see .env.test.example) or export it.");
}

afterAll(async () => {
  const { prisma } = await import("../src/lib/prisma");
  await prisma.$disconnect();
});

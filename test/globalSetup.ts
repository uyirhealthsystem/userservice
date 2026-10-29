import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { config } from "dotenv";

// Runs once, before any test file: brings the test database up to the
// current schema.
export default async function () {
  if (existsSync(".env.test")) config({ path: ".env.test" });
  execSync("npx prisma migrate deploy", { stdio: "inherit", env: { ...process.env, NODE_ENV: "test" } });
}

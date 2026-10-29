import { defineConfig } from "vitest/config";

// The suite talks to a real Postgres (unique constraints, cascades,
// transactions). Set DATABASE_URL to a throwaway test database - see
// .env.test.example.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setupEnv.ts"],
    globalSetup: ["test/globalSetup.ts"],
    // One process, one file at a time: every test shares the same Postgres
    // and truncates between cases.
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});

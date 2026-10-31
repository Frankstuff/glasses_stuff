import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    // sharp imports JSON, which Node 22 before 22.12 warns about on every test file
    execArgv: ["--disable-warning=ExperimentalWarning"],
  },
});

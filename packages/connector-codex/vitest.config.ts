import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "connector-codex",
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    /**
     * These suites spawn real `node` children — the replayed app-server and
     * the probe's one-shot runs — while the gate runs every package's files
     * in parallel on the same machine. Nothing here waits on a clock, so a
     * generous ceiling costs a passing run nothing on a loaded laptop and only
     * changes how long a genuinely wedged test takes to say so.
     */
    testTimeout: 30_000,
  },
});

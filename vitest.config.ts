import { defineConfig } from "vitest/config";

/**
 * Perf gates (tests/perf/*) time real work; parallel test-file workers
 * contend for CPU and inflate every measurement (a 300-villager p95 of
 * ~2.5 ms alone reads ~15 ms next to a busy worker). Serializing FILE
 * execution keeps the §7 budget assertions honest; the whole suite
 * stays far under its 60 s wall-clock requirement (SPEC §7).
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});

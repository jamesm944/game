import { defineConfig } from "vitest/config";

/**
 * Perf gates (tests/perf/*) time real work; parallel test-file workers
 * contend for CPU and inflate every measurement (a 300-villager p95 of
 * ~2.5 ms alone reads ~15 ms next to a busy worker). Serializing FILE
 * execution keeps the §7 budget assertions honest; the whole suite
 * stays far under its 60 s wall-clock requirement (SPEC §7).
 */
export default defineConfig({
  assetsInclude: ["**/*.gltf", "**/*.glb"],
  test: {
    fileParallelism: false,
    // Donor-audit clones under scratch/ are quarantined reference trees
    // (third_party/manifest.json, E0/#192) — their 580 test files are
    // not part of this project's gate and must never be collected.
    // unity/ and "My project/" are Unity workspaces, likewise excluded.
    // (First entries preserve vitest's default excludes.)
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "scratch/**",
      "unity/**",
      "My project/**",
    ],
  },
});

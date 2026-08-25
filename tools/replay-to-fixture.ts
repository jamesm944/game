/**
 * `npm run replay:to-fixture <file> <name>` — SPEC §2.12 / M5-T3
 * (issue #65).
 *
 * Converts a user-attached `.ageofreplay` bug replay into a permanent,
 * bisectable golden fixture at tests/golden/<name>/ (case.json +
 * generated golden.test.ts). See src/game/replayFixture.ts for the
 * file-building core; this CLI only parses args, reads/writes, and
 * prints the follow-up instructions.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildGoldenFixtureFiles } from "../src/game/replayFixture";

function usage(): never {
  console.error(
    "usage: npm run replay:to-fixture -- <exported.ageofreplay> <bug-name>",
  );
  process.exit(2);
}

const [, , fileArg, nameArg] = process.argv;
if (typeof fileArg !== "string" || typeof nameArg !== "string") usage();

const sourcePath = resolve(fileArg);
if (!existsSync(sourcePath)) {
  console.error(`replay file not found: ${sourcePath}`);
  process.exit(1);
}

let raw: unknown;
try {
  raw = JSON.parse(readFileSync(sourcePath, "utf8"));
} catch (error) {
  console.error(`not a readable .ageofreplay JSON file: ${String(error)}`);
  process.exit(1);
}

let files;
try {
  files = buildGoldenFixtureFiles(raw, nameArg);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const targetDir = resolve("tests", "golden", nameArg);
if (existsSync(targetDir)) {
  console.error(
    `refusing to overwrite existing fixture directory: ${targetDir} — delete it first or pick another name`,
  );
  process.exit(1);
}
mkdirSync(targetDir, { recursive: true });
writeFileSync(resolve(targetDir, "case.json"), files.caseJson);
writeFileSync(resolve(targetDir, "golden.test.ts"), files.goldenTestTs);

console.log(`wrote ${resolve(targetDir, "case.json")}`);
console.log(`wrote ${resolve(targetDir, "golden.test.ts")}`);
console.log("");
console.log("Next steps:");
console.log(`  1. npm test -- tests/golden/${String(nameArg)}`);
console.log(
  "     RED at the first diverging milestone while the bug exists; the",
);
console.log("     failing tick bisects regressions to their simulated second.");
console.log("  2. Commit the directory so `git bisect` can walk it. After an");
console.log("  INTENTIONAL sim change, re-export the match and re-run this");
console.log(
  "  converter; snapshot-based siblings regenerate via `npm run golden:record`.",
);

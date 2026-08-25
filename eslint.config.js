import eslint from "@typescript-eslint/eslint-plugin";
import parser from "@typescript-eslint/parser";
import prettier from "eslint-config-prettier";

export default [
  { ignores: ["dist/", "node_modules/", "prototype/", "docs/"] },
  {
    files: ["**/*.ts"],
    languageOptions: { parser },
    plugins: { "@typescript-eslint": eslint },
    rules: {
      ...eslint.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // The sim/render seam (SPEC §2.1, ADR-0001): sim stays pure TypeScript
    // and may never know render/audio exists.
    files: ["src/sim/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "three",
              message: "sim must not import the renderer (ADR-0001 seam).",
            },
          ],
          patterns: [
            {
              group: ["three", "three/**"],
              message: "sim must not import three (ADR-0001 seam).",
            },
            {
              group: ["**/render/**"],
              message: "sim must not import render code (ADR-0001 seam).",
            },
            {
              group: ["**/audio/**"],
              message: "sim must not import audio code (determinism).",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "window", message: "sim is headless-pure (ADR-0001)." },
        { name: "document", message: "sim is headless-pure (ADR-0001)." },
        {
          name: "requestAnimationFrame",
          message: "sim owns its own loop; rAF is render-side.",
        },
      ],
    },
  },
  {
    // Tests sit OUTSIDE the seam: they are observers, not sim code, and
    // the SPEC §7 harness requires headless (node-only) coverage of
    // render-side pure modules like render/mirror (M1-T6 perf gate).
    // They still may not touch three.js or audio — anything DOM/GPU-
    // coupled belongs behind integration boundaries, not unit tests.
    files: ["tests/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "three",
              message:
                "tests run headless; three.js needs a browser (use pure render/* modules instead).",
            },
          ],
          patterns: [
            {
              group: ["three", "three/**"],
              message: "tests run headless; three.js needs a browser.",
            },
            {
              // Pure audio logic (intents/coalescing/clock math) IS testable
              // headless; only AudioContext-coupled modules stay banned.
              group: [
                "**/audio/context",
                "**/audio/buses",
                "**/audio/voices",
                "**/audio/placeholder",
              ],
              message: "audio needs a browser AudioContext.",
            },
          ],
        },
      ],
    },
  },
  prettier,
];

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
    // The sim/render seam (SPEC §2.1, ADR-0001): sim stays pure TypeScript.
    files: ["src/sim/**/*.ts", "tests/**/*.ts"],
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
  prettier,
];

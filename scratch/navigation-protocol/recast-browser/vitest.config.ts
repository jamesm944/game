import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const donor = `${root}/scratch/donor-audit/browser/voidstrike/node_modules`;
export default defineConfig({
  resolve: { alias: {
    "@recast-navigation/core": `${donor}/@recast-navigation/core/dist/index.mjs`,
    "@recast-navigation/generators": `${donor}/@recast-navigation/generators/dist/index.mjs`,
    "@recast-navigation/wasm": `${donor}/@recast-navigation/wasm/dist/recast-navigation.wasm-compat.js`,
  } },
  test: { include: [fileURLToPath(new URL("./browser-artifacts.test.ts", import.meta.url))] },
});

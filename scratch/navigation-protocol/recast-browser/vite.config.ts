import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const donor = `${root}/scratch/donor-audit/browser/voidstrike/node_modules`;
export default defineConfig({
  root,
  cacheDir: fileURLToPath(new URL("./.vite", import.meta.url)),
  resolve: { alias: {
    "@recast-navigation/core": `${donor}/@recast-navigation/core/dist/index.mjs`,
    "@recast-navigation/generators": `${donor}/@recast-navigation/generators/dist/index.mjs`,
    "@recast-navigation/wasm": `${donor}/@recast-navigation/wasm/dist/recast-navigation.wasm-compat.js`,
  } },
  worker: { format: "es" },
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: { input: fileURLToPath(new URL("./index.html", import.meta.url)) },
  },
});

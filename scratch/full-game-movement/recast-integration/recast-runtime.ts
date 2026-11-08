import { createRequire } from "node:module";
import type * as RecastCore from "../../donor-audit/browser/voidstrike/node_modules/@recast-navigation/core/dist/index";
import type * as RecastGenerators from "../../donor-audit/browser/voidstrike/node_modules/@recast-navigation/generators/dist/index";

// Node 24 loads the donor's installed ESM/WASM packages synchronously here.
// Types come from their colocated declarations; no package is installed/copied.
const donorRequire = createRequire(import.meta.url);
export const recastCore = donorRequire(
  "../../donor-audit/browser/voidstrike/node_modules/@recast-navigation/core/dist/index.mjs",
) as typeof RecastCore;
export const recastGenerators = donorRequire(
  "../../donor-audit/browser/voidstrike/node_modules/@recast-navigation/generators/dist/index.mjs",
) as typeof RecastGenerators;

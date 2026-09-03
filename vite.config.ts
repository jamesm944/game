import { defineConfig } from "vite";

/**
 * Relative asset base (SPEC §2.12 deployment): the same dist/ must serve
 * from a GitHub Pages project subpath (`/<repo>/`) AND unzip flat for a
 * manual itch.io upload — both resolve `./assets/*` correctly, an
 * absolute `/assets/*` base only works at a domain root.
 */
export default defineConfig({
  base: "./",
  assetsInclude: ["**/*.gltf", "**/*.glb"],
});

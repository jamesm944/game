import { describe, expect, it } from "vitest";
import { SIM_VERSION } from "../src/sim/version";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

installSimPurityShims();

describe("skeleton", () => {
  it("imports a sim module through the enforced seam", () => {
    expect(SIM_VERSION).toMatch(/^0\.1\.0/);
  });
});

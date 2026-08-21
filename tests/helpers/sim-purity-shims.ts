/**
 * Test-only determinism guards — SPEC §2.1/§7.
 *
 * Installs beforeEach shims that turn `Math.random` and `Date.now` into
 * throwers for the duration of every test in the file. Any sim code path
 * that reaches wall-clock time or platform randomness fails loudly,
 * proving the sim seam stays deterministic (ADR-0001).
 */
import { afterEach, beforeEach } from "vitest";

function purityViolation(api: string): never {
  throw new Error(
    `sim purity violation: ${api} called during a sim test (SPEC §2.1 forbids ${api} in sim code)`,
  );
}

export function installSimPurityShims(): void {
  const realRandom = Math.random;
  const realDateNow = Date.now;

  beforeEach(() => {
    Math.random = () => purityViolation("Math.random");
    Date.now = () => purityViolation("Date.now");
  });

  afterEach(() => {
    Math.random = realRandom;
    Date.now = realDateNow;
  });
}

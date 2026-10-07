/**
 * Scenario Scripting Simulation System — Milestone S5 / Issue #133.
 *
 * Evaluates scenario triggers deterministically during each tick boundary
 * in the simulation loop.
 */

import type { SimComponents } from "../components";
import type { SimSystem, World } from "../core/world";
import {
  evaluateScenarioTriggers,
  type ScenarioCallbacks,
} from "../scenario/engine";

export function createScenarioSystem(
  comps: SimComponents,
  callbacks?: ScenarioCallbacks,
): SimSystem {
  return (world: World) => {
    if (!world.scenario) return;
    evaluateScenarioTriggers(world, comps, world.scenario, callbacks);
  };
}

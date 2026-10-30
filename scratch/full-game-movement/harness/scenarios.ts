import { readFileSync } from "node:fs";
import type { ScenarioSpec } from "./types";

const raw = JSON.parse(
  readFileSync(new URL("./fixtures/scenarios.json", import.meta.url), "utf8"),
) as unknown;

if (!Array.isArray(raw)) throw new Error("scenario fixture must be an array");
export const SCENARIOS = raw as ScenarioSpec[];

for (const scenario of SCENARIOS) {
  if (scenario.size !== 120) throw new Error(`${scenario.name}: only recorded 120x120 maps are accepted`);
  if (scenario.groups.length === 0 || scenario.commands.length === 0) {
    throw new Error(`${scenario.name}: groups and commands are required`);
  }
  const ids = new Set(scenario.groups.map((group) => group.id));
  for (const command of scenario.commands) {
    for (const id of command.groupIds) {
      if (!ids.has(id)) throw new Error(`${scenario.name}: unknown command group ${id}`);
    }
  }
}

export function scenarioByName(name: string): ScenarioSpec {
  const scenario = SCENARIOS.find((entry) => entry.name === name);
  if (!scenario) {
    throw new Error(`unknown scenario ${name}; available: ${SCENARIOS.map((entry) => entry.name).join(", ")}`);
  }
  return scenario;
}

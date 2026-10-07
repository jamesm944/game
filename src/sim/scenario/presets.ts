/**
 * Built-in Canonical Scenarios — Milestone S5 / Issue #133.
 *
 * Provides pre-authored scenarios for testing, tutorials, and campaign play.
 */

import type { ScenarioDefinition } from "./types";

/**
 * "The Outpost Siege" — Canonical 3-stage tutorial scenario:
 * 1. Gather starting resources (100 Food, 100 Wood).
 * 2. Construct a Barracks to muster military forces.
 * 3. March army to clear the bandit raider camp and claim victory.
 */
export const SCENARIO_OUTPOST_SIEGE: ScenarioDefinition = {
  id: "outpost-siege",
  title: "The Outpost Siege",
  description:
    "Bandit raiders have established an encampment nearby. Build up your settlement, muster military forces, and clear the raiders from the valley.",
  initialObjectives: [
    {
      id: "obj-gather",
      title: "Stockpile Resources",
      description: "Gather at least 100 Food and 100 Wood for your town.",
      primary: true,
      status: "active",
    },
  ],
  triggers: [
    // Trigger 1: Stockpile milestone reached
    {
      id: "trig-stockpile-reached",
      name: "Resource Stockpile Met",
      enabled: true,
      looping: false,
      conditions: [
        {
          kind: "resourceThreshold",
          player: 0,
          resource: "food",
          amount: 100,
        },
        {
          kind: "resourceThreshold",
          player: 0,
          resource: "wood",
          amount: 100,
        },
      ],
      actions: [
        {
          kind: "updateObjective",
          objectiveId: "obj-gather",
          status: "completed",
        },
        {
          kind: "displayObjective",
          objectiveId: "obj-barracks",
          title: "Construct a Barracks",
          description: "Build a military Barracks to train soldiers for defense.",
          primary: true,
          status: "active",
        },
        {
          kind: "broadcastMessage",
          sender: "Town Elder",
          message:
            "Well done! Our granaries are supplied. Now we must raise arms to defend our borders.",
        },
        {
          kind: "audioCue",
          sound: "age.up",
        },
        // Reinforcement: An allied scout arrives
        {
          kind: "spawnUnits",
          player: 0,
          unitType: "scout-cavalry",
          count: 1,
          x: 10,
          y: 10,
        },
      ],
    },

    // Trigger 2: Barracks constructed
    {
      id: "trig-barracks-ready",
      name: "Barracks Built",
      enabled: true,
      looping: false,
      conditions: [
        {
          kind: "objectiveStatus",
          objectiveId: "obj-gather",
          status: "completed",
        },
        {
          kind: "buildingsConstructed",
          player: 0,
          buildingType: "barracks",
          count: 1,
        },
      ],
      actions: [
        {
          kind: "updateObjective",
          objectiveId: "obj-barracks",
          status: "completed",
        },
        {
          kind: "displayObjective",
          objectiveId: "obj-defeat-raiders",
          title: "Defeat Bandit Raiders",
          description: "Destroy the enemy raider force lurking to the east.",
          primary: true,
          status: "active",
        },
        // Spawn raider squad
        {
          kind: "spawnUnits",
          player: 1,
          unitType: "militia",
          count: 3,
          x: 25,
          y: 25,
        },
        {
          kind: "diplomacyShift",
          playerA: 0,
          playerB: 1,
          stance: "enemy",
        },
        {
          kind: "broadcastMessage",
          sender: "Scout",
          message:
            "Hostile raiders spotted to the east! Slay them before they attack our villagers!",
        },
        {
          kind: "audioCue",
          sound: "ui.order",
        },
      ],
    },

    // Trigger 3: Raiders defeated (>= 3 casualties for player 1)
    {
      id: "trig-raiders-defeated",
      name: "Raiders Defeated",
      enabled: true,
      looping: false,
      conditions: [
        {
          kind: "objectiveStatus",
          objectiveId: "obj-barracks",
          status: "completed",
        },
        {
          kind: "unitsSlain",
          victimPlayer: 1,
          count: 3,
        },
      ],
      actions: [
        {
          kind: "updateObjective",
          objectiveId: "obj-defeat-raiders",
          status: "completed",
        },
        {
          kind: "triggerVictory",
          player: 0,
          reason: "The bandit raiders have been vanquished! The valley is safe.",
        },
        {
          kind: "audioCue",
          sound: "victory.win",
        },
      ],
    },
  ],
};

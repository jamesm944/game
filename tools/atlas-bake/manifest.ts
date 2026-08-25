/**
 * Per-unit bake manifest — WHICH real CC0 assets become each unit's
 * atlas (ASSET-INVENTORY.md "Entity mapping — units", SPEC §6).
 *
 * Every unit definition under src/data/definitions/units gets exactly
 * one entry here; `id` matches the def id and names the emitted
 * src/assets/atlas/<id>.{png,frames.json} pair. Action names are the
 * baked clip ids referenced by the defs' activityAnims maps.
 *
 * Sources (all CC0, vendored under src/assets/models/, see
 * ASSET-INVENTORY.md for provenance):
 * - UAL1/UAL2: Quaternius Universal Animation Library mannequin clips.
 *   Bone naming is IDENTICAL to Quaternius Universal Base Characters
 *   (UE-style pelvis/spine_01/upperarm_l/...), so UAL clips play
 *   directly on UBC rigs with no retarget table — verified against the
 *   vendored files (65/65 bone names match).
 * - KayKit Adventurers characters ship pre-animated (76 clips each)
 *   plus rigid accessory .gltf props that snap onto the `handslotr/l`
 *   bones with identity transforms.
 * - Scout-cavalry kitbash: Q Ultimate Animated Animals horse mount +
 *   KayKit Barbarian rider seated above the saddle (SPEC "parent
 *   rider" approach; the seat offset hides the rider's legs inside
 *   the mount body at billboard scale).
 */

/** Path prefix every manifest path resolves against. */
export const MODELS_ROOT = "src/assets/models";

/** A rigid prop welded onto a bone of a part for specific actions. */
export interface PropAttachment {
  /** Model file (glTF family) under MODELS_ROOT. */
  readonly file: string;
  /** Bone/node name inside the owning part to parent the prop to. */
  readonly bone: string;
  /** Local offset applied to the prop root once parented. */
  readonly position?: readonly [number, number, number];
  /** Local rotation in degrees, XYZ order. */
  readonly rotationDeg?: readonly [number, number, number];
  /** Uniform scale (default 1). */
  readonly scale?: number;
}

/** One animation clip played on one loaded part. */
export interface ClipBinding {
  /** Key of the part (below) whose animation clips to use. */
  readonly part: string;
  /** Exact clip name inside that part's file. */
  readonly clip: string;
}

/** One baked atlas action: simultaneous clips + props rendered attached. */
export interface BakedAction {
  /** Baked clip id — what unit-def activityAnims values point at. */
  readonly name: string;
  readonly frameCount: number;
  readonly fps: number;
  readonly bindings: readonly ClipBinding[];
  readonly props?: readonly PropAttachment[];
}

/** One loaded model contributing a subtree of the assembled rig. */
export interface RigPart {
  readonly key: string;
  readonly file: string;
  /**
   * Remove rigid (non-skinned) meshes the vendor parents to the
   * skeleton (KayKit characters ship axes/shields/hats/capes).
   */
  readonly stripDefaultProps?: boolean;
  /**
   * Contribute animation clips ONLY — the loaded scene never joins
   * the rendered graph. The UAL mannequin bodies exist so their clips
   * retarget onto UBC skeletons by identical bone names; rendering
   * them too would double-draw a second body.
   */
  readonly clipsOnly?: boolean;
  /** Uniform scale applied to the part root. */
  readonly scale?: number;
  /** Key of the part this one parents to (omit for the root part). */
  readonly parent?: string;
  readonly position?: readonly [number, number, number];
  readonly rotationDegY?: number;
}

export interface UnitBake {
  /** Matches a unit definition id; names the atlas pair. */
  readonly id: string;
  /** Normalize differing vendor facing directions to the bake's +Z. */
  readonly yawOffsetDeg: number;
  /** Turntable camera framing (see raster.turntableMvp). */
  readonly halfExtent: number;
  readonly focusY: number;
  readonly parts: readonly RigPart[];
  readonly actions: readonly BakedAction[];
  /** Human-readable notes surfaced in the frames.json index. */
  readonly gaps?: readonly string[];
}

const UAL1 = "quaternius-universal-animation-library-1/UAL1_Standard.glb";
const UAL2 = "quaternius-universal-animation-library-2/UAL2_Standard.glb";
const UBC_MALE =
  "quaternius-ultimate-base-characters/Superhero_Male_FullBody.gltf";
const BARBARIAN = "kaykit-adventurers/Characters/Barbarian.glb";
const KNIGHT = "kaykit-adventurers/Characters/Knight.glb";
const MAGE = "kaykit-adventurers/Characters/Mage.glb";
const ROGUE = "kaykit-adventurers/Characters/Rogue.glb";
const ROGUE_HOODED = "kaykit-adventurers/Characters/Rogue_Hooded.glb";
const HORSE = "quaternius-ultimate-animated-animals/glTF/Horse.gltf";

const AXE = "kaykit-adventurers/Assets/axe_1handed.gltf";
const SWORD_1H = "kaykit-adventurers/Assets/sword_1handed.gltf";
const SWORD_2H_COLOR = "kaykit-adventurers/Assets/sword_2handed_color.gltf";
const SHIELD_ROUND = "kaykit-adventurers/Assets/shield_round.gltf";
const SHIELD_BADGE = "kaykit-adventurers/Assets/shield_badge_color.gltf";
const CROSSBOW_2H = "kaykit-adventurers/Assets/crossbow_2handed.gltf";
const QUIVER = "kaykit-adventurers/Assets/quiver.gltf";
const STAFF = "kaykit-adventurers/Assets/staff.gltf";
const LOGS = "quaternius-ultimate-fantasy-rts/glTF/Logs.gltf";
const ORE = "quaternius-ultimate-fantasy-rts/glTF/Resource_Gold_1.gltf";
const CRATE = "quaternius-ultimate-fantasy-rts/glTF/Crate.gltf";

/**
 * The full V1 roster — every unit definition gets a real-rigged atlas.
 * Frame budgets keep each unit within two stacked 2048² bands (most
 * fit one); see planAtlasLayout for the vertical-stack rule.
 */
export const UNIT_BAKES: readonly UnitBake[] = [
  {
    id: "villager",
    // UBC ships facing -Z like the other Blender-export vendors; the
    // debug-dump pass pins the exact offset during calibration.
    yawOffsetDeg: 180,
    halfExtent: 1.15,
    focusY: 0.85,
    parts: [
      { key: "body", file: UBC_MALE },
      // Clip sources only (0 clips ship on the UBC body itself); their
      // tracks retarget by identical Quaternius bone names.
      { key: "ual1", file: UAL1, clipsOnly: true },
      { key: "ual2", file: UAL2, clipsOnly: true },
    ],
    actions: [
      {
        name: "idle",
        frameCount: 4,
        fps: 6,
        bindings: [{ part: "ual1", clip: "Idle_Loop" }],
      },
      {
        name: "walk",
        frameCount: 8,
        fps: 12,
        bindings: [{ part: "ual1", clip: "Walk_Loop" }],
      },
      {
        name: "chop",
        frameCount: 6,
        fps: 12,
        bindings: [{ part: "ual2", clip: "TreeChopping_Loop" }],
        props: [{ file: AXE, bone: "hand_r", scale: 0.55 }],
      },
      {
        // No pickaxe exists in any vendored pack; the axe-on-overhead-
        // strike stands in (documented gap, ASSET-INVENTORY.md).
        name: "mine",
        frameCount: 6,
        fps: 12,
        bindings: [{ part: "ual2", clip: "TreeChopping_Loop" }],
        props: [{ file: AXE, bone: "hand_r", scale: 0.55 }],
      },
      {
        // No hammer either; Fixing_Kneeling bakes toolless (gap).
        name: "build",
        frameCount: 6,
        fps: 10,
        bindings: [{ part: "ual1", clip: "Fixing_Kneeling" }],
      },
      {
        name: "farm",
        frameCount: 6,
        fps: 12,
        bindings: [{ part: "ual2", clip: "Farm_PlantSeed" }],
      },
      {
        name: "death",
        frameCount: 6,
        fps: 4,
        bindings: [{ part: "ual1", clip: "Death01" }],
      },
      {
        name: "carry-wood",
        frameCount: 6,
        fps: 12,
        bindings: [{ part: "ual2", clip: "Walk_Carry_Loop" }],
        props: [
          {
            file: LOGS,
            bone: "spine_02",
            position: [0, 0.35, 0.22],
            scale: 0.45,
          },
        ],
      },
      {
        name: "carry-ore",
        frameCount: 6,
        fps: 12,
        bindings: [{ part: "ual2", clip: "Walk_Carry_Loop" }],
        props: [
          {
            file: ORE,
            bone: "spine_02",
            position: [0, 0.35, 0.24],
            scale: 0.5,
          },
        ],
      },
      {
        // No basket/sack mesh in any vendored pack; food rides in a
        // scaled supply crate (documented gap, ASSET-INVENTORY.md).
        name: "carry-food",
        frameCount: 6,
        fps: 12,
        bindings: [{ part: "ual2", clip: "Walk_Carry_Loop" }],
        props: [
          {
            file: CRATE,
            bone: "spine_02",
            position: [0, 0.32, 0.24],
            scale: 0.16,
          },
        ],
      },
    ],
    gaps: [
      "mine reuses TreeChopping_Loop with the axe prop (no pickaxe vendored)",
      "build uses Fixing_Kneeling toolless (no hammer vendored)",
      "carry-food uses a scaled crate (no basket/sack vendored)",
    ],
  },
  {
    id: "militia",
    yawOffsetDeg: 180,
    halfExtent: 1.15,
    focusY: 0.85,
    parts: [{ key: "body", file: BARBARIAN, stripDefaultProps: true }],
    actions: [
      {
        name: "idle",
        frameCount: 4,
        fps: 6,
        bindings: [{ part: "body", clip: "Idle" }],
        props: [{ file: SWORD_1H, bone: "handslotr" }],
      },
      {
        name: "walk",
        frameCount: 8,
        fps: 12,
        bindings: [{ part: "body", clip: "Walking_A" }],
        props: [{ file: SWORD_1H, bone: "handslotr" }],
      },
      {
        name: "attack",
        frameCount: 6,
        fps: 12,
        bindings: [{ part: "body", clip: "1H_Melee_Attack_Slice_Horizontal" }],
        props: [{ file: SWORD_1H, bone: "handslotr" }],
      },
      {
        name: "hit",
        frameCount: 4,
        fps: 12,
        bindings: [{ part: "body", clip: "Hit_A" }],
        props: [{ file: SWORD_1H, bone: "handslotr" }],
      },
      {
        name: "death",
        frameCount: 6,
        fps: 4,
        bindings: [{ part: "body", clip: "Death_A" }],
        props: [{ file: SWORD_1H, bone: "handslotr" }],
      },
    ],
  },
  {
    id: "man-at-arms",
    yawOffsetDeg: 180,
    halfExtent: 1.15,
    focusY: 0.85,
    parts: [{ key: "body", file: BARBARIAN, stripDefaultProps: true }],
    actions: [
      {
        name: "idle",
        frameCount: 4,
        fps: 6,
        bindings: [{ part: "body", clip: "Idle" }],
        props: [
          { file: SWORD_2H_COLOR, bone: "handslotr" },
          { file: SHIELD_ROUND, bone: "handslotl" },
        ],
      },
      {
        name: "walk",
        frameCount: 8,
        fps: 12,
        bindings: [{ part: "body", clip: "Walking_A" }],
        props: [
          { file: SWORD_2H_COLOR, bone: "handslotr" },
          { file: SHIELD_ROUND, bone: "handslotl" },
        ],
      },
      {
        name: "attack",
        frameCount: 6,
        fps: 12,
        bindings: [{ part: "body", clip: "2H_Melee_Attack_Slice" }],
        props: [
          { file: SWORD_2H_COLOR, bone: "handslotr" },
          { file: SHIELD_ROUND, bone: "handslotl" },
        ],
      },
      {
        name: "block",
        frameCount: 4,
        fps: 12,
        bindings: [{ part: "body", clip: "Blocking" }],
        props: [
          { file: SWORD_2H_COLOR, bone: "handslotr" },
          { file: SHIELD_ROUND, bone: "handslotl" },
        ],
      },
      {
        name: "hit",
        frameCount: 4,
        fps: 12,
        bindings: [{ part: "body", clip: "Hit_A" }],
        props: [
          { file: SWORD_2H_COLOR, bone: "handslotr" },
          { file: SHIELD_ROUND, bone: "handslotl" },
        ],
      },
      {
        name: "death",
        frameCount: 6,
        fps: 4,
        bindings: [{ part: "body", clip: "Death_A" }],
        props: [
          { file: SWORD_2H_COLOR, bone: "handslotr" },
          { file: SHIELD_ROUND, bone: "handslotl" },
        ],
      },
    ],
  },
  {
    id: "archer",
    yawOffsetDeg: 180,
    halfExtent: 1.15,
    focusY: 0.85,
    parts: [{ key: "body", file: ROGUE_HOODED, stripDefaultProps: true }],
    actions: [
      {
        name: "idle",
        frameCount: 4,
        fps: 6,
        bindings: [{ part: "body", clip: "Idle" }],
        props: [
          { file: CROSSBOW_2H, bone: "handslotr" },
          {
            file: QUIVER,
            bone: "chest",
            position: [0, 0.05, -0.18],
            rotationDeg: [0, 0, 20],
          },
        ],
      },
      {
        name: "walk",
        frameCount: 8,
        fps: 12,
        bindings: [{ part: "body", clip: "Walking_A" }],
        props: [
          { file: CROSSBOW_2H, bone: "handslotr" },
          {
            file: QUIVER,
            bone: "chest",
            position: [0, 0.05, -0.18],
            rotationDeg: [0, 0, 20],
          },
        ],
      },
      {
        name: "aim",
        frameCount: 4,
        fps: 12,
        bindings: [{ part: "body", clip: "2H_Ranged_Aiming" }],
        props: [
          { file: CROSSBOW_2H, bone: "handslotr" },
          {
            file: QUIVER,
            bone: "chest",
            position: [0, 0.05, -0.18],
            rotationDeg: [0, 0, 20],
          },
        ],
      },
      {
        name: "shoot",
        frameCount: 6,
        fps: 12,
        bindings: [{ part: "body", clip: "2H_Ranged_Shoot" }],
        props: [
          { file: CROSSBOW_2H, bone: "handslotr" },
          {
            file: QUIVER,
            bone: "chest",
            position: [0, 0.05, -0.18],
            rotationDeg: [0, 0, 20],
          },
        ],
      },
      {
        name: "hit",
        frameCount: 4,
        fps: 12,
        bindings: [{ part: "body", clip: "Hit_A" }],
        props: [
          { file: CROSSBOW_2H, bone: "handslotr" },
          {
            file: QUIVER,
            bone: "chest",
            position: [0, 0.05, -0.18],
            rotationDeg: [0, 0, 20],
          },
        ],
      },
      {
        name: "death",
        frameCount: 6,
        fps: 4,
        bindings: [{ part: "body", clip: "Death_A" }],
        props: [
          {
            file: QUIVER,
            bone: "chest",
            position: [0, 0.05, -0.18],
            rotationDeg: [0, 0, 20],
          },
        ],
      },
    ],
  },
  {
    id: "skirmisher",
    yawOffsetDeg: 180,
    halfExtent: 1.15,
    focusY: 0.85,
    parts: [{ key: "body", file: ROGUE, stripDefaultProps: true }],
    actions: [
      {
        name: "idle",
        frameCount: 4,
        fps: 6,
        bindings: [{ part: "body", clip: "Idle" }],
      },
      {
        name: "walk",
        frameCount: 8,
        fps: 12,
        bindings: [{ part: "body", clip: "Walking_A" }],
      },
      {
        // Javelin throw; no spear mesh is vendored so the clip bakes
        // empty-handed (documented gap, ASSET-INVENTORY.md).
        name: "throw",
        frameCount: 6,
        fps: 12,
        bindings: [{ part: "body", clip: "Throw" }],
      },
      {
        name: "hit",
        frameCount: 4,
        fps: 12,
        bindings: [{ part: "body", clip: "Hit_A" }],
      },
      {
        name: "death",
        frameCount: 6,
        fps: 4,
        bindings: [{ part: "body", clip: "Death_A" }],
      },
    ],
    gaps: ["throw bakes without a javelin mesh (none vendored)"],
  },
  {
    id: "knight",
    yawOffsetDeg: 180,
    halfExtent: 1.15,
    focusY: 0.85,
    parts: [{ key: "body", file: KNIGHT, stripDefaultProps: true }],
    actions: [
      {
        name: "idle",
        frameCount: 4,
        fps: 6,
        bindings: [{ part: "body", clip: "Idle" }],
        props: [
          { file: SWORD_2H_COLOR, bone: "handslotr" },
          { file: SHIELD_BADGE, bone: "handslotl" },
        ],
      },
      {
        name: "walk",
        frameCount: 8,
        fps: 12,
        bindings: [{ part: "body", clip: "Walking_A" }],
        props: [
          { file: SWORD_2H_COLOR, bone: "handslotr" },
          { file: SHIELD_BADGE, bone: "handslotl" },
        ],
      },
      {
        name: "attack",
        frameCount: 6,
        fps: 12,
        bindings: [{ part: "body", clip: "1H_Melee_Attack_Slice_Horizontal" }],
        props: [
          { file: SWORD_2H_COLOR, bone: "handslotr" },
          { file: SHIELD_BADGE, bone: "handslotl" },
        ],
      },
      {
        name: "block",
        frameCount: 4,
        fps: 12,
        bindings: [{ part: "body", clip: "Blocking" }],
        props: [
          { file: SWORD_2H_COLOR, bone: "handslotr" },
          { file: SHIELD_BADGE, bone: "handslotl" },
        ],
      },
      {
        name: "hit",
        frameCount: 4,
        fps: 12,
        bindings: [{ part: "body", clip: "Hit_A" }],
        props: [
          { file: SWORD_2H_COLOR, bone: "handslotr" },
          { file: SHIELD_BADGE, bone: "handslotl" },
        ],
      },
      {
        name: "death",
        frameCount: 6,
        fps: 4,
        bindings: [{ part: "body", clip: "Death_A" }],
        props: [
          { file: SWORD_2H_COLOR, bone: "handslotr" },
          { file: SHIELD_BADGE, bone: "handslotl" },
        ],
      },
    ],
  },
  {
    id: "monk",
    yawOffsetDeg: 180,
    halfExtent: 1.15,
    focusY: 0.85,
    parts: [{ key: "body", file: MAGE, stripDefaultProps: true }],
    actions: [
      {
        name: "idle",
        frameCount: 4,
        fps: 6,
        bindings: [{ part: "body", clip: "Idle" }],
        props: [{ file: STAFF, bone: "handslotr" }],
      },
      {
        name: "walk",
        frameCount: 8,
        fps: 12,
        bindings: [{ part: "body", clip: "Walking_A" }],
        props: [{ file: STAFF, bone: "handslotr" }],
      },
      {
        name: "cast",
        frameCount: 6,
        fps: 12,
        bindings: [{ part: "body", clip: "Spellcast_Shoot" }],
        props: [{ file: STAFF, bone: "handslotr" }],
      },
      {
        name: "death",
        frameCount: 6,
        fps: 4,
        bindings: [{ part: "body", clip: "Death_A" }],
      },
    ],
  },
  {
    id: "scout-cavalry",
    yawOffsetDeg: 180,
    halfExtent: 1.7,
    focusY: 1.0,
    parts: [
      { key: "mount", file: HORSE, scale: 0.42 },
      {
        key: "rider",
        file: BARBARIAN,
        stripDefaultProps: true,
        scale: 0.85,
        parent: "mount",
        position: [0, 1.28, 0.1],
      },
    ],
    actions: [
      {
        name: "idle",
        frameCount: 4,
        fps: 6,
        bindings: [
          { part: "mount", clip: "Idle" },
          { part: "rider", clip: "Unarmed_Idle" },
        ],
      },
      {
        name: "walk",
        frameCount: 8,
        fps: 12,
        bindings: [
          { part: "mount", clip: "Walk" },
          { part: "rider", clip: "Walking_A" },
        ],
      },
      {
        name: "gallop",
        frameCount: 8,
        fps: 12,
        bindings: [
          { part: "mount", clip: "Gallop" },
          { part: "rider", clip: "Running_A" },
        ],
      },
      {
        name: "attack",
        frameCount: 6,
        fps: 12,
        bindings: [
          { part: "mount", clip: "Attack_Kick" },
          { part: "rider", clip: "1H_Melee_Attack_Slice_Horizontal" },
        ],
      },
      {
        name: "death",
        frameCount: 6,
        fps: 4,
        bindings: [
          { part: "mount", clip: "Death" },
          { part: "rider", clip: "Death_A" },
        ],
      },
    ],
  },
];

/** Unit ids accepted by --units/--all. */
export const UNIT_BAKE_IDS: readonly string[] = UNIT_BAKES.map((u) => u.id);

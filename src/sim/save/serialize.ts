/**
 * `.ageof` payload serializer — SPEC §2.12 / M5-T2 (issue #64).
 *
 * The PURE sim half of the save pipeline: one canonical byte framing of
 * everything a restored session needs to resume digest-identically,
 * compressed later by the game-side manager (fflate gzip around these
 * bytes). Sections are LENGTH-PREFIXED (`u32` byte length, big-endian
 * throughout) and written in a FIXED order:
 *
 *   0 meta       — sim version + component-name table (JSON)
 *   1 core       — lastAllocatedEid, live entity ids, PRNG 4×u32
 *   2 components — every registered component in REGISTRY (alphabetical)
 *                  order: u32 liveCount + alive bitmask + rows as raw
 *                  IEEE-754 f64 bit patterns (NaN/-0/2⁵³ survive)
 *   3 map        — u32 size + terrain‖elevation‖passability bytes
 *   4 fog        — explored/visible/contributor planes per player
 *                  verbatim + KnowledgeView memory ghosts
 *   5 commands   — pending inbox queue with ABSOLUTE target ticks
 *   6 companies  — output-profitability stamps + organic-founder
 *                  cooldowns (the deliberate non-digest closure state)
 *   7 planner    — AI build-order + military memories
 *   8 digest     — the §7 stateDigest string this payload must
 *                  reproduce after a byte-copy restore
 *
 * Restore does NOT replay: callers allocate a fresh world from the seed
 * + stored map, copy these bytes back in registry order, then re-run
 * the digest recipe against section 8 (free corruption check — see
 * game/session.ts restoreSkirmishSession).
 *
 * Purity: byte work only — no clock, no randomness, no DOM. The header
 * framing (magic/version/map-hash/gzip) lives in game/saveManager.ts.
 */

import { SIM_VERSION } from "../version";
import {
  MAX_ELEVATION_LEVEL,
  PASSABLE,
  TERRAIN_TYPE_COUNT,
  serializeLayers,
} from "../world/layers";
import type { WorldLayers } from "../world/layers";
import type { FogSnapshot } from "../systems/fog";
import { computeWorldDigest } from "../core/world";
import type { World } from "../core/world";
import type { SimCommand } from "../core/inbox";

/** Bumped on ANY breaking framing change; old saves reject loudly. */
export const SAVE_FORMAT_VERSION = 1;

/** Section order — the fixed contract both writer and reader walk. */
export const PAYLOAD_SECTION_COUNT = 9;

// ---- Plain-state shapes (filled by game/session.ts from live closures) --------

/**
 * Company ledger state outside the digest rows (SPEC §2.12 reserves
 * organic-founder cooldowns): output-profitability stamps feeding the
 * daily founding scan plus the per-player cooldowns themselves.
 */
export interface CompaniesSaveState {
  readonly lastOutputTickByBuilding: ReadonlyMap<number, number>;
  readonly lastOrganicFoundingTick: ReadonlyMap<number, number>;
}

/** AI orchestrator cross-pass memory (build-order + military layers). */
export interface PlannerSaveState {
  /** Tick the one-shot offensive armed at (undefined = not yet). */
  readonly attackedTick: number | undefined;
  /** Damaged building eid → tick its current threat was first seen. */
  readonly threatSince: ReadonlyMap<number, number>;
  /** Tick of the last emitted defense rally (cooldown anchor). */
  readonly lastRallyTick: number | undefined;
  /** Counter-training orders emitted so far this match. */
  readonly countersTrained: number;
}

export interface SimSnapshotInput {
  readonly world: World;
  /** Accumulated unpaused wall-clock play time (header field). */
  readonly playtimeSeconds: number;
  /** Captured fog planes + ghosts (systems/fog captureFogSnapshot). */
  readonly fog: FogSnapshot;
  readonly companies: CompaniesSaveState;
  readonly planner: PlannerSaveState;
}

/** Everything one parsed payload carries, ready to apply to a new world. */
export interface ParsedSimSave {
  readonly simVersion: string;
  readonly registryNames: readonly string[];
  readonly lastAllocatedEid: number;
  readonly entities: readonly number[];
  readonly prngWords: readonly [number, number, number, number];
  /** Component name → eid → row values (registry order preserved). */
  readonly componentRows: ReadonlyMap<string, ReadonlyMap<number, number[]>>;
  /** Raw canonical map bytes (terrain‖elevation‖passability). */
  readonly mapBytes: Uint8Array;
  readonly layers: WorldLayers;
  readonly fog: FogSnapshot;
  readonly commands: readonly SimCommand[];
  readonly companies: CompaniesSaveState;
  readonly planner: PlannerSaveState;
  /** The stored §7 digest the rebuilt world must reproduce exactly. */
  readonly stateDigest: string;
}

// ---- Byte writer / reader ------------------------------------------------------

class ByteWriter {
  #buffer = new Uint8Array(1024);
  #view = new DataView(this.#buffer.buffer);
  #length = 0;

  #reserve(extra: number): void {
    const needed = this.#length + extra;
    if (needed <= this.#buffer.length) return;
    let capacity = this.#buffer.length;
    while (capacity < needed) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.#buffer.subarray(0, this.#length));
    this.#buffer = grown;
    this.#view = new DataView(grown.buffer);
  }

  bytes(chunk: Uint8Array): void {
    this.#reserve(chunk.length);
    this.#buffer.set(chunk, this.#length);
    this.#length += chunk.length;
  }

  u8(value: number): void {
    this.#reserve(1);
    this.#view.setUint8(this.#length, value);
    this.#length += 1;
  }

  u16(value: number): void {
    this.#reserve(2);
    this.#view.setUint16(this.#length, value, false);
    this.#length += 2;
  }

  i32(value: number): void {
    this.#reserve(4);
    this.#view.setInt32(this.#length, value, false);
    this.#length += 4;
  }

  u32(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new Error(`value out of u32 range: ${String(value)}`);
    }
    this.#reserve(4);
    this.#view.setUint32(this.#length, value, false);
    this.#length += 4;
  }

  f64(value: number): void {
    this.#reserve(8);
    this.#view.setFloat64(this.#length, value, false);
    this.#length += 8;
  }

  /** u32 length + UTF-8 bytes. */
  string(value: string): void {
    const encoded = new TextEncoder().encode(value);
    this.u32(encoded.length);
    this.bytes(encoded);
  }

  get length(): number {
    return this.#length;
  }

  toUint8Array(): Uint8Array {
    return this.#buffer.slice(0, this.#length);
  }
}

class ByteReader {
  #view: DataView;

  constructor(
    private readonly bytes: Uint8Array,
    private cursor = 0,
  ) {
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  remaining(): number {
    return this.bytes.length - this.cursor;
  }

  require(count: number, what: string): void {
    if (this.remaining() < count) {
      throw new Error(
        `truncated save payload reading ${what}: need ${String(count)} bytes at offset ${String(this.cursor)}, only ${String(this.remaining())} left`,
      );
    }
  }

  u8(what: string): number {
    this.require(1, what);
    const value = this.#view.getUint8(this.cursor);
    this.cursor += 1;
    return value;
  }

  u16(what: string): number {
    this.require(2, what);
    const value = this.#view.getUint16(this.cursor, false);
    this.cursor += 2;
    return value;
  }

  i32(what: string): number {
    this.require(4, what);
    const value = this.#view.getInt32(this.cursor, false);
    this.cursor += 4;
    return value;
  }

  u32(what: string): number {
    this.require(4, what);
    const value = this.#view.getUint32(this.cursor, false);
    this.cursor += 4;
    return value;
  }

  f64(what: string): number {
    this.require(8, what);
    const value = this.#view.getFloat64(this.cursor, false);
    this.cursor += 8;
    return value;
  }

  string(what: string): string {
    const length = this.u32(`${what} length`);
    if (length > this.bytes.length) {
      throw new Error(
        `save ${what} declares impossible length ${String(length)}`,
      );
    }
    this.require(length, what);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      this.bytes.subarray(this.cursor, this.cursor + length),
    );
    this.cursor += length;
    return decoded;
  }

  slice(count: number, what: string): Uint8Array {
    this.require(count, what);
    const out = this.bytes.slice(this.cursor, this.cursor + count);
    this.cursor += count;
    return out;
  }
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

// ---- Snapshot -------------------------------------------------------------------

function buildMetaSection(world: World): Uint8Array {
  return jsonBytes({
    simVersion: SIM_VERSION,
    registryNames: [...world.registry.namesInOrder()],
  });
}

function buildCoreSection(world: World): Uint8Array {
  const writer = new ByteWriter();
  writer.u32(world.lastAllocatedEid);
  writer.u32(world.entities.length);
  for (const eid of world.entities) writer.u32(eid);
  for (const word of world.prng.getState()) writer.u32(word);
  return writer.toUint8Array();
}

function buildComponentsSection(world: World): Uint8Array {
  const writer = new ByteWriter();
  const names = world.registry.namesInOrder();
  writer.u32(names.length);
  for (const name of names) {
    writer.string(name);
    const id = world.registry.idOf(name);
    const rows = world.rowsByComponentId.get(id);
    if (!rows) throw new Error(`unregistered component id: ${String(id)}`);
    const eids = [...rows.keys()].sort((a, b) => a - b);
    writer.u32(eids.length);
    const maxEid = eids.length > 0 ? eids[eids.length - 1]! : 0;
    writer.u32(maxEid);
    if (maxEid > 0) {
      const mask = new Uint8Array(Math.ceil(maxEid / 8));
      for (const eid of eids) {
        mask[(eid - 1) >> 3]! |= 1 << ((eid - 1) & 7);
      }
      writer.bytes(mask);
    }
    for (const eid of eids) {
      const values = rows.get(eid)!;
      writer.u32(values.length);
      for (const value of values) writer.f64(value);
    }
  }
  return writer.toUint8Array();
}

function buildMapSection(world: World): Uint8Array {
  const writer = new ByteWriter();
  writer.u32(world.layers.size);
  writer.bytes(serializeLayers(world.layers));
  return writer.toUint8Array();
}

function buildFogSection(fog: FogSnapshot): Uint8Array {
  const writer = new ByteWriter();
  writer.u32(fog.size);
  writer.u32(fog.playerCount);
  const tiles = fog.size * fog.size;
  for (const plane of fog.planes) {
    if (
      plane.explored.length !== tiles ||
      plane.visible.length !== tiles ||
      plane.contributorCount.length !== tiles
    ) {
      throw new Error(
        `fog plane tile count mismatch: expected ${String(tiles)} per plane`,
      );
    }
    writer.bytes(plane.explored);
    writer.bytes(plane.visible);
    for (let i = 0; i < plane.contributorCount.length; i++) {
      writer.u16(plane.contributorCount[i]!);
    }
  }
  let ghostTotal = 0;
  for (const records of fog.ghosts) ghostTotal += records.length;
  writer.u32(ghostTotal);
  for (let viewer = 0; viewer < fog.ghosts.length; viewer++) {
    for (const record of fog.ghosts[viewer]!) {
      writer.u32(viewer);
      writer.u32(record.eid);
      writer.string(record.defId);
      writer.i32(record.tileX);
      writer.i32(record.tileY);
    }
  }
  return writer.toUint8Array();
}

function buildCommandsSection(commands: readonly SimCommand[]): Uint8Array {
  const writer = new ByteWriter();
  writer.u32(commands.length);
  for (const command of commands) {
    writer.string(command.kind);
    writer.u32(command.targetTick);
    if (command.data === undefined) {
      writer.u32(0xffffffff);
    } else {
      const encoded = jsonBytes(command.data);
      writer.u32(encoded.length);
      writer.bytes(encoded);
    }
  }
  return writer.toUint8Array();
}

function buildCompaniesSection(state: CompaniesSaveState): Uint8Array {
  const writer = new ByteWriter();
  const outputs = [...state.lastOutputTickByBuilding.entries()].sort(
    (a, b) => a[0] - b[0],
  );
  writer.u32(outputs.length);
  for (const [eid, tick] of outputs) {
    writer.u32(eid);
    writer.u32(tick);
  }
  const cooldowns = [...state.lastOrganicFoundingTick.entries()].sort(
    (a, b) => a[0] - b[0],
  );
  writer.u32(cooldowns.length);
  for (const [player, tick] of cooldowns) {
    writer.u32(player);
    writer.u32(tick);
  }
  return writer.toUint8Array();
}

function buildPlannerSection(state: PlannerSaveState): Uint8Array {
  const writer = new ByteWriter();
  writer.u8(state.attackedTick === undefined ? 0 : 1);
  if (state.attackedTick !== undefined) writer.u32(state.attackedTick);
  const threats = [...state.threatSince.entries()].sort((a, b) => a[0] - b[0]);
  writer.u32(threats.length);
  for (const [eid, tick] of threats) {
    writer.u32(eid);
    writer.u32(tick);
  }
  writer.u8(state.lastRallyTick === undefined ? 0 : 1);
  if (state.lastRallyTick !== undefined) writer.u32(state.lastRallyTick);
  writer.u32(state.countersTrained);
  return writer.toUint8Array();
}

function buildDigestSection(digest: string): Uint8Array {
  const writer = new ByteWriter();
  writer.string(digest);
  return writer.toUint8Array();
}

/**
 * Serialize EVERYTHING the restore needs into the uncompressed payload
 * byte stream (fixed section order, each section u32-length-prefixed).
 * The caller gzips these bytes into the `.ageof` container.
 */
export function snapshotPayload(input: SimSnapshotInput): Uint8Array {
  const sections: Uint8Array[] = [
    buildMetaSection(input.world),
    buildCoreSection(input.world),
    buildComponentsSection(input.world),
    buildMapSection(input.world),
    buildFogSection(input.fog),
    buildCommandsSection(input.world.inbox.pendingCommands()),
    buildCompaniesSection(input.companies),
    buildPlannerSection(input.planner),
    buildDigestSection(computeWorldDigest(input.world)),
  ];
  if (sections.length !== PAYLOAD_SECTION_COUNT) {
    throw new Error("payload section table drifted");
  }
  const writer = new ByteWriter();
  for (const body of sections) {
    writer.u32(body.length);
    writer.bytes(body);
  }
  return writer.toUint8Array();
}

// ---- Parse ----------------------------------------------------------------------

function parseJson(raw: string, what: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`save ${what} section is not valid JSON`, { cause: error });
  }
}

function readFlaggedU32(
  reader: ByteReader,
  flagName: string,
): number | undefined {
  const present = reader.u8(flagName);
  if (present === 0) return undefined;
  if (present !== 1) {
    throw new Error(
      `save ${flagName} flag must be 0 or 1, got ${String(present)}`,
    );
  }
  return reader.u32(flagName);
}

/** Parse one u32-length-prefixed section header, validating its span. */
function openSection(reader: ByteReader, index: number, what: string): number {
  const length = reader.u32(`${what} section length`);
  if (length > reader.remaining()) {
    throw new Error(
      `save ${what} section (index ${String(index)}) declares ${String(length)} bytes but only ${String(reader.remaining())} remain`,
    );
  }
  return length;
}

/** Parse an UNCOMPRESSED snapshot payload produced by snapshotPayload. */
export function parsePayload(payload: Uint8Array): ParsedSimSave {
  const reader = new ByteReader(payload);

  // ---- 0 meta -----------------------------------------------------------------
  const metaLength = openSection(reader, 0, "meta");
  const metaRaw = new TextDecoder("utf-8", { fatal: true }).decode(
    reader.slice(metaLength, "meta json"),
  );
  const meta = parseJson(metaRaw, "meta") as {
    simVersion?: unknown;
    registryNames?: unknown;
  };
  if (
    typeof meta.simVersion !== "string" ||
    !Array.isArray(meta.registryNames) ||
    !meta.registryNames.every((name) => typeof name === "string")
  ) {
    throw new Error("save meta malformed: simVersion/registryNames missing");
  }
  const simVersion = meta.simVersion;
  const registryNames = meta.registryNames as string[];
  if (registryNames.length === 0) {
    throw new Error("save meta lists zero components");
  }

  // ---- 1 core -----------------------------------------------------------------
  openSection(reader, 1, "core");
  const lastAllocatedEid = reader.u32("lastAllocatedEid");
  const entityCount = reader.u32("entity count");
  const entities: number[] = [];
  let previous = 0;
  for (let i = 0; i < entityCount; i++) {
    const eid = reader.u32(`entity id ${String(i)}`);
    if (eid <= previous) {
      throw new Error(
        `saved entity ids must ascend strictly (${String(eid)} after ${String(previous)})`,
      );
    }
    previous = eid;
    entities.push(eid);
  }
  const prngWords = [
    reader.u32("prng word a"),
    reader.u32("prng word b"),
    reader.u32("prng word c"),
    reader.u32("prng word d"),
  ] as const;

  // ---- 2 components -----------------------------------------------------------
  openSection(reader, 2, "components");
  const componentCount = reader.u32("component count");
  if (componentCount !== registryNames.length) {
    throw new Error(
      `save component table mismatch: meta lists ${String(registryNames.length)}, payload carries ${String(componentCount)}`,
    );
  }
  const componentRows = new Map<string, Map<number, number[]>>();
  for (const name of registryNames) {
    const stored = reader.string(`component name`);
    if (stored !== name) {
      throw new Error(
        `save component order drifted: expected ${JSON.stringify(name)}, found ${JSON.stringify(stored)}`,
      );
    }
    const rowCount = reader.u32(`${name} liveCount`);
    const maxEid = reader.u32(`${name} maxEid`);
    let mask: Uint8Array | undefined;
    if (maxEid > 0) {
      mask = reader.slice(Math.ceil(maxEid / 8), `${name} alive bitmask`);
    }
    const rows = new Map<number, number[]>();
    // Rows follow in ascending-eid order; walk the mask to recover eids.
    const liveEids: number[] = [];
    if (mask !== undefined) {
      for (let eid = 1; eid <= maxEid; eid++) {
        if ((mask[(eid - 1) >> 3]! & (1 << ((eid - 1) & 7))) !== 0) {
          liveEids.push(eid);
        }
      }
    }
    if (liveEids.length !== rowCount) {
      throw new Error(
        `component ${name}: bitmask marks ${String(liveEids.length)} live rows, header says ${String(rowCount)}`,
      );
    }
    for (const eid of liveEids) {
      const valueCount = reader.u32(`${name}:${String(eid)} arity`);
      const values: number[] = [];
      for (let v = 0; v < valueCount; v++) {
        values.push(reader.f64(`${name}:${String(eid)} value`));
      }
      rows.set(eid, values);
    }
    componentRows.set(name, rows);
  }

  // ---- 3 map ------------------------------------------------------------------
  openSection(reader, 3, "map");
  const size = reader.u32("map size");
  const tileCount = size * size;
  if (tileCount <= 0 || size > 65536) {
    throw new Error(`save map size out of range: ${String(size)}`);
  }
  const mapBytes = reader.slice(tileCount * 3, "map layer bytes");

  // ---- 4 fog ------------------------------------------------------------------
  openSection(reader, 4, "fog");
  const fogSize = reader.u32("fog size");
  const playerCount = reader.u32("fog player count");
  if (playerCount < 1 || playerCount > 16) {
    throw new Error(
      `save fog player count out of range: ${String(playerCount)}`,
    );
  }
  const fogTiles = fogSize * fogSize;
  const planes: {
    explored: Uint8Array;
    visible: Uint8Array;
    contributorCount: Uint16Array;
  }[] = [];
  for (let player = 0; player < playerCount; player++) {
    planes.push({
      explored: reader.slice(fogTiles, `fog p${String(player)} explored`),
      visible: reader.slice(fogTiles, `fog p${String(player)} visible`),
      contributorCount: (() => {
        const counts = new Uint16Array(fogTiles);
        for (let i = 0; i < fogTiles; i++) {
          counts[i] = reader.u16(`fog p${String(player)} contributor`);
        }
        return counts;
      })(),
    });
  }
  const ghostTotal = reader.u32("fog ghost count");
  const ghostLists: {
    eid: number;
    defId: string;
    tileX: number;
    tileY: number;
  }[][] = Array.from({ length: playerCount }, () => []);
  for (let g = 0; g < ghostTotal; g++) {
    const viewer = reader.u32(`ghost ${String(g)} viewer`);
    if (viewer >= playerCount) {
      throw new Error(`save fog ghost viewer out of range: ${String(viewer)}`);
    }
    ghostLists[viewer]!.push({
      eid: reader.u32(`ghost ${String(g)} eid`),
      defId: reader.string(`ghost ${String(g)} defId`),
      tileX: reader.i32(`ghost ${String(g)} tileX`),
      tileY: reader.i32(`ghost ${String(g)} tileY`),
    });
  }
  const fog: FogSnapshot = {
    size: fogSize,
    playerCount,
    planes,
    ghosts: ghostLists,
  };

  // ---- 5 commands -------------------------------------------------------------
  openSection(reader, 5, "commands");
  const commandCount = reader.u32("command count");
  const commands: SimCommand[] = [];
  for (let i = 0; i < commandCount; i++) {
    const kind = reader.string(`command ${String(i)} kind`);
    const targetTick = reader.u32(`command ${String(i)} targetTick`);
    const dataLength = reader.u32(`command ${String(i)} data length`);
    if (dataLength === 0xffffffff) {
      commands.push({ kind, targetTick });
      continue;
    }
    const raw = reader.slice(dataLength, `command ${String(i)} data`);
    const parsed = parseJson(new TextDecoder().decode(raw), "command data");
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error(`save command ${kind} data must be an object`);
    }
    commands.push({
      kind,
      targetTick,
      data: parsed as Record<string, unknown>,
    });
  }

  // ---- 6 companies ------------------------------------------------------------
  openSection(reader, 6, "companies");
  const outputCount = reader.u32("company output stamp count");
  const lastOutputTickByBuilding = new Map<number, number>();
  for (let i = 0; i < outputCount; i++) {
    const eid = reader.u32(`output stamp ${String(i)} eid`);
    lastOutputTickByBuilding.set(
      eid,
      reader.u32(`output stamp ${String(i)} tick`),
    );
  }
  const cooldownCount = reader.u32("organic cooldown count");
  const lastOrganicFoundingTick = new Map<number, number>();
  for (let i = 0; i < cooldownCount; i++) {
    const player = reader.u32(`organic cooldown ${String(i)} player`);
    lastOrganicFoundingTick.set(
      player,
      reader.u32(`organic cooldown ${String(i)} tick`),
    );
  }

  // ---- 7 planner --------------------------------------------------------------
  openSection(reader, 7, "planner");
  const attackedTick = readFlaggedU32(reader, "planner attackedTick");
  const threatCount = reader.u32("planner threat count");
  const threatSince = new Map<number, number>();
  for (let i = 0; i < threatCount; i++) {
    const eid = reader.u32(`threat ${String(i)} eid`);
    threatSince.set(eid, reader.u32(`threat ${String(i)} tick`));
  }
  const lastRallyTick = readFlaggedU32(reader, "planner lastRallyTick");
  const countersTrained = reader.u32("planner countersTrained");

  // ---- 8 digest ---------------------------------------------------------------
  openSection(reader, 8, "digest");
  const stateDigest = reader.string("state digest");
  if (!stateDigest.startsWith("fnv1a64:")) {
    throw new Error(
      `save state digest malformed: ${JSON.stringify(stateDigest)}`,
    );
  }
  if (reader.remaining() !== 0) {
    throw new Error(
      `save payload carries ${String(reader.remaining())} trailing bytes after the final section`,
    );
  }

  return {
    simVersion,
    registryNames,
    lastAllocatedEid,
    entities,
    prngWords,
    componentRows,
    mapBytes,
    layers: deserializeLayersOrThrow(mapBytes),
    fog,
    commands,
    companies: { lastOutputTickByBuilding, lastOrganicFoundingTick },
    planner: { attackedTick, threatSince, lastRallyTick, countersTrained },
    stateDigest,
  };
}

function deserializeLayersOrThrow(bytes: Uint8Array): WorldLayers {
  try {
    return deserializeSavedLayers(bytes);
  } catch (error) {
    throw new Error(`save map layers rejected: ${String(error)}`, {
      cause: error,
    });
  }
}

/**
 * Rebuild layers from SAVED canonical bytes. Unlike the mapgen-path
 * deserializer, the stored passability plane is trusted verbatim: a
 * played world legitimately blocks tiles under buildings (placement
 * stamps passability at site birth), so re-deriving from terrain would
 * reject every mid-match save. Only enum ranges are enforced.
 */
function deserializeSavedLayers(bytes: Uint8Array): WorldLayers {
  if (bytes.length === 0 || bytes.length % 3 !== 0) {
    throw new Error(
      `map bytes must be a nonzero multiple of 3 (three planes), got ${String(bytes.length)}`,
    );
  }
  const tileCount = bytes.length / 3;
  const size = Math.sqrt(tileCount);
  if (!Number.isInteger(size)) {
    throw new Error(
      `map bytes encode ${String(tileCount)} tiles, which is not a perfect square`,
    );
  }
  const terrainType = bytes.slice(0, tileCount);
  const elevationLevel = bytes.slice(tileCount, tileCount * 2);
  const derivedPassability = bytes.slice(tileCount * 2, tileCount * 3);
  for (let i = 0; i < tileCount; i++) {
    if (terrainType[i]! >= TERRAIN_TYPE_COUNT) {
      throw new Error(
        `terrain byte ${String(i)} out of enum range: ${String(terrainType[i])}`,
      );
    }
    if (elevationLevel[i]! > MAX_ELEVATION_LEVEL) {
      throw new Error(
        `elevation byte ${String(i)} above level ${String(MAX_ELEVATION_LEVEL)}`,
      );
    }
    if (derivedPassability[i]! > PASSABLE) {
      throw new Error(
        `passability byte ${String(i)} must be 0 or 1: ${String(derivedPassability[i])}`,
      );
    }
  }
  return { size, terrainType, elevationLevel, derivedPassability };
}

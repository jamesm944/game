/**
 * Save manager — `.ageof` container + IndexedDB slots (SPEC §2.12 /
 * M5-T2, issue #64).
 *
 * The game-side half of the pipeline around sim/save/serialize.ts:
 *
 * - CONTAINER: uncompressed 36-byte header (`"AOF1"` magic | u32 format
 *   version | u32 seed | u32 tick | f64 playtime seconds | u64 FNV-1a-
 *   64 map hash | u32 payload length) followed by the fflate-gzipped
 *   payload. Tools can inspect version/seed/map-hash WITHOUT inflating;
 *   every decode validates loudly and in order: magic → version →
 *   framing length → gzip integrity → MAP HASH against the payload's
 *   own map bytes (forward-incompatible by design — a version bump
 *   invalidates old saves with a named error, never a silent desync).
 *
 * - STORAGE: IndexedDB (db `ageofwind`, store `saves`, keyPath `name`)
 *   holding `{name, savedAt, playtimeSeconds, saveBlob}` rows — three
 *   ROLLING autosave slots plus named manual slots. localStorage was
 *   ruled out by SPEC §2.12 (size). A second store (`pendingLoad`)
 *   stashes one decoded container across a page reload so Load can
 *   rebuild the session through the same boot path as Restart.
 *
 * - AUTOSAVE POLICY is pure and node-testable: every ~2 simulated
 *   minutes (3600 ticks @30 Hz) the game calls pickAutosaveTarget(),
 *   which fills autosave-1..3 in order and then evicts the OLDEST by
 *   savedAt (ties break to the lowest slot index).
 */

import { gzip, gunzipSync } from "fflate";
import { openDB as idbOpen, type IDBPDatabase } from "idb";
import { fnv1a64 } from "../sim/core/digest";

/** Current container format version — bumped invalidates old saves. */
export const AGEOF_FORMAT_VERSION = 1;

/** ASCII magic every `.ageof` file starts with ("age of wind", v1). */
const MAGIC = "AOF1";
const MAGIC_BYTES = new TextEncoder().encode(MAGIC);
/** magic(4) + version(4) + seed(4) + tick(4) + playtime(8) + hash(8) + len(4). */
export const HEADER_BYTES = 36;

/** Loud rejection for any malformed/mismatched `.ageof` input. */
export class SaveFormatError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SaveFormatError";
  }
}

export interface AgeofMeta {
  readonly formatVersion: number;
  readonly seed: number;
  readonly tick: number;
  readonly playtimeSeconds: number;
  /** FNV-1a-64 of the canonical map bytes, as an unsigned 64-bit int. */
  readonly mapHash: bigint;
}

// ---- Container codec ---------------------------------------------------------

function requireU32(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new SaveFormatError(`${what} out of u32 range: ${String(value)}`);
  }
}

/**
 * Assemble the `.ageof` container: header + gzipped payload (async —
 * SPEC §2.14 keeps compression off the frame loop).
 */
export async function encodeAgeof(
  meta: Omit<AgeofMeta, "formatVersion">,
  payload: Uint8Array,
): Promise<Uint8Array> {
  requireU32(meta.seed, "seed");
  requireU32(meta.tick, "tick");
  const compressed = await new Promise<Uint8Array>((resolve, reject) => {
    gzip(payload, (error, data) => (error ? reject(error) : resolve(data)));
  });
  if (compressed.length > 0xffffffff) {
    throw new SaveFormatError("gzipped payload exceeds u32 length");
  }
  const out = new Uint8Array(HEADER_BYTES + compressed.length);
  const view = new DataView(out.buffer);
  out.set(MAGIC_BYTES, 0);
  view.setUint32(4, AGEOF_FORMAT_VERSION, false);
  view.setUint32(8, meta.seed, false);
  view.setUint32(12, meta.tick, false);
  view.setFloat64(16, meta.playtimeSeconds, false);
  view.setBigUint64(24, meta.mapHash, false);
  view.setUint32(32, compressed.length, false);
  out.set(compressed, HEADER_BYTES);
  return out;
}

/**
 * Parse + validate a `.ageof` container, inflating the payload. Every
 * failure mode throws {@link SaveFormatError} with a message naming the
 * exact expectation violated (magic → version → framing → gzip →
 * map-hash).
 */
export function decodeAgeof(bytes: Uint8Array): {
  meta: AgeofMeta;
  payload: Uint8Array;
} {
  if (bytes.length < HEADER_BYTES) {
    throw new SaveFormatError(
      `not an .ageof save: ${String(bytes.length)} bytes is shorter than the ${String(HEADER_BYTES)}-byte header`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < MAGIC_BYTES.length; i++) {
    if (bytes[i] !== MAGIC_BYTES[i]) {
      throw new SaveFormatError(
        `.ageof magic mismatch: expected ${JSON.stringify(MAGIC)}, found ${JSON.stringify(String.fromCharCode(...bytes.subarray(0, 4)))}`,
      );
    }
  }
  const formatVersion = view.getUint32(4, false);
  if (formatVersion !== AGEOF_FORMAT_VERSION) {
    throw new SaveFormatError(
      `.ageof version mismatch: file is format ${String(formatVersion)}, this build reads ${String(AGEOF_FORMAT_VERSION)} — old saves are forward-incompatible`,
    );
  }
  const seed = view.getUint32(8, false);
  const tick = view.getUint32(12, false);
  const playtimeSeconds = view.getFloat64(16, false);
  const mapHash = view.getBigUint64(24, false);
  const payloadLen = view.getUint32(32, false);
  if (payloadLen !== bytes.length - HEADER_BYTES) {
    throw new SaveFormatError(
      `.ageof framing corrupt: header declares ${String(payloadLen)} payload bytes but the file carries ${String(bytes.length - HEADER_BYTES)}`,
    );
  }
  let payload: Uint8Array;
  try {
    payload = gunzipSync(bytes.subarray(HEADER_BYTES));
  } catch (error) {
    throw new SaveFormatError(
      `.ageof payload is not valid gzip data (${String(error)})`,
      { cause: error },
    );
  }
  return {
    meta: { formatVersion, seed, tick, playtimeSeconds, mapHash },
    payload,
  };
}

/**
 * Map-hash gate shared by decode callers: the header's stored hash must
 * equal FNV-1a-64 over the payload's OWN canonical map bytes — any
 * tampering/truncation inside the compressed section fails here.
 */
export function assertMapHash(
  meta: AgeofMeta,
  canonicalMapBytes: Uint8Array,
): void {
  const actual = fnv1a64(canonicalMapBytes);
  if (actual !== meta.mapHash) {
    const hex = (value: bigint): string => value.toString(16).padStart(16, "0");
    throw new SaveFormatError(
      `.ageof map-hash mismatch: header says fnv1a64:${hex(meta.mapHash)}, payload maps to fnv1a64:${hex(actual)} — wrong map or corrupted save`,
    );
  }
}

// ---- Slot storage --------------------------------------------------------------

/** One saved row exactly as SPEC §2.12 defines the store shape. */
export interface SaveRecord {
  readonly name: string;
  readonly savedAt: number;
  readonly playtimeSeconds: number;
  readonly saveBlob: Blob;
}

/** Minimal persistence surface (IndexedDB in production; fakes in tests). */
export interface SaveStore {
  put(record: SaveRecord): Promise<void>;
  get(name: string): Promise<SaveRecord | undefined>;
  delete(name: string): Promise<void>;
  getAll(): Promise<SaveRecord[]>;
  putPendingLoad(blob: Blob): Promise<void>;
  takePendingLoad(): Promise<Blob | undefined>;
}

interface StoredPendingLoad {
  readonly id: "boot";
  readonly blob: Blob;
}

/** Real IndexedDB store (db `ageofwind`, stores `saves` + `pendingLoad`). */
export function createIdbSaveStore(): SaveStore {
  let dbPromise: Promise<IDBPDatabase> | undefined;
  const db = (): Promise<IDBPDatabase> => {
    if (dbPromise === undefined) {
      dbPromise = idbOpen("ageofwind", 1, {
        upgrade(database) {
          if (!database.objectStoreNames.contains("saves")) {
            database.createObjectStore("saves", { keyPath: "name" });
          }
          if (!database.objectStoreNames.contains("pendingLoad")) {
            database.createObjectStore("pendingLoad", { keyPath: "id" });
          }
        },
      });
    }
    return dbPromise;
  };
  return {
    async put(record) {
      void (await db()).put("saves", record);
    },
    async get(name) {
      return (await (await db()).get("saves", name)) as SaveRecord | undefined;
    },
    async delete(name) {
      void (await db()).delete("saves", name);
    },
    async getAll() {
      return (await (await db()).getAll("saves")) as SaveRecord[];
    },
    async putPendingLoad(blob) {
      const record: StoredPendingLoad = { id: "boot", blob };
      void (await db()).put("pendingLoad", record);
    },
    async takePendingLoad() {
      const database = await db();
      const record = (await database.get("pendingLoad", "boot")) as
        StoredPendingLoad | undefined;
      if (record !== undefined) {
        void database.delete("pendingLoad", "boot");
      }
      return record?.blob;
    },
  };
}

// ---- Autosave policy (pure, node-testable) --------------------------------------

/** The three rolling autosave slots, oldest-evicted. */
export const AUTOSAVE_SLOT_NAMES = [
  "autosave-1",
  "autosave-2",
  "autosave-3",
] as const;

/** ~2 simulated minutes between autosaves (30 Hz fixed step). */
export const AUTOSAVE_INTERVAL_TICKS = 2 * 60 * 30;

/**
 * Which slot the next autosave lands in: the first EMPTY slot in order,
 * else the slot with the OLDEST savedAt (ties break to lowest index).
 */
export function pickAutosaveTarget(
  existing: readonly { readonly name: string; readonly savedAt: number }[],
): string {
  const byName = new Map(existing.map((record) => [record.name, record]));
  for (const slot of AUTOSAVE_SLOT_NAMES) {
    if (!byName.has(slot)) return slot;
  }
  let target: string = AUTOSAVE_SLOT_NAMES[0];
  let oldestAt = byName.get(target)?.savedAt ?? Number.POSITIVE_INFINITY;
  for (const slot of AUTOSAVE_SLOT_NAMES.slice(1)) {
    const savedAt = byName.get(slot)?.savedAt ?? Number.POSITIVE_INFINITY;
    if (savedAt < oldestAt) {
      target = slot;
      oldestAt = savedAt;
    }
  }
  return target;
}

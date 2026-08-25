/**
 * Atlas bake v2 — real-rig turntable sampler (issue #72, SPEC §6).
 *
 * For every unit definition the manifest (manifest.ts) selects real
 * vendored CC0 rigs: Quaternius Universal Base Characters animated by
 * the Universal Animation Library clips, KayKit Adventurers characters
 * with their weapon accessories, and a horse+rider kitbash for the
 * scout. Each action clip is sampled frame-by-frame × 8 yaws and
 * rasterized into 128 px cells of stacked 2048² bands inside ONE
 * physical PNG per unit (see planAtlasLayout for the vertical-stack
 * rule that keeps runtime consumers single-texture).
 *
 * Outputs per unit:
 *   <out>/<unitDefId>.png          atlas image (2048 × 2048·pagesY)
 *   <out>/<unitDefId>.frames.json  frame index {action,yaw,frame → uvRect}
 *
 * DETERMINISM: no clock reads, no randomness; actions sort by name in
 * the planner; sampling order is fixed; zlib/JSON serialization are
 * fixed. Identical inputs produce byte-identical outputs — each run
 * prints sha256 per artifact so rebakes can be compared, and records
 * source-file hashes in the index so input drift is detectable.
 *
 * Usage:
 *   npx tsx tools/atlas-bake/index.ts [--all | --units villager,militia]
 *     [--out src/assets/atlas] [--frame-size 128] [--page-size 2048]
 *     [--yaw-count 8] [--pitch-deg 55] [--debug-dump <dir>]
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Matrix4, Object3D } from "three";
import {
  PLAYBACK_QUANTUM_FPS,
  planAtlasLayout,
  type AtlasActionMeta,
} from "../../src/render/atlasFrames";
import {
  clearFramebuffer,
  createFramebuffer,
  flattenScene,
  rasterizeView,
  turntableMvp,
  type Framebuffer,
} from "./raster";
import { encodePng } from "./png";
import { UNIT_BAKES, UNIT_BAKE_IDS, type UnitBake } from "./manifest";
import {
  assembleRig,
  attachProps,
  detachProps,
  type AssembledRig,
} from "./rig";

interface BakeOptions {
  unitIds: string[];
  outDir: string;
  frameSize: number;
  pageSize: number;
  yawCount: number;
  pitchDeg: number;
  debugDumpDir?: string | undefined;
}

function parseArgs(argv: readonly string[]): BakeOptions {
  const options: BakeOptions = {
    unitIds: [...UNIT_BAKE_IDS],
    outDir: "src/assets/atlas",
    frameSize: 128,
    pageSize: 2048,
    yawCount: 8,
    pitchDeg: 55,
  };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    switch (argv[i]) {
      case "--all":
        break;
      case "--units":
        if (!value) throw new Error("--units needs comma-separated ids");
        options.unitIds = value.split(",").map((s) => s.trim());
        i++;
        break;
      case "--out":
        if (!value) throw new Error("--out needs a directory");
        options.outDir = value;
        i++;
        break;
      case "--frame-size":
        options.frameSize = Number(value);
        i++;
        break;
      case "--page-size":
        options.pageSize = Number(value);
        i++;
        break;
      case "--yaw-count":
        options.yawCount = Number(value);
        i++;
        break;
      case "--pitch-deg":
        options.pitchDeg = Number(value);
        i++;
        break;
      case "--debug-dump":
        if (!value) throw new Error("--debug-dump needs a directory");
        options.debugDumpDir = value;
        i++;
        break;
      default:
        throw new Error(`unknown argument ${String(argv[i])}`);
    }
  }
  if (
    !Number.isInteger(options.frameSize) ||
    options.frameSize <= 0 ||
    options.pageSize % options.frameSize !== 0 ||
    !Number.isInteger(options.yawCount) ||
    options.yawCount <= 0 ||
    !Number.isFinite(options.pitchDeg)
  ) {
    throw new Error("invalid size/yaw/pitch arguments");
  }
  const known = new Set<string>(UNIT_BAKE_IDS);
  for (const id of options.unitIds) {
    if (!known.has(id)) {
      throw new Error(
        `unknown unit "${id}" (known: ${UNIT_BAKE_IDS.join(", ")})`,
      );
    }
  }
  return options;
}

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

async function hashFile(file: string): Promise<string> {
  return sha256(new Uint8Array(await fs.readFile(file)));
}

/** A debug strip image ready for PNG encoding. */
interface DebugStrip {
  width: number;
  height: number;
  rgba: Uint8Array;
}

interface BakeResult {
  pngBytes: Buffer;
  pagesY: number;
  minCoverage: number;
  maxCoverage: number;
  /** Frame-0 yaw strip / yaw-0 frame strip per action (--debug-dump). */
  debugStrips: Map<string, DebugStrip>;
}

function bakeUnit(
  bake: UnitBake,
  options: BakeOptions,
  rig: AssembledRig,
): BakeResult {
  const metas: AtlasActionMeta[] = bake.actions.map((a) => ({
    name: a.name,
    frameCount: a.frameCount,
    fps: a.fps,
  }));
  const layout = planAtlasLayout(
    metas,
    options.yawCount,
    options.frameSize,
    options.pageSize,
  );
  const columns = layout.columns;
  const rowsPerBand = layout.rows;

  // Wrapper owns the yaw rotation; mixers never fight it because clip
  // tracks target named children, not this node.
  const wrapper = new Object3D();
  wrapper.add(rig.root);

  const fb = createFramebuffer(options.frameSize);
  const mvp = turntableMvp({
    halfExtent: bake.halfExtent,
    pitchRad: (options.pitchDeg * Math.PI) / 180,
    distance: 10,
    focusY: bake.focusY,
  });

  const heightPx = options.pageSize * layout.pagesY;
  const pageCanvas = new Uint8Array(heightPx * options.pageSize * 4);
  // Debug strips collect frame-0 rows per action when --debug-dump set.
  const debugStrips = options.debugDumpDir
    ? new Map<string, DebugStrip>()
    : undefined;

  const modelRot = new Matrix4();
  let minCoverage = Infinity;
  let maxCoverage = 0;

  for (const action of layout.actions) {
    attachProps(rig.actions.get(action.name)!, rig.root);

    for (let f = 0; f < action.frameCount; f++) {
      // Pose once at identity rotation; skinning + flattening run per
      // FRAME, not per yaw — the 8 yaws reuse the cached triangles via
      // the pure-rotation model matrix below.
      const assembled = rig.actions.get(action.name)!;
      for (const mixerAction of assembled.mixerActions) {
        mixerAction.time = f / action.fps;
      }
      for (const mixer of assembled.mixers) mixer.update(0);
      wrapper.updateMatrixWorld(true);
      const tris = flattenScene(wrapper);

      if (debugStrips) {
        if (!debugStrips.has(`${action.name}__yaws`)) {
          debugStrips.set(`${action.name}__yaws`, {
            width: layout.yawCount * options.frameSize,
            height: options.frameSize,
            rgba: new Uint8Array(
              layout.yawCount * options.frameSize * options.frameSize * 4,
            ),
          });
        }
        if (!debugStrips.has(`${action.name}__frames`)) {
          debugStrips.set(`${action.name}__frames`, {
            width: action.frameCount * options.frameSize,
            height: options.frameSize,
            rgba: new Uint8Array(
              action.frameCount * options.frameSize * options.frameSize * 4,
            ),
          });
        }
      }

      for (let yaw = 0; yaw < layout.yawCount; yaw++) {
        modelRot.makeRotationY((yaw * Math.PI * 2) / layout.yawCount);
        clearFramebuffer(fb);
        rasterizeView(fb, tris, mvp, modelRot);

        let coverage = 0;
        for (let p = 3; p < fb.rgba.length; p += 4) {
          if (fb.rgba[p]! !== 0) coverage++;
        }
        minCoverage = Math.min(minCoverage, coverage);
        maxCoverage = Math.max(maxCoverage, coverage);

        const abs = action.baseFrame + yaw * action.frameCount + f;
        const col = abs % columns;
        const rowInBand = Math.floor(abs / columns) % rowsPerBand;
        const band = Math.floor(abs / layout.cellsPerPage);
        blitCell(
          pageCanvas,
          fb,
          col * options.frameSize,
          (band * rowsPerBand + rowInBand) * options.frameSize,
          options.pageSize,
        );

        if (debugStrips && f === 0) {
          blitCell(
            debugStrips.get(`${action.name}__yaws`)!.rgba,
            fb,
            yaw * options.frameSize,
            0,
            layout.yawCount * options.frameSize,
          );
        }
        if (debugStrips && yaw === 0) {
          blitCell(
            debugStrips.get(`${action.name}__frames`)!.rgba,
            fb,
            f * options.frameSize,
            0,
            action.frameCount * options.frameSize,
          );
        }
      }
    }

    detachProps(rig.actions.get(action.name)!);
  }

  const pngBytes = encodePng(options.pageSize, heightPx, pageCanvas);
  return {
    pngBytes,
    pagesY: layout.pagesY,
    minCoverage,
    maxCoverage,
    debugStrips: debugStrips ?? new Map(),
  };
}

/** Copy one rendered cell into a row-major RGBA canvas at (x, y). */
function blitCell(
  canvas: Uint8Array,
  fb: Framebuffer,
  dstX: number,
  dstY: number,
  canvasWidth: number,
): void {
  for (let y = 0; y < fb.height; y++) {
    const src = y * fb.width * 4;
    const dst = ((dstY + y) * canvasWidth + dstX) * 4;
    canvas.set(fb.rgba.subarray(src, src + fb.width * 4), dst);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await fs.mkdir(options.outDir, { recursive: true });
  if (options.debugDumpDir) {
    await fs.mkdir(options.debugDumpDir, { recursive: true });
  }

  for (const bake of UNIT_BAKES.filter((u) => options.unitIds.includes(u.id))) {
    const startedAtMs = Date.now();
    const rig = await assembleRig(bake);
    // Props stay detached until their action's sampling window.
    for (const action of rig.actions.values()) detachProps(action);

    const result = bakeUnit(bake, options, rig);

    const pngPath = path.join(options.outDir, `${bake.id}.png`);
    await fs.writeFile(pngPath, result.pngBytes);

    const metas: AtlasActionMeta[] = bake.actions.map((a) => ({
      name: a.name,
      frameCount: a.frameCount,
      fps: a.fps,
    }));
    const layout = planAtlasLayout(
      metas,
      options.yawCount,
      options.frameSize,
      options.pageSize,
    );

    const sourceFiles = [
      ...new Set([
        ...bake.parts.map((p) => p.file),
        ...bake.actions.flatMap((a) => a.props ?? []).map((p) => p.file),
      ]),
    ].sort();
    const hashes: Array<{ file: string; sha256: string }> = [];
    for (const rel of sourceFiles) {
      hashes.push({
        file: `src/assets/models/${rel}`,
        sha256: await hashFile(path.join("src/assets/models", rel)),
      });
    }

    const indexJson = {
      id: `atlas/${bake.id}`,
      generator: "tools/atlas-bake@2",
      generatorNote:
        "real CC0 rigs via tools/atlas-bake manifest.ts (issue #72); bands stack vertically into one image",
      provenance: hashes.map((h) => `${h.file} sha256=${h.sha256}`).join("; "),
      sourceFiles: hashes,
      gaps: bake.gaps ?? [],
      frameSize: options.frameSize,
      pageSize: options.pageSize,
      columns: layout.columns,
      rows: layout.rows,
      cellsPerPage: layout.cellsPerPage,
      pageCount: layout.pageCount,
      pagesY: layout.pagesY,
      yawCount: layout.yawCount,
      totalFrames: layout.totalFrames,
      quantumFps: PLAYBACK_QUANTUM_FPS,
      actions: layout.actions.map((a) => ({
        name: a.name,
        slot: layout.actions.findIndex((x) => x === a),
        baseFrame: a.baseFrame,
        frameCount: a.frameCount,
        fps: a.fps,
        duration: a.duration,
        page: a.page,
      })),
      rects: Array.from({ length: layout.totalFrames }, (_, abs) => [
        layout.rects[abs * 4]!,
        layout.rects[abs * 4 + 1]!,
        layout.rects[abs * 4 + 2]!,
        layout.rects[abs * 4 + 3]!,
      ]),
    };
    const jsonText = `${JSON.stringify(indexJson, null, 2)}\n`;
    const jsonPath = path.join(options.outDir, `${bake.id}.frames.json`);
    await fs.writeFile(jsonPath, jsonText, "utf8");

    for (const [actionName, strip] of result.debugStrips) {
      const stripPath = path.join(
        options.debugDumpDir ?? ".",
        `${bake.id}__${actionName}.png`,
      );
      await fs.writeFile(
        stripPath,
        encodePng(strip.width, strip.height, strip.rgba),
      );
    }

    console.log(
      `atlas-bake[${bake.id}]: ${layout.totalFrames} frames` +
        ` (${layout.actions.map((a) => a.name).join(", ")})` +
        ` × ${layout.yawCount} yaws @ ${options.frameSize}px` +
        ` bands=${result.pagesY}`,
    );
    console.log(
      `coverage px/cell: min=${result.minCoverage} max=${result.maxCoverage}`,
    );
    console.log(`${pngPath}  sha256=${sha256(result.pngBytes)}`);
    console.log(`${jsonPath}  sha256=${sha256(jsonText)}`);
    console.log(`elapsed=${((Date.now() - startedAtMs) / 1000).toFixed(1)}s`);
  }

  if (options.debugDumpDir) {
    console.log(`debug strips written to ${options.debugDumpDir}`);
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exitCode = 1;
});

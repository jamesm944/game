/**
 * Headless GLTF scene loading for the atlas bake (change #1 of the
 * ASSET-INVENTORY 6-change list: the tool now consumes the vendored
 * CC0 packs directly, not just self-contained .glb files).
 *
 * Two load paths, both network-free and deterministic:
 *
 * - `.glb`: raw bytes straight into GLTFLoader.parse (embedded
 *   buffers/textures). KayKit characters and the UAL libraries are
 *   vendored this way.
 * - `.gltf`: JSON is pre-processed before parsing — external `.bin`
 *   buffer URIs are inlined as base64 data URIs read from sibling
 *   files (Quaternius UBC ships gltf+bin+png), and every texture
 *   reference is stripped. The CPU rasterizer shades flat gray from
 *   geometry normals only, so images cost parse failures for nothing.
 */

import "./nodeShims";

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AnimationClip, Object3D } from "three";
import type { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export interface GltfScene {
  scene: Object3D;
  animations: AnimationClip[];
}

/** Subset of a .gltf JSON document this module needs to touch. */
interface GltfJson {
  buffers?: Array<{ uri?: string }>;
  images?: unknown;
  textures?: unknown;
  samplers?: unknown;
  materials?: Array<Record<string, unknown>>;
}

type ParseFn = (
  data: ArrayBuffer | string,
  resourcePath: string,
  onLoad: (scene: GltfScene) => void,
  onError: (error: unknown) => void,
) => void;

function parseGltf(
  loader: GLTFLoader,
  data: ArrayBuffer | string,
): Promise<GltfScene> {
  return new Promise<GltfScene>((resolve, reject) => {
    (loader.parse as unknown as ParseFn)(data, "", resolve, reject);
  });
}

function stripTextureReferences(json: GltfJson): void {
  delete json.images;
  delete json.textures;
  delete json.samplers;
  for (const mat of json.materials ?? []) {
    const pbr = mat.pbrMetallicRoughness as Record<string, unknown> | undefined;
    if (pbr) {
      delete pbr.baseColorTexture;
      delete pbr.metallicRoughnessTexture;
    }
    delete mat.normalTexture;
    delete mat.occlusionTexture;
    delete mat.emissiveTexture;
    delete mat.extensions;
  }
}

async function loadGlb(loader: GLTFLoader, file: string): Promise<GltfScene> {
  const bytes = await fs.readFile(file);
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  return parseGltf(loader, ab);
}

async function loadGltfJson(
  loader: GLTFLoader,
  file: string,
): Promise<GltfScene> {
  const dir = path.dirname(file);
  const json = JSON.parse(await fs.readFile(file, "utf8")) as GltfJson;
  stripTextureReferences(json);
  for (const buf of json.buffers ?? []) {
    if (buf.uri && !buf.uri.startsWith("data:")) {
      const bin = await fs.readFile(
        path.join(dir, decodeURIComponent(buf.uri)),
      );
      buf.uri = `data:application/octet-stream;base64,${bin.toString("base64")}`;
    }
  }
  return parseGltf(loader, JSON.stringify(json));
}

/** Parse any vendored gltf/glb into a three scene + animation clips. */
export async function loadGltfScene(file: string): Promise<GltfScene> {
  const { GLTFLoader } =
    await import("three/examples/jsm/loaders/GLTFLoader.js");
  const loader = new GLTFLoader();
  return file.toLowerCase().endsWith(".glb")
    ? loadGlb(loader, file)
    : loadGltfJson(loader, file);
}

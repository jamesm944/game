/**
 * Node-side browser globals required by three's GLTFLoader/FileLoader.
 *
 * GLTFLoader was written for browsers: its FileLoader reports progress
 * through `ProgressEvent` and some code paths probe `self`. Neither
 * exists in Node, so the bake installs minimal shims before any parse.
 * Import this module FIRST — before any dynamic GLTFLoader import.
 */

type GlobalWithExtras = typeof globalThis & Record<string, unknown>;

const g = globalThis as GlobalWithExtras;

if (typeof g.self === "undefined") {
  // GLTFLoader probes `self.URL` on its blob-texture path only; the
  // bake strips textures before parse, so aliasing globalThis suffices.
  (g as { self: unknown }).self = g;
}

if (typeof g.ProgressEvent === "undefined") {
  class ProgressEventShim {
    readonly type: string;
    lengthComputable: boolean;
    loaded: number;
    total: number;
    constructor(
      type: string,
      options?: { lengthComputable?: boolean; loaded?: number; total?: number },
    ) {
      this.type = type;
      this.lengthComputable = options?.lengthComputable ?? false;
      this.loaded = options?.loaded ?? 0;
      this.total = options?.total ?? 0;
    }
  }
  g.ProgressEvent = ProgressEventShim as unknown as typeof ProgressEvent;
}

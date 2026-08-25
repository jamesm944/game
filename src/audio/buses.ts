/** Mix graph: master → {music, sfx, ui, ambient} GainNodes; volumes persist to localStorage; ducking for jingles/stingers (SPEC §2.10). */

export type BusName = "music" | "sfx" | "ui" | "ambient";
/** localStorage key volumes persist under (ui/settings.ts writes the same format). */
export const VOLUME_KEY = "ageofwind.volumes";

/**
 * Default bus gains — the single source shared by createBuses's
 * loadVolume and the settings panel's initial slider positions.
 */
export const DEFAULT_BUS_VOLUMES: Readonly<Record<BusName | "master", number>> =
  Object.freeze({
    master: 0.8,
    music: 0.6,
    sfx: 0.9,
    ui: 0.7,
    ambient: 0.5,
  });

const DEFAULTS = DEFAULT_BUS_VOLUMES;

export interface Buses {
  master: GainNode;
  music: GainNode;
  sfx: GainNode;
  ui: GainNode;
  ambient: GainNode;
}

export function createBuses(ctx: AudioContext): Buses {
  const master = ctx.createGain();
  master.connect(ctx.destination);
  const make = (name: BusName): GainNode => {
    const g = ctx.createGain();
    g.gain.value = loadVolume(name);
    g.connect(master);
    return g;
  };
  const buses: Buses = {
    master,
    music: make("music"),
    sfx: make("sfx"),
    ui: make("ui"),
    ambient: make("ambient"),
  };
  master.gain.value = loadVolume("master");
  return buses;
}

function loadVolume(name: BusName | "master"): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    if (!raw) return DEFAULTS[name];
    const parsed = JSON.parse(raw) as Partial<
      Record<BusName | "master", number>
    >;
    const v = parsed[name];
    return typeof v === "number" ? Math.min(1, Math.max(0, v)) : DEFAULTS[name];
  } catch {
    return DEFAULTS[name];
  }
}

export function setBusVolume(
  buses: Buses,
  name: BusName | "master",
  v: number,
): void {
  const g = name === "master" ? buses.master : buses[name];
  g.gain.value = Math.min(1, Math.max(0, v));
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    parsed[name] = g.gain.value;
    localStorage.setItem(VOLUME_KEY, JSON.stringify(parsed));
  } catch {
    /* private mode — volume is session-only */
  }
}

/** Momentarily lower music so a stinger reads (equal-power-ish ramp). */
export function duckMusic(
  buses: Buses,
  ctx: AudioContext,
  to = 0.25,
  ms = 900,
): void {
  const now = ctx.currentTime;
  const target = buses.music.gain.value;
  buses.music.gain.cancelScheduledValues(now);
  buses.music.gain.setValueAtTime(target, now);
  buses.music.gain.linearRampToValueAtTime(target * to, now + 0.08);
  buses.music.gain.setValueAtTime(target * to, now + ms / 1000);
  buses.music.gain.linearRampToValueAtTime(target, now + ms / 1000 + 0.6);
}

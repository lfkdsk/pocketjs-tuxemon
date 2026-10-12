// Player-owned preferences. These deliberately live outside reducer/session
// state and save envelopes: a preference follows the installation, not one
// campaign slot. The three stores mirror the game's save channels while
// keeping a separate key/path on every target.

import { fsHost, readFileSync, write } from "@pocketjs/framework/fs";
import { BTN } from "@pocketjs/framework/input";
import type { AudioDriverState } from "../vendor/pocket-rpgkit/src/ui/audio/index.ts";
import type { SoundCue } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";
import { pspSaveHost } from "./save-psp.ts";

export const SETTINGS_FORMAT = "pocket-tuxemon-settings";
export const SETTINGS_VERSION = 1;
export const SETTINGS_STORAGE_KEY = "pocket-tuxemon/settings";
export const SETTINGS_FS_ENTRY = "settings.json";
export const SETTINGS_PSP_ENTRY = "save/settings.json";

export const CONTROL_ACTIONS = [
  "up",
  "left",
  "right",
  "down",
  "primary",
  "secondary",
  "back",
] as const;

export type ControlAction = (typeof CONTROL_ACTIONS)[number];
export type PhysicalButton = ControlAction;
export type UnitMeasure = "metric" | "imperial";
export type Hemisphere = "northern" | "southern";
export type ScreenScale = "auto";

export type ControlBindings = Readonly<Record<ControlAction, PhysicalButton>>;

export interface GameSettings {
  readonly controls: ControlBindings;
  readonly musicMuted: boolean;
  /** Percentage, matching upstream's 0..100 slider. */
  readonly musicVolume: number;
  /** Percentage, matching upstream's 0..100 slider. */
  readonly soundVolume: number;
  readonly units: UnitMeasure;
  readonly hemisphere: Hemisphere;
  /** PocketJS owns the physical/window scale; the guest logical size stays 480x272. */
  readonly screenScale: ScreenScale;
}

interface SettingsDocument extends GameSettings {
  readonly format: typeof SETTINGS_FORMAT;
  readonly version: typeof SETTINGS_VERSION;
}

const DEFAULT_CONTROLS: ControlBindings = Object.freeze({
  up: "up",
  left: "left",
  right: "right",
  down: "down",
  primary: "primary",
  secondary: "secondary",
  back: "back",
});

/** Upstream defaults: music .5, effects .2, metric, northern hemisphere. */
export const DEFAULT_SETTINGS: Readonly<GameSettings> = Object.freeze({
  controls: DEFAULT_CONTROLS,
  musicMuted: false,
  musicVolume: 50,
  soundVolume: 20,
  units: "metric",
  hemisphere: "northern",
  screenScale: "auto",
});

export function defaultSettings(): GameSettings {
  return { ...DEFAULT_SETTINGS, controls: { ...DEFAULT_CONTROLS } };
}

/** Python's round()/fixed-point formatting uses round-half-to-even, while
 * JavaScript's Math.round()/toFixed() do not. Measurements are non-negative,
 * so this small helper is enough to reproduce the upstream journal exactly. */
export function roundHalfEven(value: number, digits = 0): number {
  const scale = 10 ** digits;
  const scaled = value * scale;
  const lower = Math.floor(scaled);
  const fraction = scaled - lower;
  const tieTolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 2;
  if (Math.abs(fraction - 0.5) <= tieTolerance) {
    return (lower % 2 === 0 ? lower : lower + 1) / scale;
  }
  return Math.round(scaled) / scale;
}

/** Match Tuxemon journal_info.py/formula.py unit formatting. */
export function formatMonsterHeight(centimeters: number, units: UnitMeasure): string {
  if (units === "imperial") return `${roundHalfEven(centimeters * 0.032808399)} ft`;
  return centimeters >= 100
    ? `${roundHalfEven(centimeters / 100, 1).toFixed(1)} m`
    : `${roundHalfEven(centimeters)} cm`;
}

/** Match Tuxemon journal_info.py/formula.py unit formatting. */
export function formatMonsterWeight(kilograms: number, units: UnitMeasure): string {
  if (units === "imperial") return `${roundHalfEven(kilograms * 2.2046)} lb`;
  return kilograms >= 1_000
    ? `${roundHalfEven(kilograms / 1_000, 1).toFixed(1)} t`
    : `${roundHalfEven(kilograms)} kg`;
}

/** Match character.py's two-stage steps -> km -> mi conversion. */
export function formatWalkedDistance(steps: number, units: UnitMeasure): string {
  const kilometers = roundHalfEven(Math.max(0, steps) / 1_000, 2);
  if (units === "imperial") {
    return `${roundHalfEven(kilometers * 0.6213711922, 2)} mi`;
  }
  return `${kilometers} km`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPercent(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100;
}

function isPhysicalButton(value: unknown): value is PhysicalButton {
  return typeof value === "string" && (CONTROL_ACTIONS as readonly string[]).includes(value);
}

function decodeControls(value: unknown): ControlBindings | null {
  if (!isRecord(value)) return null;
  const controls = {} as Record<ControlAction, PhysicalButton>;
  const used = new Set<PhysicalButton>();
  for (const action of CONTROL_ACTIONS) {
    const button = value[action];
    if (!isPhysicalButton(button) || used.has(button)) return null;
    controls[action] = button;
    used.add(button);
  }
  return controls;
}

/** Strict whole-document decoder. A partial/damaged preference file never
 * leaks half-valid values into play: callers fall back to all defaults. */
export function decodeSettings(text: string): GameSettings | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.format !== SETTINGS_FORMAT || value.version !== SETTINGS_VERSION) {
    return null;
  }
  const controls = decodeControls(value.controls);
  if (
    controls === null
    || typeof value.musicMuted !== "boolean"
    || !isPercent(value.musicVolume)
    || !isPercent(value.soundVolume)
    || (value.units !== "metric" && value.units !== "imperial")
    || (value.hemisphere !== "northern" && value.hemisphere !== "southern")
    || value.screenScale !== "auto"
  ) {
    return null;
  }
  return {
    controls,
    musicMuted: value.musicMuted,
    musicVolume: value.musicVolume,
    soundVolume: value.soundVolume,
    units: value.units,
    hemisphere: value.hemisphere,
    screenScale: value.screenScale,
  };
}

export function encodeSettings(settings: Readonly<GameSettings>): string {
  const document: SettingsDocument = {
    format: SETTINGS_FORMAT,
    version: SETTINGS_VERSION,
    controls: Object.fromEntries(
      CONTROL_ACTIONS.map((action) => [action, settings.controls[action]]),
    ) as Record<ControlAction, PhysicalButton>,
    musicMuted: settings.musicMuted,
    musicVolume: settings.musicVolume,
    soundVolume: settings.soundVolume,
    units: settings.units,
    hemisphere: settings.hemisphere,
    screenScale: settings.screenScale,
  };
  return JSON.stringify(document);
}

export type SettingsChannel = "browser" | "desktop" | "psp";

export interface SettingsStore {
  readonly channel: SettingsChannel;
  read(): string | null;
  write(text: string): void;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): StorageLike | null {
  try {
    const storage = (globalThis as { localStorage?: unknown }).localStorage;
    if (
      !storage || typeof storage !== "object"
      || typeof (storage as StorageLike).getItem !== "function"
      || typeof (storage as StorageLike).setItem !== "function"
      || typeof (storage as StorageLike).removeItem !== "function"
    ) return null;
    // Some private modes expose Storage but reject every write. A bounded
    // probe makes the unavailable channel fail at detection, not on Save.
    const candidate = storage as StorageLike;
    const probe = `${SETTINGS_STORAGE_KEY}/probe`;
    candidate.setItem(probe, "1");
    candidate.removeItem(probe);
    return candidate;
  } catch {
    return null;
  }
}

/** Desktop data.fs first, then the PSP memory-stick bridge, then Web Storage. */
export function detectSettingsStore(): SettingsStore | null {
  if (fsHost()) {
    return {
      channel: "desktop",
      read() {
        try {
          return readFileSync(SETTINGS_FS_ENTRY, "utf8");
        } catch {
          return null;
        }
      },
      write(text) {
        write(SETTINGS_FS_ENTRY, text);
      },
    };
  }
  const psp = pspSaveHost();
  if (psp) {
    return {
      channel: "psp",
      read() {
        try {
          return psp.read(SETTINGS_PSP_ENTRY) ?? null;
        } catch {
          return null;
        }
      },
      write(text) {
        psp.write(SETTINGS_PSP_ENTRY, text);
      },
    };
  }
  const storage = browserStorage();
  return storage ? {
    channel: "browser",
    read: () => storage.getItem(SETTINGS_STORAGE_KEY),
    write: (text) => storage.setItem(SETTINGS_STORAGE_KEY, text),
  } : null;
}

/** Missing, unreadable and malformed files all select a fresh complete default. */
export function loadSettings(store: SettingsStore | null = detectSettingsStore()): GameSettings {
  if (!store) return defaultSettings();
  try {
    const text = store.read();
    return text === null ? defaultSettings() : decodeSettings(text) ?? defaultSettings();
  } catch {
    return defaultSettings();
  }
}

/** Best-effort persistence: live preferences still take effect when a device
 * becomes read-only, and the UI can report false without throwing a frame. */
export function persistSettings(
  settings: Readonly<GameSettings>,
  store: SettingsStore | null = detectSettingsStore(),
): boolean {
  if (!store) return false;
  try {
    store.write(encodeSettings(settings));
    return true;
  } catch (error) {
    globalThis.console?.debug?.("pocket-tuxemon: settings write failed", error);
    return false;
  }
}

export interface SettingsController {
  readonly channel: SettingsChannel | null;
  get(): Readonly<GameSettings>;
  revision(): number;
  replace(next: Readonly<GameSettings>): boolean;
  update(change: (current: Readonly<GameSettings>) => GameSettings): boolean;
  resetControls(): boolean;
}

/** One controller is created by the application shell and shared by Options,
 * input and audio. It contains no Solid dependency, so focused tests and the
 * QuickJS hot path can use the same implementation. */
export function createSettingsController(
  store: SettingsStore | null = detectSettingsStore(),
): SettingsController {
  let current = loadSettings(store);
  let revision = 0;
  const replace = (next: Readonly<GameSettings>): boolean => {
    // Re-decode our stable document so callers cannot install an invalid
    // object through an unchecked cast.
    const validated = decodeSettings(encodeSettings(next));
    if (!validated) return false;
    current = validated;
    revision++;
    return persistSettings(current, store);
  };
  return {
    channel: store?.channel ?? null,
    get: () => current,
    revision: () => revision,
    replace,
    update(change) {
      return replace(change(current));
    },
    resetControls() {
      return replace({ ...current, controls: { ...DEFAULT_CONTROLS } });
    },
  };
}

export interface ControlBindingResult {
  readonly settings: GameSettings;
  readonly conflict: ControlAction | null;
}

/** Duplicate physical bindings would make the later upstream mapping hide
 * the earlier one. The port surfaces that fact and rejects it explicitly. */
export function bindControl(
  settings: Readonly<GameSettings>,
  action: ControlAction,
  button: PhysicalButton,
): ControlBindingResult {
  const conflict = CONTROL_ACTIONS.find(
    (candidate) => candidate !== action && settings.controls[candidate] === button,
  ) ?? null;
  if (conflict) return { settings: { ...settings, controls: { ...settings.controls } }, conflict };
  return {
    settings: {
      ...settings,
      controls: { ...settings.controls, [action]: button },
    },
    conflict: null,
  };
}

/** Accept a detected conflict as an explicit swap. Every one of the seven
 * physical slots remains reachable, unlike upstream's last-key-wins map. */
export function swapControl(
  settings: Readonly<GameSettings>,
  action: ControlAction,
  button: PhysicalButton,
): GameSettings {
  const conflict = CONTROL_ACTIONS.find(
    (candidate) => candidate !== action && settings.controls[candidate] === button,
  );
  if (!conflict) return { ...settings, controls: { ...settings.controls, [action]: button } };
  const previous = settings.controls[action];
  return {
    ...settings,
    controls: {
      ...settings.controls,
      [action]: button,
      [conflict]: previous,
    },
  };
}

export const PHYSICAL_BUTTON_MASK: Readonly<Record<PhysicalButton, number>> = Object.freeze({
  up: BTN.UP,
  left: BTN.LEFT,
  right: BTN.RIGHT,
  down: BTN.DOWN,
  primary: BTN.CIRCLE,
  secondary: BTN.TRIANGLE,
  back: BTN.CROSS,
});

/** Canonical masks consumed by the imported game. A physical slot can move,
 * but these semantic outputs remain stable for every reducer/overlay. */
export const CONTROL_ACTION_MASK: Readonly<Record<ControlAction, number>> = Object.freeze({
  up: BTN.UP,
  left: BTN.LEFT,
  right: BTN.RIGHT,
  down: BTN.DOWN,
  primary: BTN.CIRCLE,
  secondary: BTN.TRIANGLE,
  back: BTN.CROSS,
});

export const REMAPPABLE_BUTTON_MASK = CONTROL_ACTIONS.reduce(
  (mask, button) => mask | PHYSICAL_BUTTON_MASK[button],
  0,
);

/** Remap host-normalized physical slots into the game's semantic BTN masks.
 * Non-remappable inputs (START, SELECT, shoulder buttons, SQUARE) pass through. */
export function remapButtons(buttons: number, bindings: ControlBindings): number {
  let mapped = buttons & ~REMAPPABLE_BUTTON_MASK;
  for (const action of CONTROL_ACTIONS) {
    if (buttons & PHYSICAL_BUTTON_MASK[bindings[action]]) mapped |= CONTROL_ACTION_MASK[action];
  }
  return mapped >>> 0;
}

/** A binding capture accepts exactly one new remappable physical slot. */
export function pressedPhysicalButton(pressed: number): PhysicalButton | null {
  let found: PhysicalButton | null = null;
  for (const button of CONTROL_ACTIONS) {
    if (!(pressed & PHYSICAL_BUTTON_MASK[button])) continue;
    if (found !== null) return null;
    found = button;
  }
  return found;
}

export interface ButtonRemapper {
  map(buttons: number): number;
  physicalButtons(): number;
  physicalPressed(): number;
}

type PocketFrame = (
  buttons: number,
  analog?: number,
  touches?: readonly number[],
  hits?: readonly number[],
  touchSurfaces?: readonly number[],
  rightAnalog?: number,
  axisDeltas?: readonly unknown[],
  motion?: unknown,
) => void;

type RemappedPocketFrame = PocketFrame & {
  /** Reducer-semantic ingress used by deterministic tape playback. */
  __pocketSemanticFrame?: PocketFrame;
};

/** Install after PocketJS mount(), which owns globalThis.frame. The wrapper
 * changes only the normalized PSP button mask and forwards every optional
 * host input argument byte-for-byte. Keyboard and controller therefore share
 * one persisted mapping, while touch contacts remain independent. */
export function installButtonRemapFrame(input: ButtonRemapper): () => void {
  const globals = globalThis as typeof globalThis & { frame?: PocketFrame };
  const previous = globals.frame;
  if (!previous) return () => undefined;
  const wrapped: RemappedPocketFrame = (buttons, ...rest) => previous(input.map(buttons), ...rest);
  // Journey/chapter tapes already contain semantic masks. Keep an explicit
  // route around the physical-input adapter so deterministic playback does
  // not translate those masks a second time after controls are remapped.
  wrapped.__pocketSemanticFrame =
    (previous as RemappedPocketFrame).__pocketSemanticFrame ?? previous;
  globals.frame = wrapped;
  return () => {
    if (globals.frame === wrapped) globals.frame = previous;
  };
}

/** Stateful frame adapter. Changing a mapping arms a release gate so the key
 * used to bind an action cannot become a second, ghost press next frame. */
export function createButtonRemapper(
  settings: Pick<SettingsController, "get" | "revision">,
): ButtonRemapper {
  let physical = 0;
  let newlyPressed = 0;
  let observedRevision = settings.revision();
  let controls = settings.get().controls;
  let identity = CONTROL_ACTIONS.every((action) => controls[action] === action);
  let suppressUntilRelease = false;
  return {
    map(buttons) {
      const nextPhysical = buttons & REMAPPABLE_BUTTON_MASK;
      newlyPressed = nextPhysical & ~physical;
      physical = nextPhysical;
      const revision = settings.revision();
      if (revision !== observedRevision) {
        observedRevision = revision;
        controls = settings.get().controls;
        identity = CONTROL_ACTIONS.every((action) => controls[action] === action);
        suppressUntilRelease = true;
      }
      if (suppressUntilRelease) {
        if (nextPhysical === 0) suppressUntilRelease = false;
        return (buttons & ~REMAPPABLE_BUTTON_MASK) >>> 0;
      }
      // Most installations keep the defaults. Avoid seven table lookups on
      // every gameplay frame; a changed revision refreshes this fast path.
      return identity ? buttons >>> 0 : remapButtons(buttons, controls);
    },
    physicalButtons: () => physical,
    physicalPressed: () => newlyPressed,
  };
}

function scaledPercent(value: number, gain: number): number {
  return Math.max(0, Math.min(100, value * gain));
}

function scaleCues(cues: readonly Readonly<SoundCue>[], gain: number): readonly Readonly<SoundCue>[] {
  if (gain === 1 || cues.length === 0) return cues;
  return cues.map((cue) => "stop" in cue
    ? cue
    : { ...cue, volume: scaledPercent(cue.volume, gain) });
}

/** Apply preferences to presentation intent only. Reducer audio state stays
 * untouched, so saves, rewind and deterministic journey hashes do not change. */
export function applyAudioSettings(
  state: AudioDriverState,
  settings: Pick<GameSettings, "musicMuted" | "musicVolume" | "soundVolume">,
): AudioDriverState {
  const musicGain = settings.musicMuted ? 0 : settings.musicVolume / 100;
  const soundGain = settings.soundVolume / 100;
  const audio = state.interp.audio;
  const cues = scaleCues(state.interp.cues, soundGain);
  if (!audio && cues === state.interp.cues) return state;
  const scaledAudio = audio ? {
    ...audio,
    ...(audio.bgm ? { bgm: { ...audio.bgm, volume: scaledPercent(audio.bgm.volume, musicGain) } } : {}),
    ...(audio.bgs ? { bgs: { ...audio.bgs, volume: scaledPercent(audio.bgs.volume, musicGain) } } : {}),
    ...(audio.me ? { me: { ...audio.me, volume: scaledPercent(audio.me.volume, musicGain) } } : {}),
  } : undefined;
  return {
    ...state,
    interp: {
      ...state.interp,
      ...(scaledAudio ? { audio: scaledAudio } : {}),
      cues,
    },
  };
}

export interface AudioSettingsAdapter {
  apply(state: AudioDriverState): AudioDriverState;
}

/** Preserve object identity while both reducer frame and preferences are
 * unchanged. AudioDriver uses that identity to distinguish an idle repeat
 * from a refold/load. */
export function createAudioSettingsAdapter(
  settings: Pick<SettingsController, "get" | "revision">,
): AudioSettingsAdapter {
  let previousInput: AudioDriverState | undefined;
  let previousMusicMuted: boolean | undefined;
  let previousMusicVolume: number | undefined;
  let previousSoundVolume: number | undefined;
  let previousOutput: AudioDriverState | undefined;
  return {
    apply(state) {
      // Read the revision so the adapter remains compatible with controllers
      // whose get() accessor is otherwise non-reactive, but compare only the
      // three audio fields. Controls, units and hemisphere must not create a
      // new audio projection on a frozen Options frame.
      settings.revision();
      const current = settings.get();
      if (
        state === previousInput
        && current.musicMuted === previousMusicMuted
        && current.musicVolume === previousMusicVolume
        && current.soundVolume === previousSoundVolume
      ) return previousOutput!;
      previousInput = state;
      previousMusicMuted = current.musicMuted;
      previousMusicVolume = current.musicVolume;
      previousSoundVolume = current.soundVolume;
      previousOutput = applyAudioSettings(state, current);
      return previousOutput;
    },
  };
}

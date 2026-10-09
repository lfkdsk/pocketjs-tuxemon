// Pure reducer for Tuxemon's authored FM tuner. Radio content and labels are
// compiled into scene args by the importer, so saves/replays never read the
// source tree and English/Chinese builds use the same reducer.

import type { ExtensionReadContext } from "../vendor/pocket-rpgkit/src/engine/extensions.ts";
import type { SceneCompletion, SceneInput, SceneRules } from "../vendor/pocket-rpgkit/src/engine/scene.ts";
import type { JsonValue, VariableValue } from "../vendor/pocket-rpgkit/src/engine/types.ts";

export const TUXEMON_RADIO_SCENE_ID = "tux.radio";

export const RADIO_TOUCH_TUNE_DOWN = 0;
export const RADIO_TOUCH_TUNE_UP = 1;
export const RADIO_TOUCH_PLAY = 2;
export const RADIO_TOUCH_RETURN = 3;
export const RADIO_TOUCH_BROADCAST_NEXT = 4;

export interface RadioSceneLabels {
  title: string;
  tuner: string;
  tuningStatic: string;
  tuningStation: string;
  hint: string;
  signal: string;
  play: string;
  back: string;
  next: string;
  strong: string;
  moderate: string;
  weak: string;
  none: string;
}

export interface RadioSceneBroadcast {
  conditions: {
    mapSlugs: string[];
    variables: Record<string, VariableValue>;
  };
  dialogue: string[];
  setVariables?: Record<string, VariableValue>;
}

export interface RadioSceneStation {
  slug: string;
  label: string;
  frequency?: number;
  defaultDialogue: string[];
  broadcasts: RadioSceneBroadcast[];
}

export interface RadioSceneArgs {
  map: string;
  initialFrequency: number;
  minFrequency: number;
  maxFrequency: number;
  step: number;
  tolerance: number;
  strongThreshold: number;
  fallbackStation: string;
  stations: RadioSceneStation[];
  labels: RadioSceneLabels;
}

export interface RadioSceneState extends RadioSceneArgs {
  kind: "radio";
  phase: "tune" | "broadcast" | "done";
  frequency: number;
  signalStrength: number;
  selectedStationSlug: string;
  currentStationSlug: string;
  broadcastStationSlug: string;
  broadcastDialogue: string[];
  broadcastCursor: number;
  variables: Record<string, VariableValue>;
  pendingWrites: Record<string, VariableValue>;
}

function stateOf(value: JsonValue): RadioSceneState {
  return value as unknown as RadioSceneState;
}

function finite(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`tux.radio: ${at} must be finite`);
  }
  return value;
}

function validateArgs(value: JsonValue): RadioSceneArgs {
  const args = value as unknown as RadioSceneArgs;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("tux.radio: args must be an object");
  }
  if (typeof args.map !== "string" || !args.map) throw new Error("tux.radio: map is required");
  const min = finite(args.minFrequency, "minFrequency");
  const max = finite(args.maxFrequency, "maxFrequency");
  const initial = finite(args.initialFrequency, "initialFrequency");
  const step = finite(args.step, "step");
  const tolerance = finite(args.tolerance, "tolerance");
  if (min >= max || initial < min || initial > max || step <= 0 || tolerance <= 0) {
    throw new Error("tux.radio: invalid tuner band");
  }
  if (!Number.isInteger(args.strongThreshold) || args.strongThreshold < 0 || args.strongThreshold > 100) {
    throw new Error("tux.radio: strongThreshold must be an integer from 0 to 100");
  }
  if (typeof args.fallbackStation !== "string" || !args.fallbackStation) {
    throw new Error("tux.radio: fallbackStation is required");
  }
  if (!Array.isArray(args.stations) || !args.stations.some((station) => station.slug === args.fallbackStation)) {
    throw new Error("tux.radio: stations must include the fallback station");
  }
  if (!args.labels || typeof args.labels !== "object") throw new Error("tux.radio: labels are required");
  return args;
}

function station(state: Readonly<RadioSceneState>, slug: string): RadioSceneStation | undefined {
  return state.stations.find((entry) => entry.slug === slug);
}

/** Match NuPhoneRadioTuner: within tolerance, smallest difference wins;
 * equal distances retain the first YAML station. */
export function radioBestStation(
  state: Pick<RadioSceneState, "frequency" | "stations" | "fallbackStation" | "tolerance">,
): string {
  let best = state.fallbackStation;
  let minDiff = Number.POSITIVE_INFINITY;
  for (const entry of state.stations) {
    if (entry.frequency === undefined) continue;
    const diff = Math.abs(state.frequency - entry.frequency);
    if (diff <= state.tolerance && diff < minDiff) {
      minDiff = diff;
      best = entry.slug;
    }
  }
  return best;
}

/** Python's int() truncates this positive signal formula toward zero. */
export function radioSignalStrength(
  state: Pick<RadioSceneState, "frequency" | "stations" | "tolerance">,
): number {
  let minDiff = Number.POSITIVE_INFINITY;
  for (const entry of state.stations) {
    if (entry.frequency === undefined) continue;
    minDiff = Math.min(minDiff, Math.abs(state.frequency - entry.frequency));
  }
  return minDiff === Number.POSITIVE_INFINITY
    ? 0
    : Math.max(0, Math.trunc((1 - minDiff / state.tolerance) * 100));
}

export function radioSignalLabel(state: Readonly<RadioSceneState>): string {
  if (state.signalStrength >= 80) return state.labels.strong;
  if (state.signalStrength >= 50) return state.labels.moderate;
  if (state.signalStrength > 0) return state.labels.weak;
  return state.labels.none;
}

export function radioSelectedStation(state: Readonly<RadioSceneState>): RadioSceneStation | undefined {
  return station(state, state.selectedStationSlug);
}

function conditionMatches(state: Readonly<RadioSceneState>, broadcast: Readonly<RadioSceneBroadcast>): boolean {
  if (broadcast.conditions.mapSlugs.length > 0 && !broadcast.conditions.mapSlugs.includes(state.map)) {
    return false;
  }
  return Object.entries(broadcast.conditions.variables).every(([key, expected]) =>
    state.variables[key] === expected
  );
}

function chosenBroadcast(
  state: Readonly<RadioSceneState>,
  slug: string,
): { dialogue: string[]; setVariables?: Record<string, VariableValue> } {
  const selected = station(state, slug) ?? station(state, state.fallbackStation);
  if (!selected) return { dialogue: [state.labels.tuningStatic] };
  for (const broadcast of selected.broadcasts) {
    if (conditionMatches(state, broadcast)) {
      return {
        dialogue: broadcast.dialogue.length > 0 ? broadcast.dialogue : selected.defaultDialogue,
        ...(broadcast.setVariables ? { setVariables: broadcast.setVariables } : {}),
      };
    }
  }
  return { dialogue: selected.defaultDialogue };
}

function play(state: RadioSceneState, slug: string): void {
  const selected = chosenBroadcast(state, slug);
  state.currentStationSlug = slug;
  state.broadcastStationSlug = slug;
  state.broadcastDialogue = selected.dialogue.length > 0
    ? [...selected.dialogue]
    : [state.labels.tuningStatic];
  state.broadcastCursor = 0;
  state.phase = "broadcast";
  if (selected.setVariables) {
    for (const [key, value] of Object.entries(selected.setVariables)) {
      state.pendingWrites[key] = value;
    }
  }
}

function refreshTuner(state: RadioSceneState, autoPlay: boolean): void {
  state.signalStrength = radioSignalStrength(state);
  state.selectedStationSlug = radioBestStation(state);
  if (
    autoPlay &&
    state.signalStrength >= state.strongThreshold &&
    state.selectedStationSlug !== state.fallbackStation &&
    state.selectedStationSlug !== state.currentStationSlug
  ) {
    play(state, state.selectedStationSlug);
  }
}

function tune(state: RadioSceneState, delta: number): void {
  // The authored slider increments by 0.1 MHz. Rounding to tenths prevents
  // repeated input from accumulating a display drift while retaining the
  // same floating-point signal formula as upstream.
  const next = Math.round((state.frequency + delta) * 10) / 10;
  state.frequency = Math.max(state.minFrequency, Math.min(state.maxFrequency, next));
  refreshTuner(state, true);
}

function playSelected(state: RadioSceneState): void {
  refreshTuner(state, false);
  const slug = state.signalStrength >= state.strongThreshold &&
    state.selectedStationSlug !== state.fallbackStation
    ? state.selectedStationSlug
    : state.fallbackStation;
  play(state, slug);
}

function finishBroadcast(state: RadioSceneState): void {
  state.broadcastCursor += 1;
  if (state.broadcastCursor < state.broadcastDialogue.length) return;
  // Upstream applies set_variables after the dialog closes. Mirror that in
  // the scene-local snapshot immediately; SceneCompletion commits the same
  // values atomically when the tuner itself closes.
  Object.assign(state.variables, state.pendingWrites);
  state.phase = "tune";
  state.broadcastDialogue = [];
  state.broadcastCursor = 0;
}

function referencedVariables(args: Readonly<RadioSceneArgs>, context: ExtensionReadContext): Record<string, VariableValue> {
  const keys = new Set(args.stations.flatMap((entry) => entry.broadcasts.flatMap((broadcast) =>
    Object.keys(broadcast.conditions.variables)
  )));
  return Object.fromEntries([...keys].flatMap((key) => {
    const value = context.variables[key];
    return value === undefined ? [] : [[key, value]];
  }));
}

export const radioSceneRules: SceneRules = {
  start(ext, rawArgs, _seed, context) {
    const args = validateArgs(rawArgs);
    const state: RadioSceneState = {
      ...args,
      kind: "radio",
      phase: "tune",
      frequency: args.initialFrequency,
      signalStrength: 0,
      selectedStationSlug: args.fallbackStation,
      currentStationSlug: args.fallbackStation,
      broadcastStationSlug: args.fallbackStation,
      broadcastDialogue: [],
      broadcastCursor: 0,
      variables: referencedVariables(args, context),
      pendingWrites: {},
    };
    // Construction updates the dial and signal but deliberately does not
    // auto-play a station, matching NuPhoneRadioTuner.__init__.
    refreshTuner(state, false);
    return { ext, state: state as unknown as JsonValue };
  },

  step(rawState, input: Readonly<SceneInput>) {
    const state = stateOf(rawState);
    if (state.phase === "done") return rawState;
    if (state.phase === "broadcast") {
      if (input.confirmEdge || input.cancelEdge || input.selectIndex === RADIO_TOUCH_BROADCAST_NEXT) {
        finishBroadcast(state);
      }
      return rawState;
    }

    if (input.selectIndex === RADIO_TOUCH_TUNE_DOWN || input.leftEdge) {
      tune(state, -state.step);
    } else if (input.selectIndex === RADIO_TOUCH_TUNE_UP || input.rightEdge) {
      tune(state, state.step);
    } else if (input.selectIndex === RADIO_TOUCH_PLAY || input.confirmEdge) {
      playSelected(state);
    } else if (input.selectIndex === RADIO_TOUCH_RETURN || input.cancelEdge) {
      state.phase = "done";
    }
    return rawState;
  },

  done(rawState): SceneCompletion | null {
    const state = stateOf(rawState);
    if (state.phase !== "done") return null;
    return Object.keys(state.pendingWrites).length > 0
      ? { writes: state.pendingWrites }
      : {};
  },
};

// NuPhone world-menu overlay state. The GPS reads the campaign's durable
// inventory and tracker switches only when opened, then remains read-only.
// This mirrors Tuxemon's phone -> app -> map stack while keeping save/rewind
// ownership in the ordinary session reducer.

import { createSignal, onCleanup, type Accessor } from "solid-js";
import { BTN } from "@pocketjs/framework/input";
import type { NuPhoneDirection, NuPhoneMapData } from "./feature-modes-data.ts";
import type {
  GameViewDemoRuntime,
  GameViewSessionHost,
} from "../vendor/pocket-rpgkit/src/ui/demo-contract.ts";
import type { Lang } from "./language.ts";

export type NuPhoneScreen = "phone" | "map" | "message";

export interface NuPhoneState {
  screen: NuPhoneScreen;
  known: string[];
  currentLocation: string | null;
  cursor: string;
  hasMapApp: boolean;
}

export type NuPhoneAction = NuPhoneDirection | "confirm" | "back";

export interface NuPhoneOptions {
  data: NuPhoneMapData;
  lang: Lang;
}

export interface NuPhoneRuntime {
  step: GameViewDemoRuntime["step"];
  isOpen: GameViewDemoRuntime["isOpen"];
  open(): void;
  close(): void;
  applyAction(action: NuPhoneAction): void;
  /** Touch path: select any authored point that is currently selectable. */
  selectPoint(key: string): void;
  openSignal: Accessor<boolean>;
  state: Accessor<NuPhoneState>;
  data: NuPhoneMapData;
  lang: Lang;
}

export interface PocketNuPhoneHook {
  open(): void;
  close(): void;
  isOpen(): boolean;
  state(): NuPhoneState;
  act(action: NuPhoneAction): void;
  selectPoint(key: string): void;
}

declare global {
  // eslint-disable-next-line no-var
  var __pocketNuPhone: PocketNuPhoneHook | undefined;
}

const pointKeys = (data: NuPhoneMapData): Set<string> =>
  new Set(data.points.map((point) => point.key));

/** Tracker actions use location ids, while map_groups holds TMX slugs. Map
 * aliases such as routea/tunnel_below are canonicalized through their
 * `spyder_` map slug so they reveal the same pin as the current marker. */
export function canonicalTrackerLocation(data: NuPhoneMapData, tracker: string): string | null {
  if (pointKeys(data).has(tracker)) return tracker;
  return data.mapToLocation[tracker] ?? data.mapToLocation[`spyder_${tracker}`] ?? null;
}

export function knownTrackerLocations(
  data: NuPhoneMapData,
  switches: Readonly<Record<string, boolean>>,
): string[] {
  const known = new Set<string>();
  for (const [id, enabled] of Object.entries(switches)) {
    if (!enabled || !id.startsWith("tracker.")) continue;
    const key = canonicalTrackerLocation(data, id.slice("tracker.".length));
    if (key) known.add(key);
  }
  return data.points.filter((point) => known.has(point.key)).map((point) => point.key);
}

export function currentNuPhoneLocation(data: NuPhoneMapData, mapId: string): string | null {
  return data.mapToLocation[mapId] ?? (pointKeys(data).has(mapId) ? mapId : null);
}

export function nuPhonePointSelectable(
  data: NuPhoneMapData,
  state: Pick<NuPhoneState, "known">,
  key: string,
): boolean {
  const point = data.points.find((entry) => entry.key === key);
  return point !== undefined && (point.core || state.known.includes(key));
}

function initialCursor(data: NuPhoneMapData, known: readonly string[], currentLocation: string | null): string {
  if (currentLocation && nuPhonePointSelectable(data, { known: [...known] }, currentLocation)) {
    return currentLocation;
  }
  return data.points.find((point) => point.core || known.includes(point.key))?.key ?? data.points[0]!.key;
}

/** Pure map navigation. Authored null edges and locked non-core targets
 * consume input without moving, exactly like NuPhoneMap.process_event. */
export function nuPhoneMapStep(
  data: NuPhoneMapData,
  state: Readonly<NuPhoneState>,
  direction: NuPhoneDirection,
): NuPhoneState {
  if (state.screen !== "map") return { ...state };
  const point = data.points.find((entry) => entry.key === state.cursor);
  const target = point?.nav[direction] ?? null;
  if (target === null || !nuPhonePointSelectable(data, state, target)) return { ...state };
  return { ...state, cursor: target };
}

function snapshotState(options: NuPhoneOptions, host: GameViewSessionHost): NuPhoneState {
  const session = host.getState();
  const known = knownTrackerLocations(options.data, session.sw.switches);
  const currentLocation = currentNuPhoneLocation(options.data, session.mapId);
  return {
    screen: "phone",
    known,
    currentLocation,
    cursor: initialCursor(options.data, known, currentLocation),
    hasMapApp: (session.sw.items[options.data.entry.appItem] ?? 0) > 0,
  };
}

export function hasNuPhone(data: NuPhoneMapData, host: GameViewSessionHost): boolean {
  return (host.getState().sw.items[data.entry.phoneItem] ?? 0) > 0;
}

export function createNuPhoneRuntime(
  options: NuPhoneOptions,
  host: GameViewSessionHost,
): NuPhoneRuntime {
  const [openSignal, setOpen] = createSignal(false);
  const [state, setState] = createSignal<NuPhoneState>(snapshotState(options, host));

  const open = (): void => {
    setState(snapshotState(options, host));
    setOpen(true);
  };
  const close = (): void => {
    setOpen(false);
  };

  const applyAction = (action: NuPhoneAction): void => {
    if (!openSignal()) return;
    const current = state();
    if (action === "back") {
      if (current.screen === "map" || current.screen === "message") {
        setState({ ...current, screen: "phone" });
      } else {
        close();
      }
      return;
    }
    if (current.screen === "phone") {
      if (action === "confirm" && current.hasMapApp) {
        setState({ ...current, screen: current.known.length > 0 ? "map" : "message" });
      }
      return;
    }
    if (current.screen === "message") {
      if (action === "confirm") setState({ ...current, screen: "phone" });
      return;
    }
    if (action === "up" || action === "right" || action === "down" || action === "left") {
      setState((value) => nuPhoneMapStep(options.data, value, action));
    }
  };

  const selectPoint = (key: string): void => {
    const current = state();
    if (current.screen !== "map" || !nuPhonePointSelectable(options.data, current, key)) return;
    setState({ ...current, cursor: key });
  };

  const step: GameViewDemoRuntime["step"] = (_buttons, pressed) => {
    if (!openSignal()) return { consumed: false };
    if (pressed & BTN.START) {
      close();
      return { consumed: true };
    }
    let action: NuPhoneAction | null = null;
    if (pressed & BTN.UP) action = "up";
    else if (pressed & BTN.RIGHT) action = "right";
    else if (pressed & BTN.DOWN) action = "down";
    else if (pressed & BTN.LEFT) action = "left";
    else if (pressed & BTN.CIRCLE) action = "confirm";
    else if (pressed & BTN.CROSS) action = "back";
    if (action !== null) applyAction(action);
    return { consumed: true };
  };

  const hook: PocketNuPhoneHook = {
    open,
    close,
    isOpen: openSignal,
    state,
    act: applyAction,
    selectPoint,
  };
  globalThis.__pocketNuPhone = hook;
  onCleanup(() => {
    if (globalThis.__pocketNuPhone === hook) delete globalThis.__pocketNuPhone;
  });

  return {
    step,
    isOpen: openSignal,
    open,
    close,
    applyAction,
    selectPoint,
    openSignal,
    state,
    data: options.data,
    lang: options.lang,
  };
}

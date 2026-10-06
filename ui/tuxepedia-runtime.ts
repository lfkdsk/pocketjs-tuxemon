// Tuxepedia overlay runtime: the player-facing encyclopedia opened from the
// START menu. Pure navigation logic (tuxepediaStep/tuxepediaRows) lives here
// so tests drive it without a JSX transform; ui/tuxepedia.tsx adds the
// presentation. The 14 authored `open_journal` previews keep using the
// tux.journal scene; this overlay is the menu-opened browse mode.
//
// The overlay reads seen/caught from the live session once on open (the
// overlay consumes every host frame while open, so discovery cannot change
// underneath it) and never writes state, so saves, loads and rewinds stay
// correct by construction: the next open re-reads the live extension.

import { createSignal, onCleanup, type Accessor } from "solid-js";
import { BTN } from "@pocketjs/framework/input";
import type {
  GameViewDemoRuntime,
  GameViewSessionHost,
} from "../vendor/pocket-rpgkit/src/ui/demo-contract.ts";
import { tuxemonExtensionState } from "../battle/extension.ts";
import type { TuxemonSceneCatalog } from "../battle/scenes.ts";
import type { Lang } from "./language.ts";

export const TUXEPEDIA_PAGE_SIZE = 8;

export type TuxepediaFilter = "all" | "caught";

export interface TuxepediaState {
  /** Index into the filtered row list. */
  cursor: number;
  filter: TuxepediaFilter;
  seen: string[];
  caught: string[];
}

export type TuxepediaAction = "up" | "down" | "pageUp" | "pageDown" | "toggleFilter";

/** The slugs the list shows for a state: every imported monster, or only the
 *  caught ones. Unknown rows render as a placeholder without touching the
 *  lazy monster repository. */
export function tuxepediaRows(state: Readonly<TuxepediaState>, all: readonly string[]): string[] {
  if (state.filter !== "caught") return [...all];
  const caught = new Set(state.caught);
  return all.filter((slug) => caught.has(slug));
}

function wrapIndex(index: number, length: number): number {
  return length > 0 ? (index + length) % length : 0;
}

/** Fold one pressed-edge action over the catalog order. `all` is every
 *  monster slug in Tuxemon-number order (the catalog index). */
export function tuxepediaStep(
  state: Readonly<TuxepediaState>,
  action: TuxepediaAction,
  all: readonly string[],
): TuxepediaState {
  const rows = tuxepediaRows(state, all);
  const count = rows.length;
  switch (action) {
    case "up":
      return { ...state, cursor: wrapIndex(state.cursor - 1, count) };
    case "down":
      return { ...state, cursor: wrapIndex(state.cursor + 1, count) };
    case "pageUp":
      return { ...state, cursor: Math.max(0, state.cursor - TUXEPEDIA_PAGE_SIZE) };
    case "pageDown":
      return { ...state, cursor: Math.min(Math.max(0, count - 1), state.cursor + TUXEPEDIA_PAGE_SIZE) };
    case "toggleFilter": {
      const current = rows[state.cursor];
      const filter: TuxepediaFilter = state.filter === "all" ? "caught" : "all";
      const next: TuxepediaState = { ...state, filter };
      // Keep the cursor on the same monster when it survives the filter.
      const nextRows = tuxepediaRows(next, all);
      const keep = current ? nextRows.indexOf(current) : -1;
      return { ...next, cursor: keep >= 0 ? keep : 0 };
    }
  }
}

export interface TuxepediaCounts {
  /** Monsters the player has seen OR caught (the union; pokedex convention:
   *  seen includes caught). */
  seen: number;
  caught: number;
  total: number;
}

/** The displayed "seen" count: every monster in either the seen-only or the
 *  caught set. The extension keeps the two sets disjoint (caught wins over
 *  seen-only, battle/extension.ts), so this is their union. */
export function tuxepediaSeenCount(seen: readonly string[], caught: readonly string[]): number {
  return new Set([...seen, ...caught]).size;
}

export interface TuxepediaOptions {
  catalog: TuxemonSceneCatalog;
  lang: Lang;
}

/** Everything the presentation reads, plus the GameView step contract. */
export interface TuxepediaRuntime {
  step: GameViewDemoRuntime["step"];
  isOpen: GameViewDemoRuntime["isOpen"];
  /** Test/tooling handle: open the overlay on the live session state. */
  open(): void;
  close(): void;
  /** Touch: select a row by its index into the filtered list. */
  setCursor(index: number): void;
  /** Touch/keyboard: apply one navigation action. */
  applyAction(action: TuxepediaAction): void;
  openSignal: Accessor<boolean>;
  state: Accessor<TuxepediaState>;
  /** The filtered slug list for the current state. */
  rows: Accessor<string[]>;
  counts: Accessor<TuxepediaCounts>;
  lang: Lang;
}

/** Test/tooling handle: the live overlay publishes itself here. */
export interface PocketTuxepediaHook {
  open(): void;
  close(): void;
  isOpen(): boolean;
  state(): TuxepediaState;
  /** The filtered slug list for the current state. */
  rows(): string[];
  /** The displayed counts (seen = seen ∪ caught). */
  counts(): TuxepediaCounts;
  /** Drive one navigation action (the touch/keyboard path). */
  act(action: TuxepediaAction): void;
}

declare global {
  // eslint-disable-next-line no-var
  var __pocketTuxepedia: PocketTuxepediaHook | undefined;
}

/** Read seen/caught from the live session. A save that predates the
 *  Tuxepedia (or any undecodable extension) reads as nothing discovered, so
 *  the overlay always opens instead of throwing. */
function readDiscovery(host: GameViewSessionHost): { seen: string[]; caught: string[] } {
  try {
    const ext = tuxemonExtensionState(host.getState().ext);
    return { seen: [...ext.seen], caught: [...ext.caught] };
  } catch {
    return { seen: [], caught: [] };
  }
}

export function createTuxepediaRuntime(
  options: TuxepediaOptions,
  host: GameViewSessionHost,
): TuxepediaRuntime {
  const [openSignal, setOpen] = createSignal(false);
  const [state, setState] = createSignal<TuxepediaState>({
    cursor: 0,
    filter: "all",
    seen: [],
    caught: [],
  });
  // The catalog index is stable for the boot language; cache the slug order.
  // The original journal excludes txmn_id 0 (special/developer monsters) from
  // its pages (tuxemon/states/journal_state.py: `min_txmn < txmn_id`), so the
  // list starts at #001, not #000.
  const all = options.catalog.index
    .filter((entry) => entry.txmnId > 0)
    .map((entry) => entry.id);
  const rows: Accessor<string[]> = () => tuxepediaRows(state(), all);
  const counts: Accessor<TuxepediaCounts> = () => ({
    seen: tuxepediaSeenCount(state().seen, state().caught),
    caught: state().caught.length,
    total: all.length,
  });

  const open = (): void => {
    const { seen, caught } = readDiscovery(host);
    setState({ cursor: 0, filter: "all", seen, caught });
    setOpen(true);
  };
  const close = (): void => {
    setOpen(false);
  };
  const setCursor = (index: number): void => {
    setState((current) => ({ ...current, cursor: Math.max(0, Math.min(rows().length - 1, index)) }));
  };
  const applyAction = (action: TuxepediaAction): void => {
    setState((current) => tuxepediaStep(current, action, all));
  };

  const step: GameViewDemoRuntime["step"] = (_buttons, pressed) => {
    if (!openSignal()) return { consumed: false };
    if (pressed & (BTN.CROSS | BTN.START)) {
      close();
      return { consumed: true };
    }
    let action: TuxepediaAction | null = null;
    if (pressed & BTN.UP) action = "up";
    else if (pressed & BTN.DOWN) action = "down";
    else if (pressed & BTN.LEFT) action = "pageUp";
    else if (pressed & BTN.RIGHT) action = "pageDown";
    else if (pressed & BTN.SQUARE) action = "toggleFilter";
    if (action !== null) applyAction(action);
    return { consumed: true };
  };

  const hook: PocketTuxepediaHook = {
    open,
    close,
    isOpen: () => openSignal(),
    state,
    rows,
    counts,
    act: applyAction,
  };
  globalThis.__pocketTuxepedia = hook;
  onCleanup(() => {
    if (globalThis.__pocketTuxepedia === hook) delete globalThis.__pocketTuxepedia;
  });

  return {
    step,
    isOpen: () => openSignal(),
    open,
    close,
    setCursor,
    applyAction,
    openSignal,
    state,
    rows,
    counts,
    lang: options.lang,
  };
}

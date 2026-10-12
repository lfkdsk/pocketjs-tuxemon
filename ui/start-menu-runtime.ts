// Game-owned START menu controller. The state transitions in this file are
// deliberately JSX-free: presentation can render the exported rows/views,
// while tests and non-pointer controls drive the same pure reducer.

import { createSignal, onCleanup, type Accessor } from "solid-js";
import { BTN } from "@pocketjs/framework/input";
import {
  packTuxemonExtensionState,
  tuxemonExtensionState,
  type BattleHistoryEntry,
} from "../battle/extension.ts";
import type { SpawnedMonsterSnapshot } from "../battle/types.ts";
import type { BattleDb } from "../importer/battle-schema.ts";
import type {
  GameViewDemoRuntime,
  GameViewSessionHost,
} from "../vendor/pocket-rpgkit/src/ui/demo-contract.ts";
import type { SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";

export type StartMenuBaseRowId =
  | "party"
  | "bag"
  | "player"
  | "missions"
  | "save"
  | "load"
  | "options"
  | "exit";

export type StartMenuBuiltinAppId = "tuxepedia" | "nuphone";
export type StartMenuRowId = StartMenuBaseRowId | StartMenuBuiltinAppId | (string & {});

export interface StartMenuRootLabels {
  party: string;
  bag: string;
  player: string;
  missions: string;
  save: string;
  load: string;
  options: string;
  exit: string;
  tuxepedia: string;
  nuphone: string;
}

export type PartyActionId = "info" | "moves" | "move" | "sort" | "release";
export type PartySortId = "level" | "hp" | "name" | "id";

export interface StartMenuLabels {
  root: StartMenuRootLabels;
  partyActions: Record<PartyActionId, string>;
  partySorts: Record<PartySortId, string>;
  yes: string;
  no: string;
}

export interface StartMenuRow {
  id: StartMenuRowId;
  label: string;
  enabled: boolean;
  kind: "base" | "app";
}

/** A dynamic upstream world-menu entry. `position` is applied after the base
 * list has been built, and entries are inserted in ascending position order. */
export interface StartMenuAppRow {
  id: StartMenuRowId;
  label: string;
  position: number;
  enabled?: boolean;
}

/** false hides a base row; "disabled" keeps it visible but unselectable. */
export type StartMenuRowAvailability = boolean | "disabled";
export type StartMenuAvailability = Partial<Record<StartMenuBaseRowId, StartMenuRowAvailability>>;

const BASE_ORDER: readonly StartMenuBaseRowId[] = [
  "party",
  "bag",
  "player",
  "missions",
  "save",
  "load",
  "options",
  "exit",
];

/** Build the upstream base order and then perform upstream-style dynamic
 * insertion. Positions are capped to the current list length. Duplicate
 * display labels are suppressed, matching WorldMenuManager. */
export function startMenuRows(
  labels: Readonly<StartMenuRootLabels>,
  availability: Readonly<StartMenuAvailability>,
  apps: readonly StartMenuAppRow[] = [],
): StartMenuRow[] {
  const rows: StartMenuRow[] = [];
  for (const id of BASE_ORDER) {
    const availabilityForRow = availability[id] ?? true;
    if (availabilityForRow === false) continue;
    rows.push({
      id,
      label: labels[id],
      enabled: availabilityForRow !== "disabled",
      kind: "base",
    });
  }

  const orderedApps = apps
    .map((app, order) => ({ app, order }))
    .filter(({ app }) => app.enabled !== false)
    .sort((left, right) => left.app.position - right.app.position || left.order - right.order);
  for (const { app } of orderedApps) {
    if (rows.some((row) => row.label === app.label)) continue;
    const position = Number.isFinite(app.position) ? Math.max(0, Math.trunc(app.position)) : rows.length;
    rows.splice(Math.min(position, rows.length), 0, {
      id: app.id,
      label: app.label,
      enabled: true,
      kind: "app",
    });
  }
  return rows;
}

export interface PartyMonsterView {
  iid: string | null;
  slug: string;
  name: string;
  speciesName: string;
  txmnId: number | null;
  level: number;
  hp: number;
  maxHp: number;
  hpRatio: number;
  status: string | null;
  types: string[];
}

export interface PartyMoveView {
  slug: string;
  name: string;
  description: string;
  type: string | null;
  accuracy: number | null;
  potency: number | null;
  power: number | null;
  recharge: number | null;
}

export type StartMenuCatalog = Pick<BattleDb, "monsters" | "techniques">;

export function partyMonsterView(
  monster: Readonly<SpawnedMonsterSnapshot>,
  catalog: StartMenuCatalog,
): PartyMonsterView {
  const species = catalog.monsters[monster.slug];
  const maxHp = Math.max(0, monster.base.hp);
  const hp = Math.max(0, Math.min(maxHp, monster.currentHp ?? maxHp));
  return {
    iid: monster.iid ?? null,
    slug: monster.slug,
    name: monster.nickname ?? species?.name ?? monster.slug,
    speciesName: species?.name ?? monster.slug,
    txmnId: species?.txmnId ?? null,
    level: monster.level,
    hp,
    maxHp,
    hpRatio: maxHp > 0 ? hp / maxHp : 0,
    status: monster.status ?? null,
    types: [...(monster.types ?? species?.types ?? [])],
  };
}

/** Move rows keep authored monster order but, like upstream's moves page,
 * suppress duplicate technique slugs. */
export function partyMoveViews(
  monster: Readonly<SpawnedMonsterSnapshot>,
  catalog: StartMenuCatalog,
): PartyMoveView[] {
  const seen = new Set<string>();
  const rows: PartyMoveView[] = [];
  for (const slug of monster.moves) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    const technique = catalog.techniques[slug];
    rows.push({
      slug,
      name: technique?.name ?? slug,
      description: technique?.description ?? "",
      type: technique?.types[0] ?? null,
      accuracy: technique?.accuracy ?? null,
      potency: technique?.potency ?? null,
      power: technique?.power ?? null,
      recharge: technique?.recharge ?? null,
    });
  }
  return rows;
}

export function partyActions(monster: Readonly<SpawnedMonsterSnapshot>, partySize: number): PartyActionId[] {
  const actions: PartyActionId[] = ["info"];
  if (monster.moves.length > 0) actions.push("moves");
  if (partySize > 1) actions.push("move", "sort", "release");
  return actions;
}

/** The four sort orders from upstream MonsterMenuHandler. Sorts are stable so
 * equal keys retain the current party order. */
export function sortParty(
  party: readonly SpawnedMonsterSnapshot[],
  sort: PartySortId,
  catalog: StartMenuCatalog,
): SpawnedMonsterSnapshot[] {
  const decorated = party.map((monster, index) => ({ monster, index }));
  decorated.sort((left, right) => {
    const a = partyMonsterView(left.monster, catalog);
    const b = partyMonsterView(right.monster, catalog);
    let order = 0;
    switch (sort) {
      case "level":
        order = a.level - b.level;
        break;
      case "hp":
        order = b.hpRatio - a.hpRatio;
        break;
      case "name":
        order = a.name.toLocaleLowerCase().localeCompare(b.name.toLocaleLowerCase());
        break;
      case "id":
        order = (a.txmnId ?? Number.MAX_SAFE_INTEGER) - (b.txmnId ?? Number.MAX_SAFE_INTEGER);
        break;
    }
    return order || left.index - right.index;
  });
  return decorated.map(({ monster }) => monster);
}

export interface PlayerBattleSummary {
  total: number;
  won: number;
  lost: number;
  draw: number;
}

export interface PlayerSummary {
  name: string;
  gold: number;
  playtimeFrames: number;
  playtimeSeconds: number;
  playtime: string;
  seen: number;
  caught: number;
  history: BattleHistoryEntry[];
  battles: PlayerBattleSummary;
}

/** Upstream's player page formats elapsed time as unpadded hours and minutes. */
export function formatStartMenuPlaytime(seconds: number): string {
  const wholeMinutes = Math.floor(Math.max(0, seconds) / 60);
  return `${Math.floor(wholeMinutes / 60)}h ${wholeMinutes % 60}m`;
}

export function playerSummary(
  session: Pick<SessionState, "sw" | "ext">,
): PlayerSummary {
  const ext = tuxemonExtensionState(session.ext);
  const history = ext.history
    .filter((entry) => entry.fighter === "player")
    .map((entry) => ({ ...entry }));
  const seen = new Set([...ext.seen, ...ext.caught]).size;
  const caught = new Set(ext.caught).size;
  // The game clock is the saved, transfer-stable 60 Hz counter. Session.frame
  // is host timeline state and is not part of rpgkit-save/v1, while
  // interp.frame restarts on each map entry.
  const playtimeFrames = ext.clock.refTick;
  const playtimeSeconds = Math.floor(playtimeFrames / 60);
  return {
    name: session.sw.playerName,
    gold: session.sw.gold,
    playtimeFrames,
    playtimeSeconds,
    playtime: formatStartMenuPlaytime(playtimeSeconds),
    seen,
    caught,
    history,
    battles: {
      total: history.length,
      won: history.filter((entry) => entry.outcome === "won").length,
      lost: history.filter((entry) => entry.outcome === "lost").length,
      draw: history.filter((entry) => entry.outcome === "draw").length,
    },
  };
}

export type PartyPhase = "list" | "action" | "detail" | "moves" | "move" | "sort" | "releaseConfirm";
export type StartMenuScreen = "root" | "party" | "player";

export interface PartyMenuState {
  phase: PartyPhase;
  cursor: number;
  actionCursor: number;
  moveCursor: number;
  sortCursor: number;
  /** 0 = Yes, 1 = No. Confirmation deliberately opens on No. */
  releaseCursor: 0 | 1;
}

export interface StartMenuState {
  screen: StartMenuScreen;
  rootCursor: number;
  partyMenu: PartyMenuState;
  party: SpawnedMonsterSnapshot[];
  player: PlayerSummary;
}

export type StartMenuAction = "up" | "down" | "left" | "right" | "confirm" | "back";

export type StartMenuEffect =
  | { type: "close" }
  | { type: "dispatch"; id: StartMenuRowId }
  | { type: "persistParty" };

export interface StartMenuTransition {
  state: StartMenuState;
  effects: StartMenuEffect[];
}

export interface StartMenuReduceContext {
  rows: readonly StartMenuRow[];
  catalog: StartMenuCatalog;
}

const PARTY_SORTS: readonly PartySortId[] = ["level", "hp", "name", "id"];

function wrap(index: number, length: number): number {
  return length > 0 ? (index + length) % length : 0;
}

function clamp(index: number, length: number): number {
  return length > 0 ? Math.max(0, Math.min(length - 1, Math.trunc(index))) : 0;
}

function listPartyState(cursor = 0): PartyMenuState {
  return {
    phase: "list",
    cursor,
    actionCursor: 0,
    moveCursor: 0,
    sortCursor: 0,
    releaseCursor: 1,
  };
}

function updatePartyMenu(state: Readonly<StartMenuState>, partyMenu: PartyMenuState): StartMenuState {
  return { ...state, partyMenu };
}

function partyTransition(
  state: Readonly<StartMenuState>,
  action: StartMenuAction,
  catalog: StartMenuCatalog,
): StartMenuTransition {
  const current = state.partyMenu;
  const party = state.party;
  if (party.length === 0) {
    return { state: { ...state, screen: "root", partyMenu: listPartyState() }, effects: [] };
  }
  const selected = party[clamp(current.cursor, party.length)]!;

  if (current.phase === "list") {
    if (action === "back") {
      return { state: { ...state, screen: "root" }, effects: [] };
    }
    if (action === "up" || action === "down") {
      const delta = action === "up" ? -1 : 1;
      return {
        state: updatePartyMenu(state, { ...current, cursor: wrap(current.cursor + delta, party.length) }),
        effects: [],
      };
    }
    if (action === "confirm") {
      return {
        state: updatePartyMenu(state, { ...current, phase: "action", actionCursor: 0 }),
        effects: [],
      };
    }
    return { state: { ...state }, effects: [] };
  }

  if (current.phase === "action") {
    const actions = partyActions(selected, party.length);
    if (action === "back") {
      return { state: updatePartyMenu(state, listPartyState(current.cursor)), effects: [] };
    }
    if (action === "up" || action === "down") {
      const delta = action === "up" ? -1 : 1;
      return {
        state: updatePartyMenu(state, {
          ...current,
          actionCursor: wrap(current.actionCursor + delta, actions.length),
        }),
        effects: [],
      };
    }
    if (action !== "confirm") return { state: { ...state }, effects: [] };
    switch (actions[clamp(current.actionCursor, actions.length)]!) {
      case "info":
        return { state: updatePartyMenu(state, { ...current, phase: "detail" }), effects: [] };
      case "moves":
        return { state: updatePartyMenu(state, { ...current, phase: "moves", moveCursor: 0 }), effects: [] };
      case "move":
        return { state: updatePartyMenu(state, { ...current, phase: "move" }), effects: [] };
      case "sort":
        return { state: updatePartyMenu(state, { ...current, phase: "sort", sortCursor: 0 }), effects: [] };
      case "release":
        return {
          state: updatePartyMenu(state, { ...current, phase: "releaseConfirm", releaseCursor: 1 }),
          effects: [],
        };
    }
  }

  if (current.phase === "detail" || current.phase === "moves") {
    if (action === "back" || action === "confirm") {
      return { state: updatePartyMenu(state, listPartyState(current.cursor)), effects: [] };
    }
    if (action === "left" || action === "right") {
      const delta = action === "left" ? -1 : 1;
      return {
        state: updatePartyMenu(state, {
          ...current,
          cursor: wrap(current.cursor + delta, party.length),
          moveCursor: 0,
        }),
        effects: [],
      };
    }
    if (current.phase === "moves" && (action === "up" || action === "down")) {
      const moves = partyMoveViews(selected, catalog);
      const delta = action === "up" ? -1 : 1;
      return {
        state: updatePartyMenu(state, {
          ...current,
          moveCursor: wrap(current.moveCursor + delta, moves.length),
        }),
        effects: [],
      };
    }
    return { state: { ...state }, effects: [] };
  }

  if (current.phase === "move") {
    // Upstream swaps the picked monster with every row crossed. Confirm and
    // cancel both end move mode; cancel intentionally does not roll back.
    if (action === "confirm" || action === "back") {
      return { state: updatePartyMenu(state, listPartyState(current.cursor)), effects: [] };
    }
    if (action === "up" || action === "down") {
      const delta = action === "up" ? -1 : 1;
      const destination = wrap(current.cursor + delta, party.length);
      const nextParty = [...party];
      [nextParty[current.cursor], nextParty[destination]] = [nextParty[destination]!, nextParty[current.cursor]!];
      return {
        state: {
          ...state,
          party: nextParty,
          partyMenu: { ...current, cursor: destination },
        },
        effects: [{ type: "persistParty" }],
      };
    }
    return { state: { ...state }, effects: [] };
  }

  if (current.phase === "sort") {
    if (action === "back") {
      return { state: updatePartyMenu(state, { ...current, phase: "action" }), effects: [] };
    }
    if (action === "up" || action === "down") {
      const delta = action === "up" ? -1 : 1;
      return {
        state: updatePartyMenu(state, {
          ...current,
          sortCursor: wrap(current.sortCursor + delta, PARTY_SORTS.length),
        }),
        effects: [],
      };
    }
    if (action === "confirm") {
      const nextParty = sortParty(party, PARTY_SORTS[clamp(current.sortCursor, PARTY_SORTS.length)]!, catalog);
      return {
        state: {
          ...state,
          party: nextParty,
          partyMenu: listPartyState(clamp(current.cursor, nextParty.length)),
        },
        effects: [{ type: "persistParty" }],
      };
    }
    return { state: { ...state }, effects: [] };
  }

  // releaseConfirm
  if (action === "back") {
    return { state: updatePartyMenu(state, listPartyState(current.cursor)), effects: [] };
  }
  if (action === "up" || action === "down" || action === "left" || action === "right") {
    return {
      state: updatePartyMenu(state, {
        ...current,
        releaseCursor: current.releaseCursor === 0 ? 1 : 0,
      }),
      effects: [],
    };
  }
  if (action !== "confirm") return { state: { ...state }, effects: [] };
  if (current.releaseCursor === 1 || party.length <= 1) {
    return { state: updatePartyMenu(state, listPartyState(current.cursor)), effects: [] };
  }
  const nextParty = party.filter((_, index) => index !== current.cursor);
  return {
    state: {
      ...state,
      party: nextParty,
      partyMenu: listPartyState(clamp(current.cursor, nextParty.length)),
    },
    effects: [{ type: "persistParty" }],
  };
}

/** Pure keyboard/gamepad fold. External systems are represented as effects;
 * only the controller performs host writes or invokes callbacks. */
export function startMenuStep(
  state: Readonly<StartMenuState>,
  action: StartMenuAction,
  context: Readonly<StartMenuReduceContext>,
): StartMenuTransition {
  if (state.screen === "party") return partyTransition(state, action, context.catalog);

  if (state.screen === "player") {
    if (action === "right" && state.party.length > 0) {
      return {
        state: { ...state, screen: "party", partyMenu: listPartyState(state.partyMenu.cursor) },
        effects: [],
      };
    }
    if (action === "back" || action === "left" || action === "confirm") {
      return { state: { ...state, screen: "root" }, effects: [] };
    }
    return { state: { ...state }, effects: [] };
  }

  if (action === "back") return { state: { ...state }, effects: [{ type: "close" }] };
  if (action === "up" || action === "down") {
    const delta = action === "up" ? -1 : 1;
    let cursor = state.rootCursor;
    if (context.rows.length > 0) {
      for (let count = 0; count < context.rows.length; count++) {
        cursor = wrap(cursor + delta, context.rows.length);
        if (context.rows[cursor]?.enabled) break;
      }
    }
    return { state: { ...state, rootCursor: cursor }, effects: [] };
  }
  if (action !== "confirm") return { state: { ...state }, effects: [] };
  const row = context.rows[clamp(state.rootCursor, context.rows.length)];
  if (!row?.enabled) return { state: { ...state }, effects: [] };
  if (row.id === "party") {
    if (state.party.length === 0) return { state: { ...state }, effects: [] };
    return { state: { ...state, screen: "party", partyMenu: listPartyState() }, effects: [] };
  }
  if (row.id === "player") {
    return { state: { ...state, screen: "player" }, effects: [] };
  }
  return { state: { ...state }, effects: [{ type: "dispatch", id: row.id }] };
}

/** Pure touch selection. It selects the active list but does not activate it;
 * call `confirm` through the reducer (or runtime.activateIndex) to share the
 * exact keyboard transition. Selecting a move destination performs the same
 * live swap as directional movement. */
export function startMenuSelectIndex(
  state: Readonly<StartMenuState>,
  index: number,
  context: Readonly<StartMenuReduceContext>,
): StartMenuTransition {
  if (state.screen === "root") {
    return {
      state: { ...state, rootCursor: clamp(index, context.rows.length) },
      effects: [],
    };
  }
  if (state.screen !== "party" || state.party.length === 0) {
    return { state: { ...state }, effects: [] };
  }
  const menu = state.partyMenu;
  if (menu.phase === "action") {
    const selected = state.party[clamp(menu.cursor, state.party.length)]!;
    return {
      state: updatePartyMenu(state, {
        ...menu,
        actionCursor: clamp(index, partyActions(selected, state.party.length).length),
      }),
      effects: [],
    };
  }
  if (menu.phase === "sort") {
    return {
      state: updatePartyMenu(state, { ...menu, sortCursor: clamp(index, PARTY_SORTS.length) }),
      effects: [],
    };
  }
  if (menu.phase === "releaseConfirm") {
    return {
      state: updatePartyMenu(state, { ...menu, releaseCursor: clamp(index, 2) as 0 | 1 }),
      effects: [],
    };
  }
  if (menu.phase === "moves") {
    const selected = state.party[clamp(menu.cursor, state.party.length)]!;
    return {
      state: updatePartyMenu(state, {
        ...menu,
        moveCursor: clamp(index, partyMoveViews(selected, context.catalog).length),
      }),
      effects: [],
    };
  }
  const destination = clamp(index, state.party.length);
  if (menu.phase === "move" && destination !== menu.cursor) {
    const nextParty = [...state.party];
    [nextParty[menu.cursor], nextParty[destination]] = [nextParty[destination]!, nextParty[menu.cursor]!];
    return {
      state: { ...state, party: nextParty, partyMenu: { ...menu, cursor: destination } },
      effects: [{ type: "persistParty" }],
    };
  }
  return {
    state: updatePartyMenu(state, { ...menu, cursor: destination, moveCursor: 0 }),
    effects: [],
  };
}

export interface StartMenuOptions {
  catalog: StartMenuCatalog;
  labels: StartMenuLabels;
  /** START by default. Must be one button bit. */
  openButton?: number;
  /** Override live defaults. false hides a row; "disabled" retains it. */
  availability?: StartMenuAvailability | ((state: SessionState) => StartMenuAvailability);
  /** Override the built-in Tuxepedia-at-0 and inventory-gated NuPhone-at-3 rows. */
  apps?: readonly StartMenuAppRow[] | ((state: SessionState) => readonly StartMenuAppRow[]);
  /** External root rows (bag/missions/save/load/options/apps/exit) dispatch here. */
  onDispatch?: (id: StartMenuRowId) => void;
  callbacks?: Partial<Record<StartMenuRowId, () => void>>;
}

export interface StartMenuRuntime {
  step: GameViewDemoRuntime["step"];
  isOpen: GameViewDemoRuntime["isOpen"];
  open(): void;
  close(): void;
  applyAction(action: StartMenuAction): void;
  /** Select only; use activateIndex for a tap that should also confirm. */
  selectIndex(index: number): void;
  activateIndex(index: number): void;
  swipe(direction: "left" | "right"): void;
  openSignal: Accessor<boolean>;
  state: Accessor<StartMenuState>;
  rows: Accessor<readonly StartMenuRow[]>;
  selectedMonster: Accessor<PartyMonsterView | null>;
  moves: Accessor<readonly PartyMoveView[]>;
  actionRows: Accessor<readonly PartyActionId[]>;
  sortRows: readonly PartySortId[];
  labels: StartMenuLabels;
}

export interface PocketStartMenuHook {
  open(): void;
  close(): void;
  isOpen(): boolean;
  state(): StartMenuState;
  rows(): readonly StartMenuRow[];
  act(action: StartMenuAction): void;
  selectIndex(index: number): void;
  activateIndex(index: number): void;
}

declare global {
  // eslint-disable-next-line no-var
  var __pocketStartMenu: PocketStartMenuHook | undefined;
}

function validateOpenButton(openButton: number): void {
  if (!Number.isInteger(openButton) || openButton <= 0 || openButton > 0xffff || (openButton & (openButton - 1)) !== 0) {
    throw new RangeError("start menu: openButton must be one u16 button bit");
  }
}

function defaultAvailability(session: SessionState, party: readonly SpawnedMonsterSnapshot[]): StartMenuAvailability {
  return {
    party: party.length > 0,
    bag: Object.values(session.sw.items).some((quantity) => quantity > 0),
    player: true,
    missions: false,
    save: true,
    load: true,
    options: true,
    exit: true,
  };
}

function defaultApps(session: SessionState, labels: StartMenuRootLabels): StartMenuAppRow[] {
  return [
    {
      id: "tuxepedia",
      label: labels.tuxepedia,
      position: 0,
      enabled: (session.sw.items.app_tuxepedia ?? 0) > 0,
    },
    {
      id: "nuphone",
      label: labels.nuphone,
      position: 3,
      enabled: (session.sw.items.nu_phone ?? 0) > 0,
    },
  ];
}

function readStartSnapshot(session: SessionState): { party: SpawnedMonsterSnapshot[]; player: PlayerSummary } {
  const ext = tuxemonExtensionState(session.ext);
  return { party: [...ext.party], player: playerSummary(session) };
}

export function createStartMenuRuntime(
  options: StartMenuOptions,
  host: GameViewSessionHost,
): StartMenuRuntime {
  const openButton = options.openButton ?? BTN.START;
  validateOpenButton(openButton);
  const firstSession = host.getState();
  const firstSnapshot = readStartSnapshot(firstSession);
  const [openSignal, setOpen] = createSignal(false);
  const [rows, setRows] = createSignal<readonly StartMenuRow[]>([]);
  const [state, setState] = createSignal<StartMenuState>({
    screen: "root",
    rootCursor: 0,
    partyMenu: listPartyState(),
    party: firstSnapshot.party,
    player: firstSnapshot.player,
  });

  const context = (): StartMenuReduceContext => ({ rows: rows(), catalog: options.catalog });
  const selectedMonster: Accessor<PartyMonsterView | null> = () => {
    const current = state();
    const monster = current.party[clamp(current.partyMenu.cursor, current.party.length)];
    return monster ? partyMonsterView(monster, options.catalog) : null;
  };
  const moves: Accessor<readonly PartyMoveView[]> = () => {
    const current = state();
    const monster = current.party[clamp(current.partyMenu.cursor, current.party.length)];
    return monster ? partyMoveViews(monster, options.catalog) : [];
  };
  const actionRows: Accessor<readonly PartyActionId[]> = () => {
    const current = state();
    const monster = current.party[clamp(current.partyMenu.cursor, current.party.length)];
    return monster ? partyActions(monster, current.party.length) : [];
  };

  const close = (): void => {
    setOpen(false);
  };
  const open = (): void => {
    const session = host.getState();
    const snapshot = readStartSnapshot(session);
    const defaults = defaultAvailability(session, snapshot.party);
    const overrides = typeof options.availability === "function"
      ? options.availability(session)
      : (options.availability ?? {});
    const apps = typeof options.apps === "function"
      ? options.apps(session)
      : (options.apps ?? defaultApps(session, options.labels.root));
    const nextRows = startMenuRows(options.labels.root, { ...defaults, ...overrides }, apps);
    const firstEnabled = nextRows.findIndex((row) => row.enabled);
    setRows(nextRows);
    setState({
      screen: "root",
      rootCursor: firstEnabled >= 0 ? firstEnabled : 0,
      partyMenu: listPartyState(),
      party: snapshot.party,
      player: snapshot.player,
    });
    setOpen(true);
  };

  const persistParty = (party: readonly SpawnedMonsterSnapshot[]): void => {
    const session = host.getState();
    const ext = tuxemonExtensionState(session.ext);
    host.replaceState({
      ...session,
      ext: packTuxemonExtensionState({ ...ext, party: [...party] }),
    }, host.heldButtons());
  };

  const perform = (transition: StartMenuTransition): boolean => {
    setState(transition.state);
    let stateChanged = false;
    for (const effect of transition.effects) {
      if (effect.type === "persistParty") {
        persistParty(transition.state.party);
        stateChanged = true;
      } else if (effect.type === "close") {
        close();
      } else {
        close();
        options.callbacks?.[effect.id]?.();
        options.onDispatch?.(effect.id);
      }
    }
    return stateChanged;
  };

  const applyActionWithResult = (action: StartMenuAction): boolean => {
    if (!openSignal()) return false;
    return perform(startMenuStep(state(), action, context()));
  };
  const applyAction = (action: StartMenuAction): void => {
    applyActionWithResult(action);
  };
  const selectIndexWithResult = (index: number): boolean => {
    if (!openSignal()) return false;
    return perform(startMenuSelectIndex(state(), index, context()));
  };
  const selectIndex = (index: number): void => {
    selectIndexWithResult(index);
  };
  const activateIndex = (index: number): void => {
    selectIndexWithResult(index);
    applyActionWithResult("confirm");
  };

  const step: GameViewDemoRuntime["step"] = (_buttons, pressed) => {
    if (!openSignal()) {
      if (pressed & openButton) {
        open();
        return { consumed: true };
      }
      return { consumed: false };
    }
    if (pressed & openButton) {
      close();
      return { consumed: true };
    }
    let action: StartMenuAction | null = null;
    if (pressed & BTN.UP) action = "up";
    else if (pressed & BTN.RIGHT) action = "right";
    else if (pressed & BTN.DOWN) action = "down";
    else if (pressed & BTN.LEFT) action = "left";
    else if (pressed & BTN.CIRCLE) action = "confirm";
    else if (pressed & BTN.CROSS) action = "back";
    const stateChanged = action === null ? false : applyActionWithResult(action);
    return stateChanged ? { consumed: true, stateChanged: true } : { consumed: true };
  };

  const hook: PocketStartMenuHook = {
    open,
    close,
    isOpen: openSignal,
    state,
    rows,
    act: applyAction,
    selectIndex,
    activateIndex,
  };
  globalThis.__pocketStartMenu = hook;
  onCleanup(() => {
    if (globalThis.__pocketStartMenu === hook) delete globalThis.__pocketStartMenu;
  });

  return {
    step,
    isOpen: openSignal,
    open,
    close,
    applyAction,
    selectIndex,
    activateIndex,
    swipe: applyAction,
    openSignal,
    state,
    rows,
    selectedMonster,
    moves,
    actionRows,
    sortRows: PARTY_SORTS,
    labels: options.labels,
  };
}

// Game-owned out-of-battle Bag controller. The reducer-facing item mechanics
// live in battle/world-items.ts; this module owns menu navigation, live-session
// persistence, localized prompts, and the handoff of map-owned directives.

import { createSignal, onCleanup, type Accessor } from "solid-js";
import { BTN } from "@pocketjs/framework/input";
import {
  packTuxemonExtensionState,
  tuxemonExtensionState,
  type TuxemonExtensionState,
} from "../battle/extension.ts";
import {
  listWorldItems,
  useWorldItem,
  worldItemTargetEligibility,
  type WorldItemContext,
  type WorldItemDirective,
  type WorldItemListEntry,
  type WorldItemPage,
  type WorldItemUseResult,
} from "../battle/world-items.ts";
import type { BattleDb } from "../importer/battle-schema.ts";
import type {
  GameViewDemoRuntime,
  GameViewSessionHost,
} from "../vendor/pocket-rpgkit/src/ui/demo-contract.ts";
import type { StartMenuData } from "./feature-modes-data.ts";
import type { Lang } from "./language.ts";

export type BagMenuScreen = "items" | "confirm" | "party" | "moves" | "message";
export type BagMenuAction = "up" | "down" | "left" | "right" | "confirm" | "back";
export type BagSwipeDirection = "up" | "down" | "left" | "right";

export interface BagMenuMessage {
  text: string;
  back: Exclude<BagMenuScreen, "message">;
  closeAfter: boolean;
}

export interface BagMenuState {
  screen: BagMenuScreen;
  page: number;
  cursor: number;
  /** 0 = Use, 1 = Cancel. */
  actionCursor: 0 | 1;
  partyCursor: number;
  moveCursor: number;
  selectedItem: string | null;
  selectedTarget: number | null;
  message: BagMenuMessage | null;
  /** Forces reactive views to re-read host state after a committed use. */
  revision: number;
}

export interface BagMenuLabels {
  title: string;
  use: string;
  cancel: string;
  cannotUseHere: string;
  noTarget: string;
  party: string;
  techniques: string;
  back: string;
  empty: string;
  hp: string;
}

export interface BagPartyRow {
  index: number;
  iid: string | null;
  name: string;
  species: string;
  level: number;
  hp: number;
  maxHp: number;
  status: string | null;
  eligible: boolean;
}

export interface BagMoveRow {
  index: number;
  slug: string;
  name: string;
}

export interface BagMenuOptions {
  db: BattleDb;
  data: StartMenuData;
  lang: Lang;
  /** Live environmental facts needed by fishing, hammer, and item evolution. */
  context?: WorldItemContext | ((host: GameViewSessionHost) => WorldItemContext);
  /** The world shell applies teleport/fishing/entity directives. */
  onDirectives?: (
    directives: readonly WorldItemDirective[],
    result: Readonly<WorldItemUseResult>,
    host: GameViewSessionHost,
  ) => void;
  /** Actual use (success or post-effect failure) lets the parent close START. */
  onComplete?: (completion: BagMenuCompletion) => void;
  onClose?: () => void;
}

export type BagMenuCompletion =
  | { kind: "dismissed" }
  | { kind: "used"; result: WorldItemUseResult };

export interface BagMenuRuntime {
  step: GameViewDemoRuntime["step"];
  isOpen: GameViewDemoRuntime["isOpen"];
  open(): void;
  close(): void;
  applyAction(action: BagMenuAction): void;
  /** Touch path: select a row in the currently visible screen. */
  selectIndex(index: number): void;
  /** Touch path: select and confirm through the same reducer path. */
  activateIndex(index: number): void;
  /** Both horizontal and vertical swipes page the item list. */
  swipe(direction: BagSwipeDirection): void;
  openSignal: Accessor<boolean>;
  state: Accessor<BagMenuState>;
  page: Accessor<WorldItemPage>;
  partyRows: Accessor<readonly BagPartyRow[]>;
  moveRows: Accessor<readonly BagMoveRow[]>;
  selectedItem: Accessor<WorldItemListEntry | null>;
  completion: Accessor<BagMenuCompletion | null>;
  labels: BagMenuLabels;
  lang: Lang;
}

export interface PocketBagMenuHook {
  open(): void;
  close(): void;
  isOpen(): boolean;
  state(): BagMenuState;
  page(): WorldItemPage;
  completion(): BagMenuCompletion | null;
  act(action: BagMenuAction): void;
  selectIndex(index: number): void;
  activateIndex(index: number): void;
  swipe(direction: BagSwipeDirection): void;
}

declare global {
  // eslint-disable-next-line no-var
  var __pocketBagMenu: PocketBagMenuHook | undefined;
}

function localized(value: { en_US: string; zh_CN: string }, lang: Lang): string {
  return value[lang];
}

export function bagMenuLabels(data: StartMenuData, lang: Lang): BagMenuLabels {
  return {
    title: localized(data.root.bag, lang),
    use: localized(data.bag.use, lang),
    cancel: localized(data.bag.cancel, lang),
    cannotUseHere: localized(data.bag.cannotUseHere, lang),
    noTarget: localized(data.bag.noTarget, lang),
    party: localized(data.root.party, lang),
    techniques: localized(data.party.techniques, lang),
    back: localized(data.common.back, lang),
    empty: localized(data.common.empty, lang),
    hp: localized(data.common.hp, lang),
  };
}

function formatName(template: string, name: string): string {
  return template.replaceAll("{name}", name);
}

function wrap(index: number, length: number): number {
  return length > 0 ? (index + length) % length : 0;
}

function clamp(index: number, length: number): number {
  return length > 0 ? Math.max(0, Math.min(length - 1, Math.trunc(index))) : 0;
}

function initialState(): BagMenuState {
  return {
    screen: "items",
    page: 0,
    cursor: 0,
    actionCursor: 0,
    partyCursor: 0,
    moveCursor: 0,
    selectedItem: null,
    selectedTarget: null,
    message: null,
    revision: 0,
  };
}

function contextValue(options: BagMenuOptions, host: GameViewSessionHost): WorldItemContext {
  return typeof options.context === "function" ? options.context(host) : (options.context ?? {});
}

function unavailableMessage(
  labels: BagMenuLabels,
  item: Pick<WorldItemListEntry, "name" | "reason">,
): string {
  const locationFailure = item.reason === "not-usable-in-world"
    || item.reason === "wrong-location"
    || item.reason === "no-faint-point";
  return formatName(locationFailure ? labels.cannotUseHere : labels.noTarget, item.name);
}

function partyRow(
  db: BattleDb,
  extension: Readonly<TuxemonExtensionState>,
  index: number,
  eligible: boolean,
): BagPartyRow {
  const monster = extension.party[index]!;
  const species = db.monsters[monster.slug];
  const maxHp = Math.max(0, monster.base.hp);
  return {
    index,
    iid: monster.iid ?? null,
    name: monster.nickname ?? species?.name ?? monster.slug,
    species: species?.name ?? monster.slug,
    level: monster.level,
    hp: Math.max(0, Math.min(maxHp, monster.currentHp ?? maxHp)),
    maxHp,
    status: monster.status ?? null,
    eligible,
  };
}

export function createBagMenuRuntime(
  options: BagMenuOptions,
  host: GameViewSessionHost,
): BagMenuRuntime {
  const labels = bagMenuLabels(options.data, options.lang);
  const [openSignal, setOpen] = createSignal(false);
  const [state, setState] = createSignal<BagMenuState>(initialState());
  const [completion, setCompletion] = createSignal<BagMenuCompletion | null>(null);

  const snapshot = () => {
    // Reading state().revision gives accessors a reactive dependency after a
    // host replacement, even though the host itself is not a Solid signal.
    state().revision;
    const session = host.getState();
    return { session, extension: tuxemonExtensionState(session.ext) };
  };
  const page: Accessor<WorldItemPage> = () => {
    const current = state();
    const live = snapshot();
    return listWorldItems(options.db, live.extension, live.session.sw, {
      page: current.page,
      context: contextValue(options, host),
    });
  };
  const selectedItem: Accessor<WorldItemListEntry | null> = () => {
    const current = state();
    if (current.selectedItem) {
      const live = snapshot();
      const all = listWorldItems(options.db, live.extension, live.session.sw, {
        page: current.page,
        context: contextValue(options, host),
      });
      return all.items.find((row) => row.slug === current.selectedItem)
        ?? (options.db.items[current.selectedItem] ? {
          slug: current.selectedItem,
          name: options.db.items[current.selectedItem]!.name,
          description: options.db.items[current.selectedItem]!.description,
          quantity: live.session.sw.items[current.selectedItem] ?? 0,
          sort: options.db.items[current.selectedItem]!.sort,
          category: options.db.items[current.selectedItem]!.category,
          requiresTarget: options.db.items[current.selectedItem]!.behaviors.requires_monster_menu === true,
          usable: true,
          reason: null,
          detail: null,
        } : null);
    }
    return page().items[current.cursor] ?? null;
  };
  const partyRows: Accessor<readonly BagPartyRow[]> = () => {
    const current = state();
    const live = snapshot();
    const slug = current.selectedItem;
    if (!slug) return [];
    return live.extension.party.map((_, index) => partyRow(
      options.db,
      live.extension,
      index,
      worldItemTargetEligibility(
        options.db,
        live.extension,
        live.session.sw,
        slug,
        index,
        contextValue(options, host),
      ).eligible,
    ));
  };
  const moveRows: Accessor<readonly BagMoveRow[]> = () => {
    const current = state();
    const live = snapshot();
    const target = current.selectedTarget === null ? undefined : live.extension.party[current.selectedTarget];
    return (target?.moves ?? []).map((slug, index) => ({
      index,
      slug,
      name: options.db.techniques[slug]?.name ?? slug,
    }));
  };

  const close = (): void => {
    if (openSignal() && completion() === null) {
      const dismissed: BagMenuCompletion = { kind: "dismissed" };
      setCompletion(dismissed);
      options.onComplete?.(dismissed);
    }
    setOpen(false);
    options.onClose?.();
  };
  const open = (): void => {
    setState(initialState());
    setCompletion(null);
    setOpen(true);
  };
  const showMessage = (
    text: string,
    back: Exclude<BagMenuScreen, "message">,
    closeAfter: boolean,
  ): void => {
    setState((current) => ({ ...current, screen: "message", message: { text, back, closeAfter } }));
  };

  const settleUse = (
    result: WorldItemUseResult,
    back: "items" | "party",
    stateChanged: boolean,
  ): boolean => {
    const before = host.getState();
    if (stateChanged) {
      host.replaceState({
        ...before,
        sw: result.switches,
        ext: packTuxemonExtensionState(result.extension),
      }, host.heldButtons());
    }
    if (result.directives.length > 0) options.onDirectives?.(result.directives, result, host);
    const used: BagMenuCompletion = { kind: "used", result };
    setCompletion(used);
    options.onComplete?.(used);
    const item = options.db.items[result.item]!;
    const show = result.success
      ? item.behaviors.show_dialog_on_success === true
      : item.behaviors.show_dialog_on_failure === true;
    if (show) {
      setState((current) => ({
        ...current,
        screen: "message",
        message: { text: result.message, back, closeAfter: true },
        revision: current.revision + (stateChanged ? 1 : 0),
      }));
    } else {
      close();
    }
    return stateChanged;
  };

  const useSelected = (targetIndex?: number, forgetMove?: number): boolean => {
    const current = state();
    const item = current.selectedItem;
    if (!item) return false;
    const live = snapshot();
    const result = useWorldItem(options.db, live.extension, live.session.sw, {
      item,
      ...(targetIndex === undefined ? {} : { target: targetIndex }),
      ...(forgetMove === undefined ? {} : { forgetMove }),
      context: contextValue(options, host),
    });
    const stateChanged = result.extension !== live.extension || result.switches !== live.session.sw;
    if (result.reason === "move-choice-required" && result.moveChoice) {
      setState((value) => ({
        ...value,
        screen: "moves",
        selectedTarget: result.moveChoice!.targetIndex,
        moveCursor: 0,
        message: null,
      }));
      return false;
    }
    if (!result.consumed && !result.success) {
      const row = selectedItem();
      showMessage(
        row ? unavailableMessage(labels, { ...row, reason: result.reason }) : result.message,
        targetIndex === undefined ? "items" : "party",
        false,
      );
      return false;
    }
    return settleUse(result, targetIndex === undefined ? "items" : "party", stateChanged);
  };

  const applyActionWithResult = (action: BagMenuAction): boolean => {
    if (!openSignal()) return false;
    const current = state();
    if (current.screen === "message") {
      if (action !== "confirm" && action !== "back") return false;
      if (current.message?.closeAfter) close();
      else setState({ ...current, screen: current.message?.back ?? "items", message: null });
      return false;
    }

    if (current.screen === "items") {
      const rows = page().items;
      if (action === "back") {
        close();
      } else if (action === "up" || action === "down") {
        const delta = action === "up" ? -1 : 1;
        setState({ ...current, cursor: wrap(current.cursor + delta, rows.length) });
      } else if (action === "left" || action === "right") {
        const info = page();
        const delta = action === "left" ? -1 : 1;
        setState({
          ...current,
          page: wrap(info.page + delta, info.pageCount),
          cursor: 0,
          selectedItem: null,
        });
      } else if (action === "confirm") {
        const row = rows[clamp(current.cursor, rows.length)];
        if (!row) return false;
        if (!row.usable) {
          showMessage(unavailableMessage(labels, row), "items", false);
        } else {
          setState({ ...current, screen: "confirm", selectedItem: row.slug, actionCursor: 0 });
        }
      }
      return false;
    }

    if (current.screen === "confirm") {
      if (action === "back") {
        setState({ ...current, screen: "items", selectedItem: null });
      } else if (action === "up" || action === "down" || action === "left" || action === "right") {
        setState({ ...current, actionCursor: current.actionCursor === 0 ? 1 : 0 });
      } else if (action === "confirm") {
        if (current.actionCursor === 1) {
          setState({ ...current, screen: "items", selectedItem: null });
        } else if (options.db.items[current.selectedItem!]?.behaviors.requires_monster_menu === true) {
          setState({ ...current, screen: "party", partyCursor: 0, selectedTarget: null });
        } else {
          return useSelected();
        }
      }
      return false;
    }

    if (current.screen === "party") {
      const rows = partyRows();
      if (action === "back") {
        setState({ ...current, screen: "confirm", selectedTarget: null });
      } else if (action === "up" || action === "down") {
        const delta = action === "up" ? -1 : 1;
        setState({ ...current, partyCursor: wrap(current.partyCursor + delta, rows.length) });
      } else if (action === "confirm") {
        const row = rows[clamp(current.partyCursor, rows.length)];
        if (!row) return false;
        if (!row.eligible) {
          const item = selectedItem();
          showMessage(formatName(labels.noTarget, item?.name ?? current.selectedItem ?? ""), "party", false);
        } else {
          setState({ ...current, selectedTarget: row.index });
          return useSelected(row.index);
        }
      }
      return false;
    }

    // moves
    const moves = moveRows();
    if (action === "back") {
      setState({ ...current, screen: "party", moveCursor: 0 });
    } else if (action === "up" || action === "down") {
      const delta = action === "up" ? -1 : 1;
      setState({ ...current, moveCursor: wrap(current.moveCursor + delta, moves.length) });
    } else if (action === "confirm" && current.selectedTarget !== null && moves.length > 0) {
      return useSelected(current.selectedTarget, clamp(current.moveCursor, moves.length));
    }
    return false;
  };

  const applyAction = (action: BagMenuAction): void => {
    applyActionWithResult(action);
  };
  const selectIndex = (index: number): void => {
    if (!openSignal()) return;
    const current = state();
    if (current.screen === "items") setState({ ...current, cursor: clamp(index, page().items.length) });
    else if (current.screen === "confirm") setState({ ...current, actionCursor: clamp(index, 2) as 0 | 1 });
    else if (current.screen === "party") setState({ ...current, partyCursor: clamp(index, partyRows().length) });
    else if (current.screen === "moves") setState({ ...current, moveCursor: clamp(index, moveRows().length) });
  };
  const activateIndex = (index: number): void => {
    selectIndex(index);
    applyActionWithResult("confirm");
  };
  const swipe = (direction: BagSwipeDirection): void => {
    if (state().screen !== "items") return;
    applyActionWithResult(direction === "left" || direction === "up" ? "right" : "left");
  };

  const step: GameViewDemoRuntime["step"] = (_buttons, pressed) => {
    if (!openSignal()) return { consumed: false };
    let action: BagMenuAction | null = null;
    if (pressed & BTN.UP) action = "up";
    else if (pressed & (BTN.RIGHT | BTN.RTRIGGER)) action = "right";
    else if (pressed & BTN.DOWN) action = "down";
    else if (pressed & (BTN.LEFT | BTN.LTRIGGER)) action = "left";
    else if (pressed & BTN.CIRCLE) action = "confirm";
    else if (pressed & (BTN.CROSS | BTN.START)) action = "back";
    const stateChanged = action === null ? false : applyActionWithResult(action);
    return stateChanged ? { consumed: true, stateChanged: true } : { consumed: true };
  };

  const hook: PocketBagMenuHook = {
    open,
    close,
    isOpen: openSignal,
    state,
    page,
    completion,
    act: applyAction,
    selectIndex,
    activateIndex,
    swipe,
  };
  globalThis.__pocketBagMenu = hook;
  onCleanup(() => {
    if (globalThis.__pocketBagMenu === hook) delete globalThis.__pocketBagMenu;
  });

  return {
    step,
    isOpen: openSignal,
    open,
    close,
    applyAction,
    selectIndex,
    activateIndex,
    swipe,
    openSignal,
    state,
    page,
    partyRows,
    moveRows,
    selectedItem,
    completion,
    labels,
    lang: options.lang,
  };
}

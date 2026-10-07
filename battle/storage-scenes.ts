// Monster-management scenes: PC storage, scripted trades and monster shops.
//
// Every reducer is pure JSON in, JSON out. A scene keeps the extension
// state it opened with plus a small draft (iid orderings, purchases), and
// commits one replacement extension state on completion, so save/restore,
// rewind and multi-rate replay follow the kit's scene lifecycle.

import type { ExtensionReadContext } from "../vendor/pocket-rpgkit/src/engine/extensions.ts";
import { rngNext } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";
import type { SceneCompletion, SceneInput, SceneRules } from "../vendor/pocket-rpgkit/src/engine/scene.ts";
import type { JsonValue } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import {
  KENNEL_BOX,
  KENNEL_LIMIT,
  LOCKER_ITEM_CAP,
  LOCKER_LIMIT,
  PARTY_LIMIT,
  nextMonsterIid,
  packTuxemonExtensionState,
  registerCaughtMonster,
  resolveBattleDb,
  tuxemonExtensionState,
  type BattleDbSource,
  type GameLang,
  type MonsterBox,
  type TuxemonExtensionState,
} from "./extension.ts";
import { battleDbToTuxemonBattleDb } from "./from-battle-db.ts";
import { MONSTER_SHOP_LABELS_ZH, PC_LABELS_ZH, TRADE_MESSAGE_ZH } from "./scene-labels-zh.ts";
import { spawnMonsterWithRandom } from "./spawn.ts";
import type { SpawnedMonsterSnapshot } from "./types.ts";

/** Re-exported for the scene's title templates ({max} placeholders). */
export { LOCKER_LIMIT, PARTY_LIMIT };

export const TUXEMON_PC_SCENE_ID = "tux.pc";
export const TUXEMON_TRADE_SCENE_ID = "tux.trade";
export const TUXEMON_MONSTER_SHOP_SCENE_ID = "tux.monsterShop";

/** Upstream item-box id created on the first PC visit (sizes.LOCKER). */
export const LOCKER_BOX = "Locker";

/** Upstream TradingTransition runs for eight seconds at the 60 Hz reference. */
export const TRADE_ANIMATION_TICKS = 480;
/** Upstream `bond_acquisition` in config_monster.yaml. */
const TRADED_BOND = 10;
const PURCHASED_BOND = 20;

type Names = (slug: string) => string;

function record(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

function text(value: JsonValue | undefined, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function wrap(index: number, length: number): number {
  return length > 0 ? (index + length) % length : 0;
}

/** Substitute {name}-style placeholders; unknown keys are left literal. */
export function format(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

function seededRandom(seed: number): { random: () => number; cursor: () => number } {
  let cursor = seed >>> 0;
  return {
    random() {
      const next = rngNext(cursor);
      cursor = next.next;
      return next.value;
    },
    cursor: () => cursor,
  };
}

function monsterLabel(monster: SpawnedMonsterSnapshot, names: Names): string {
  return monster.nickname ?? names(monster.slug);
}

// ---------------------------------------------------------------------------
// PC storage

export interface StorageMonsterRow {
  iid: string;
  slug: string;
  label: string;
  level: number;
  hp: number;
  maxHp: number;
}

export interface StorageBoxRow {
  id: string;
  label: string;
  hidden: boolean;
  capacity: number;
  /** Instance ids in storage order. Menus display them sorted by slug. */
  monsters: string[];
}

export interface PcLabels {
  title: string;
  pickUp: string;
  dropOff: string;
  logOff: string;
  pick: string;
  moveTo: string;
  release: string;
  cancel: string;
  yes: string;
  no: string;
  empty: string;
  full: string;
  added: string;
  stored: string;
  moved: string;
  releaseConfirm: string;
  released: string;
  lastMonster: string;
  itemPickUp: string;
  itemDropOff: string;
  itemTake: string;
  itemDisband: string;
  itemEmpty: string;
  itemLockerFull: string;
  bagFull: string;
  itemTaken: string;
  itemDisbanded: string;
  itemStored: string;
  itemBagEmpty: string;
  lockerBox: string;
  // Footer hints and detail-panel titles. The scene composes these instead
  // of hardcoding English, so zh_CN builds read in Chinese with the game's
  // key-name wording (行动键/取消键/…). {kinds}/{items}/{party}/{max} are
  // substituted at render time. No upstream msgids; the per-language
  // defaults own them.
  hintMenu: string;
  hintBoxesPickUp: string;
  hintBoxesDropOff: string;
  hintParty: string;
  hintOptions: string;
  hintItemBoxes: string;
  hintItemBag: string;
  hintSelect: string;
  hintQuantity: string;
  quantityHint: string;
  bagTitle: string;
  lockerTitle: string;
  partyTitle: string;
}

const PC_LABELS: PcLabels = {
  title: "PC",
  pickUp: "Pick Up Tuxemon",
  dropOff: "Drop Off Tuxemon",
  logOff: "Log Off",
  pick: "Pick up",
  moveTo: "Move to {box}",
  release: "Release",
  cancel: "Cancel",
  yes: "Yes",
  no: "No",
  empty: "This shelter is empty, there are no monsters to take.",
  full: "This shelter is full.",
  added: "You added {name} into your party!",
  stored: "{name} was stored in {box}.",
  moved: "{name} was moved to {box}.",
  releaseConfirm: "Are you sure you would like to release {name}?",
  released: "{name} has been released.",
  lastMonster: "{name} is your last Tuxemon able to fight.",
  itemPickUp: "Pick Up Item",
  itemDropOff: "Drop Off Item",
  itemTake: "Take",
  itemDisband: "Disband",
  itemEmpty: "This locker is empty, there are no items to take.",
  itemLockerFull: "This locker is full.",
  bagFull: "Your bag is full, you cannot take any more from storage.",
  itemTaken: "You added {nr} {name} into your bag!",
  itemDisbanded: "{nr} {name} have been disbanded.",
  itemStored: "{nr} {name} were stored in the locker.",
  itemBagEmpty: "You have no items that can be stored.",
  lockerBox: "Locker",
  hintMenu: "Up/Down: choose  A: select",
  hintBoxesPickUp: "Choose a box to open.  B: back",
  hintBoxesDropOff: "Choose a box to store it in.  B: back",
  hintParty: "Choose a Tuxemon to drop off.  B: back",
  hintOptions: "A: options  B: back  Left/Right: page",
  hintItemBoxes: "A: open the locker  B: back",
  hintItemBag: "A: store  B: back  Left/Right: page",
  hintSelect: "A: select  B: back",
  hintQuantity: "Left/Right: +/-1  Up/Down: +/-10  A: ok  B: back",
  quantityHint: "< > 1   ^ v 10   A ok   B back",
  bagTitle: "BAG {kinds} KINDS",
  lockerTitle: "LOCKER {kinds}/{max} {items} ITEMS",
  partyTitle: "PARTY {party}/{max}",
};

export type PcMenuItem = "pickUp" | "dropOff" | "itemPickUp" | "itemDropOff" | "logOff";
export type PcOption = "pick" | "move" | "release" | "cancel";
export type PcItemOption = "take" | "disband" | "cancel";
export type PcPhase =
  | "menu"
  | "boxes"
  | "box"
  | "options"
  | "moveTarget"
  | "confirmRelease"
  | "party"
  | "itemBoxes"
  | "itemLocker"
  | "itemBag"
  | "itemOptions"
  | "itemQuantity"
  | "done";

export interface PcSceneState {
  kind: "pc";
  base: JsonValue;
  labels: PcLabels;
  monsters: Record<string, StorageMonsterRow>;
  party: string[];
  boxes: StorageBoxRow[];
  phase: PcPhase;
  /** "pickUp" browses boxes; "dropOff" chooses the target of partyCursor. */
  mode: "pickUp" | "dropOff";
  menuCursor: number;
  boxCursor: number;
  monsterCursor: number;
  optionCursor: number;
  targetCursor: number;
  partyCursor: number;
  confirmCursor: number;
  message: string | null;
  // --- Item locker draft (committed atomically on Log Off) ---
  /** Locker stacks, keyed by item slug. Upstream "Locker" item box. */
  locker: Record<string, number>;
  /** Backpack draft, seeded from the session bag and committed on Log Off. */
  bag: Record<string, number>;
  /** Item display names from the project catalog (slug -> name). */
  itemNames: Record<string, string>;
  /** Item slugs upstream hides from menus (behaviors.visible == false). */
  notStorable: string[];
  /** "itemPickUp" browses the locker; "itemDropOff" fills it from the bag. */
  itemMode: "pickUp" | "dropOff";
  itemBoxCursor: number;
  itemCursor: number;
  itemOptionCursor: number;
  quantity: number;
  quantityMax: number;
  quantityMode: "take" | "disband" | "deposit";
  /** Set once the backpack draft diverges from the session bag. */
  bagDirty: boolean;
}

function stateOf<T>(value: JsonValue): T {
  return value as unknown as T;
}

export function pcVisibleBoxes(state: Readonly<PcSceneState>): StorageBoxRow[] {
  return state.boxes.filter((box) => !box.hidden);
}

export function pcMenuItems(state: Readonly<PcSceneState>): PcMenuItem[] {
  const items: PcMenuItem[] = [];
  if (pcVisibleBoxes(state).some((box) => box.monsters.length > 0)) items.push("pickUp");
  if (state.party.length > 1) items.push("dropOff");
  // Upstream PCMenuBuilder: item storage shows when a visible item box holds
  // items; item drop-off shows when the bag carries more than one item type.
  if (pcLockerItemCount(state) > 0) items.push("itemPickUp");
  if (pcBagKindCount(state) > 1) items.push("itemDropOff");
  items.push("logOff");
  return items;
}

/** Locker item display rows: upstream sorts the grid by slug. */
export function pcLockerRows(state: Readonly<PcSceneState>): string[] {
  return Object.keys(state.locker).sort();
}

/** Bag rows eligible for drop-off: upstream ItemFilter.set_filter_all_visible. */
export function pcBagRows(state: Readonly<PcSceneState>): string[] {
  const hidden = new Set(state.notStorable);
  return Object.keys(state.bag).filter((slug) => !hidden.has(slug) && state.bag[slug]! > 0).sort();
}

export function pcLockerItemCount(state: Readonly<PcSceneState>): number {
  return Object.values(state.locker).reduce((sum, quantity) => sum + quantity, 0);
}

export function pcLockerKindCount(state: Readonly<PcSceneState>): number {
  return Object.keys(state.locker).length;
}

export function pcBagKindCount(state: Readonly<PcSceneState>): number {
  return Object.values(state.bag).filter((quantity) => quantity > 0).length;
}

export function pcItemName(state: Readonly<PcSceneState>, slug: string): string {
  return state.itemNames[slug] ?? slug;
}

/** Upstream item option list: take and disband (change needs >= 2 boxes). */
export function pcItemOptions(state: Readonly<PcSceneState>): PcItemOption[] {
  return ["take", "disband", "cancel"];
}

/** Max that can be taken from the locker into the bag without the kit's
 *  backpack normalization discarding the excess. */
export function pcTakeMax(state: Readonly<PcSceneState>, slug: string): number {
  const held = state.bag[slug] ?? 0;
  if (held > 0) return Math.min(state.locker[slug] ?? 0, LOCKER_ITEM_CAP - held);
  // A new kind needs a free backpack slot (kit maxKinds).
  return pcBagKindCount(state) >= LOCKER_ITEM_CAP ? 0 : (state.locker[slug] ?? 0);
}

/** Max that can be deposited from the bag into the locker. */
export function pcDepositMax(state: Readonly<PcSceneState>, slug: string): number {
  const held = state.locker[slug] ?? 0;
  if (held > 0) return Math.min(state.bag[slug] ?? 0, LOCKER_ITEM_CAP - held);
  // A new locker kind needs a free locker slot (MAX_LOCKER).
  return pcLockerKindCount(state) >= LOCKER_LIMIT ? 0 : (state.bag[slug] ?? 0);
}

/** Box contents in display order: upstream sorts the grid by slug. */
export function pcBoxView(state: Readonly<PcSceneState>, box: Readonly<StorageBoxRow>): string[] {
  return box.monsters
    .map((iid, index) => ({ iid, index }))
    .sort((a, b) => {
      const left = state.monsters[a.iid]!.slug;
      const right = state.monsters[b.iid]!.slug;
      return left < right ? -1 : left > right ? 1 : a.index - b.index;
    })
    .map((entry) => entry.iid);
}

export function pcSelectedBox(state: Readonly<PcSceneState>): StorageBoxRow | undefined {
  return pcVisibleBoxes(state)[state.boxCursor];
}

export function pcSelectedMonster(state: Readonly<PcSceneState>): string | undefined {
  const box = pcSelectedBox(state);
  return box ? pcBoxView(state, box)[state.monsterCursor] : undefined;
}

function moveCandidates(state: Readonly<PcSceneState>, from: Readonly<StorageBoxRow>): StorageBoxRow[] {
  const visible = pcVisibleBoxes(state);
  // Upstream offers "move" only with two or more visible boxes.
  if (visible.length < 2) return [];
  return visible.filter((box) => box.id !== from.id && box.monsters.length < box.capacity);
}

export function pcOptions(state: Readonly<PcSceneState>): PcOption[] {
  const box = pcSelectedBox(state);
  const options: PcOption[] = [];
  if (state.party.length < PARTY_LIMIT) options.push("pick");
  if (box && moveCandidates(state, box).length > 0) options.push("move");
  options.push("release", "cancel");
  return options;
}

export function pcMoveTargets(state: Readonly<PcSceneState>): StorageBoxRow[] {
  const box = pcSelectedBox(state);
  return box ? moveCandidates(state, box) : [];
}

/** Upstream disables the party's last conscious monster in Drop Off. */
export function pcPartyEntryLocked(state: Readonly<PcSceneState>, iid: string): boolean {
  const conscious = state.party.filter((candidate) => state.monsters[candidate]!.hp > 0);
  return conscious.length === 1 && conscious[0] === iid;
}

function pcLabels(raw: JsonValue | undefined, lang: GameLang = "en_US"): PcLabels {
  const source = record(raw);
  const labels = { ...(lang === "zh_CN" ? PC_LABELS_ZH : PC_LABELS) };
  for (const key of Object.keys(labels) as (keyof PcLabels)[]) {
    labels[key] = text(source[key], labels[key]);
  }
  return labels;
}

function boxLabel(id: string, labels: Readonly<Record<string, JsonValue>>): string {
  return text(labels[id], id);
}

function storageRow(monster: SpawnedMonsterSnapshot, names: Names): StorageMonsterRow {
  return {
    iid: monster.iid!,
    slug: monster.slug,
    label: monsterLabel(monster, names),
    level: monster.level,
    hp: monster.currentHp ?? monster.base.hp,
    maxHp: monster.base.hp,
  };
}

function afterBoxChange(state: PcSceneState): void {
  const box = pcSelectedBox(state);
  if (!box || box.monsters.length === 0) {
    state.phase = "boxes";
    state.monsterCursor = 0;
    return;
  }
  state.phase = "box";
  state.monsterCursor = Math.min(state.monsterCursor, box.monsters.length - 1);
}

function pcStep(state: PcSceneState, input: Readonly<SceneInput>): void {
  const up = input.upEdge === true;
  const down = input.downEdge === true;
  const labels = state.labels;
  const nameOf = (iid: string) => state.monsters[iid]!.label;
  if (input.confirmEdge || input.cancelEdge || up || down) state.message = null;
  switch (state.phase) {
    case "menu": {
      const items = pcMenuItems(state);
      state.menuCursor = Math.min(state.menuCursor, items.length - 1);
      // The upstream PC ignores escape: Log Off is the only way out.
      if (up) state.menuCursor = wrap(state.menuCursor - 1, items.length);
      else if (down) state.menuCursor = wrap(state.menuCursor + 1, items.length);
      else if (input.confirmEdge) {
        const item = items[state.menuCursor]!;
        if (item === "logOff") state.phase = "done";
        else if (item === "pickUp") {
          state.mode = "pickUp";
          state.phase = "boxes";
          state.boxCursor = 0;
        } else if (item === "itemPickUp") {
          state.itemMode = "pickUp";
          state.phase = "itemBoxes";
          state.itemBoxCursor = 0;
        } else if (item === "itemDropOff") {
          state.itemMode = "dropOff";
          state.phase = "itemBoxes";
          state.itemBoxCursor = 0;
        } else {
          state.mode = "dropOff";
          state.phase = "party";
          state.partyCursor = 0;
        }
      }
      return;
    }
    case "boxes": {
      const boxes = pcVisibleBoxes(state);
      if (up) state.boxCursor = wrap(state.boxCursor - 1, boxes.length);
      else if (down) state.boxCursor = wrap(state.boxCursor + 1, boxes.length);
      else if (input.cancelEdge) state.phase = state.mode === "pickUp" ? "menu" : "party";
      else if (input.confirmEdge) {
        const box = boxes[state.boxCursor];
        if (!box) return;
        if (state.mode === "pickUp") {
          if (box.monsters.length === 0) state.message = labels.empty;
          else {
            state.phase = "box";
            state.monsterCursor = 0;
          }
        } else if (box.monsters.length >= box.capacity) {
          state.message = labels.full;
        } else {
          const iid = state.party[state.partyCursor]!;
          state.party.splice(state.partyCursor, 1);
          box.monsters.push(iid);
          state.message = format(labels.stored, { name: nameOf(iid), box: box.label });
          state.phase = "menu";
          state.menuCursor = 0;
        }
      }
      return;
    }
    case "box": {
      const box = pcSelectedBox(state)!;
      if (up) state.monsterCursor = wrap(state.monsterCursor - 1, box.monsters.length);
      else if (down) state.monsterCursor = wrap(state.monsterCursor + 1, box.monsters.length);
      else if (input.leftEdge) state.monsterCursor = Math.max(0, state.monsterCursor - 8);
      else if (input.rightEdge) state.monsterCursor = Math.min(box.monsters.length - 1, state.monsterCursor + 8);
      else if (input.cancelEdge) state.phase = "boxes";
      else if (input.confirmEdge) {
        state.phase = "options";
        state.optionCursor = 0;
      }
      return;
    }
    case "options": {
      const options = pcOptions(state);
      if (up) state.optionCursor = wrap(state.optionCursor - 1, options.length);
      else if (down) state.optionCursor = wrap(state.optionCursor + 1, options.length);
      else if (input.cancelEdge) state.phase = "box";
      else if (input.confirmEdge) {
        const option = options[state.optionCursor]!;
        const box = pcSelectedBox(state)!;
        const iid = pcSelectedMonster(state)!;
        if (option === "cancel") state.phase = "box";
        else if (option === "pick") {
          box.monsters.splice(box.monsters.indexOf(iid), 1);
          state.party.push(iid);
          state.message = format(labels.added, { name: nameOf(iid) });
          afterBoxChange(state);
        } else if (option === "release") {
          state.phase = "confirmRelease";
          state.confirmCursor = 1;
        } else {
          const targets = pcMoveTargets(state);
          if (targets.length === 1) {
            box.monsters.splice(box.monsters.indexOf(iid), 1);
            targets[0]!.monsters.push(iid);
            state.message = format(labels.moved, { name: nameOf(iid), box: targets[0]!.label });
            afterBoxChange(state);
          } else {
            state.phase = "moveTarget";
            state.targetCursor = 0;
          }
        }
      }
      return;
    }
    case "moveTarget": {
      const targets = pcMoveTargets(state);
      if (up) state.targetCursor = wrap(state.targetCursor - 1, targets.length);
      else if (down) state.targetCursor = wrap(state.targetCursor + 1, targets.length);
      else if (input.cancelEdge) state.phase = "options";
      else if (input.confirmEdge) {
        const box = pcSelectedBox(state)!;
        const iid = pcSelectedMonster(state)!;
        const target = targets[state.targetCursor]!;
        box.monsters.splice(box.monsters.indexOf(iid), 1);
        target.monsters.push(iid);
        state.message = format(labels.moved, { name: nameOf(iid), box: target.label });
        afterBoxChange(state);
      }
      return;
    }
    case "confirmRelease": {
      if (up || down) state.confirmCursor = 1 - state.confirmCursor;
      else if (input.cancelEdge || (input.confirmEdge && state.confirmCursor === 1)) state.phase = "options";
      else if (input.confirmEdge) {
        const box = pcSelectedBox(state)!;
        const iid = pcSelectedMonster(state)!;
        box.monsters.splice(box.monsters.indexOf(iid), 1);
        state.message = format(labels.released, { name: nameOf(iid) });
        afterBoxChange(state);
      }
      return;
    }
    case "party": {
      if (up) state.partyCursor = wrap(state.partyCursor - 1, state.party.length);
      else if (down) state.partyCursor = wrap(state.partyCursor + 1, state.party.length);
      else if (input.cancelEdge) state.phase = "menu";
      else if (input.confirmEdge) {
        const iid = state.party[state.partyCursor]!;
        if (pcPartyEntryLocked(state, iid)) {
          state.message = format(labels.lastMonster, { name: nameOf(iid) });
        } else {
          state.phase = "boxes";
          state.boxCursor = 0;
        }
      }
      return;
    }
    case "itemBoxes": {
      // One item box (the Locker) exists today; the list still mirrors
      // upstream's ItemBoxState so future boxes need no new navigation.
      if (input.cancelEdge) {
        state.phase = "menu";
        state.menuCursor = 0;
      } else if (input.confirmEdge) {
        if (state.itemMode === "pickUp") {
          if (pcLockerKindCount(state) === 0) state.message = labels.itemEmpty;
          else {
            state.phase = "itemLocker";
            state.itemCursor = 0;
          }
        } else {
          const rows = pcBagRows(state);
          if (rows.length === 0) state.message = labels.itemBagEmpty;
          else {
            state.phase = "itemBag";
            state.itemCursor = 0;
          }
        }
      }
      return;
    }
    case "itemLocker": {
      const rows = pcLockerRows(state);
      if (up) state.itemCursor = wrap(state.itemCursor - 1, rows.length);
      else if (down) state.itemCursor = wrap(state.itemCursor + 1, rows.length);
      else if (input.leftEdge) state.itemCursor = Math.max(0, state.itemCursor - 8);
      else if (input.rightEdge) state.itemCursor = Math.min(rows.length - 1, state.itemCursor + 8);
      else if (input.cancelEdge) state.phase = "itemBoxes";
      else if (input.confirmEdge) {
        state.phase = "itemOptions";
        state.itemOptionCursor = 0;
      }
      return;
    }
    case "itemBag": {
      const rows = pcBagRows(state);
      if (up) state.itemCursor = wrap(state.itemCursor - 1, rows.length);
      else if (down) state.itemCursor = wrap(state.itemCursor + 1, rows.length);
      else if (input.leftEdge) state.itemCursor = Math.max(0, state.itemCursor - 8);
      else if (input.rightEdge) state.itemCursor = Math.min(rows.length - 1, state.itemCursor + 8);
      else if (input.cancelEdge) state.phase = "itemBoxes";
      else if (input.confirmEdge) {
        const slug = rows[state.itemCursor]!;
        const max = pcDepositMax(state, slug);
        if (max <= 0) {
          state.message = labels.itemLockerFull;
        } else {
          state.quantityMode = "deposit";
          state.quantity = 1;
          state.quantityMax = max;
          state.phase = "itemQuantity";
        }
      }
      return;
    }
    case "itemOptions": {
      const options = pcItemOptions(state);
      if (up) state.itemOptionCursor = wrap(state.itemOptionCursor - 1, options.length);
      else if (down) state.itemOptionCursor = wrap(state.itemOptionCursor + 1, options.length);
      else if (input.cancelEdge) state.phase = "itemLocker";
      else if (input.confirmEdge) {
        const option = options[state.itemOptionCursor]!;
        const slug = pcLockerRows(state)[state.itemCursor]!;
        if (option === "cancel") state.phase = "itemLocker";
        else if (option === "take") {
          const max = pcTakeMax(state, slug);
          if (max <= 0) {
            state.message = labels.bagFull;
            state.phase = "itemLocker";
          } else {
            state.quantityMode = "take";
            state.quantity = 1;
            state.quantityMax = max;
            state.phase = "itemQuantity";
          }
        } else {
          state.quantityMode = "disband";
          state.quantity = 1;
          state.quantityMax = state.locker[slug]!;
          state.phase = "itemQuantity";
        }
      }
      return;
    }
    case "itemQuantity": {
      const step = input.leftEdge ? -1 : input.rightEdge ? 1 : input.upEdge ? 10 : input.downEdge ? -10 : 0;
      if (step !== 0) {
        state.quantity = Math.max(1, Math.min(state.quantityMax, state.quantity + step));
      } else if (input.cancelEdge) {
        state.phase = state.quantityMode === "deposit" ? "itemBag" : "itemOptions";
      } else if (input.confirmEdge) {
        const slug = (state.quantityMode === "deposit" ? pcBagRows(state) : pcLockerRows(state))[state.itemCursor]!;
        const name = pcItemName(state, slug);
        const qty = state.quantity;
        if (state.quantityMode === "deposit") {
          state.bag[slug] = state.bag[slug]! - qty;
          if (state.bag[slug]! <= 0) delete state.bag[slug];
          state.locker[slug] = (state.locker[slug] ?? 0) + qty;
          state.bagDirty = true;
          state.message = format(labels.itemStored, { name, nr: String(qty) });
          state.phase = "itemBoxes";
        } else {
          state.locker[slug] = state.locker[slug]! - qty;
          if (state.locker[slug]! <= 0) delete state.locker[slug];
          if (state.quantityMode === "take") {
            state.bag[slug] = (state.bag[slug] ?? 0) + qty;
            state.bagDirty = true;
            state.message = format(labels.itemTaken, { name, nr: String(qty) });
          } else {
            state.message = format(labels.itemDisbanded, { name, nr: String(qty) });
          }
          // Upstream returns to the box list once the locker is empty.
          state.phase = pcLockerKindCount(state) === 0 ? "itemBoxes" : "itemLocker";
          state.itemCursor = Math.min(state.itemCursor, Math.max(0, pcLockerRows(state).length - 1));
        }
      }
      return;
    }
    case "done":
      return;
  }
}

function pcCommit(state: Readonly<PcSceneState>): JsonValue {
  const base = tuxemonExtensionState(state.base);
  const byIid = new Map<string, SpawnedMonsterSnapshot>();
  for (const monster of base.party) byIid.set(monster.iid!, monster);
  for (const monster of base.kennel) byIid.set(monster.iid!, monster);
  for (const box of Object.values(base.boxes ?? {})) {
    for (const monster of box.monsters) byIid.set(monster.iid!, monster);
  }
  const resolve = (iids: readonly string[]) => iids.map((iid) => byIid.get(iid)!);
  let kennel: SpawnedMonsterSnapshot[] = [];
  const boxes: Record<string, MonsterBox> = {};
  for (const box of state.boxes) {
    if (box.id === KENNEL_BOX) kennel = resolve(box.monsters);
    else boxes[box.id] = { hidden: box.hidden, capacity: box.capacity, monsters: resolve(box.monsters) };
  }
  const next: TuxemonExtensionState = {
    ...base,
    party: resolve(state.party),
    kennel,
    // `base` already carries kennelBox: start() created the Kennel.
    ...(base.boxes === undefined ? {} : { boxes }),
    // Always override the base locker: an emptied box is invisible upstream
    // and stays sparse (undefined is dropped by the save codec).
    itemLocker: Object.keys(state.locker).length > 0 ? { ...state.locker } : undefined,
  };
  return packTuxemonExtensionState(next);
}

function pcRules(names: Names, lang: GameLang = "en_US"): SceneRules {
  return {
    start(ext, rawArgs, _seed, context: ExtensionReadContext) {
      const args = record(rawArgs);
      const labels = pcLabels(args.labels, lang);
      const boxNames = record(args.boxNames);
      const current = tuxemonExtensionState(ext);
      // Opening a PC creates the main Kennel box (upstream PCState.__init__).
      const opened = current.kennelBox === true ? ext : packTuxemonExtensionState({ ...current, kennelBox: true });
      const monsters: Record<string, StorageMonsterRow> = {};
      const register = (list: readonly SpawnedMonsterSnapshot[]) => list.map((monster) => {
        monsters[monster.iid!] = storageRow(monster, names);
        return monster.iid!;
      });
      const party = register(current.party);
      const boxes: StorageBoxRow[] = [{
        id: KENNEL_BOX,
        label: boxLabel(KENNEL_BOX, boxNames),
        hidden: false,
        capacity: KENNEL_LIMIT,
        monsters: register(current.kennel),
      }];
      for (const [id, box] of Object.entries(current.boxes ?? {})) {
        boxes.push({
          id,
          label: boxLabel(id, boxNames),
          hidden: box.hidden,
          capacity: box.capacity,
          monsters: register(box.monsters),
        });
      }
      // Upstream PCState also creates the "Locker" item box on open. The
      // locker is sparse here (an empty box is invisible in menus), so it
      // only persists once the player stores something.
      const locker: Record<string, number> = { ...(current.itemLocker ?? {}) };
      const bag: Record<string, number> = { ...context.items };
      const itemNames: Record<string, string> = {};
      for (const item of context.itemCatalog ?? []) itemNames[item.id] = item.name;
      const notStorable = Array.isArray(args.notStorable)
        ? args.notStorable.filter((slug): slug is string => typeof slug === "string")
        : [];
      const state: PcSceneState = {
        kind: "pc",
        base: opened,
        labels,
        monsters,
        party,
        boxes,
        phase: "menu",
        mode: "pickUp",
        menuCursor: 0,
        boxCursor: 0,
        monsterCursor: 0,
        optionCursor: 0,
        targetCursor: 0,
        partyCursor: 0,
        confirmCursor: 0,
        message: null,
        locker,
        bag,
        itemNames,
        notStorable,
        itemMode: "pickUp",
        itemBoxCursor: 0,
        itemCursor: 0,
        itemOptionCursor: 0,
        quantity: 1,
        quantityMax: 1,
        quantityMode: "take",
        bagDirty: false,
      };
      return { ext: opened, state: state as unknown as JsonValue };
    },
    step(rawState, input) {
      pcStep(stateOf<PcSceneState>(rawState), input);
      return rawState;
    },
    done(rawState): SceneCompletion | null {
      const state = stateOf<PcSceneState>(rawState);
      if (state.phase !== "done") return null;
      const completion: SceneCompletion = { ext: pcCommit(state) };
      // The kit normalizes the backpack replacement (maxKinds/maxPerItem);
      // the take flow already clamped quantities so nothing is discarded.
      if (state.bagDirty) completion.items = { ...state.bag };
      return completion;
    },
  };
}

// ---------------------------------------------------------------------------
// Scripted trade

export interface TradeSceneState {
  kind: "trade";
  sent: string;
  received: string;
  message: string;
  tick: number;
  phase: "animate" | "message" | "done";
}

function tradeRules(source: BattleDbSource, names: Names, lang: GameLang = "en_US"): SceneRules {
  return {
    start(ext, rawArgs, seed, context: ExtensionReadContext) {
      const args = record(rawArgs);
      if (typeof args.variable !== "string" || typeof args.species !== "string") {
        throw new Error("tux.trade: variable and species must be strings");
      }
      // Upstream stops without a trade unless the variable names a monster
      // the player still owns (no_choice / no_options codes are numbers).
      const iid = context.variables[args.variable];
      if (typeof iid !== "string") return null;
      const current = tuxemonExtensionState(ext);
      const slot = current.party.findIndex((monster) => monster.iid === iid);
      if (slot < 0) return null;
      const db = resolveBattleDb(source);
      if (!(args.species in db.monsters)) throw new Error(`tux.trade: unknown monster '${args.species}'`);
      const sent = current.party[slot]!;
      const [newIid, nextMonsterId] = nextMonsterIid(current.nextMonsterId);
      const rng = seededRandom(seed);
      // TradeManager.execute_scripted_trade: Monster.spawn_base at the sent
      // monster's level in the same party slot; the sent monster is gone.
      const received: SpawnedMonsterSnapshot = {
        ...spawnMonsterWithRandom(db, battleDbToTuxemonBattleDb(db), rng.random, args.species, sent.level, {
          iid: newIid,
        }),
        bond: TRADED_BOND,
      };
      const party = [...current.party];
      party[slot] = received;
      const next = registerCaughtMonster({ ...current, party, nextMonsterId }, args.species);
      const state: TradeSceneState = {
        kind: "trade",
        sent: sent.slug,
        received: args.species,
        message: format(text(args.message, lang === "zh_CN" ? TRADE_MESSAGE_ZH : "You traded {sent} and received {received}!"), {
          sent: names(sent.slug),
          received: names(args.species),
        }),
        tick: 0,
        phase: "animate",
      };
      return { ext: packTuxemonExtensionState(next), state: state as unknown as JsonValue };
    },
    step(rawState, input, ticks) {
      const state = stateOf<TradeSceneState>(rawState);
      if (state.phase === "animate") {
        state.tick = Math.min(TRADE_ANIMATION_TICKS, state.tick + ticks);
        if (input.confirmEdge || input.cancelEdge) state.tick = TRADE_ANIMATION_TICKS;
        if (state.tick >= TRADE_ANIMATION_TICKS) state.phase = "message";
      } else if (state.phase === "message" && (input.confirmEdge || input.cancelEdge)) {
        state.phase = "done";
      }
      return rawState;
    },
    done(rawState): SceneCompletion | null {
      return stateOf<TradeSceneState>(rawState).phase === "done" ? {} : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Monster shop

export interface MonsterShopRow {
  key: string;
  slug: string;
  label: string;
  price: number;
  level: number;
  remaining: number;
}

export interface MonsterShopLabels {
  title: string;
  buy: string;
  cancel: string;
  confirm: string;
  bought: string;
  tooExpensive: string;
  soldOut: string;
  noRoom: string;
}

const MONSTER_SHOP_LABELS: MonsterShopLabels = {
  title: "Tuxemon",
  buy: "Buy",
  cancel: "Cancel",
  confirm: "Buy {name} for ${price}?",
  bought: "You bought {name}!",
  tooExpensive: "You can't afford that yet",
  soldOut: "Sold Out!",
  noRoom: "There is no room for another Tuxemon.",
};

export interface MonsterShopSceneState {
  kind: "monsterShop";
  base: JsonValue;
  labels: MonsterShopLabels;
  rows: MonsterShopRow[];
  cursor: number;
  confirmCursor: number;
  gold: number;
  startGold: number;
  rng: number;
  partySize: number;
  kennelSize: number;
  nextMonsterId: number;
  purchased: SpawnedMonsterSnapshot[];
  sold: Record<string, number>;
  phase: "list" | "confirm" | "done";
  message: string | null;
}

function shopLabels(raw: JsonValue | undefined, lang: GameLang = "en_US"): MonsterShopLabels {
  const source = record(raw);
  const labels = { ...(lang === "zh_CN" ? MONSTER_SHOP_LABELS_ZH : MONSTER_SHOP_LABELS) };
  for (const key of Object.keys(labels) as (keyof MonsterShopLabels)[]) {
    labels[key] = text(source[key], labels[key]);
  }
  return labels;
}

function positiveInteger(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`tux.monsterShop: ${label} must be a non-negative integer`);
  }
  return value;
}

function monsterShopRules(source: BattleDbSource, names: Names, lang: GameLang = "en_US"): SceneRules {
  return {
    start(ext, rawArgs, seed, context: ExtensionReadContext) {
      const args = record(rawArgs);
      if (typeof args.economy !== "string" || !Array.isArray(args.entries)) {
        throw new Error("tux.monsterShop: economy and entries are required");
      }
      const current = tuxemonExtensionState(ext);
      const rows: MonsterShopRow[] = [];
      for (const raw of args.entries) {
        const entry = record(raw);
        if (typeof entry.slug !== "string") throw new Error("tux.monsterShop: entry slug must be a string");
        // Stock labels follow upstream EconomyApplier: "<economy>:<slug>".
        const key = `${args.economy}:${entry.slug}`;
        const remaining = positiveInteger(entry.stock, "stock") - (current.shopSold?.[key] ?? 0);
        if (remaining <= 0) continue;
        rows.push({
          key,
          slug: entry.slug,
          label: names(entry.slug),
          price: positiveInteger(entry.price, "price"),
          level: positiveInteger(entry.level, "level"),
          remaining,
        });
      }
      rows.sort((a, b) => a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
      const labels = shopLabels(args.labels, lang);
      const state: MonsterShopSceneState = {
        kind: "monsterShop",
        base: ext,
        labels,
        rows,
        cursor: 0,
        confirmCursor: 0,
        gold: context.gold,
        startGold: context.gold,
        rng: seed >>> 0,
        partySize: current.party.length,
        kennelSize: current.kennel.length,
        nextMonsterId: current.nextMonsterId,
        purchased: [],
        sold: {},
        phase: "list",
        message: rows.length === 0 ? labels.soldOut : null,
      };
      return { ext, state: state as unknown as JsonValue };
    },
    step(rawState, input) {
      const state = stateOf<MonsterShopSceneState>(rawState);
      const up = input.upEdge === true || input.leftEdge === true;
      const down = input.downEdge === true || input.rightEdge === true;
      if (state.phase === "list") {
        if (up || down || input.confirmEdge || input.cancelEdge) state.message = null;
        if (input.cancelEdge) state.phase = "done";
        else if (up) state.cursor = wrap(state.cursor - 1, state.rows.length);
        else if (down) state.cursor = wrap(state.cursor + 1, state.rows.length);
        else if (input.confirmEdge) {
          const row = state.rows[state.cursor];
          if (!row) state.message = state.labels.soldOut;
          else if (state.gold < row.price) state.message = state.labels.tooExpensive;
          else if (state.partySize >= PARTY_LIMIT && state.kennelSize >= KENNEL_LIMIT) {
            state.message = state.labels.noRoom;
          } else {
            state.phase = "confirm";
            state.confirmCursor = 0;
          }
        }
      } else if (state.phase === "confirm") {
        if (up || down) state.confirmCursor = 1 - state.confirmCursor;
        else if (input.cancelEdge || (input.confirmEdge && state.confirmCursor === 1)) state.phase = "list";
        else if (input.confirmEdge) {
          const row = state.rows[state.cursor]!;
          const db = resolveBattleDb(source);
          const rng = seededRandom(state.rng);
          const [iid, nextMonsterId] = nextMonsterIid(state.nextMonsterId);
          state.purchased.push({
            ...spawnMonsterWithRandom(db, battleDbToTuxemonBattleDb(db), rng.random, row.slug, row.level, { iid }),
            bond: PURCHASED_BOND,
          });
          state.rng = rng.cursor();
          state.nextMonsterId = nextMonsterId;
          if (state.partySize < PARTY_LIMIT) state.partySize++;
          else state.kennelSize++;
          state.gold -= row.price;
          state.sold[row.key] = (state.sold[row.key] ?? 0) + 1;
          state.message = format(state.labels.bought, { name: row.label });
          row.remaining--;
          if (row.remaining === 0) {
            state.rows.splice(state.cursor, 1);
            state.cursor = Math.max(0, Math.min(state.cursor, state.rows.length - 1));
          }
          state.phase = "list";
        }
      }
      return rawState;
    },
    done(rawState): SceneCompletion | null {
      const state = stateOf<MonsterShopSceneState>(rawState);
      if (state.phase !== "done") return null;
      if (state.purchased.length === 0) return {};
      const base = tuxemonExtensionState(state.base);
      const party = [...base.party];
      const kennel = [...base.kennel];
      // Upstream party.add_monster: the party first, then the Kennel box.
      for (const monster of state.purchased) {
        if (party.length < PARTY_LIMIT) party.push(monster);
        else kennel.push(monster);
      }
      const shopSold = { ...base.shopSold };
      for (const [key, count] of Object.entries(state.sold)) shopSold[key] = (shopSold[key] ?? 0) + count;
      const next: TuxemonExtensionState = {
        ...base,
        party,
        kennel,
        ...(kennel.length > 0 ? { kennelBox: true as const } : {}),
        nextMonsterId: state.nextMonsterId,
        shopSold,
      };
      return { ext: packTuxemonExtensionState(next), gold: state.gold };
    },
  };
}

export function createStorageSceneRules(
  source: BattleDbSource,
  names: Names,
  lang: GameLang = "en_US",
): Record<string, SceneRules> {
  return {
    [TUXEMON_PC_SCENE_ID]: pcRules(names, lang),
    [TUXEMON_TRADE_SCENE_ID]: tradeRules(source, names, lang),
    [TUXEMON_MONSTER_SHOP_SCENE_ID]: monsterShopRules(source, names, lang),
  };
}

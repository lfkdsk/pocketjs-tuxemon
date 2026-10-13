/** Deterministic server-owned expedition sessions.
 *
 * Expedition is an authoritative reducer state. Services retain this value
 * and expose only observeExpedition(); players submit one value-equal member
 * of legalExpeditionActions(). There is deliberately no import, replay,
 * rewind, save, or cursor-setting API.
 */

import battleDbJson from "../data/battle-db.json";
import battleDbZhJson from "../data/battle-db.zh_CN.json";
import expeditionShopsJson from "../data/expedition-shops.json";
import { validateBattleDb, type BattleDb } from "../importer/battle-schema.ts";
import { createSwitchState } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";
import { sha256Bytes } from "../vendor/pocket-rpgkit/src/engine/map-repository.ts";
import { canonicalJson, utf8Encode } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import {
  arenaTeamRecordFromProvenance,
  appendArenaExperience,
  appendArenaItem,
  buildValidatedArenaTeam,
  type ArenaProvenanceEvent,
  type ArenaTeamRecord,
} from "./arena-team.ts";
import {
  createArenaBattle,
  defaultAction as defaultArenaAction,
  isOver as arenaIsOver,
  observe as observeArena,
  submit as submitArena,
  type ArenaAction,
  type ArenaBattle,
  type ArenaObservation,
} from "./arena.ts";
import { nextRandom, randomIntInclusive, type RngState } from "./core.ts";
import { initialTuxemonExtensionState } from "./extension.ts";
import { battleDbToTuxemonBattleDb } from "./from-battle-db.ts";
import { attemptCapture, canUseBattleItem, defeatExperienceAwards } from "./tuxemon.ts";
import { worldItemTargetEligibility } from "./world-items.ts";

export const EXPEDITION_VERSION = 1 as const;
export const MAX_EXPEDITION_STEPS = 10_000;
export const MAX_EXPEDITION_TEAM = 5;

export type ExpeditionCycle = "ranked" | "persistent";
export type ExpeditionEndReason = "voluntary" | "budget" | "defeated";

export interface ExpeditionRules {
  cycle: ExpeditionCycle;
  stepBudget: number;
  levelCap?: number;
  initialMoney?: number;
  initialItems?: Readonly<Record<string, number>>;
  startingArea?: string;
  starter?: { species: string; level: number };
  /** Only persistent cycles may continue an ended authoritative state. */
  continuation?: Expedition;
}

interface NormalizedExpeditionRules {
  cycle: ExpeditionCycle;
  stepBudget: number;
  levelCap: number;
  initialMoney: number;
  initialItems: Record<string, number>;
  startingArea: string;
  starter: { species: string; level: number };
}

export interface ExpeditionArea {
  id: string;
  name: string;
  connections: readonly string[];
  shop: string | null;
}

interface ExpeditionLedger {
  baseItems: Record<string, number>;
  purchasedItems: Record<string, number>;
  consumedItems: Record<string, number>;
  baseMoney: number;
  earnedMoney: number;
  spentMoney: number;
}

interface ExpeditionEncounter {
  area: string;
  species: string;
  level: number;
  experienceModifier: number;
  acquireSeed: string;
  partyIndices: number[];
  battle: ArenaBattle;
}

export interface Expedition {
  v: typeof EXPEDITION_VERSION;
  /** Private master seed. Never return the authoritative state to a player. */
  seed: string;
  run: number;
  rules: NormalizedExpeditionRules;
  area: string;
  team: ArenaTeamRecord[];
  partyHp: number[];
  inventory: Record<string, number>;
  money: number;
  remainingSteps: number;
  /** Nonce required on the next submitted action. */
  nextAction: number;
  /** Globally unique provenance sequence allocated by this account/run chain. */
  nextEventSeq: number;
  rng: number;
  rngDraws: number;
  shopPurchases: Record<string, number>;
  ledger: ExpeditionLedger;
  encounter: ExpeditionEncounter | null;
  ended: boolean;
  endReason: ExpeditionEndReason | null;
}

export type ExpeditionAction =
  | { type: "travel"; area: string; sequence: number }
  | { type: "explore"; sequence: number }
  | { type: "battle"; mode: "manual"; action: ArenaAction; sequence: number }
  | { type: "battle"; mode: "auto"; sequence: number }
  | { type: "catch"; item: string; sequence: number }
  | { type: "flee"; sequence: number }
  | { type: "useItem"; item: string; target: number; sequence: number }
  | { type: "learnMove"; item: string; move: string; target: number; forget?: string; sequence: number }
  | { type: "heal"; sequence: number }
  | { type: "shop"; shop: string; item: string; quantity: 1; sequence: number }
  | { type: "end"; sequence: number };

export type ExpeditionError =
  | "INVALID_ACTION"
  | "ILLEGAL_ACTION"
  | "STALE_ACTION"
  | "OUT_OF_ORDER"
  | "EXPEDITION_OVER"
  | "CORRUPT_STATE";

export type ExpeditionApplyResult =
  | { ok: true; expedition: Expedition }
  | { ok: false; expedition: Expedition; error: ExpeditionError };

export interface ExpeditionObservation {
  v: typeof EXPEDITION_VERSION;
  cycle: ExpeditionCycle;
  run: number;
  status: "active" | "ended";
  area: { id: string; name: string };
  destinations: Array<{ id: string; name: string }>;
  team: Array<{
    slot: number;
    species: { slug: string; en_US: string; zh_CN: string };
    level: number;
    experience: number;
    hp: { current: number; max: number };
    moves: Array<{ slug: string; en_US: string; zh_CN: string }>;
  }>;
  backpack: Array<{ item: string; en_US: string; zh_CN: string; quantity: number }>;
  money: number;
  remainingSteps: number;
  nextAction: number;
  encounter: null | {
    species: { slug: string; en_US: string; zh_CN: string };
    level: number;
    hpPercent: number;
    status: string | null;
    battle: ArenaObservation;
  };
  shop: null | {
    id: string;
    goods: Array<{ item: string; en_US: string; zh_CN: string; price: number; remaining: number | null }>;
  };
  result: null | { reason: ExpeditionEndReason };
}

interface ShopGood {
  item: string;
  price: number;
  sellPrice?: number;
  stock?: number;
  variables?: Array<{ key: string; value: string }>;
}

interface ShopCatalog {
  shops: Record<string, { items: ShopGood[] }>;
}

const SOURCE_DB = validateBattleDb(battleDbJson);
const ZH_DB = validateBattleDb(battleDbZhJson);
const RULES_DB = battleDbToTuxemonBattleDb(SOURCE_DB);
const SHOP_CATALOG = expeditionShopsJson as ShopCatalog;
const HEX_SEED = /^[0-9a-f]{64}$/;

const AREAS: Record<string, ExpeditionArea> = {
  spyder_route1: {
    id: "spyder_route1", name: "Route 1", connections: ["spyder_citypark", "spyder_route2"],
    shop: "spyder_cotton_scoop",
  },
  spyder_citypark: {
    id: "spyder_citypark", name: "City Park", connections: ["spyder_route1"], shop: null,
  },
  spyder_route2: {
    id: "spyder_route2", name: "Route 2", connections: ["spyder_route1", "spyder_route3"],
    shop: "spyder_leather_scoop",
  },
  spyder_route3: {
    id: "spyder_route3", name: "Route 3", connections: ["spyder_route2", "spyder_route3_desert", "spyder_route4"],
    shop: null,
  },
  spyder_route3_desert: {
    id: "spyder_route3_desert", name: "Route 3 Desert", connections: ["spyder_route3"], shop: null,
  },
  spyder_route4: {
    id: "spyder_route4", name: "Route 4", connections: ["spyder_route3", "spyder_route5"],
    shop: "spyder_flower_scoop",
  },
  spyder_route5: {
    id: "spyder_route5", name: "Route 5", connections: ["spyder_route4", "spyder_route6"], shop: null,
  },
  spyder_route6: {
    id: "spyder_route6", name: "Route 6", connections: ["spyder_route5"], shop: null,
  },
};

export const EXPEDITION_AREAS: Readonly<Record<string, Readonly<ExpeditionArea>>> = Object.freeze(
  Object.fromEntries(Object.entries(AREAS).map(([id, area]) => [id, Object.freeze({
    ...area,
    connections: Object.freeze([...area.connections]),
  })])),
);

const DEFAULT_ITEMS = Object.freeze({ tuxeball: 5, potion: 2 });

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function domainHex(seed: string, domain: string): string {
  return sha256Bytes(utf8Encode(`pocket-tuxemon/expedition/v1\n${domain}\n${seed}`));
}

function domainCursor(seed: string, domain: string): number {
  return Number.parseInt(domainHex(seed, domain).slice(0, 8), 16) >>> 0;
}

function displayName(table: BattleDb, kind: "monster" | "technique" | "item", slug: string): string {
  if (kind === "monster") return table.monsters[slug]?.name ?? slug;
  if (kind === "technique") return table.techniques[slug]?.name ?? slug;
  return table.items[slug]?.name ?? slug;
}

function normalizedRules(value: ExpeditionRules): NormalizedExpeditionRules {
  if (!isRecord(value) || (value.cycle !== "ranked" && value.cycle !== "persistent")) {
    throw new Error("expedition rules require cycle 'ranked' or 'persistent'");
  }
  const stepBudget = value.stepBudget;
  if (!Number.isSafeInteger(stepBudget) || stepBudget < 1 || stepBudget > MAX_EXPEDITION_STEPS) {
    throw new Error(`expedition stepBudget must be 1..${MAX_EXPEDITION_STEPS}`);
  }
  const levelCap = value.levelCap ?? 50;
  if (!Number.isSafeInteger(levelCap) || levelCap < 1 || levelCap > SOURCE_DB.rules.levelRange[1]) {
    throw new Error(`expedition levelCap must be 1..${SOURCE_DB.rules.levelRange[1]}`);
  }
  const initialMoney = value.initialMoney ?? 1_000;
  if (!Number.isSafeInteger(initialMoney) || initialMoney < 0) {
    throw new Error("expedition initialMoney must be a nonnegative safe integer");
  }
  const initialItems: Record<string, number> = {};
  for (const [item, quantity] of Object.entries(value.initialItems ?? DEFAULT_ITEMS)) {
    if (!Object.hasOwn(SOURCE_DB.items, item) || !Number.isSafeInteger(quantity) || quantity < 0) {
      throw new Error(`expedition initialItems has invalid entry '${item}'`);
    }
    if (quantity > 0) initialItems[item] = quantity;
  }
  const startingArea = value.startingArea ?? "spyder_route1";
  if (!Object.hasOwn(AREAS, startingArea)) throw new Error(`unknown expedition area '${startingArea}'`);
  const starter = clone(value.starter ?? { species: "rockitten", level: 5 });
  if (!Object.hasOwn(SOURCE_DB.monsters, starter.species) || !Number.isSafeInteger(starter.level) ||
      starter.level < 1 || starter.level > levelCap) {
    throw new Error("expedition starter must name a known species at a legal level");
  }
  if (value.cycle === "ranked" && value.continuation !== undefined) {
    throw new Error("ranked expeditions cannot continue prior state");
  }
  return { cycle: value.cycle, stepBudget, levelCap, initialMoney, initialItems, startingArea, starter };
}

function maxHp(record: ArenaTeamRecord, levelCap: number): number {
  return buildValidatedArenaTeam([record], { minSize: 1, maxSize: 1, levelCap })[0]!.base.hp;
}

function starterRecord(seed: string, rules: NormalizedExpeditionRules): ArenaTeamRecord {
  const provenance: ArenaProvenanceEvent[] = [{
    seq: 1,
    type: "acquire",
    seed: domainHex(seed, "starter"),
    species: rules.starter.species,
    level: rules.starter.level,
    origin: {
      kind: "expedition",
      area: rules.startingArea,
      step: 0,
      capture: { result: "starter" },
    },
  }];
  return arenaTeamRecordFromProvenance(rules.starter.species, provenance, { levelCap: rules.levelCap });
}

function continuedState(seed: string, rules: NormalizedExpeditionRules, previous: Expedition): Expedition {
  if (rules.cycle !== "persistent" || previous.rules.cycle !== "persistent" || !previous.ended || previous.encounter) {
    throw new Error("persistent continuation requires an ended persistent expedition");
  }
  if (previous.seed === seed) throw new Error("persistent continuation requires a fresh seed");
  const validation = checkExpeditionConservation(previous);
  if (validation.length > 0) throw new Error(`cannot continue corrupt expedition: ${validation.join("; ")}`);
  for (const record of previous.team) {
    const checked = buildValidatedArenaTeam([record], { minSize: 1, maxSize: 1, levelCap: rules.levelCap });
    if (checked.length !== 1) throw new Error("continued team is invalid");
  }
  const inventory = clone(previous.inventory);
  const money = previous.money;
  return {
    v: EXPEDITION_VERSION,
    seed,
    run: previous.run + 1,
    rules,
    area: previous.area,
    team: clone(previous.team),
    partyHp: previous.partyHp.map((hp, index) => Math.min(hp, maxHp(previous.team[index]!, rules.levelCap))),
    inventory,
    money,
    remainingSteps: rules.stepBudget,
    nextAction: previous.nextAction,
    nextEventSeq: previous.nextEventSeq,
    rng: domainCursor(seed, "encounters"),
    rngDraws: 0,
    shopPurchases: {},
    ledger: {
      baseItems: clone(inventory),
      purchasedItems: {},
      consumedItems: {},
      baseMoney: money,
      earnedMoney: 0,
      spentMoney: 0,
    },
    encounter: null,
    ended: false,
    endReason: null,
  };
}

export function createExpedition(config: { seed: string; rules: ExpeditionRules }): Expedition {
  if (!isRecord(config) || typeof config.seed !== "string" || !HEX_SEED.test(config.seed)) {
    throw new Error("expedition seed must be exactly 64 lowercase hexadecimal characters");
  }
  const rules = normalizedRules(config.rules);
  if (config.rules.continuation) return continuedState(config.seed, rules, config.rules.continuation);
  const team = [starterRecord(config.seed, rules)];
  const inventory = clone(rules.initialItems);
  return {
    v: EXPEDITION_VERSION,
    seed: config.seed,
    run: 1,
    rules,
    area: rules.startingArea,
    team,
    partyHp: [maxHp(team[0]!, rules.levelCap)],
    inventory,
    money: rules.initialMoney,
    remainingSteps: rules.stepBudget,
    nextAction: 1,
    nextEventSeq: 2,
    rng: domainCursor(config.seed, "encounters"),
    rngDraws: 0,
    shopPurchases: {},
    ledger: {
      baseItems: clone(inventory),
      purchasedItems: {},
      consumedItems: {},
      baseMoney: rules.initialMoney,
      earnedMoney: 0,
      spentMoney: 0,
    },
    encounter: null,
    ended: false,
    endReason: null,
  };
}

function activeGoods(expedition: Expedition): ShopGood[] {
  const shop = AREAS[expedition.area]!.shop;
  if (!shop) return [];
  return (SHOP_CATALOG.shops[shop]?.items ?? []).filter((good) =>
    good.variables?.every(({ key, value }) => key === "daytime" && value === "true") ?? true
  );
}

function remainingStock(expedition: Expedition, shop: string, good: ShopGood): number | null {
  if (good.stock === undefined) return null;
  return Math.max(0, good.stock - (expedition.shopPurchases[`${shop}:${good.item}`] ?? 0));
}

function captureItem(slug: string): boolean {
  return RULES_DB.item[slug]?.effects.some((effect) =>
    effect.type === "capture" || effect.type === "capture_combined"
  ) ?? false;
}

function itemMove(slug: string): string | null {
  const effect = RULES_DB.item[slug]?.effects.find((candidate) => candidate.type === "learn_tm");
  return effect?.parameters[0] ?? null;
}

function usableExpeditionItem(slug: string): boolean {
  const effects = RULES_DB.item[slug]?.effects ?? [];
  return effects.length > 0 && effects.every((effect) =>
    effect.type === "give_tp" || effect.type === "gain_xp" ||
    effect.type === "heal" || effect.type === "restore"
  );
}

function itemEligible(expedition: Expedition, item: string, target: number): boolean {
  const monster = buildValidatedArenaTeam([expedition.team[target]], {
    minSize: 1,
    maxSize: 1,
    levelCap: expedition.rules.levelCap,
  })[0];
  if (!monster) return false;
  monster.currentHp = expedition.partyHp[target]!;
  if (monster.currentHp === 0) monster.status = "faint";
  return worldItemTargetEligibility(
    SOURCE_DB,
    { ...initialTuxemonExtensionState(), party: [monster] },
    createSwitchState({ items: { [item]: 1 } }),
    item,
    0,
  ).eligible;
}

function captureEligible(expedition: Expedition, item: string): boolean {
  const encounter = expedition.encounter;
  const target = encounter?.battle.core.parties[1][0];
  if (!encounter || !target) return false;
  return canUseBattleItem(
    RULES_DB,
    {
      ...encounter.battle.core,
      kind: "wild",
      inventory: { ...encounter.battle.core.inventory, [item]: 1 },
    },
    item,
    target.uid,
    true,
  );
}

function legalItemActions(expedition: Expedition): ExpeditionAction[] {
  const result: ExpeditionAction[] = [];
  for (const item of Object.keys(expedition.inventory).sort()) {
    if ((expedition.inventory[item] ?? 0) <= 0) continue;
    const move = itemMove(item);
    for (const [target, record] of expedition.team.entries()) {
      if (!itemEligible(expedition, item, target)) continue;
      if (move && !record.moves.includes(move)) {
        if (record.moves.length < SOURCE_DB.rules.maxMoves) {
          result.push({ type: "learnMove", item, move, target, sequence: expedition.nextAction });
        } else {
          for (const forget of record.moves) {
            result.push({ type: "learnMove", item, move, target, forget, sequence: expedition.nextAction });
          }
        }
      } else if (!move && usableExpeditionItem(item)) {
        result.push({ type: "useItem", item, target, sequence: expedition.nextAction });
      }
    }
  }
  return result;
}

export function legalExpeditionActions(expedition: Expedition): ExpeditionAction[] {
  if (expedition.ended || expedition.remainingSteps <= 0) return [];
  const sequence = expedition.nextAction;
  if (expedition.encounter) {
    const actions: ExpeditionAction[] = [
      { type: "battle", mode: "auto", sequence },
      ...observeArena(expedition.encounter.battle, 0).legalActions.map((action) => ({
        type: "battle" as const,
        mode: "manual" as const,
        action,
        sequence,
      })),
      { type: "flee", sequence },
    ];
    if (expedition.team.length < MAX_EXPEDITION_TEAM) {
      for (const item of Object.keys(expedition.inventory).sort()) {
        if ((expedition.inventory[item] ?? 0) > 0 && captureItem(item) && captureEligible(expedition, item)) {
          actions.push({ type: "catch", item, sequence });
        }
      }
    }
    return clone(actions);
  }
  const actions: ExpeditionAction[] = [];
  for (const area of AREAS[expedition.area]!.connections) {
    actions.push({ type: "travel", area, sequence });
  }
  if (expedition.partyHp.some((hp) => hp > 0)) actions.push({ type: "explore", sequence });
  actions.push(...legalItemActions(expedition));
  const shop = AREAS[expedition.area]!.shop;
  if (shop) {
    const potion = activeGoods(expedition).find((good) => good.item === "potion");
    if (potion && expedition.money >= potion.price && expedition.partyHp.some((hp, index) =>
      hp < maxHp(expedition.team[index]!, expedition.rules.levelCap))) {
      actions.push({ type: "heal", sequence });
    }
    for (const good of activeGoods(expedition)) {
      const stock = remainingStock(expedition, shop, good);
      if (expedition.money >= good.price && (stock === null || stock > 0)) {
        actions.push({ type: "shop", shop, item: good.item, quantity: 1, sequence });
      }
    }
  }
  actions.push({ type: "end", sequence });
  return clone(actions);
}

function observationShop(expedition: Expedition): ExpeditionObservation["shop"] {
  const shop = AREAS[expedition.area]!.shop;
  if (!shop) return null;
  return {
    id: shop,
    goods: activeGoods(expedition).map((good) => ({
      item: good.item,
      en_US: displayName(SOURCE_DB, "item", good.item),
      zh_CN: displayName(ZH_DB, "item", good.item),
      price: good.price,
      remaining: remainingStock(expedition, shop, good),
    })),
  };
}

export function observeExpedition(expedition: Expedition): ExpeditionObservation {
  const encounter = expedition.encounter;
  let visibleEncounter: ExpeditionObservation["encounter"] = null;
  if (encounter) {
    const battle = observeArena(encounter.battle, 0);
    const wild = battle.opponent.active[0];
    visibleEncounter = {
      species: {
        slug: encounter.species,
        en_US: displayName(SOURCE_DB, "monster", encounter.species),
        zh_CN: displayName(ZH_DB, "monster", encounter.species),
      },
      level: encounter.level,
      hpPercent: wild?.hpPercent ?? 0,
      status: wild?.status ?? null,
      battle,
    };
  }
  return {
    v: EXPEDITION_VERSION,
    cycle: expedition.rules.cycle,
    run: expedition.run,
    status: expedition.ended ? "ended" : "active",
    area: { id: expedition.area, name: AREAS[expedition.area]!.name },
    destinations: AREAS[expedition.area]!.connections.map((id) => ({ id, name: AREAS[id]!.name })),
    team: expedition.team.map((record, slot) => ({
      slot,
      species: {
        slug: record.species,
        en_US: displayName(SOURCE_DB, "monster", record.species),
        zh_CN: displayName(ZH_DB, "monster", record.species),
      },
      level: record.level,
      experience: record.experience ?? 0,
      hp: { current: expedition.partyHp[slot]!, max: maxHp(record, expedition.rules.levelCap) },
      moves: record.moves.map((slug) => ({
        slug,
        en_US: displayName(SOURCE_DB, "technique", slug),
        zh_CN: displayName(ZH_DB, "technique", slug),
      })),
    })),
    backpack: Object.entries(expedition.inventory)
      .filter(([, quantity]) => quantity > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([item, quantity]) => ({
        item,
        en_US: displayName(SOURCE_DB, "item", item),
        zh_CN: displayName(ZH_DB, "item", item),
        quantity,
      })),
    money: expedition.money,
    remainingSteps: expedition.remainingSteps,
    nextAction: expedition.nextAction,
    encounter: visibleEncounter,
    shop: observationShop(expedition),
    result: expedition.endReason ? { reason: expedition.endReason } : null,
  };
}

function count(table: Record<string, number>, key: string): number {
  return table[key] ?? 0;
}

export function checkExpeditionConservation(expedition: Expedition): string[] {
  const errors: string[] = [];
  const validCountTable = (table: Record<string, number>, label: string): void => {
    for (const [item, quantity] of Object.entries(table)) {
      if (!Object.hasOwn(SOURCE_DB.items, item) || !Number.isSafeInteger(quantity) || quantity < 0) {
        errors.push(`${label} has an invalid entry for '${item}'`);
      }
    }
  };
  validCountTable(expedition.inventory, "inventory");
  validCountTable(expedition.ledger.baseItems, "base item ledger");
  validCountTable(expedition.ledger.purchasedItems, "purchased item ledger");
  validCountTable(expedition.ledger.consumedItems, "consumed item ledger");
  const items = new Set([
    ...Object.keys(expedition.ledger.baseItems),
    ...Object.keys(expedition.ledger.purchasedItems),
    ...Object.keys(expedition.ledger.consumedItems),
    ...Object.keys(expedition.inventory),
  ]);
  for (const item of items) {
    const expected = count(expedition.ledger.baseItems, item) +
      count(expedition.ledger.purchasedItems, item) - count(expedition.ledger.consumedItems, item);
    if (expected < 0 || count(expedition.inventory, item) !== expected) {
      errors.push(`inventory conservation failed for '${item}'`);
    }
  }
  const expectedMoney = expedition.ledger.baseMoney + expedition.ledger.earnedMoney - expedition.ledger.spentMoney;
  if (![expedition.ledger.baseMoney, expedition.ledger.earnedMoney, expedition.ledger.spentMoney, expedition.money]
      .every((value) => Number.isSafeInteger(value) && value >= 0) ||
      expectedMoney < 0 || expedition.money !== expectedMoney) errors.push("money conservation failed");
  if (!Number.isSafeInteger(expedition.remainingSteps) || expedition.remainingSteps < 0 ||
      expedition.remainingSteps > expedition.rules.stepBudget) errors.push("step budget is out of range");
  if (expedition.partyHp.length !== expedition.team.length) errors.push("party health does not match team size");
  if (expedition.team.length < 1 || expedition.team.length > MAX_EXPEDITION_TEAM) errors.push("team size is invalid");
  try {
    buildValidatedArenaTeam(expedition.team, {
      minSize: 1,
      maxSize: MAX_EXPEDITION_TEAM,
      levelCap: expedition.rules.levelCap,
    });
    for (const [index, hp] of expedition.partyHp.entries()) {
      if (!Number.isSafeInteger(hp) || hp < 0 || hp > maxHp(expedition.team[index]!, expedition.rules.levelCap)) {
        errors.push(`party health is invalid at slot ${index}`);
      }
    }
  } catch {
    errors.push("team provenance is invalid");
  }
  const maximumSequence = expedition.team.reduce((maximum, record) =>
    Math.max(maximum, ...record.provenance.map((event) => event.seq)), 0);
  if (!Number.isSafeInteger(expedition.nextEventSeq) || expedition.nextEventSeq <= maximumSequence) {
    errors.push("next provenance sequence is invalid");
  }
  if (!Number.isSafeInteger(expedition.nextAction) || expedition.nextAction < 1) {
    errors.push("next action sequence is invalid");
  }
  return errors;
}

function selectEncounter(expedition: Expedition): ExpeditionEncounter {
  const table = SOURCE_DB.encounters[expedition.area]!;
  const rows = table.monsters.filter((row) => row.level[0] <= expedition.rules.levelCap &&
    row.variables.every(({ key, value }) => key === "daytime" && value === "true"));
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  if (rows.length === 0 || !Number.isFinite(total) || total <= 0) {
    throw new Error(`expedition area '${expedition.area}' has no eligible encounter rows`);
  }
  let roll = nextRandom(expedition) * total;
  let row = rows.at(-1)!;
  for (const candidate of rows) {
    roll -= candidate.weight;
    if (roll < 0) {
      row = candidate;
      break;
    }
  }
  const level = randomIntInclusive(expedition, row.level[0], Math.min(row.level[1], expedition.rules.levelCap));
  const acquireSeed = domainHex(expedition.seed, `wild:${expedition.nextAction}:${expedition.rngDraws}`);
  const enemy = arenaTeamRecordFromProvenance(row.monster, [{
    seq: 1,
    type: "acquire",
    seed: acquireSeed,
    species: row.monster,
    level,
  }], { levelCap: expedition.rules.levelCap });
  const partyIndices = expedition.partyHp.flatMap((hp, index) => hp > 0 ? [index] : []);
  const team = partyIndices.map((index) => expedition.team[index]!);
  let battle = createArenaBattle({
    seed: domainHex(expedition.seed, `battle:${expedition.nextAction}:${expedition.rngDraws}`),
    format: "single",
    sides: [{ kind: "agent", team }, { kind: "agent", team: [enemy] }],
    teamRules: { minSize: 1, maxSize: MAX_EXPEDITION_TEAM, levelCap: expedition.rules.levelCap },
  });
  for (const [battleIndex, expeditionIndex] of partyIndices.entries()) {
    battle.core.parties[0][battleIndex]!.currentHp = expedition.partyHp[expeditionIndex]!;
  }
  return {
    area: expedition.area,
    species: row.monster,
    level,
    experienceModifier: row.experienceModifier,
    acquireSeed,
    partyIndices,
    battle,
  };
}

function consumeItem(expedition: Expedition, item: string): void {
  const quantity = expedition.inventory[item] ?? 0;
  if (quantity <= 0) throw new Error(`cannot consume missing item '${item}'`);
  expedition.inventory[item] = quantity - 1;
  expedition.ledger.consumedItems[item] = count(expedition.ledger.consumedItems, item) + 1;
}

function spendMoney(expedition: Expedition, amount: number): void {
  if (amount < 0 || expedition.money < amount) throw new Error("cannot spend unavailable money");
  expedition.money -= amount;
  expedition.ledger.spentMoney += amount;
}

function updateHealthAfterRecord(
  expedition: Expedition,
  target: number,
  before: ArenaTeamRecord,
  after: ArenaTeamRecord,
): void {
  const oldMax = maxHp(before, expedition.rules.levelCap);
  const newMax = maxHp(after, expedition.rules.levelCap);
  expedition.partyHp[target] = Math.min(newMax, expedition.partyHp[target]! + Math.max(0, newMax - oldMax));
}

function settleBattle(expedition: Expedition): void {
  const encounter = expedition.encounter!;
  const battle = encounter.battle;
  for (const [battleIndex, expeditionIndex] of encounter.partyIndices.entries()) {
    expedition.partyHp[expeditionIndex] = Math.max(0, battle.core.parties[0][battleIndex]?.currentHp ?? 0);
  }
  if (!arenaIsOver(battle)) return;
  if (battle.terminal?.winner === 0) {
    const loser = clone(battle.core.parties[1][0]!);
    loser.experienceModifier = encounter.experienceModifier;
    const reward = battle.core.rewards.at(-1);
    const participants = reward?.winners.map(({ uid }) => uid) ?? [];
    if (participants.length > 0) {
      const rewardState = clone(battle.core);
      rewardState.parties[1][0] = loser;
      rewardState.damageByDefender[String(loser.uid)] = [...participants];
      const awards = defeatExperienceAwards(RULES_DB, rewardState, loser);
      for (const uid of participants) {
        const battleIndex = battle.core.parties[0].findIndex((monster) => monster.uid === uid);
        const target = encounter.partyIndices[battleIndex];
        const amount = awards.get(uid) ?? 0;
        if (target === undefined || amount <= 0) continue;
        const before = expedition.team[target]!;
        const appended = appendArenaExperience(before, {
          type: "experience",
          step: expedition.nextAction,
          amount,
          source: {
            kind: "battle",
            area: encounter.area,
            species: encounter.species,
            level: encounter.level,
            experienceModifier: encounter.experienceModifier,
            participants: participants.length,
          },
        }, expedition.nextEventSeq, { levelCap: expedition.rules.levelCap });
        expedition.team[target] = appended.record;
        expedition.nextEventSeq = appended.nextSeq;
        updateHealthAfterRecord(expedition, target, before, appended.record);
      }
    }
  }
  expedition.encounter = null;
  if (expedition.partyHp.every((hp) => hp <= 0)) {
    expedition.ended = true;
    expedition.endReason = "defeated";
  }
}

function applyBattle(expedition: Expedition, action: Extract<ExpeditionAction, { type: "battle" }>): void {
  const encounter = expedition.encounter!;
  if (action.mode === "manual") {
    const player = submitArena(encounter.battle, 0, action.action);
    if (!player.ok) throw new Error(`advertised battle action was rejected: ${player.error}`);
    const opponent = submitArena(player.battle, 1, defaultArenaAction(player.battle, 1));
    if (!opponent.ok) throw new Error(`wild battle policy was rejected: ${opponent.error}`);
    encounter.battle = opponent.battle;
  } else {
    let battle = encounter.battle;
    while (!arenaIsOver(battle)) {
      const player = submitArena(battle, 0, defaultArenaAction(battle, 0));
      if (!player.ok) throw new Error(`automatic battle action was rejected: ${player.error}`);
      const opponent = submitArena(player.battle, 1, defaultArenaAction(player.battle, 1));
      if (!opponent.ok) throw new Error(`wild battle policy was rejected: ${opponent.error}`);
      battle = opponent.battle;
    }
    encounter.battle = battle;
  }
  settleBattle(expedition);
}

function applyCapture(expedition: Expedition, item: string): void {
  const encounter = expedition.encounter!;
  const target = encounter.battle.core.parties[1][0]!;
  const roll = attemptCapture(RULES_DB, encounter.battle.core, item, target);
  consumeItem(expedition, item);
  if (!roll.success) return;
  const provenance: ArenaProvenanceEvent[] = [{
    seq: expedition.nextEventSeq++,
    type: "acquire",
    seed: encounter.acquireSeed,
    species: encounter.species,
    level: encounter.level,
    origin: {
      kind: "expedition",
      area: encounter.area,
      step: expedition.nextAction,
      capture: { result: "caught", item, success: true, shakes: roll.shakes },
    },
  }];
  const record = arenaTeamRecordFromProvenance(encounter.species, provenance, {
    levelCap: expedition.rules.levelCap,
  });
  expedition.team.push(record);
  expedition.partyHp.push(maxHp(record, expedition.rules.levelCap));
  expedition.encounter = null;
}

function healWithItem(expedition: Expedition, item: string, target: number): void {
  const maximum = maxHp(expedition.team[target]!, expedition.rules.levelCap);
  let hp = expedition.partyHp[target]!;
  for (const effect of RULES_DB.item[item]!.effects) {
    if (effect.type !== "heal") continue;
    const amount = Number(effect.parameters[0] ?? 0);
    hp += effect.parameters[1] === "percentage" ? Math.trunc(maximum * amount) : Math.trunc(amount);
  }
  expedition.partyHp[target] = Math.max(0, Math.min(maximum, hp));
}

function applyItem(expedition: Expedition, item: string, target: number, forget?: string): void {
  const before = expedition.team[target]!;
  const appended = appendArenaItem(before, {
    type: "item",
    item,
    step: expedition.nextAction,
    ...(forget === undefined ? {} : { forget }),
  }, expedition.nextEventSeq, { levelCap: expedition.rules.levelCap });
  consumeItem(expedition, item);
  expedition.team[target] = appended.record;
  expedition.nextEventSeq = appended.nextSeq;
  updateHealthAfterRecord(expedition, target, before, appended.record);
  healWithItem(expedition, item, target);
}

function applyLegalAction(expedition: Expedition, action: ExpeditionAction): void {
  switch (action.type) {
    case "travel": expedition.area = action.area; break;
    case "explore": expedition.encounter = selectEncounter(expedition); break;
    case "battle": applyBattle(expedition, action); break;
    case "catch": applyCapture(expedition, action.item); break;
    case "flee": expedition.encounter = null; break;
    case "useItem": applyItem(expedition, action.item, action.target); break;
    case "learnMove": applyItem(expedition, action.item, action.target, action.forget); break;
    case "heal": {
      const shop = AREAS[expedition.area]!.shop!;
      const potion = SHOP_CATALOG.shops[shop]!.items.find((good) => good.item === "potion")!;
      spendMoney(expedition, potion.price);
      expedition.partyHp = expedition.team.map((record) => maxHp(record, expedition.rules.levelCap));
      break;
    }
    case "shop": {
      const good = SHOP_CATALOG.shops[action.shop]!.items.find((candidate) => candidate.item === action.item)!;
      spendMoney(expedition, good.price);
      expedition.inventory[action.item] = count(expedition.inventory, action.item) + 1;
      expedition.ledger.purchasedItems[action.item] = count(expedition.ledger.purchasedItems, action.item) + 1;
      const key = `${action.shop}:${action.item}`;
      expedition.shopPurchases[key] = count(expedition.shopPurchases, key) + 1;
      break;
    }
    case "end": expedition.ended = true; expedition.endReason = "voluntary"; break;
  }
}

function actionSequence(value: unknown): number | null {
  return isRecord(value) && Number.isSafeInteger(value.sequence) ? value.sequence as number : null;
}

export function applyExpeditionAction(expedition: Expedition, value: unknown): ExpeditionApplyResult {
  if (checkExpeditionConservation(expedition).length > 0) {
    return { ok: false, expedition, error: "CORRUPT_STATE" };
  }
  if (expedition.ended) return { ok: false, expedition, error: "EXPEDITION_OVER" };
  const sequence = actionSequence(value);
  if (sequence !== null && sequence < expedition.nextAction) {
    return { ok: false, expedition, error: "STALE_ACTION" };
  }
  if (sequence !== null && sequence > expedition.nextAction) {
    return { ok: false, expedition, error: "OUT_OF_ORDER" };
  }
  if (!isRecord(value)) return { ok: false, expedition, error: "INVALID_ACTION" };
  const legal = legalExpeditionActions(expedition);
  let encoded: string;
  try {
    encoded = canonicalJson(value);
  } catch {
    return { ok: false, expedition, error: "INVALID_ACTION" };
  }
  const action = legal.find((candidate) => canonicalJson(candidate) === encoded);
  if (!action) return { ok: false, expedition, error: sequence === null ? "INVALID_ACTION" : "ILLEGAL_ACTION" };
  const next = clone(expedition);
  try {
    applyLegalAction(next, action);
    next.remainingSteps--;
    next.nextAction++;
    if (next.remainingSteps === 0 && !next.ended) {
      next.encounter = null;
      next.ended = true;
      next.endReason = "budget";
    }
    if (checkExpeditionConservation(next).length > 0) {
      return { ok: false, expedition, error: "CORRUPT_STATE" };
    }
    return { ok: true, expedition: next };
  } catch {
    return { ok: false, expedition, error: "CORRUPT_STATE" };
  }
}

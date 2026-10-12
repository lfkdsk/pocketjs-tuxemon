import type { BattleDb, BattlePlugin } from "../importer/battle-schema.ts";
import { battleDbToTuxemonBattleDb } from "./from-battle-db.ts";
import {
  evolutionConditionsPass,
  giveExperience,
  transferToSpecies,
  type MoveForgetSelector,
  type ProgressionResult,
} from "./progression.ts";
import { calculateBaseStats, monsterFromSnapshot } from "./stats.ts";
import { addStepTracker } from "./step-tracker.ts";
import { STAT_NAMES, type BattleMonster, type DbEvolution, type SpawnedMonsterSnapshot, type StatName } from "./types.ts";
import type { TuxemonExtensionState } from "./extension.ts";
import { rngNext, type SwitchState } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";

export const WORLD_ITEM_PAGE_SIZE = 11;

const SORT_ORDER = ["potion", "food", "utility", "quest"] as const;
const SORT_RANK = new Map<string, number>(SORT_ORDER.map((value, index) => [value, index]));

export type WorldItemFailureReason =
  | "unknown-item"
  | "not-owned"
  | "not-visible"
  | "not-usable-in-world"
  | "target-required"
  | "invalid-target"
  | "no-eligible-target"
  | "target-ineligible"
  | "wrong-location"
  | "no-faint-point"
  | "unsupported-condition"
  | "unsupported-effect"
  | "no-effect"
  | "festering"
  | "evolution-unavailable"
  | "move-choice-required"
  | "invalid-move-choice";

export interface WorldItemEligibility {
  eligible: boolean;
  reason: WorldItemFailureReason | null;
  /** Stable English fallback for a UI that has not mapped `reason` yet. */
  detail: string | null;
}

export interface WorldItemListEntry {
  slug: string;
  name: string;
  description: string;
  quantity: number;
  sort: string;
  category: string;
  requiresTarget: boolean;
  usable: boolean;
  reason: WorldItemFailureReason | null;
  detail: string | null;
}

export interface WorldItemPage {
  page: number;
  pageSize: number;
  pageCount: number;
  totalItems: number;
  items: WorldItemListEntry[];
}

export interface WorldItemContext {
  /** Evolution location context. Missing means outdoors. */
  inside?: boolean;
  /** Tags on the tile immediately in front of the player. */
  facingTile?: string | readonly string[];
  /** Tags/name of the event immediately in front of the player. */
  facingSprite?: string | readonly string[];
  /** Owner of the faint point used by `teleport_item center`. */
  faintPointCharacter?: string;
}

export type WorldItemTarget =
  | number
  | string
  | { partyIndex: number }
  | { iid: string };

export type WorldItemDirective =
  | { type: "teleport"; character: string; map: string; x: number; y: number }
  | { type: "fishing"; facingTile: string | null }
  | { type: "remove-facing-entity"; facingSprite: string | null };

export interface WorldItemMoveChoice {
  targetIndex: number;
  technique: string;
  knownMoves: string[];
}

export interface WorldItemUseRequest {
  item: string;
  target?: WorldItemTarget;
  /** Existing move index or slug to forget when a TM target already has four moves. */
  forgetMove?: number | string;
  /** Used by XP items when a level-up teaches more than the move limit. */
  chooseMoveToForget?: MoveForgetSelector;
  context?: WorldItemContext;
}

export interface WorldItemEffectResult {
  type: string;
  success: boolean;
  reason: WorldItemFailureReason | null;
}

export interface WorldItemUseResult {
  extension: TuxemonExtensionState;
  switches: SwitchState;
  item: string;
  targetIndex: number | null;
  success: boolean;
  consumed: boolean;
  reason: WorldItemFailureReason | null;
  detail: string | null;
  useMessage: string;
  message: string;
  effects: WorldItemEffectResult[];
  directives: WorldItemDirective[];
  moveChoice?: WorldItemMoveChoice;
  progression?: ProgressionResult;
}

interface ResolvedTarget {
  index: number;
  snapshot: SpawnedMonsterSnapshot;
  monster: BattleMonster;
}

const eligible = (): WorldItemEligibility => ({ eligible: true, reason: null, detail: null });

function ineligible(reason: WorldItemFailureReason, detail: string): WorldItemEligibility {
  return { eligible: false, reason, detail };
}

function parameters(plugin: BattlePlugin): unknown[] {
  return plugin.parameters ?? [];
}

function textParameter(plugin: BattlePlugin, index: number): string {
  const value = parameters(plugin)[index];
  return value === undefined || value === null ? "" : String(value);
}

function numberParameter(plugin: BattlePlugin, index: number, fallback = 0): number {
  const value = Number(parameters(plugin)[index]);
  return Number.isFinite(value) ? value : fallback;
}

function values(value: string | readonly string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  return typeof value === "string" ? [value] : value;
}

function hasValue(value: string | readonly string[] | undefined, expected: string): boolean {
  const wanted = expected.trim().toLowerCase();
  return values(value).some((candidate) => candidate.trim().toLowerCase() === wanted);
}

function compare(left: number, operator: string, right: number): boolean {
  switch (operator) {
    case "<":
    case "less_than": return left < right;
    case "<=":
    case "less_or_equal": return left <= right;
    case ">":
    case "greater_than": return left > right;
    case ">=":
    case "greater_or_equal": return left >= right;
    case "==":
    case "=":
    case "equals":
    case "equal_to": return left === right;
    case "!=":
    case "not_equals": return left !== right;
    default: return false;
  }
}

function expectedResult(plugin: BattlePlugin, actual: boolean): WorldItemEligibility {
  if (plugin.operator !== undefined && plugin.operator !== "is" && plugin.operator !== "not") {
    return ineligible("unsupported-condition", `Unsupported item condition operator '${plugin.operator}'.`);
  }
  const passed = plugin.operator === "not" ? !actual : actual;
  return passed ? eligible() : ineligible("target-ineligible", "This item cannot be used on that monster.");
}

function itemEvolutionCandidates(
  itemSlug: string,
  monster: BattleMonster,
  party: readonly BattleMonster[],
  variables: SwitchState["variables"],
  inside: boolean,
  evolutions: readonly DbEvolution[],
): Array<{ evolution: DbEvolution; weight: number }> {
  const context = { owned: true, party, variables, inside, useItem: true } as const;
  return evolutions.flatMap((evolution) => {
    const weight = evolution.item?.[itemSlug];
    return typeof weight === "number" && weight > 0
        && evolutionConditionsPass(monster, evolution, context)
      ? [{ evolution, weight }]
      : [];
  });
}

function conditionEligibility(
  db: BattleDb,
  rulesDb: ReturnType<typeof battleDbToTuxemonBattleDb>,
  extension: Readonly<TuxemonExtensionState>,
  switches: Readonly<SwitchState>,
  itemSlug: string,
  plugin: BattlePlugin,
  target: ResolvedTarget | null,
  context: Readonly<WorldItemContext>,
): WorldItemEligibility {
  const targetRequired = !["facing_tile", "facing_sprite"].includes(plugin.type);
  if (targetRequired && target === null) {
    return ineligible("target-required", "Choose a monster first.");
  }
  const monster = target?.monster;
  let actual: boolean;
  switch (plugin.type) {
    case "current_hp": {
      const operator = textParameter(plugin, 0);
      const asked = numberParameter(plugin, 1, Number.NaN);
      if (!monster || !Number.isFinite(asked)) {
        return ineligible("unsupported-condition", "The item's HP condition is invalid.");
      }
      actual = compare(monster.base.hp > 0 ? monster.currentHp / monster.base.hp : 0, operator, asked);
      break;
    }
    case "has_status":
      actual = monster?.status !== null && monster?.status !== undefined;
      break;
    case "status":
      actual = monster?.status?.slug === textParameter(plugin, 0);
      break;
    case "has_tech":
      actual = monster?.moves.some((move) => move.slug === textParameter(plugin, 0)) ?? false;
      break;
    case "has_tp_room": {
      const stat = textParameter(plugin, 0);
      if (!monster || !STAT_NAMES.includes(stat as StatName)) {
        return ineligible("unsupported-condition", "The item's training-point condition is invalid.");
      }
      const rules = db.rules.trainingPoints;
      const total = STAT_NAMES.reduce((sum, name) => sum + monster.trainingPoints[name], 0);
      actual = monster.trainingPoints[stat as StatName] < rules.maxPerStat && total < rules.maxTotal;
      break;
    }
    case "has_path": {
      if (!monster) return ineligible("target-required", "Choose a monster first.");
      const wanted = textParameter(plugin, 0);
      actual = (rulesDb.monster[monster.slug]?.evolutions ?? [])
        .some((evolution) => evolution.item?.[wanted] !== undefined);
      break;
    }
    case "can_evolve": {
      if (!monster || !target) return ineligible("target-required", "Choose a monster first.");
      const party = extension.party.map((snapshot, index) => monsterFromSnapshot(rulesDb, index + 1, snapshot));
      actual = (rulesDb.monster[monster.slug]?.evolutions ?? []).some((evolution) =>
        evolutionConditionsPass(monster, evolution, {
          owned: true,
          party,
          variables: switches.variables,
          inside: context.inside ?? false,
          useItem: true,
        })
      );
      break;
    }
    case "base": {
      if (!monster) return ineligible("target-required", "Choose a monster first.");
      const source = textParameter(plugin, 0);
      const species = db.monsters[monster.slug];
      if (!species) return ineligible("invalid-target", "That monster is not present in the battle database.");
      const dataset = source === "tags" ? species.tags
        : source === "types" ? monster.types
        : source === "shape" || source === "shapes" ? [species.shape]
        : source === "terrains" ? species.terrains
        : source === "species" ? [species.species]
        : null;
      if (dataset === null) {
        return ineligible("unsupported-condition", `Unsupported base item condition '${source}'.`);
      }
      const normalized = new Set(dataset.map((entry) => entry.trim().toLowerCase()));
      const checks = textParameter(plugin, 1).split(":").filter(Boolean).map((option) => {
        const negated = option.startsWith("!");
        const present = normalized.has((negated ? option.slice(1) : option).trim().toLowerCase());
        return negated ? !present : present;
      });
      const matchAll = textParameter(plugin, 2).toLowerCase() === "true";
      actual = checks.length > 0 && (matchAll ? checks.every(Boolean) : checks.some(Boolean));
      break;
    }
    case "facing_tile":
      actual = hasValue(context.facingTile, textParameter(plugin, 0));
      break;
    case "facing_sprite":
      actual = hasValue(context.facingSprite, textParameter(plugin, 0));
      break;
    default:
      return ineligible("unsupported-condition", `Unsupported item condition '${plugin.type}'.`);
  }
  const result = expectedResult(plugin, actual);
  if (!result.eligible && (plugin.type === "facing_tile" || plugin.type === "facing_sprite")) {
    return ineligible("wrong-location", "This item cannot be used at the current location.");
  }
  return result;
}

function resolveTarget(
  rulesDb: ReturnType<typeof battleDbToTuxemonBattleDb>,
  party: readonly SpawnedMonsterSnapshot[],
  target: WorldItemTarget | undefined,
): ResolvedTarget | null {
  let index = -1;
  if (typeof target === "number") index = target;
  else if (typeof target === "string") index = party.findIndex((monster) => monster.iid === target);
  else if (target && "partyIndex" in target) index = target.partyIndex;
  else if (target && "iid" in target) index = party.findIndex((monster) => monster.iid === target.iid);
  if (!Number.isInteger(index) || index < 0 || index >= party.length) return null;
  const snapshot = party[index]!;
  return { index, snapshot, monster: monsterFromSnapshot(rulesDb, index + 1, snapshot) };
}

function itemAvailability(
  db: BattleDb,
  switches: Readonly<SwitchState>,
  itemSlug: string,
): WorldItemEligibility {
  const item = db.items[itemSlug];
  if (!item) return ineligible("unknown-item", `Unknown item '${itemSlug}'.`);
  if ((switches.items[itemSlug] ?? 0) <= 0) return ineligible("not-owned", `You do not have ${item.name}.`);
  if (item.behaviors.visible !== true) return ineligible("not-visible", `${item.name} is hidden from the bag.`);
  if (!item.usableIn.includes("WorldState")) {
    return ineligible("not-usable-in-world", `${item.name} cannot be used outside battle.`);
  }
  return eligible();
}

function implicitWorldEligibility(
  extension: Readonly<TuxemonExtensionState>,
  item: BattleDb["items"][string],
  context: Readonly<WorldItemContext>,
): WorldItemEligibility {
  const teleport = item.effects.find((effect) => effect.type === "teleport_item");
  if (teleport && textParameter(teleport, 0) === "center") {
    const character = context.faintPointCharacter ?? "player";
    if (!extension.faintPoints[character]) {
      return ineligible("no-faint-point", `No recovery destination is stored for '${character}'.`);
    }
  }
  return eligible();
}

function targetConditions(
  db: BattleDb,
  rulesDb: ReturnType<typeof battleDbToTuxemonBattleDb>,
  extension: Readonly<TuxemonExtensionState>,
  switches: Readonly<SwitchState>,
  itemSlug: string,
  target: ResolvedTarget | null,
  context: Readonly<WorldItemContext>,
): WorldItemEligibility {
  const item = db.items[itemSlug]!;
  for (const condition of item.conditions) {
    const result = conditionEligibility(db, rulesDb, extension, switches, itemSlug, condition, target, context);
    if (!result.eligible) return result;
  }
  return implicitWorldEligibility(extension, item, context);
}

/** Eligibility for one concrete party target. No state or RNG is consumed. */
export function worldItemTargetEligibility(
  db: BattleDb,
  extension: Readonly<TuxemonExtensionState>,
  switches: Readonly<SwitchState>,
  itemSlug: string,
  target: WorldItemTarget,
  context: Readonly<WorldItemContext> = {},
): WorldItemEligibility {
  const availability = itemAvailability(db, switches, itemSlug);
  if (!availability.eligible) return availability;
  const rulesDb = battleDbToTuxemonBattleDb(db);
  const resolved = resolveTarget(rulesDb, extension.party, target);
  if (!resolved) return ineligible("invalid-target", "The selected monster is not in the party.");
  return targetConditions(db, rulesDb, extension, switches, itemSlug, resolved, context);
}

/** Eligibility from the bag: targeted items pass when at least one party member can receive them. */
export function worldItemEligibility(
  db: BattleDb,
  extension: Readonly<TuxemonExtensionState>,
  switches: Readonly<SwitchState>,
  itemSlug: string,
  context: Readonly<WorldItemContext> = {},
): WorldItemEligibility {
  const availability = itemAvailability(db, switches, itemSlug);
  if (!availability.eligible) return availability;
  const item = db.items[itemSlug]!;
  const rulesDb = battleDbToTuxemonBattleDb(db);
  if (item.behaviors.requires_monster_menu === true) {
    for (let index = 0; index < extension.party.length; index++) {
      if (targetConditions(
        db,
        rulesDb,
        extension,
        switches,
        itemSlug,
        resolveTarget(rulesDb, extension.party, index),
        context,
      ).eligible) return eligible();
    }
    return ineligible("no-eligible-target", `No party monster can use ${item.name}.`);
  }
  return targetConditions(db, rulesDb, extension, switches, itemSlug, null, context);
}

/**
 * Bag listing parity: filter only hidden/empty stacks, slice acquisition order
 * into pages, then sort each page by upstream's sort rank and localized name.
 */
export function listWorldItems(
  db: BattleDb,
  extension: Readonly<TuxemonExtensionState>,
  switches: Readonly<SwitchState>,
  options: { page?: number; pageSize?: number; context?: Readonly<WorldItemContext> } = {},
): WorldItemPage {
  const pageSize = Number.isInteger(options.pageSize) && (options.pageSize ?? 0) > 0
    ? options.pageSize!
    : WORLD_ITEM_PAGE_SIZE;
  const inventory = Object.entries(switches.items).flatMap(([slug, rawQuantity], acquisitionIndex) => {
    const item = db.items[slug];
    const quantity = Math.trunc(rawQuantity);
    return item && item.behaviors.visible === true && quantity > 0
      ? [{ slug, item, quantity, acquisitionIndex }]
      : [];
  });
  const pageCount = Math.max(1, Math.ceil(inventory.length / pageSize));
  const requestedPage = Number.isInteger(options.page) ? options.page! : 0;
  const page = Math.max(0, Math.min(pageCount - 1, requestedPage));
  const sliced = inventory.slice(page * pageSize, (page + 1) * pageSize);
  sliced.sort((left, right) => {
    const rank = (SORT_RANK.get(left.item.sort) ?? SORT_ORDER.length)
      - (SORT_RANK.get(right.item.sort) ?? SORT_ORDER.length);
    if (rank !== 0) return rank;
    const a = left.item.name.toLowerCase();
    const b = right.item.name.toLowerCase();
    return a < b ? -1 : a > b ? 1 : left.acquisitionIndex - right.acquisitionIndex;
  });
  const context = options.context ?? {};
  return {
    page,
    pageSize,
    pageCount,
    totalItems: inventory.length,
    items: sliced.map(({ slug, item, quantity }) => {
      const use = worldItemEligibility(db, extension, switches, slug, context);
      return {
        slug,
        name: item.name,
        description: item.description,
        quantity,
        sort: item.sort,
        category: item.category,
        requiresTarget: item.behaviors.requires_monster_menu === true,
        usable: use.eligible,
        reason: use.reason,
        detail: use.detail,
      };
    }),
  };
}

function formatMessage(template: string, itemName: string, playerName: string): string {
  return template.replaceAll("{name}", itemName).replaceAll("{user}", playerName);
}

function failUse(
  extension: TuxemonExtensionState,
  switches: SwitchState,
  itemSlug: string,
  item: BattleDb["items"][string] | undefined,
  result: WorldItemEligibility,
  targetIndex: number | null = null,
): WorldItemUseResult {
  return {
    extension,
    switches,
    item: itemSlug,
    targetIndex,
    success: false,
    consumed: false,
    reason: result.reason,
    detail: result.detail,
    useMessage: item ? formatMessage(item.messages.use, item.name, switches.playerName) : "",
    message: item ? formatMessage(item.messages.failure, item.name, switches.playerName) : result.detail ?? "",
    effects: [],
    directives: [],
  };
}

function writeBackMonster(snapshot: SpawnedMonsterSnapshot, monster: BattleMonster): SpawnedMonsterSnapshot {
  return {
    ...snapshot,
    slug: monster.slug,
    level: Math.trunc(monster.level),
    stage: monster.stage,
    gender: monster.gender,
    tasteCold: monster.tasteCold,
    tasteWarm: monster.tasteWarm,
    height: monster.height,
    weight: monster.weight,
    individualValues: { ...monster.individualValues },
    birthdate: [...monster.birthdate],
    base: { ...monster.base },
    currentHp: Math.max(0, Math.min(monster.base.hp, Math.trunc(monster.currentHp))),
    moves: monster.moves.map((move) => move.slug),
    types: [...monster.originalTypes],
    totalExperience: Math.max(0, Math.trunc(monster.totalExperience)),
    experienceModifier: monster.experienceModifier,
    moneyModifier: monster.moneyModifier,
    bond: Math.max(0, Math.min(100, Math.trunc(monster.bond))),
    trainingPoints: { ...monster.trainingPoints },
    status: monster.status?.slug ?? null,
    acquisition: monster.acquisition,
    captureDevice: monster.captureDevice,
    waitingToEvolve: monster.waitingToEvolve,
  };
}

function withPartyMonster(
  extension: TuxemonExtensionState,
  index: number,
  monster: SpawnedMonsterSnapshot,
): TuxemonExtensionState {
  const party = [...extension.party];
  party[index] = monster;
  return { ...extension, party };
}

function withCaught(extension: TuxemonExtensionState, slug: string): TuxemonExtensionState {
  const seen = extension.seen.includes(slug)
    ? extension.seen.filter((candidate) => candidate !== slug)
    : extension.seen;
  const caught = extension.caught.includes(slug) ? extension.caught : [...extension.caught, slug];
  return seen === extension.seen && caught === extension.caught ? extension : { ...extension, seen, caught };
}

function consume(switches: SwitchState, itemSlug: string): SwitchState {
  const items = { ...switches.items };
  const quantity = Math.max(0, Math.trunc(items[itemSlug] ?? 0) - 1);
  if (quantity === 0) delete items[itemSlug];
  else items[itemSlug] = quantity;
  return { ...switches, items };
}

function moveChoiceIndex(moves: readonly string[], choice: number | string | undefined): number {
  if (typeof choice === "number") return Number.isInteger(choice) ? choice : -1;
  return typeof choice === "string" ? moves.indexOf(choice) : -1;
}

/**
 * Pure out-of-battle item reducer. Inputs are never mutated; map-facing work is
 * returned as directives for the world/session reducer to apply.
 */
export function useWorldItem(
  db: BattleDb,
  extension: TuxemonExtensionState,
  switches: SwitchState,
  request: Readonly<WorldItemUseRequest>,
): WorldItemUseResult {
  const item = db.items[request.item];
  const availability = itemAvailability(db, switches, request.item);
  if (!availability.eligible) return failUse(extension, switches, request.item, item, availability);
  const rulesDb = battleDbToTuxemonBattleDb(db);
  const requiresTarget = item!.behaviors.requires_monster_menu === true;
  if (requiresTarget && request.target === undefined) {
    return failUse(
      extension,
      switches,
      request.item,
      item,
      ineligible("target-required", "Choose a monster first."),
    );
  }
  const target = request.target === undefined ? null : resolveTarget(rulesDb, extension.party, request.target);
  if (request.target !== undefined && target === null) {
    return failUse(
      extension,
      switches,
      request.item,
      item,
      ineligible("invalid-target", "The selected monster is not in the party."),
    );
  }
  const conditions = targetConditions(
    db,
    rulesDb,
    extension,
    switches,
    request.item,
    target,
    request.context ?? {},
  );
  if (!conditions.eligible) {
    return failUse(extension, switches, request.item, item, conditions, target?.index ?? null);
  }

  const tmEffect = item!.effects.find((effect) => effect.type === "learn_tm");
  if (tmEffect && target) {
    const technique = textParameter(tmEffect, 0);
    const moves = target.snapshot.moves;
    if (!moves.includes(technique) && moves.length >= db.rules.maxMoves) {
      if (request.forgetMove === undefined) {
        const pending = ineligible("move-choice-required", `Choose a move to forget before learning '${technique}'.`);
        return {
          ...failUse(extension, switches, request.item, item, pending, target.index),
          moveChoice: { targetIndex: target.index, technique, knownMoves: [...moves] },
        };
      }
      const index = moveChoiceIndex(moves, request.forgetMove);
      if (index < 0 || index >= moves.length) {
        return failUse(
          extension,
          switches,
          request.item,
          item,
          ineligible("invalid-move-choice", "The selected move is not known by that monster."),
          target.index,
        );
      }
    }
  }

  let nextExtension = extension;
  let nextSwitches = switches;
  let activeTarget = target;
  let success = false;
  let failureReason: WorldItemFailureReason | null = null;
  let failureDetail: string | null = null;
  let progression: ProgressionResult | undefined;
  const effects: WorldItemEffectResult[] = [];
  const directives: WorldItemDirective[] = [];
  const context = request.context ?? {};
  const setTarget = (snapshot: SpawnedMonsterSnapshot) => {
    if (!activeTarget) return;
    nextExtension = withPartyMonster(nextExtension, activeTarget.index, snapshot);
    activeTarget = {
      index: activeTarget.index,
      snapshot,
      monster: monsterFromSnapshot(rulesDb, activeTarget.index + 1, snapshot),
    };
  };
  const effectResult = (type: string, effectSuccess: boolean, reason: WorldItemFailureReason | null = null) => {
    effects.push({ type, success: effectSuccess, reason });
    success ||= effectSuccess;
    if (!effectSuccess && failureReason === null) failureReason = reason ?? "unsupported-effect";
  };

  for (const effect of item!.effects) {
    switch (effect.type) {
      case "heal": {
        if (!activeTarget) {
          effectResult(effect.type, false, "target-required");
          break;
        }
        if (activeTarget.snapshot.status === "festering" && item!.category === "potion") {
          failureDetail = "Festering prevents this potion from restoring HP.";
          effectResult(effect.type, false, "festering");
          break;
        }
        const amount = numberParameter(effect, 0);
        const kind = textParameter(effect, 1);
        const healed = kind === "percentage"
          ? Math.trunc(activeTarget.snapshot.base.hp * amount)
          : Math.trunc(amount);
        setTarget({
          ...activeTarget.snapshot,
          currentHp: Math.max(0, Math.min(
            activeTarget.snapshot.base.hp,
            (activeTarget.snapshot.currentHp ?? activeTarget.snapshot.base.hp) + healed,
          )),
        });
        effectResult(effect.type, true);
        break;
      }
      case "restore": {
        if (!activeTarget) {
          effectResult(effect.type, false, "target-required");
          break;
        }
        setTarget({ ...activeTarget.snapshot, status: null });
        effectResult(effect.type, true);
        break;
      }
      case "gain_xp": {
        if (!activeTarget) {
          effectResult(effect.type, false, "target-required");
          break;
        }
        const monster = monsterFromSnapshot(rulesDb, activeTarget.index + 1, activeTarget.snapshot);
        const party = nextExtension.party.map((snapshot, index) => monsterFromSnapshot(rulesDb, index + 1, snapshot));
        party[activeTarget.index] = monster;
        progression = giveExperience(
          rulesDb,
          monster,
          Math.trunc(numberParameter(effect, 0)),
          {
            owned: true,
            party,
            variables: nextSwitches.variables,
            inside: context.inside ?? false,
          },
          request.chooseMoveToForget,
        );
        setTarget(writeBackMonster(activeTarget.snapshot, monster));
        effectResult(effect.type, true);
        break;
      }
      case "give_tp": {
        if (!activeTarget) {
          effectResult(effect.type, false, "target-required");
          break;
        }
        const stat = textParameter(effect, 0);
        if (!STAT_NAMES.includes(stat as StatName)) {
          effectResult(effect.type, false, "unsupported-effect");
          break;
        }
        const tp = { ...activeTarget.monster.trainingPoints };
        const rules = db.rules.trainingPoints;
        const total = STAT_NAMES.reduce((sum, name) => sum + tp[name], 0);
        const amount = Math.max(0, Math.trunc(numberParameter(effect, 1, rules.defaultGain)));
        const grant = Math.max(0, Math.min(amount, rules.maxPerStat - tp[stat as StatName], rules.maxTotal - total));
        tp[stat as StatName] += grant;
        const base = calculateBaseStats(
          rulesDb,
          activeTarget.snapshot.slug,
          activeTarget.snapshot.level,
          activeTarget.snapshot.individualValues,
          activeTarget.snapshot.tasteCold,
          activeTarget.snapshot.tasteWarm,
          tp,
        );
        setTarget({
          ...activeTarget.snapshot,
          trainingPoints: tp,
          base,
          currentHp: Math.min(activeTarget.snapshot.currentHp ?? activeTarget.snapshot.base.hp, base.hp),
        });
        effectResult(effect.type, true);
        break;
      }
      case "learn_tm": {
        if (!activeTarget) {
          effectResult(effect.type, false, "target-required");
          break;
        }
        const technique = textParameter(effect, 0);
        if (!db.techniques[technique] || activeTarget.snapshot.moves.includes(technique)) {
          effectResult(effect.type, false, "target-ineligible");
          break;
        }
        let moves = [...activeTarget.snapshot.moves];
        if (moves.length >= db.rules.maxMoves) {
          const index = moveChoiceIndex(moves, request.forgetMove);
          moves.splice(index, 1);
        }
        moves.push(technique);
        setTarget({ ...activeTarget.snapshot, moves });
        effectResult(effect.type, true);
        break;
      }
      case "evolve": {
        if (!activeTarget) {
          effectResult(effect.type, false, "target-required");
          break;
        }
        const party = nextExtension.party.map((snapshot, index) => monsterFromSnapshot(rulesDb, index + 1, snapshot));
        const candidates = itemEvolutionCandidates(
          request.item,
          activeTarget.monster,
          party,
          nextSwitches.variables,
          context.inside ?? false,
          rulesDb.monster[activeTarget.monster.slug]?.evolutions ?? [],
        );
        if (candidates.length === 0) {
          effectResult(effect.type, false, "evolution-unavailable");
          break;
        }
        const random = () => {
          const draw = rngNext(nextSwitches.rng);
          nextSwitches = { ...nextSwitches, rng: draw.next };
          return draw.value;
        };
        let chosen = candidates[0]!;
        if (candidates.length > 1) {
          const total = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
          const wanted = random() * total;
          let accumulated = 0;
          for (const candidate of candidates) {
            accumulated += candidate.weight;
            chosen = candidate;
            if (wanted < accumulated) break;
          }
        }
        const evolved = transferToSpecies(
          db,
          rulesDb,
          activeTarget.monster,
          chosen.evolution.monster_slug,
          random,
        );
        setTarget(evolved);
        nextExtension = withCaught(nextExtension, evolved.slug);
        effectResult(effect.type, true);
        break;
      }
      case "repellent": {
        const trackers = addStepTracker(nextExtension.stepTrackers, "player", "repellent", {
          countdown: numberParameter(effect, 0),
          milestones: [],
          autoReset: false,
        });
        if (trackers !== undefined) nextExtension = { ...nextExtension, stepTrackers: trackers };
        effectResult(effect.type, true);
        break;
      }
      case "teleport_item": {
        const character = context.faintPointCharacter ?? "player";
        const destination = textParameter(effect, 0);
        if (destination === "center") {
          const point = nextExtension.faintPoints[character]!;
          directives.push({ type: "teleport", character, map: point.map, x: point.x, y: point.y });
        } else {
          directives.push({
            type: "teleport",
            character,
            map: destination,
            x: Math.trunc(numberParameter(effect, 1, -1)),
            y: Math.trunc(numberParameter(effect, 2, -1)),
          });
        }
        effectResult(effect.type, true);
        break;
      }
      case "fishing":
        directives.push({ type: "fishing", facingTile: values(context.facingTile)[0] ?? null });
        effectResult(effect.type, true);
        break;
      case "remove_entity":
        directives.push({ type: "remove-facing-entity", facingSprite: values(context.facingSprite)[0] ?? null });
        effectResult(effect.type, true);
        break;
      default:
        effectResult(effect.type, false, "unsupported-effect");
        failureDetail = `Unsupported world item effect '${effect.type}'.`;
        break;
    }
  }

  if (item!.effects.length === 0) {
    failureReason = "no-effect";
    failureDetail = `${item!.name} has no out-of-battle effect.`;
  }
  const consumed = item!.consumable;
  if (consumed) nextSwitches = consume(nextSwitches, request.item);
  const reason = success ? null : failureReason ?? "unsupported-effect";
  return {
    extension: nextExtension,
    switches: nextSwitches,
    item: request.item,
    targetIndex: activeTarget?.index ?? null,
    success,
    consumed,
    reason,
    detail: success ? null : failureDetail ?? "The item had no effect.",
    useMessage: formatMessage(item!.messages.use, item!.name, switches.playerName),
    message: formatMessage(success ? item!.messages.success : item!.messages.failure, item!.name, switches.playerName),
    effects,
    directives,
    ...(progression === undefined ? {} : { progression }),
  };
}

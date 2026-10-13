/**
 * Public, seedless expedition journals.
 *
 * A journal deliberately stores only values already exposed by
 * observeExpedition(), plus the accepted public action. It is a presentation
 * record, not an authoritative state snapshot and not proof that the actions
 * were accepted by a particular service.
 *
 * Version 1 uses full observations. The expedition reducer admits at most
 * 10,000 actions, and an accepted encoded journal is additionally capped at
 * 64 MiB. Keeping full frames makes consumers and validation unambiguous while
 * those two limits put a hard bound on storage and parsing work.
 */

import {
  ARENA_DEADLINE_TICKS,
  ARENA_MAX_TURNS,
  ARENA_VERSION,
  type ArenaAction,
  type ArenaObservation,
} from "./arena.ts";
import {
  EXPEDITION_AREAS,
  EXPEDITION_VERSION,
  MAX_EXPEDITION_STEPS,
  MAX_EXPEDITION_TEAM,
  type ExpeditionAction,
  type ExpeditionCycle,
  type ExpeditionObservation,
} from "./expedition.ts";

export const EXPEDITION_JOURNAL_FORMAT = "pocket-tuxemon/expedition-journal/v1" as const;
export const MAX_EXPEDITION_JOURNAL_ENTRIES = MAX_EXPEDITION_STEPS;
export const MAX_EXPEDITION_JOURNAL_BYTES = 64 * 1024 * 1024;

const MAX_STRING_LENGTH = 1_024;
const MAX_TOTAL_STRING_UNITS = 32 * 1024 * 1024;
const MAX_TOTAL_NODES = 4_000_000;
const MAX_OBSERVATION_COLLECTION = 512;
const MAX_LEVEL = 100;
const STAT_KEYS = ["armour", "dodge", "hp", "melee", "ranged", "speed"] as const;

export interface ExpeditionJournalPublicRules {
  cycle: ExpeditionCycle;
  stepBudget: number;
  levelCap: number;
  startingArea: string;
}

export interface ExpeditionJournalEntry {
  /** One-based index within this journal, independent of account-wide action sequence. */
  step: number;
  action: ExpeditionAction;
  observation: ExpeditionObservation;
}

export interface ExpeditionJournal {
  format: typeof EXPEDITION_JOURNAL_FORMAT;
  rules: ExpeditionJournalPublicRules;
  initialObservation: ExpeditionObservation;
  entries: ExpeditionJournalEntry[];
}

export type ExpeditionJournalValidation =
  | { ok: true; journal: ExpeditionJournal }
  | { ok: false; error: string };

export class ExpeditionJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpeditionJournalError";
  }
}

interface DecodeBudget {
  nodes: number;
  stringUnits: number;
}

function fail(message: string): never {
  throw new ExpeditionJournalError(message);
}

function consumeNode(budget: DecodeBudget, path: string): void {
  if (--budget.nodes < 0) fail(`${path}: journal exceeds the structural node limit`);
}

/** Accept only ordinary JSON containers with enumerable data properties.
 * Symbols, accessors, inherited bags and non-enumerable fields are rejected
 * before a field is read. */
function exactObject(
  value: unknown,
  required: readonly string[],
  path: string,
  budget: DecodeBudget,
  optional: readonly string[] = [],
): Record<string, unknown> {
  consumeNode(budget, path);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${path}: expected an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${path}: expected a plain object`);
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string") ||
      keys.some((key) => typeof key === "string" && !allowed.has(key)) ||
      required.some((key) => !keys.includes(key)) ||
      keys.length < required.length || keys.length > required.length + optional.length) {
    fail(`${path}: object fields do not match the version-1 schema`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      fail(`${path}.${String(key)}: expected an enumerable data property`);
    }
  }
  return value as Record<string, unknown>;
}

function exactArray(value: unknown, maximum: number, path: string, budget: DecodeBudget): unknown[] {
  consumeNode(budget, path);
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(`${path}: expected an array`);
  }
  if (value.length > maximum) fail(`${path}: array exceeds the ${maximum}-entry limit`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.at(-1) !== "length") {
    fail(`${path}: sparse arrays and extra fields are not allowed`);
  }
  for (let index = 0; index < value.length; index++) {
    if (keys[index] !== String(index)) fail(`${path}: sparse arrays and extra fields are not allowed`);
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      fail(`${path}[${index}]: expected an enumerable data property`);
    }
  }
  return value;
}

function textValue(value: unknown, path: string, budget: DecodeBudget, allowEmpty = true): string {
  consumeNode(budget, path);
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > MAX_STRING_LENGTH) {
    fail(`${path}: expected ${allowEmpty ? "a" : "a non-empty"} bounded string`);
  }
  budget.stringUnits -= value.length;
  if (budget.stringUnits < 0) fail(`${path}: journal exceeds the total string limit`);
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, path: string, budget: DecodeBudget): number {
  consumeNode(budget, path);
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(`${path}: expected an integer in ${minimum}..${maximum}`);
  }
  return value as number;
}

function bool(value: unknown, path: string, budget: DecodeBudget): boolean {
  consumeNode(budget, path);
  if (typeof value !== "boolean") fail(`${path}: expected a boolean`);
  return value;
}

function nullableText(value: unknown, path: string, budget: DecodeBudget): string | null {
  if (value === null) {
    consumeNode(budget, path);
    return null;
  }
  return textValue(value, path, budget, false);
}

function localizedName(value: unknown, path: string, budget: DecodeBudget): { en_US: string; zh_CN: string } {
  const source = exactObject(value, ["en_US", "zh_CN"], path, budget);
  return {
    en_US: textValue(source.en_US, `${path}.en_US`, budget),
    zh_CN: textValue(source.zh_CN, `${path}.zh_CN`, budget),
  };
}

function expeditionName(
  value: unknown,
  path: string,
  budget: DecodeBudget,
): { slug: string; en_US: string; zh_CN: string } {
  const source = exactObject(value, ["slug", "en_US", "zh_CN"], path, budget);
  return {
    slug: textValue(source.slug, `${path}.slug`, budget, false),
    en_US: textValue(source.en_US, `${path}.en_US`, budget),
    zh_CN: textValue(source.zh_CN, `${path}.zh_CN`, budget),
  };
}

function arenaName(
  value: unknown,
  path: string,
  budget: DecodeBudget,
): { slug: string; displayName: { en_US: string; zh_CN: string } } {
  const source = exactObject(value, ["slug", "displayName"], path, budget);
  return {
    slug: textValue(source.slug, `${path}.slug`, budget, false),
    displayName: localizedName(source.displayName, `${path}.displayName`, budget),
  };
}

function arenaAction(value: unknown, path: string, budget: DecodeBudget): ArenaAction {
  const discriminant = exactObject(value, ["type"], path, budget, ["slot", "target", "party", "item"]);
  const type = textValue(discriminant.type, `${path}.type`, budget, false);
  if (type === "move") {
    const source = exactObject(value, ["type", "slot"], path, budget, ["target"]);
    return {
      type,
      slot: integer(source.slot, 0, 3, `${path}.slot`, budget),
      ...(Object.hasOwn(source, "target")
        ? { target: integer(source.target, 0, 1, `${path}.target`, budget) }
        : {}),
    };
  }
  if (type === "swap") {
    const source = exactObject(value, ["type", "party"], path, budget);
    return { type, party: integer(source.party, 0, MAX_EXPEDITION_TEAM - 1, `${path}.party`, budget) };
  }
  if (type === "item") {
    const source = exactObject(value, ["type", "item"], path, budget, ["target"]);
    return {
      type,
      item: textValue(source.item, `${path}.item`, budget, false),
      ...(Object.hasOwn(source, "target")
        ? { target: integer(source.target, 0, MAX_EXPEDITION_TEAM - 1, `${path}.target`, budget) }
        : {}),
    };
  }
  if (type === "run") {
    exactObject(value, ["type"], path, budget);
    return { type };
  }
  fail(`${path}.type: unknown Arena action`);
}

function expeditionAction(value: unknown, path: string, budget: DecodeBudget): ExpeditionAction {
  const envelope = exactObject(value, ["type", "sequence"], path, budget, [
    "area", "mode", "action", "item", "target", "move", "forget", "shop", "quantity",
  ]);
  const type = textValue(envelope.type, `${path}.type`, budget, false);
  const sequence = integer(envelope.sequence, 1, Number.MAX_SAFE_INTEGER, `${path}.sequence`, budget);
  if (type === "travel") {
    const source = exactObject(value, ["type", "area", "sequence"], path, budget);
    const area = textValue(source.area, `${path}.area`, budget, false);
    if (!Object.hasOwn(EXPEDITION_AREAS, area)) fail(`${path}.area: unknown expedition area`);
    return { type, area, sequence };
  }
  if (type === "explore" || type === "flee" || type === "heal" || type === "end") {
    exactObject(value, ["type", "sequence"], path, budget);
    return { type, sequence };
  }
  if (type === "battle") {
    const mode = textValue(envelope.mode, `${path}.mode`, budget, false);
    if (mode === "auto") {
      exactObject(value, ["type", "mode", "sequence"], path, budget);
      return { type, mode, sequence };
    }
    if (mode === "manual") {
      const source = exactObject(value, ["type", "mode", "action", "sequence"], path, budget);
      return { type, mode, action: arenaAction(source.action, `${path}.action`, budget), sequence };
    }
    fail(`${path}.mode: unknown battle mode`);
  }
  if (type === "catch") {
    const source = exactObject(value, ["type", "item", "sequence"], path, budget);
    return { type, item: textValue(source.item, `${path}.item`, budget, false), sequence };
  }
  if (type === "useItem") {
    const source = exactObject(value, ["type", "item", "target", "sequence"], path, budget);
    return {
      type,
      item: textValue(source.item, `${path}.item`, budget, false),
      target: integer(source.target, 0, MAX_EXPEDITION_TEAM - 1, `${path}.target`, budget),
      sequence,
    };
  }
  if (type === "learnMove") {
    const source = exactObject(value, ["type", "item", "move", "target", "sequence"], path, budget, ["forget"]);
    return {
      type,
      item: textValue(source.item, `${path}.item`, budget, false),
      move: textValue(source.move, `${path}.move`, budget, false),
      target: integer(source.target, 0, MAX_EXPEDITION_TEAM - 1, `${path}.target`, budget),
      ...(Object.hasOwn(source, "forget")
        ? { forget: textValue(source.forget, `${path}.forget`, budget, false) }
        : {}),
      sequence,
    };
  }
  if (type === "shop") {
    const source = exactObject(value, ["type", "shop", "item", "quantity", "sequence"], path, budget);
    const quantity = integer(source.quantity, 1, 1, `${path}.quantity`, budget) as 1;
    return {
      type,
      shop: textValue(source.shop, `${path}.shop`, budget, false),
      item: textValue(source.item, `${path}.item`, budget, false),
      quantity,
      sequence,
    };
  }
  fail(`${path}.type: unknown expedition action`);
}

function stats(value: unknown, path: string, budget: DecodeBudget): Record<(typeof STAT_KEYS)[number], number> {
  const source = exactObject(value, STAT_KEYS, path, budget);
  return Object.fromEntries(STAT_KEYS.map((key) => [
    key,
    integer(source[key], 0, Number.MAX_SAFE_INTEGER, `${path}.${key}`, budget),
  ])) as Record<(typeof STAT_KEYS)[number], number>;
}

function stages(value: unknown, path: string, budget: DecodeBudget): Partial<Record<(typeof STAT_KEYS)[number], number>> {
  const source = exactObject(value, [], path, budget, STAT_KEYS);
  const output: Partial<Record<(typeof STAT_KEYS)[number], number>> = {};
  for (const key of STAT_KEYS) {
    if (Object.hasOwn(source, key)) output[key] = integer(source[key], -100, 100, `${path}.${key}`, budget);
  }
  return output;
}

function arenaObservation(value: unknown, path: string, budget: DecodeBudget): ArenaObservation {
  const source = exactObject(value, [
    "v", "side", "format", "turn", "round", "deadlineTicks", "actingParty",
    "own", "opponent", "legalActions", "result",
  ], path, budget);
  if (source.v !== ARENA_VERSION) fail(`${path}.v: expected Arena version ${ARENA_VERSION}`);
  consumeNode(budget, `${path}.v`);
  const side = integer(source.side, 0, 1, `${path}.side`, budget) as 0 | 1;
  if (source.format !== "single" && source.format !== "double") fail(`${path}.format: invalid Arena format`);
  consumeNode(budget, `${path}.format`);
  const format = source.format;
  const turn = integer(source.turn, 0, ARENA_MAX_TURNS, `${path}.turn`, budget);
  const round = integer(source.round, 0, ARENA_MAX_TURNS + 1, `${path}.round`, budget);
  const deadlineTicks = integer(source.deadlineTicks, ARENA_DEADLINE_TICKS, ARENA_DEADLINE_TICKS,
    `${path}.deadlineTicks`, budget);
  const actingParty = source.actingParty === null
    ? (consumeNode(budget, `${path}.actingParty`), null)
    : integer(source.actingParty, 0, MAX_EXPEDITION_TEAM - 1, `${path}.actingParty`, budget);

  const ownSource = exactObject(source.own, ["active", "party"], `${path}.own`, budget);
  const ownActiveSource = exactArray(ownSource.active, 2, `${path}.own.active`, budget);
  const active = ownActiveSource.map((entry, index) =>
    integer(entry, 0, MAX_EXPEDITION_TEAM - 1, `${path}.own.active[${index}]`, budget));
  if (new Set(active).size !== active.length) fail(`${path}.own.active: duplicate party index`);
  const partySource = exactArray(ownSource.party, MAX_EXPEDITION_TEAM, `${path}.own.party`, budget);
  if (partySource.length === 0) fail(`${path}.own.party: party must not be empty`);
  const party = partySource.map((entry, index) => {
    const member = exactObject(entry, [
      "party", "active", "species", "level", "hp", "status", "types", "gender", "base", "stages", "moves",
    ], `${path}.own.party[${index}]`, budget);
    const partyIndex = integer(member.party, 0, MAX_EXPEDITION_TEAM - 1,
      `${path}.own.party[${index}].party`, budget);
    if (partyIndex !== index) fail(`${path}.own.party[${index}].party: expected ${index}`);
    const activeMember = bool(member.active, `${path}.own.party[${index}].active`, budget);
    if (activeMember !== active.includes(index)) fail(`${path}.own.party[${index}].active: active list mismatch`);
    const hpSource = exactObject(member.hp, ["current", "max", "percent"],
      `${path}.own.party[${index}].hp`, budget);
    const hpMax = integer(hpSource.max, 1, Number.MAX_SAFE_INTEGER,
      `${path}.own.party[${index}].hp.max`, budget);
    const hpCurrent = integer(hpSource.current, 0, hpMax,
      `${path}.own.party[${index}].hp.current`, budget);
    const typesSource = exactArray(member.types, 8, `${path}.own.party[${index}].types`, budget);
    const movesSource = exactArray(member.moves, 4, `${path}.own.party[${index}].moves`, budget);
    const moves = movesSource.map((move, moveIndex) => {
      const row = exactObject(move, ["slot", "slug", "displayName", "cooldown"],
        `${path}.own.party[${index}].moves[${moveIndex}]`, budget);
      const slot = integer(row.slot, 0, 3, `${path}.own.party[${index}].moves[${moveIndex}].slot`, budget);
      if (slot !== moveIndex) fail(`${path}.own.party[${index}].moves[${moveIndex}].slot: expected ${moveIndex}`);
      return {
        slot,
        slug: textValue(row.slug, `${path}.own.party[${index}].moves[${moveIndex}].slug`, budget, false),
        displayName: localizedName(row.displayName,
          `${path}.own.party[${index}].moves[${moveIndex}].displayName`, budget),
        cooldown: integer(row.cooldown, 0, Number.MAX_SAFE_INTEGER,
          `${path}.own.party[${index}].moves[${moveIndex}].cooldown`, budget),
      };
    });
    return {
      party: partyIndex,
      active: activeMember,
      species: arenaName(member.species, `${path}.own.party[${index}].species`, budget),
      level: integer(member.level, 1, MAX_LEVEL, `${path}.own.party[${index}].level`, budget),
      hp: {
        current: hpCurrent,
        max: hpMax,
        percent: integer(hpSource.percent, 0, 100, `${path}.own.party[${index}].hp.percent`, budget),
      },
      status: nullableText(member.status, `${path}.own.party[${index}].status`, budget),
      types: typesSource.map((type, typeIndex) =>
        textValue(type, `${path}.own.party[${index}].types[${typeIndex}]`, budget, false)),
      gender: textValue(member.gender, `${path}.own.party[${index}].gender`, budget),
      base: stats(member.base, `${path}.own.party[${index}].base`, budget),
      stages: stages(member.stages, `${path}.own.party[${index}].stages`, budget),
      moves,
    };
  });

  const opponentSource = exactObject(source.opponent, ["active"], `${path}.opponent`, budget);
  const opponentActiveSource = exactArray(opponentSource.active, 2, `${path}.opponent.active`, budget);
  const opponentActive = opponentActiveSource.map((entry, index) => {
    const member = exactObject(entry,
      ["position", "species", "level", "hpPercent", "status", "revealedMoves"],
      `${path}.opponent.active[${index}]`, budget);
    const position = integer(member.position, 0, 1, `${path}.opponent.active[${index}].position`, budget);
    if (position !== index) fail(`${path}.opponent.active[${index}].position: expected ${index}`);
    const revealedSource = exactArray(member.revealedMoves, 4,
      `${path}.opponent.active[${index}].revealedMoves`, budget);
    return {
      position,
      species: arenaName(member.species, `${path}.opponent.active[${index}].species`, budget),
      level: integer(member.level, 1, MAX_LEVEL, `${path}.opponent.active[${index}].level`, budget),
      hpPercent: integer(member.hpPercent, 0, 100, `${path}.opponent.active[${index}].hpPercent`, budget),
      status: nullableText(member.status, `${path}.opponent.active[${index}].status`, budget),
      revealedMoves: revealedSource.map((move, moveIndex) => {
        const row = exactObject(move, ["slug", "displayName"],
          `${path}.opponent.active[${index}].revealedMoves[${moveIndex}]`, budget);
        return {
          slug: textValue(row.slug,
            `${path}.opponent.active[${index}].revealedMoves[${moveIndex}].slug`, budget, false),
          displayName: localizedName(row.displayName,
            `${path}.opponent.active[${index}].revealedMoves[${moveIndex}].displayName`, budget),
        };
      }),
    };
  });

  const legalSource = exactArray(source.legalActions, 128, `${path}.legalActions`, budget);
  const legalActions = legalSource.map((action, index) =>
    arenaAction(action, `${path}.legalActions[${index}]`, budget));
  let result: ArenaObservation["result"] = null;
  if (source.result === null) {
    consumeNode(budget, `${path}.result`);
  } else {
    const resultSource = exactObject(source.result, ["winner", "turns", "reason"], `${path}.result`, budget);
    const winner = resultSource.winner === null
      ? (consumeNode(budget, `${path}.result.winner`), null)
      : integer(resultSource.winner, 0, 1, `${path}.result.winner`, budget) as 0 | 1;
    if (!["knockout", "draw", "escape", "capture", "turn-limit"].includes(resultSource.reason as string)) {
      fail(`${path}.result.reason: invalid Arena result reason`);
    }
    consumeNode(budget, `${path}.result.reason`);
    result = {
      winner,
      turns: integer(resultSource.turns, 0, ARENA_MAX_TURNS, `${path}.result.turns`, budget),
      reason: resultSource.reason as NonNullable<ArenaObservation["result"]>["reason"],
    };
  }
  if (result !== null && legalActions.length !== 0) fail(`${path}.legalActions: terminal Arena has legal actions`);
  return {
    v: ARENA_VERSION,
    side,
    format,
    turn,
    round,
    deadlineTicks,
    actingParty,
    own: { active, party },
    opponent: { active: opponentActive },
    legalActions,
    result,
  };
}

function expeditionObservation(value: unknown, path: string, budget: DecodeBudget): ExpeditionObservation {
  const source = exactObject(value, [
    "v", "cycle", "run", "status", "area", "destinations", "team", "backpack", "money",
    "remainingSteps", "nextAction", "encounter", "shop", "result",
  ], path, budget);
  if (source.v !== EXPEDITION_VERSION) fail(`${path}.v: expected expedition version ${EXPEDITION_VERSION}`);
  consumeNode(budget, `${path}.v`);
  if (source.cycle !== "ranked" && source.cycle !== "persistent") fail(`${path}.cycle: invalid cycle`);
  consumeNode(budget, `${path}.cycle`);
  const cycle = source.cycle;
  if (source.status !== "active" && source.status !== "ended") fail(`${path}.status: invalid status`);
  consumeNode(budget, `${path}.status`);
  const status = source.status;
  const areaSource = exactObject(source.area, ["id", "name"], `${path}.area`, budget);
  const areaId = textValue(areaSource.id, `${path}.area.id`, budget, false);
  if (!Object.hasOwn(EXPEDITION_AREAS, areaId)) fail(`${path}.area.id: unknown expedition area`);
  const area = { id: areaId, name: textValue(areaSource.name, `${path}.area.name`, budget) };

  const destinationsSource = exactArray(source.destinations, Object.keys(EXPEDITION_AREAS).length,
    `${path}.destinations`, budget);
  const destinations = destinationsSource.map((entry, index) => {
    const destination = exactObject(entry, ["id", "name"], `${path}.destinations[${index}]`, budget);
    const id = textValue(destination.id, `${path}.destinations[${index}].id`, budget, false);
    if (!Object.hasOwn(EXPEDITION_AREAS, id)) fail(`${path}.destinations[${index}].id: unknown expedition area`);
    return { id, name: textValue(destination.name, `${path}.destinations[${index}].name`, budget) };
  });

  const teamSource = exactArray(source.team, MAX_EXPEDITION_TEAM, `${path}.team`, budget);
  if (teamSource.length === 0) fail(`${path}.team: team must not be empty`);
  const team = teamSource.map((entry, index) => {
    const member = exactObject(entry, ["slot", "species", "level", "experience", "hp", "status", "moves"],
      `${path}.team[${index}]`, budget);
    const slot = integer(member.slot, 0, MAX_EXPEDITION_TEAM - 1, `${path}.team[${index}].slot`, budget);
    if (slot !== index) fail(`${path}.team[${index}].slot: expected ${index}`);
    const hpSource = exactObject(member.hp, ["current", "max"], `${path}.team[${index}].hp`, budget);
    const maximumHp = integer(hpSource.max, 1, Number.MAX_SAFE_INTEGER, `${path}.team[${index}].hp.max`, budget);
    const movesSource = exactArray(member.moves, 4, `${path}.team[${index}].moves`, budget);
    return {
      slot,
      species: expeditionName(member.species, `${path}.team[${index}].species`, budget),
      level: integer(member.level, 1, MAX_LEVEL, `${path}.team[${index}].level`, budget),
      experience: integer(member.experience, 0, Number.MAX_SAFE_INTEGER,
        `${path}.team[${index}].experience`, budget),
      hp: {
        current: integer(hpSource.current, 0, maximumHp, `${path}.team[${index}].hp.current`, budget),
        max: maximumHp,
      },
      status: nullableText(member.status, `${path}.team[${index}].status`, budget),
      moves: movesSource.map((move, moveIndex) => {
        const row = exactObject(move, ["slug", "en_US", "zh_CN"],
          `${path}.team[${index}].moves[${moveIndex}]`, budget);
        return {
          slug: textValue(row.slug, `${path}.team[${index}].moves[${moveIndex}].slug`, budget, false),
          en_US: textValue(row.en_US, `${path}.team[${index}].moves[${moveIndex}].en_US`, budget),
          zh_CN: textValue(row.zh_CN, `${path}.team[${index}].moves[${moveIndex}].zh_CN`, budget),
        };
      }),
    };
  });

  const backpackSource = exactArray(source.backpack, MAX_OBSERVATION_COLLECTION, `${path}.backpack`, budget);
  const backpack = backpackSource.map((entry, index) => {
    const item = exactObject(entry, ["item", "en_US", "zh_CN", "quantity"],
      `${path}.backpack[${index}]`, budget);
    return {
      item: textValue(item.item, `${path}.backpack[${index}].item`, budget, false),
      en_US: textValue(item.en_US, `${path}.backpack[${index}].en_US`, budget),
      zh_CN: textValue(item.zh_CN, `${path}.backpack[${index}].zh_CN`, budget),
      quantity: integer(item.quantity, 1, Number.MAX_SAFE_INTEGER, `${path}.backpack[${index}].quantity`, budget),
    };
  });

  let encounter: ExpeditionObservation["encounter"] = null;
  if (source.encounter === null) {
    consumeNode(budget, `${path}.encounter`);
  } else {
    const row = exactObject(source.encounter, ["species", "level", "hpPercent", "status", "battle"],
      `${path}.encounter`, budget);
    encounter = {
      species: expeditionName(row.species, `${path}.encounter.species`, budget),
      level: integer(row.level, 1, MAX_LEVEL, `${path}.encounter.level`, budget),
      hpPercent: integer(row.hpPercent, 0, 100, `${path}.encounter.hpPercent`, budget),
      status: nullableText(row.status, `${path}.encounter.status`, budget),
      battle: arenaObservation(row.battle, `${path}.encounter.battle`, budget),
    };
  }

  let shop: ExpeditionObservation["shop"] = null;
  if (source.shop === null) {
    consumeNode(budget, `${path}.shop`);
  } else {
    const shopSource = exactObject(source.shop, ["id", "goods"], `${path}.shop`, budget);
    const goodsSource = exactArray(shopSource.goods, MAX_OBSERVATION_COLLECTION, `${path}.shop.goods`, budget);
    shop = {
      id: textValue(shopSource.id, `${path}.shop.id`, budget, false),
      goods: goodsSource.map((entry, index) => {
        const good = exactObject(entry, ["item", "en_US", "zh_CN", "price", "remaining"],
          `${path}.shop.goods[${index}]`, budget);
        const remaining = good.remaining === null
          ? (consumeNode(budget, `${path}.shop.goods[${index}].remaining`), null)
          : integer(good.remaining, 0, Number.MAX_SAFE_INTEGER,
            `${path}.shop.goods[${index}].remaining`, budget);
        return {
          item: textValue(good.item, `${path}.shop.goods[${index}].item`, budget, false),
          en_US: textValue(good.en_US, `${path}.shop.goods[${index}].en_US`, budget),
          zh_CN: textValue(good.zh_CN, `${path}.shop.goods[${index}].zh_CN`, budget),
          price: integer(good.price, 0, Number.MAX_SAFE_INTEGER, `${path}.shop.goods[${index}].price`, budget),
          remaining,
        };
      }),
    };
  }

  let result: ExpeditionObservation["result"] = null;
  if (source.result === null) {
    consumeNode(budget, `${path}.result`);
  } else {
    const resultSource = exactObject(source.result, ["reason"], `${path}.result`, budget);
    if (resultSource.reason !== "voluntary" && resultSource.reason !== "budget" &&
        resultSource.reason !== "defeated") fail(`${path}.result.reason: invalid expedition result reason`);
    consumeNode(budget, `${path}.result.reason`);
    result = { reason: resultSource.reason };
  }
  if ((status === "ended") !== (result !== null)) fail(`${path}: status and result disagree`);

  return {
    v: EXPEDITION_VERSION,
    cycle,
    run: integer(source.run, 1, Number.MAX_SAFE_INTEGER, `${path}.run`, budget),
    status,
    area,
    destinations,
    team,
    backpack,
    money: integer(source.money, 0, Number.MAX_SAFE_INTEGER, `${path}.money`, budget),
    remainingSteps: integer(source.remainingSteps, 0, MAX_EXPEDITION_STEPS, `${path}.remainingSteps`, budget),
    nextAction: integer(source.nextAction, 1, Number.MAX_SAFE_INTEGER, `${path}.nextAction`, budget),
    encounter,
    shop,
    result,
  };
}

function publicRules(value: unknown, path: string, budget: DecodeBudget): ExpeditionJournalPublicRules {
  const source = exactObject(value, ["cycle", "stepBudget", "levelCap", "startingArea"], path, budget);
  if (source.cycle !== "ranked" && source.cycle !== "persistent") fail(`${path}.cycle: invalid cycle`);
  consumeNode(budget, `${path}.cycle`);
  const startingArea = textValue(source.startingArea, `${path}.startingArea`, budget, false);
  if (!Object.hasOwn(EXPEDITION_AREAS, startingArea)) fail(`${path}.startingArea: unknown expedition area`);
  return {
    cycle: source.cycle,
    stepBudget: integer(source.stepBudget, 1, MAX_EXPEDITION_STEPS, `${path}.stepBudget`, budget),
    levelCap: integer(source.levelCap, 1, MAX_LEVEL, `${path}.levelCap`, budget),
    startingArea,
  };
}

function decodeJournal(value: unknown): ExpeditionJournal {
  const budget: DecodeBudget = { nodes: MAX_TOTAL_NODES, stringUnits: MAX_TOTAL_STRING_UNITS };
  const source = exactObject(value, ["format", "rules", "initialObservation", "entries"], "$", budget);
  if (source.format !== EXPEDITION_JOURNAL_FORMAT) {
    fail(`$.format: expected '${EXPEDITION_JOURNAL_FORMAT}'`);
  }
  consumeNode(budget, "$.format");
  const rules = publicRules(source.rules, "$.rules", budget);
  const initialObservation = expeditionObservation(source.initialObservation, "$.initialObservation", budget);
  if (initialObservation.cycle !== rules.cycle) fail("$.initialObservation.cycle: does not match rules.cycle");
  if (initialObservation.status !== "active" || initialObservation.result !== null) {
    fail("$.initialObservation: journal must start at an active observation");
  }
  if (initialObservation.remainingSteps !== rules.stepBudget) {
    fail("$.initialObservation.remainingSteps: does not match rules.stepBudget");
  }
  if (initialObservation.area.id !== rules.startingArea) {
    fail("$.initialObservation.area.id: does not match rules.startingArea");
  }

  const entriesSource = exactArray(source.entries, MAX_EXPEDITION_JOURNAL_ENTRIES, "$.entries", budget);
  let previous = initialObservation;
  const entries = entriesSource.map((entry, index): ExpeditionJournalEntry => {
    const path = `$.entries[${index}]`;
    const row = exactObject(entry, ["step", "action", "observation"], path, budget);
    const step = integer(row.step, 1, MAX_EXPEDITION_JOURNAL_ENTRIES, `${path}.step`, budget);
    if (step !== index + 1) fail(`${path}.step: expected ${index + 1}`);
    if (previous.status !== "active") fail(`${path}: entries cannot follow a terminal observation`);
    const action = expeditionAction(row.action, `${path}.action`, budget);
    if (action.sequence !== previous.nextAction) {
      fail(`${path}.action.sequence: expected ${previous.nextAction}`);
    }
    const observation = expeditionObservation(row.observation, `${path}.observation`, budget);
    if (observation.nextAction !== action.sequence + 1) {
      fail(`${path}.observation.nextAction: expected ${action.sequence + 1}`);
    }
    if (observation.cycle !== initialObservation.cycle || observation.run !== initialObservation.run) {
      fail(`${path}.observation: cycle and run must remain constant`);
    }
    if (observation.remainingSteps !== previous.remainingSteps - 1) {
      fail(`${path}.observation.remainingSteps: expected ${previous.remainingSteps - 1}`);
    }
    previous = observation;
    return { step, action, observation };
  });
  const journal: ExpeditionJournal = {
    format: EXPEDITION_JOURNAL_FORMAT,
    rules,
    initialObservation,
    entries,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(journal)).byteLength;
  if (bytes > MAX_EXPEDITION_JOURNAL_BYTES) {
    fail(`$: encoded journal exceeds the ${MAX_EXPEDITION_JOURNAL_BYTES}-byte limit`);
  }
  return journal;
}

export function validateExpeditionJournal(value: unknown): ExpeditionJournalValidation {
  try {
    return { ok: true, journal: decodeJournal(value) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function startExpeditionJournal(
  rulesPublic: ExpeditionJournalPublicRules,
  initialObservation: ExpeditionObservation,
): ExpeditionJournal {
  const checked = validateExpeditionJournal({
    format: EXPEDITION_JOURNAL_FORMAT,
    rules: rulesPublic,
    initialObservation,
    entries: [],
  });
  if (!checked.ok) throw new ExpeditionJournalError(checked.error);
  return checked.journal;
}

export function appendExpeditionJournal(
  journal: ExpeditionJournal,
  action: ExpeditionAction,
  observationAfter: ExpeditionObservation,
): ExpeditionJournal {
  const checked = validateExpeditionJournal({
    ...journal,
    entries: [
      ...journal.entries,
      { step: journal.entries.length + 1, action, observation: observationAfter },
    ],
  });
  if (!checked.ok) throw new ExpeditionJournalError(checked.error);
  return checked.journal;
}

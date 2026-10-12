/** Deterministic reconstruction of persistent Arena teams.
 *
 * A TeamRecord is a claim plus an append-only server event log. Battle-ready
 * stats are always rebuilt from game data and that log; callers cannot inject
 * base stats, IVs, training points, types, or any other combat value.
 */

import battleDbJson from "../data/battle-db.json";
import { validateBattleDb } from "../importer/battle-schema.ts";
import { createSwitchState } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";
import { sha256Bytes } from "../vendor/pocket-rpgkit/src/engine/map-repository.ts";
import { utf8Encode } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import type { RngState } from "./core.ts";
import { initialTuxemonExtensionState } from "./extension.ts";
import { battleDbToTuxemonBattleDb } from "./from-battle-db.ts";
import { spawnMonster } from "./spawn.ts";
import { calculateBaseStats } from "./stats.ts";
import {
  STAT_NAMES,
  type SpawnedMonsterSnapshot,
  type StatName,
} from "./types.ts";
import { worldItemTargetEligibility } from "./world-items.ts";

export interface ArenaAcquireEvent {
  seq: number;
  type: "acquire";
  seed: string;
  species: string;
  level: number;
}

export interface ArenaLevelEvent {
  seq: number;
  type: "level";
  /** Every event advances exactly one level. */
  level: number;
}

export interface ArenaLearnEvent {
  seq: number;
  type: "learn";
  move: string;
  /** Required when the four-move limit has already been reached. */
  forget?: string;
}

export interface ArenaItemEvent {
  seq: number;
  type: "item";
  item: string;
  /** Move replaced by a TM, when necessary. */
  forget?: string;
}

export type ArenaProvenanceEvent =
  | ArenaAcquireEvent
  | ArenaLevelEvent
  | ArenaLearnEvent
  | ArenaItemEvent;

export interface ArenaTeamRecord {
  species: string;
  level: number;
  moves: string[];
  provenance: ArenaProvenanceEvent[];
}

export interface ArenaTeamRules {
  minSize?: number;
  maxSize?: number;
  levelCap?: number;
  /** Rebuild battle stats at this level after validating the saved level. */
  uniformLevel?: number | null;
  bannedSpecies?: readonly string[];
  bannedMoves?: readonly string[];
  bannedItems?: readonly string[];
}

interface NormalizedTeamRules {
  minSize: number;
  maxSize: number;
  levelCap: number;
  uniformLevel: number | null;
  bannedSpecies: Set<string>;
  bannedMoves: Set<string>;
  bannedItems: Set<string>;
}

export type ArenaTeamValidation =
  | { ok: true; errors: [] }
  | { ok: false; errors: string[] };

const SOURCE_DB = validateBattleDb(battleDbJson);
const RULES_DB = battleDbToTuxemonBattleDb(SOURCE_DB);
const HEX_SEED = /^[0-9a-fA-F]{64}$/;
const MAX_PROVENANCE_EVENTS = 1_024;

export const DEFAULT_ARENA_TEAM_RULES: Readonly<Required<ArenaTeamRules>> = Object.freeze({
  minSize: 1,
  maxSize: 5,
  levelCap: SOURCE_DB.rules.levelRange[1],
  uniformLevel: null,
  bannedSpecies: Object.freeze([] as string[]),
  bannedMoves: Object.freeze([] as string[]),
  bannedItems: Object.freeze([] as string[]),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function exactObject(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key)) && required.every((key) => key in value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function recordSeed(seed: string, seq: number): number {
  const digest = sha256Bytes(utf8Encode(`pocket-tuxemon/arena-team/v1\n${seq}\n${seed.toLowerCase()}`));
  return Number.parseInt(digest.slice(0, 8), 16) >>> 0;
}

function stringSet(
  value: unknown,
  label: string,
  known: (slug: string) => boolean,
  errors: string[],
): Set<string> {
  if (!Array.isArray(value) || value.length > 1_024 || value.some((entry) => typeof entry !== "string")) {
    errors.push(`${label} must be an array of slugs`);
    return new Set();
  }
  const result = new Set(value as string[]);
  if (result.size !== value.length) errors.push(`${label} must not contain duplicates`);
  for (const slug of result) if (!known(slug)) errors.push(`${label} contains unknown slug '${slug}'`);
  return result;
}

function normalizeRules(value: unknown, errors: string[]): NormalizedTeamRules {
  const input = value === undefined ? {} : value;
  if (!isRecord(input) || !exactObject(input, [
    "minSize", "maxSize", "levelCap", "uniformLevel", "bannedSpecies", "bannedMoves", "bannedItems",
  ], [])) {
    errors.push("team rules must contain only documented fields");
  }
  const source = isRecord(input) ? input : {};
  const integer = (key: "minSize" | "maxSize" | "levelCap", fallback: number): number => {
    const candidate = source[key] ?? fallback;
    if (!Number.isSafeInteger(candidate) || (candidate as number) < 1) {
      errors.push(`team rules ${key} must be a positive safe integer`);
      return fallback;
    }
    return candidate as number;
  };
  const minSize = integer("minSize", DEFAULT_ARENA_TEAM_RULES.minSize);
  const maxSize = integer("maxSize", DEFAULT_ARENA_TEAM_RULES.maxSize);
  const levelCap = integer("levelCap", DEFAULT_ARENA_TEAM_RULES.levelCap);
  if (minSize > maxSize || maxSize > 6) errors.push("team rules require 1 <= minSize <= maxSize <= 6");
  if (levelCap < SOURCE_DB.rules.levelRange[0] || levelCap > SOURCE_DB.rules.levelRange[1]) {
    errors.push(`team rules levelCap must be ${SOURCE_DB.rules.levelRange[0]}..${SOURCE_DB.rules.levelRange[1]}`);
  }
  const uniformValue = source.uniformLevel ?? DEFAULT_ARENA_TEAM_RULES.uniformLevel;
  const uniformLevel = uniformValue === null ? null : uniformValue as number;
  if (uniformLevel !== null && (typeof uniformLevel !== "number" || !Number.isSafeInteger(uniformLevel) ||
      uniformLevel < SOURCE_DB.rules.levelRange[0] || uniformLevel > levelCap)) {
    errors.push(`team rules uniformLevel must be null or ${SOURCE_DB.rules.levelRange[0]}..levelCap`);
  }
  return {
    minSize,
    maxSize,
    levelCap,
    uniformLevel,
    bannedSpecies: stringSet(
      source.bannedSpecies ?? DEFAULT_ARENA_TEAM_RULES.bannedSpecies,
      "team rules bannedSpecies",
      (slug) => Object.hasOwn(SOURCE_DB.monsters, slug),
      errors,
    ),
    bannedMoves: stringSet(
      source.bannedMoves ?? DEFAULT_ARENA_TEAM_RULES.bannedMoves,
      "team rules bannedMoves",
      (slug) => Object.hasOwn(SOURCE_DB.techniques, slug),
      errors,
    ),
    bannedItems: stringSet(
      source.bannedItems ?? DEFAULT_ARENA_TEAM_RULES.bannedItems,
      "team rules bannedItems",
      (slug) => Object.hasOwn(SOURCE_DB.items, slug),
      errors,
    ),
  };
}

function recalculate(snapshot: SpawnedMonsterSnapshot, level = snapshot.level): void {
  snapshot.level = level;
  snapshot.base = calculateBaseStats(
    RULES_DB,
    snapshot.slug,
    level,
    snapshot.individualValues,
    snapshot.tasteCold,
    snapshot.tasteWarm,
    snapshot.trainingPoints,
  );
  snapshot.currentHp = snapshot.base.hp;
  const experience = SOURCE_DB.rules.experience.groups.default!;
  snapshot.totalExperience = Math.trunc(
    experience.multiplier * level ** experience.experienceCoefficient,
  );
}

function learnMove(
  snapshot: SpawnedMonsterSnapshot,
  move: unknown,
  forget: unknown,
  label: string,
  errors: string[],
): boolean {
  if (typeof move !== "string" || !Object.hasOwn(SOURCE_DB.techniques, move)) {
    errors.push(`${label} names an unknown move`);
    return false;
  }
  if (snapshot.moves.includes(move)) {
    errors.push(`${label} repeats known move '${move}'`);
    return false;
  }
  if (forget !== undefined && (typeof forget !== "string" || !snapshot.moves.includes(forget))) {
    errors.push(`${label} cannot forget unknown move '${String(forget)}'`);
    return false;
  }
  if (snapshot.moves.length >= SOURCE_DB.rules.maxMoves && forget === undefined) {
    errors.push(`${label} must forget a move at the ${SOURCE_DB.rules.maxMoves}-move limit`);
    return false;
  }
  if (snapshot.moves.length < SOURCE_DB.rules.maxMoves && forget !== undefined) {
    errors.push(`${label} cannot forget a move below the ${SOURCE_DB.rules.maxMoves}-move limit`);
    return false;
  }
  if (forget !== undefined) snapshot.moves.splice(snapshot.moves.indexOf(forget as string), 1);
  snapshot.moves.push(move);
  return true;
}

function moveIsLevelEligible(snapshot: SpawnedMonsterSnapshot, move: string): boolean {
  return RULES_DB.monster[snapshot.slug]!.moveset.some((entry) =>
    entry.technique === move && entry.learning_method === "level_up" &&
    entry.level_learned <= snapshot.level &&
    (entry.evolution_stage_learned === undefined || entry.evolution_stage_learned === snapshot.stage)
  );
}

function applyItem(
  snapshot: SpawnedMonsterSnapshot,
  itemSlug: unknown,
  forget: unknown,
  rules: NormalizedTeamRules,
  label: string,
  errors: string[],
): void {
  if (
    typeof itemSlug !== "string" ||
    !Object.hasOwn(SOURCE_DB.items, itemSlug) ||
    !Object.hasOwn(RULES_DB.item, itemSlug)
  ) {
    errors.push(`${label} names an unknown item`);
    return;
  }
  const extension = { ...initialTuxemonExtensionState(), party: [clone(snapshot)] };
  const eligibility = worldItemTargetEligibility(
    SOURCE_DB,
    extension,
    createSwitchState({ items: { [itemSlug]: 1 } }),
    itemSlug,
    0,
  );
  if (!eligibility.eligible) {
    errors.push(`${label} cannot apply item '${itemSlug}' to this monster`);
    return;
  }
  if (rules.bannedItems.has(itemSlug)) {
    errors.push(`${label} uses banned item '${itemSlug}'`);
    return;
  }
  const item = RULES_DB.item[itemSlug]!;
  if (item.effects.length === 0 || item.effects.some((effect) =>
    effect.type !== "give_tp" && effect.type !== "learn_tm"
  )) {
    errors.push(`${label} item '${itemSlug}' has no supported persistent Arena effect`);
    return;
  }
  for (const effect of item.effects) {
    if (effect.type === "learn_tm") {
      learnMove(snapshot, effect.parameters[0], forget, label, errors);
      continue;
    }
    const stat = effect.parameters[0];
    if (!STAT_NAMES.includes(stat as StatName)) {
      errors.push(`${label} item '${itemSlug}' has an invalid training stat`);
      continue;
    }
    const amount = Number(effect.parameters[1] ?? SOURCE_DB.rules.trainingPoints.defaultGain);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      errors.push(`${label} item '${itemSlug}' has an invalid training amount`);
      continue;
    }
    const training = snapshot.trainingPoints!;
    const total = STAT_NAMES.reduce((sum, name) => sum + training[name]!, 0);
    const grant = Math.max(0, Math.min(
      amount,
      SOURCE_DB.rules.trainingPoints.maxPerStat - training[stat as StatName]!,
      SOURCE_DB.rules.trainingPoints.maxTotal - total,
    ));
    if (grant === 0) {
      errors.push(`${label} item '${itemSlug}' cannot add more training points`);
      continue;
    }
    training[stat as StatName]! += grant;
    recalculate(snapshot);
  }
}

interface RebuiltTeam {
  errors: string[];
  snapshots: SpawnedMonsterSnapshot[];
}

function rebuildTeam(records: unknown, rulesValue: unknown): RebuiltTeam {
  const errors: string[] = [];
  const rules = normalizeRules(rulesValue, errors);
  if (!Array.isArray(records)) {
    errors.push("team must be an array");
    return { errors, snapshots: [] };
  }
  if (records.length < rules.minSize || records.length > rules.maxSize) {
    errors.push(`team size must be ${rules.minSize}..${rules.maxSize}`);
    return { errors, snapshots: [] };
  }
  const sequences = new Set<number>();
  const snapshots: SpawnedMonsterSnapshot[] = [];
  for (const [recordIndex, rawRecord] of records.entries()) {
    const prefix = `team[${recordIndex}]`;
    if (!isRecord(rawRecord) || !exactObject(rawRecord, ["species", "level", "moves", "provenance"], [
      "species", "level", "moves", "provenance",
    ])) {
      errors.push(`${prefix} must contain only species, level, moves, and provenance`);
      continue;
    }
    if (typeof rawRecord.species !== "string" || !Object.hasOwn(SOURCE_DB.monsters, rawRecord.species)) {
      errors.push(`${prefix}.species is unknown`);
      continue;
    }
    if (!Number.isSafeInteger(rawRecord.level) || (rawRecord.level as number) < 1) {
      errors.push(`${prefix}.level must be a positive safe integer`);
      continue;
    }
    if (!Array.isArray(rawRecord.moves) || rawRecord.moves.length > SOURCE_DB.rules.maxMoves ||
        rawRecord.moves.some((move) => typeof move !== "string")) {
      errors.push(`${prefix}.moves must be at most ${SOURCE_DB.rules.maxMoves} move slugs`);
      continue;
    }
    if (!Array.isArray(rawRecord.provenance) || rawRecord.provenance.length === 0 ||
        rawRecord.provenance.length > MAX_PROVENANCE_EVENTS) {
      errors.push(`${prefix}.provenance must contain 1..${MAX_PROVENANCE_EVENTS} events`);
      continue;
    }
    const first = rawRecord.provenance[0];
    if (!isRecord(first) || first.type !== "acquire" || !exactObject(first,
      ["seq", "type", "seed", "species", "level"], ["seq", "type", "seed", "species", "level"])) {
      errors.push(`${prefix}.provenance[0] must be an acquire event`);
      continue;
    }
    if (!Number.isSafeInteger(first.seq) || (first.seq as number) < 1 || sequences.has(first.seq as number)) {
      errors.push(`${prefix}.provenance[0].seq must be a unique positive safe integer`);
      continue;
    }
    if (typeof first.seed !== "string" || !HEX_SEED.test(first.seed)) {
      errors.push(`${prefix}.provenance[0].seed must be 64 hexadecimal characters`);
      continue;
    }
    if (first.species !== rawRecord.species || !Number.isSafeInteger(first.level) ||
        (first.level as number) < SOURCE_DB.rules.levelRange[0] || (first.level as number) > rules.levelCap) {
      errors.push(`${prefix}.provenance[0] does not match a legal species and level`);
      continue;
    }
    sequences.add(first.seq as number);
    const rng: RngState = { rng: recordSeed(first.seed, first.seq as number), rngDraws: 0 };
    const snapshot = spawnMonster(
      SOURCE_DB,
      RULES_DB,
      rng,
      rawRecord.species,
      first.level as number,
      { iid: `arena-team-${first.seq}`, experienceModifier: 0, moneyModifier: 0 },
    );
    let previousSeq = first.seq as number;
    for (let eventIndex = 1; eventIndex < rawRecord.provenance.length; eventIndex++) {
      const rawEvent = rawRecord.provenance[eventIndex];
      const label = `${prefix}.provenance[${eventIndex}]`;
      if (!isRecord(rawEvent) || typeof rawEvent.type !== "string" ||
          !Number.isSafeInteger(rawEvent.seq) || (rawEvent.seq as number) <= previousSeq ||
          sequences.has(rawEvent.seq as number)) {
        errors.push(`${label} must have a globally unique, increasing server sequence`);
        continue;
      }
      previousSeq = rawEvent.seq as number;
      sequences.add(previousSeq);
      if (rawEvent.type === "level" && exactObject(rawEvent, ["seq", "type", "level"], ["seq", "type", "level"])) {
        if (!Number.isSafeInteger(rawEvent.level) || rawEvent.level !== snapshot.level + 1 ||
            (rawEvent.level as number) > rules.levelCap) {
          errors.push(`${label} must advance exactly one level without exceeding levelCap`);
        } else recalculate(snapshot, rawEvent.level as number);
      } else if (rawEvent.type === "learn" && exactObject(
        rawEvent, ["seq", "type", "move", "forget"], ["seq", "type", "move"],
      )) {
        if (typeof rawEvent.move !== "string" || !moveIsLevelEligible(snapshot, rawEvent.move)) {
          errors.push(`${label} move is not level-eligible for this species`);
        } else learnMove(snapshot, rawEvent.move, rawEvent.forget, label, errors);
      } else if (rawEvent.type === "item" && exactObject(
        rawEvent, ["seq", "type", "item", "forget"], ["seq", "type", "item"],
      )) {
        applyItem(snapshot, rawEvent.item, rawEvent.forget, rules, label, errors);
      } else {
        errors.push(`${label} has an unknown type or fields`);
      }
    }
    if (rules.bannedSpecies.has(snapshot.slug)) errors.push(`${prefix} uses banned species '${snapshot.slug}'`);
    for (const move of snapshot.moves) {
      if (rules.bannedMoves.has(move)) errors.push(`${prefix} uses banned move '${move}'`);
    }
    if (rawRecord.level !== snapshot.level) {
      errors.push(`${prefix}.level does not match the provenance-derived level ${snapshot.level}`);
    }
    if (JSON.stringify(rawRecord.moves) !== JSON.stringify(snapshot.moves)) {
      errors.push(`${prefix}.moves do not match the provenance-derived move list`);
    }
    if (rules.uniformLevel !== null) recalculate(snapshot, rules.uniformLevel);
    snapshots.push(snapshot);
  }
  return { errors, snapshots };
}

/** Validate without trusting any record-carried combat value. */
export function validateTeam(records: unknown, rules: ArenaTeamRules = {}): ArenaTeamValidation {
  const rebuilt = rebuildTeam(records, rules);
  return rebuilt.errors.length === 0
    ? { ok: true, errors: [] }
    : { ok: false, errors: rebuilt.errors };
}

/** Validate the match rule object independently before accepting a config. */
export function validateTeamRules(rules: unknown): ArenaTeamValidation {
  const errors: string[] = [];
  normalizeRules(rules, errors);
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

/** Internal construction seam used by createArenaBattle after the same full
 * validation. Returned snapshots are detached JSON values. */
export function buildValidatedArenaTeam(
  records: unknown,
  rules: ArenaTeamRules = {},
): SpawnedMonsterSnapshot[] {
  const rebuilt = rebuildTeam(records, rules);
  if (rebuilt.errors.length > 0) {
    throw new Error(`arena team rejected: ${rebuilt.errors.join("; ")}`);
  }
  return clone(rebuilt.snapshots);
}

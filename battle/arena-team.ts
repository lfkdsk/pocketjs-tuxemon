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
import { canonicalJson, utf8Encode } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import type { RngState } from "./core.ts";
import { initialTuxemonExtensionState } from "./extension.ts";
import { battleDbToTuxemonBattleDb } from "./from-battle-db.ts";
import { spawnMonster } from "./spawn.ts";
import { calculateBaseStats } from "./stats.ts";
import { calculateDefeatExperience } from "./progression.ts";
import { applyCaptureDeviceEffects } from "./tuxemon.ts";
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
  /** Present on server-created expedition records. Legacy Arena records omit
   * this object and retain their original v1 reconstruction semantics. */
  origin?: ArenaExpeditionOrigin;
}

export type ArenaExpeditionCaptureResult =
  | { result: "starter" }
  | { result: "caught"; item: string; success: true; shakes: number; status: string | null };

export interface ArenaExpeditionOrigin {
  kind: "expedition";
  area: string;
  /** Global expedition action ordinal. The issued starter is step zero. */
  step: number;
  /** Wild encounter XP rate retained after capture. Older records omit this
   * field and keep the historical 1x reconstruction behavior. */
  experienceModifier?: number;
  capture: ArenaExpeditionCaptureResult;
}

export interface ArenaLevelEvent {
  seq: number;
  type: "level";
  /** Every event advances exactly one level. */
  level: number;
  /** Expedition progression emits this as an audit of the preceding XP. */
  step?: number;
}

export interface ArenaLearnEvent {
  seq: number;
  type: "learn";
  move: string;
  /** Required when the four-move limit has already been reached. */
  forget?: string;
  /** Expedition progression emits this as an audit of XP/TM learning. */
  step?: number;
}

export interface ArenaItemEvent {
  seq: number;
  type: "item";
  item: string;
  /** Move replaced by a TM, when necessary. */
  forget?: string;
  step?: number;
}

export interface ArenaExperienceEvent {
  seq: number;
  type: "experience";
  step: number;
  amount: number;
  source:
    | {
      kind: "battle";
      area: string;
      species: string;
      level: number;
      experienceModifier: number;
      participants: number;
      opponentSeed: string;
      opponentSeq: number;
      trainingPoints: StatName[];
    }
    | { kind: "item"; item: string };
}

export type ArenaProvenanceEvent =
  | ArenaAcquireEvent
  | ArenaExperienceEvent
  | ArenaLevelEvent
  | ArenaLearnEvent
  | ArenaItemEvent;

export interface ArenaTeamRecord {
  /** Explicit mode prevents an expedition record from silently falling back
   * to the less strict legacy reconstruction contract. */
  kind: "legacy" | "expedition";
  species: string;
  level: number;
  moves: string[];
  /** Required on expedition records so partial progress between levels is
   * caller-visible and checked against the complete event log. */
  experience?: number;
  /** Bond is part of real battle progression even though it is not a stat. */
  bond?: number;
  /** Integrity checksum for server-created expedition provenance. This is not
   * an ownership signature; authenticated storage remains the trust boundary. */
  provenanceHash?: string;
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
  /** Select the authenticated storage class when callers know whether a team
   * must come from expeditions or the legacy Arena constructor. */
  requiredKind?: ArenaTeamRecord["kind"] | null;
}

interface NormalizedTeamRules {
  minSize: number;
  maxSize: number;
  levelCap: number;
  uniformLevel: number | null;
  bannedSpecies: Set<string>;
  bannedMoves: Set<string>;
  bannedItems: Set<string>;
  requiredKind: ArenaTeamRecord["kind"] | null;
}

export type ArenaTeamValidation =
  | { ok: true; errors: [] }
  | { ok: false; errors: string[] };

const SOURCE_DB = validateBattleDb(battleDbJson);
const RULES_DB = battleDbToTuxemonBattleDb(SOURCE_DB);
const HEX_SEED = /^[0-9a-fA-F]{64}$/;
const LOWER_HEX = /^[0-9a-f]{64}$/;
export const MAX_ARENA_PROVENANCE_EVENTS = 65_536;

export const DEFAULT_ARENA_TEAM_RULES: Readonly<Required<ArenaTeamRules>> = Object.freeze({
  minSize: 1,
  maxSize: 5,
  levelCap: SOURCE_DB.rules.levelRange[1],
  uniformLevel: null,
  bannedSpecies: Object.freeze([] as string[]),
  bannedMoves: Object.freeze([] as string[]),
  bannedItems: Object.freeze([] as string[]),
  requiredKind: null,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function exactObject(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = new Set(allowed);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) return false;
  return ownKeys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return keys.has(key as string) && descriptor?.enumerable === true && "value" in descriptor;
  }) && required.every((key) => Object.hasOwn(value, key));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function recordSeed(seed: string, seq: number): number {
  const digest = sha256Bytes(utf8Encode(`pocket-tuxemon/arena-team/v1\n${seq}\n${seed.toLowerCase()}`));
  return Number.parseInt(digest.slice(0, 8), 16) >>> 0;
}

function expeditionProvenanceHash(provenance: readonly ArenaProvenanceEvent[]): string {
  return sha256Bytes(utf8Encode(
    `pocket-tuxemon/arena-team/expedition-v1\n${canonicalJson(provenance)}\n`,
  ));
}

function originExperienceModifier(origin: ArenaExpeditionOrigin | null | undefined): number {
  if (!origin) return 0;
  return origin.capture.result === "caught" ? origin.experienceModifier ?? 1 : 1;
}

/** Reapply the acquisition XP rate only in progression-bearing expedition
 * battles. Callers must validate the record before trusting this projection. */
export function arenaTeamExperienceModifier(record: ArenaTeamRecord): number {
  const acquisition = record.provenance[0];
  return acquisition?.type === "acquire"
    ? originExperienceModifier(acquisition.origin)
    : 0;
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
    "requiredKind",
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
  const requiredKind = source.requiredKind ?? DEFAULT_ARENA_TEAM_RULES.requiredKind;
  if (requiredKind !== null && requiredKind !== "legacy" && requiredKind !== "expedition") {
    errors.push("team rules requiredKind must be null, 'legacy', or 'expedition'");
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
    requiredKind: requiredKind === "legacy" || requiredKind === "expedition" ? requiredKind : null,
  };
}

function levelFloor(level: number): number {
  const experience = SOURCE_DB.rules.experience.groups.default!;
  return Math.trunc(experience.multiplier * level ** experience.experienceCoefficient);
}

function recalculate(
  snapshot: SpawnedMonsterSnapshot,
  level = snapshot.level,
  resetExperience = false,
): void {
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
  if (resetExperience) snapshot.totalExperience = levelFloor(level);
}

interface ProgressionAudit {
  levels: number[];
  learns: Array<{ move: string; forget?: string }>;
}

/** Apply the same level thresholds and default first-slot move replacement as
 * the production progression reducer, while retaining partial experience for
 * the persistent Arena record. */
function applyExperience(
  snapshot: SpawnedMonsterSnapshot,
  amount: number,
  levelCap: number,
): ProgressionAudit {
  const currentExperience = snapshot.totalExperience ?? levelFloor(snapshot.level);
  const effectiveAmount = Math.trunc(amount * (snapshot.experienceModifier ?? 1));
  if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(effectiveAmount) ||
      effectiveAmount <= 0 || !Number.isSafeInteger(currentExperience + effectiveAmount)) {
    throw new Error("experience amount must be a positive safe integer");
  }
  snapshot.totalExperience = currentExperience + effectiveAmount;
  const oldLevel = snapshot.level;
  while (snapshot.level < levelCap && snapshot.totalExperience >= levelFloor(snapshot.level + 1)) {
    snapshot.level++;
  }
  const levels = Array.from({ length: snapshot.level - oldLevel }, (_, index) => oldLevel + index + 1);
  if (levels.length > 0) recalculate(snapshot, snapshot.level);

  const schedule = RULES_DB.monster[snapshot.slug]!.moveset;
  const learned: string[] = [];
  for (const entry of schedule) {
    if (entry.level_learned <= oldLevel || entry.level_learned > snapshot.level) continue;
    const first = schedule.find((candidate) => candidate.technique === entry.technique)!;
    if (first.learning_method !== "level_up" || first.level_learned > snapshot.level ||
        (first.evolution_stage_learned !== undefined && first.evolution_stage_learned !== snapshot.stage) ||
        snapshot.moves.includes(entry.technique)) continue;
    snapshot.moves.push(entry.technique);
    learned.push(entry.technique);
  }
  const forgotten: string[] = [];
  while (snapshot.moves.length > SOURCE_DB.rules.maxMoves) {
    forgotten.push(snapshot.moves.shift()!);
  }
  const forgetOffset = learned.length - forgotten.length;
  return {
    levels,
    learns: learned.map((move, index) => ({
      move,
      ...(index < forgetOffset ? {} : { forget: forgotten[index - forgetOffset]! }),
    })),
  };
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
  expedition: boolean,
): { learns: Array<{ move: string; forget?: string }>; experienceItem: string | null } {
  if (
    typeof itemSlug !== "string" ||
    !Object.hasOwn(SOURCE_DB.items, itemSlug) ||
    !Object.hasOwn(RULES_DB.item, itemSlug)
  ) {
    errors.push(`${label} names an unknown item`);
    return { learns: [], experienceItem: null };
  }
  const item = RULES_DB.item[itemSlug]!;
  const persistent = item.effects.some((effect) => effect.type === "give_tp" || effect.type === "learn_tm");
  const extension = { ...initialTuxemonExtensionState(), party: [clone(snapshot)] };
  if (persistent) {
    const eligibility = worldItemTargetEligibility(
      SOURCE_DB,
      extension,
      createSwitchState({ items: { [itemSlug]: 1 } }),
      itemSlug,
      0,
    );
    if (!eligibility.eligible) {
      errors.push(`${label} cannot apply item '${itemSlug}' to this monster`);
      return { learns: [], experienceItem: null };
    }
  }
  if (rules.bannedItems.has(itemSlug)) {
    errors.push(`${label} uses banned item '${itemSlug}'`);
    return { learns: [], experienceItem: null };
  }
  const allowed = expedition
    ? new Set(["give_tp", "learn_tm", "gain_xp", "heal", "restore"])
    : new Set(["give_tp", "learn_tm"]);
  if (item.effects.length === 0 || item.effects.some((effect) =>
    !allowed.has(effect.type)
  )) {
    errors.push(`${label} item '${itemSlug}' has no supported persistent Arena effect`);
    return { learns: [], experienceItem: null };
  }
  const hasTm = item.effects.some((effect) => effect.type === "learn_tm");
  if (!hasTm && forget !== undefined) {
    errors.push(`${label} cannot forget a move for non-TM item '${itemSlug}'`);
    return { learns: [], experienceItem: null };
  }
  const learns: Array<{ move: string; forget?: string }> = [];
  let experienceItem: string | null = null;
  for (const effect of item.effects) {
    if (effect.type === "learn_tm") {
      const before = errors.length;
      const move = effect.parameters[0];
      if (learnMove(snapshot, move, forget, label, errors) && errors.length === before) {
        learns.push({
          move: move!,
          ...(forget === undefined ? {} : { forget: forget as string }),
        });
      }
      continue;
    }
    if (effect.type === "gain_xp") {
      experienceItem = itemSlug;
      continue;
    }
    if (effect.type === "heal" || effect.type === "restore") continue;
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
  return { learns, experienceItem };
}

interface RebuiltTeam {
  errors: string[];
  snapshots: SpawnedMonsterSnapshot[];
}

function validStep(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function expeditionOrigin(
  value: unknown,
  species: string,
  level: number,
  label: string,
  errors: string[],
): ArenaExpeditionOrigin | null {
  if (!isRecord(value) || !exactObject(value, ["kind", "area", "step", "experienceModifier", "capture"], [
    "kind", "area", "step", "capture",
  ]) || value.kind !== "expedition" || typeof value.area !== "string" ||
      !Object.hasOwn(SOURCE_DB.encounters, value.area) || !validStep(value.step) ||
      !isRecord(value.capture)) {
    errors.push(`${label} must be a valid expedition origin`);
    return null;
  }
  const capture = value.capture;
  if (capture.result === "starter") {
    if (!exactObject(capture, ["result"], ["result"]) || value.step !== 0 ||
        value.experienceModifier !== undefined) {
      errors.push(`${label} starter origin must be issued at step zero`);
      return null;
    }
  } else if (capture.result === "caught") {
    if (!exactObject(capture, ["result", "item", "success", "shakes", "status"], [
      "result", "item", "success", "shakes", "status",
    ]) || typeof capture.item !== "string" || capture.success !== true ||
        !Number.isSafeInteger(capture.shakes) || (capture.shakes as number) < 1 ||
        capture.shakes !== Number(RULES_DB.capture.total_shakes) || value.step === 0 ||
        (capture.status !== null && (typeof capture.status !== "string" ||
          !Object.hasOwn(RULES_DB.status, capture.status) ||
          RULES_DB.status[capture.status]!.behaviors?.persists_after_combat !== true))) {
      errors.push(`${label} caught origin has an invalid capture result`);
      return null;
    }
    const item = RULES_DB.item[capture.item];
    if (!item || !item.effects.some((effect) =>
      effect.type === "capture" || effect.type === "capture_combined"
    )) {
      errors.push(`${label} caught origin names a non-capture item`);
      return null;
    }
    const hasModifier = Object.hasOwn(value, "experienceModifier");
    const modifier = value.experienceModifier;
    if (hasModifier && (typeof modifier !== "number" || !Number.isFinite(modifier) || modifier <= 0)) {
      errors.push(`${label}.experienceModifier must be a positive finite encounter multiplier`);
      return null;
    }
    const rows = SOURCE_DB.encounters[value.area]!.monsters;
    if (!rows.some((row) => row.monster === species && level >= row.level[0] && level <= row.level[1] &&
        (!hasModifier || row.experienceModifier === modifier))) {
      errors.push(`${label} species, level, and experience modifier do not occur in the recorded area`);
      return null;
    }
  } else {
    errors.push(`${label} capture result is unknown`);
    return null;
  }
  return clone(value as unknown as ArenaExpeditionOrigin);
}

interface ExperienceSourceReward {
  amount: number;
  trainingPoints: StatName[];
  bond: number;
}

function experienceSourceReward(
  snapshot: SpawnedMonsterSnapshot,
  value: unknown,
  label: string,
  errors: string[],
): ExperienceSourceReward | null {
  if (!isRecord(value) || typeof value.kind !== "string") {
    errors.push(`${label} has an invalid source`);
    return null;
  }
  if (value.kind === "item" && exactObject(value, ["kind", "item"], ["kind", "item"])) {
    if (typeof value.item !== "string" || !Object.hasOwn(RULES_DB.item, value.item)) {
      errors.push(`${label} names an unknown experience item`);
      return null;
    }
    const effects = RULES_DB.item[value.item]!.effects.filter((effect) => effect.type === "gain_xp");
    const amount = effects.reduce((sum, effect) => sum + Number(effect.parameters[0] ?? 0), 0);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      errors.push(`${label} item has no positive experience effect`);
      return null;
    }
    return { amount, trainingPoints: [], bond: 0 };
  }
  if (value.kind === "battle" && exactObject(value, [
    "kind", "area", "species", "level", "experienceModifier", "participants",
    "opponentSeed", "opponentSeq", "trainingPoints",
  ], [
    "kind", "area", "species", "level", "experienceModifier", "participants",
    "opponentSeed", "opponentSeq", "trainingPoints",
  ])) {
    if (typeof value.area !== "string" || !Object.hasOwn(SOURCE_DB.encounters, value.area) ||
        typeof value.species !== "string" || !Object.hasOwn(SOURCE_DB.monsters, value.species) ||
        !Number.isSafeInteger(value.level) || (value.level as number) <= 0 ||
        typeof value.experienceModifier !== "number" || !Number.isFinite(value.experienceModifier) ||
        value.experienceModifier <= 0 || !Number.isSafeInteger(value.participants) ||
        (value.participants as number) <= 0 || (value.participants as number) > 6 ||
        typeof value.opponentSeed !== "string" || !HEX_SEED.test(value.opponentSeed) ||
        !Number.isSafeInteger(value.opponentSeq) || (value.opponentSeq as number) < 1 ||
        !Array.isArray(value.trainingPoints) || value.trainingPoints.some((stat) =>
          typeof stat !== "string" || !STAT_NAMES.includes(stat as StatName))) {
      errors.push(`${label} has invalid battle reward fields`);
      return null;
    }
    const row = SOURCE_DB.encounters[value.area]!.monsters.find((candidate) =>
      candidate.monster === value.species && (value.level as number) >= candidate.level[0] &&
      (value.level as number) <= candidate.level[1] &&
      candidate.experienceModifier === value.experienceModifier
    );
    if (!row) {
      errors.push(`${label} does not match a real encounter row`);
      return null;
    }
    const opponentRng: RngState = {
      rng: recordSeed(value.opponentSeed, value.opponentSeq as number),
      rngDraws: 0,
    };
    const opponent = spawnMonster(
      SOURCE_DB,
      RULES_DB,
      opponentRng,
      value.species,
      value.level as number,
      { experienceModifier: value.experienceModifier, moneyModifier: 0 },
    );
    const trainingPoints: StatName[] = [];
    const training = clone(snapshot.trainingPoints!);
    for (const stat of STAT_NAMES) {
      if (opponent.base[stat] <= snapshot.base[stat]) continue;
      const total = STAT_NAMES.reduce((sum, name) => sum + training[name]!, 0);
      if (total >= SOURCE_DB.rules.trainingPoints.maxTotal ||
          training[stat]! >= SOURCE_DB.rules.trainingPoints.maxPerStat) continue;
      training[stat]!++;
      trainingPoints.push(stat);
    }
    if (JSON.stringify(value.trainingPoints) !== JSON.stringify(trainingPoints)) {
      errors.push(`${label}.trainingPoints does not match the real battle reward`);
      return null;
    }
    const amount = calculateDefeatExperience(
      RULES_DB,
      {
        level: value.level as number,
        totalExperience: levelFloor(value.level as number),
        experienceModifier: value.experienceModifier,
      },
      { level: snapshot.level, acquisition: "captured" },
      value.participants as number,
    );
    return { amount, trainingPoints, bond: 3 };
  }
  errors.push(`${label} has an unknown source or fields`);
  return null;
}

function applyExperienceSourceReward(
  snapshot: SpawnedMonsterSnapshot,
  reward: ExperienceSourceReward,
): void {
  if (reward.trainingPoints.length > 0) {
    for (const stat of reward.trainingPoints) snapshot.trainingPoints![stat]!++;
    recalculate(snapshot);
  }
  snapshot.bond = Math.min(100, (snapshot.bond ?? 25) + reward.bond);
}

function applyRewardProgression(
  snapshot: SpawnedMonsterSnapshot,
  reward: ExperienceSourceReward,
  levelCap: number,
): ProgressionAudit {
  applyExperienceSourceReward(snapshot, reward);
  return reward.amount === 0
    ? { levels: [], learns: [] }
    : applyExperience(snapshot, reward.amount, levelCap);
}

function rebuildTeam(records: unknown, rulesValue: unknown, compareClaims = true): RebuiltTeam {
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
    if (!isRecord(rawRecord) || !exactObject(rawRecord, [
      "kind", "species", "level", "moves", "experience", "bond", "provenanceHash", "provenance",
    ], [
      "kind", "species", "level", "moves", "provenance",
    ])) {
      errors.push(`${prefix} must contain only kind, species, level, moves, optional experience, bond, provenanceHash, and provenance`);
      continue;
    }
    if (rawRecord.kind !== "legacy" && rawRecord.kind !== "expedition") {
      errors.push(`${prefix}.kind must be 'legacy' or 'expedition'`);
      continue;
    }
    if (rules.requiredKind !== null && rawRecord.kind !== rules.requiredKind) {
      errors.push(`${prefix}.kind must be '${rules.requiredKind}' for this storage class`);
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
        rawRecord.provenance.length > MAX_ARENA_PROVENANCE_EVENTS) {
      errors.push(`${prefix}.provenance must contain 1..${MAX_ARENA_PROVENANCE_EVENTS} events`);
      continue;
    }
    const first = rawRecord.provenance[0];
    if (!isRecord(first) || first.type !== "acquire" || !exactObject(first,
      ["seq", "type", "seed", "species", "level", "origin"], ["seq", "type", "seed", "species", "level"])) {
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
    const origin = first.origin === undefined
      ? null
      : expeditionOrigin(
        first.origin,
        rawRecord.species,
        first.level as number,
        `${prefix}.provenance[0].origin`,
        errors,
      );
    if (rawRecord.kind === "expedition" && !origin) {
      errors.push(`${prefix}.kind expedition requires an expedition origin`);
    }
    if (rawRecord.kind === "legacy" && first.origin !== undefined) {
      errors.push(`${prefix}.kind legacy cannot contain an expedition origin`);
    }
    if (origin) {
      snapshot.experienceModifier = originExperienceModifier(origin);
    }
    if (origin?.capture.result === "caught") {
      const item = RULES_DB.item[origin.capture.item]!;
      const combined = item.effects.some((effect) => effect.type === "capture_combined");
      const config = RULES_DB.capture_devices.items[origin.capture.item];
      snapshot.acquisition = "captured";
      snapshot.captureDevice = origin.capture.item;
      snapshot.bond = 25;
      if (!combined && config) {
        try {
          applyCaptureDeviceEffects(config, snapshot);
        } catch (error) {
          errors.push(`${prefix}.provenance[0].origin capture effect failed: ${
            error instanceof Error ? error.message : String(error)
          }`);
        }
      }
    }
    if (compareClaims && origin) {
      const expectedHash = expeditionProvenanceHash(rawRecord.provenance as ArenaProvenanceEvent[]);
      if (typeof rawRecord.provenanceHash !== "string" || !LOWER_HEX.test(rawRecord.provenanceHash) ||
          rawRecord.provenanceHash !== expectedHash) {
        errors.push(`${prefix}.provenanceHash does not match the expedition provenance`);
      }
    } else if (compareClaims && rawRecord.provenanceHash !== undefined) {
      errors.push(`${prefix}.provenanceHash requires a valid expedition origin`);
    }
    let previousSeq = first.seq as number;
    let previousStep = origin?.step ?? 0;
    let previousRootStep = origin?.step ?? 0;
    let expectedAudits: Array<
      | { type: "level"; level: number; step: number }
      | { type: "learn"; move: string; forget?: string; step: number }
    > = [];
    let pendingExperienceItem: { item: string; step: number } | null = null;
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

      const eventStep = rawEvent.step;
      if (origin) {
        if (!validStep(eventStep) || (eventStep as number) < previousStep) {
          errors.push(`${label}.step must be a nondecreasing expedition step`);
          continue;
        }
        previousStep = eventStep as number;
      } else if (eventStep !== undefined) {
        errors.push(`${label}.step requires an expedition acquisition`);
        continue;
      }

      if (expectedAudits.length > 0) {
        const expected = expectedAudits.shift()!;
        if (expected.type === "level" && rawEvent.type === "level" && exactObject(
          rawEvent, ["seq", "type", "level", "step"], ["seq", "type", "level", "step"],
        ) && rawEvent.level === expected.level && rawEvent.step === expected.step) {
          continue;
        }
        if (expected.type === "learn" && rawEvent.type === "learn" && exactObject(
          rawEvent, ["seq", "type", "move", "forget", "step"], ["seq", "type", "move", "step"],
        ) && rawEvent.move === expected.move && rawEvent.forget === expected.forget &&
            rawEvent.step === expected.step) {
          continue;
        }
        errors.push(`${label} does not match the derived ${expected.type} audit`);
        continue;
      }
      if (pendingExperienceItem && rawEvent.type !== "experience") {
        errors.push(`${label} must settle experience item '${pendingExperienceItem.item}' first`);
        continue;
      }

      if (rawEvent.type === "experience" && exactObject(
        rawEvent, ["seq", "type", "step", "amount", "source"], ["seq", "type", "step", "amount", "source"],
      )) {
        if (!origin) {
          errors.push(`${label} requires an expedition acquisition`);
          continue;
        }
        const settlesExperienceItem = pendingExperienceItem !== null;
        if (!settlesExperienceItem && (rawEvent.step as number) <= previousRootStep) {
          errors.push(`${label}.step must be newer than the preceding expedition transaction`);
          continue;
        }
        const reward = experienceSourceReward(snapshot, rawEvent.source, `${label}.source`, errors);
        if (!Number.isSafeInteger(rawEvent.amount) || (rawEvent.amount as number) < 0 ||
            reward === null || rawEvent.amount !== reward.amount) {
          errors.push(`${label}.amount does not match its real game-data source`);
          continue;
        }
        if (pendingExperienceItem) {
          const source = isRecord(rawEvent.source) ? rawEvent.source : {};
          if (source.kind !== "item" || source.item !== pendingExperienceItem.item ||
              rawEvent.step !== pendingExperienceItem.step) {
            errors.push(`${label} does not settle the preceding experience item`);
            continue;
          }
          pendingExperienceItem = null;
        } else if (isRecord(rawEvent.source) && rawEvent.source.kind === "item") {
          errors.push(`${label} has no preceding item consumption`);
          continue;
        }
        if (!settlesExperienceItem) previousRootStep = rawEvent.step as number;
        try {
          const progression = applyRewardProgression(snapshot, reward, rules.levelCap);
          expectedAudits = [
            ...progression.levels.map((level) => ({
              type: "level" as const,
              level,
              step: rawEvent.step as number,
            })),
            ...progression.learns.map((learn) => ({
              type: "learn" as const,
              ...learn,
              step: rawEvent.step as number,
            })),
          ];
        } catch (error) {
          errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else if (rawEvent.type === "level" && exactObject(
        rawEvent, ["seq", "type", "level"], ["seq", "type", "level"],
      )) {
        if (origin) {
          errors.push(`${label} is not caused by a preceding experience event`);
          continue;
        }
        if (!Number.isSafeInteger(rawEvent.level) || rawEvent.level !== snapshot.level + 1 ||
            (rawEvent.level as number) > rules.levelCap) {
          errors.push(`${label} must advance exactly one level without exceeding levelCap`);
        } else recalculate(snapshot, rawEvent.level as number, true);
      } else if (rawEvent.type === "learn" && exactObject(
        rawEvent, ["seq", "type", "move", "forget"], ["seq", "type", "move"],
      )) {
        if (origin) {
          errors.push(`${label} is not caused by a preceding progression event`);
          continue;
        }
        if (typeof rawEvent.move !== "string" || !moveIsLevelEligible(snapshot, rawEvent.move)) {
          errors.push(`${label} move is not level-eligible for this species`);
        } else learnMove(snapshot, rawEvent.move, rawEvent.forget, label, errors);
      } else if (rawEvent.type === "item" && exactObject(
        rawEvent, ["seq", "type", "item", "forget", "step"],
        origin ? ["seq", "type", "item", "step"] : ["seq", "type", "item"],
      )) {
        if (origin && (rawEvent.step as number) <= previousRootStep) {
          errors.push(`${label}.step must be newer than the preceding expedition transaction`);
          continue;
        }
        const applied = applyItem(snapshot, rawEvent.item, rawEvent.forget, rules, label, errors, origin !== null);
        if (origin) {
          previousRootStep = rawEvent.step as number;
          expectedAudits = applied.learns.map((learn) => ({
            type: "learn" as const,
            ...learn,
            step: rawEvent.step as number,
          }));
          if (applied.experienceItem) {
            pendingExperienceItem = { item: applied.experienceItem, step: rawEvent.step as number };
          }
        }
      } else {
        errors.push(`${label} has an unknown type or fields`);
      }
    }
    if (expectedAudits.length > 0) {
      errors.push(`${prefix}.provenance is missing ${expectedAudits.length} derived progression audit(s)`);
    }
    if (pendingExperienceItem) {
      errors.push(`${prefix}.provenance does not settle experience item '${pendingExperienceItem.item}'`);
    }
    if (rules.bannedSpecies.has(snapshot.slug)) errors.push(`${prefix} uses banned species '${snapshot.slug}'`);
    for (const move of snapshot.moves) {
      if (rules.bannedMoves.has(move)) errors.push(`${prefix} uses banned move '${move}'`);
    }
    if (compareClaims && rawRecord.level !== snapshot.level) {
      errors.push(`${prefix}.level does not match the provenance-derived level ${snapshot.level}`);
    }
    if (compareClaims && JSON.stringify(rawRecord.moves) !== JSON.stringify(snapshot.moves)) {
      errors.push(`${prefix}.moves do not match the provenance-derived move list`);
    }
    if (compareClaims && origin && (!Number.isSafeInteger(rawRecord.experience) ||
        rawRecord.experience !== snapshot.totalExperience)) {
      errors.push(`${prefix}.experience does not match the provenance-derived total ${snapshot.totalExperience}`);
    } else if (compareClaims && rawRecord.experience !== undefined &&
        rawRecord.experience !== snapshot.totalExperience) {
      errors.push(`${prefix}.experience does not match the provenance-derived total ${snapshot.totalExperience}`);
    }
    if (compareClaims && origin && (!Number.isSafeInteger(rawRecord.bond) || rawRecord.bond !== snapshot.bond)) {
      errors.push(`${prefix}.bond does not match the provenance-derived bond ${snapshot.bond}`);
    } else if (compareClaims && !origin && rawRecord.bond !== undefined) {
      errors.push(`${prefix}.bond is only valid for expedition records`);
    }
    if (rules.uniformLevel !== null) recalculate(snapshot, rules.uniformLevel);
    snapshots.push(snapshot);
  }
  return { errors, snapshots };
}

/** Validate without trusting any record-carried combat value. */
export function validateTeam(records: unknown, rules: ArenaTeamRules = {}): ArenaTeamValidation {
  try {
    const rebuilt = rebuildTeam(records, rules);
    return rebuilt.errors.length === 0
      ? { ok: true, errors: [] }
      : { ok: false, errors: rebuilt.errors };
  } catch {
    return { ok: false, errors: ["team must be bounded canonical JSON"] };
  }
}

/** Validate the match rule object independently before accepting a config. */
export function validateTeamRules(rules: unknown): ArenaTeamValidation {
  const errors: string[] = [];
  normalizeRules(rules, errors);
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

/** Materialize the caller-visible claims from a validated provenance log.
 * Expedition reducers use this after appending authoritative events; external
 * callers should still use validateTeam on records loaded from their own
 * authenticated storage. */
export function arenaTeamRecordFromProvenance(
  species: string,
  provenance: ArenaProvenanceEvent[],
  rules: ArenaTeamRules = {},
): ArenaTeamRecord {
  const rebuilt = rebuildTeam([{
    kind: provenance[0]?.type === "acquire" && provenance[0].origin !== undefined ? "expedition" : "legacy",
    species,
    level: 1,
    moves: [],
    experience: 0,
    provenance: clone(provenance),
  }], {
    ...rules,
    minSize: 1,
    maxSize: 1,
    uniformLevel: null,
  }, false);
  if (rebuilt.errors.length > 0 || rebuilt.snapshots.length !== 1) {
    throw new Error(`arena provenance rejected: ${rebuilt.errors.join("; ")}`);
  }
  const snapshot = rebuilt.snapshots[0]!;
  const expedition = provenance[0]?.type === "acquire" && provenance[0].origin !== undefined;
  return {
    kind: expedition ? "expedition" : "legacy",
    species: snapshot.slug,
    level: snapshot.level,
    moves: [...snapshot.moves],
    experience: snapshot.totalExperience,
    ...(expedition ? { bond: snapshot.bond } : {}),
    ...(expedition ? { provenanceHash: expeditionProvenanceHash(provenance) } : {}),
    provenance: clone(provenance),
  };
}

export interface ArenaProvenanceAppendResult {
  record: ArenaTeamRecord;
  nextSeq: number;
}

function checkedAppendStart(
  record: ArenaTeamRecord,
  firstSeq: number,
  rules: ArenaTeamRules,
): { snapshot: SpawnedMonsterSnapshot; provenance: ArenaProvenanceEvent[] } {
  if (!Number.isSafeInteger(firstSeq) || firstSeq < 1) {
    throw new Error("arena provenance sequence must be a positive safe integer");
  }
  const last = record.provenance.at(-1)?.seq ?? 0;
  if (firstSeq <= last) throw new Error("arena provenance sequence must increase");
  const snapshot = buildValidatedArenaTeam([record], {
    ...rules,
    minSize: 1,
    maxSize: 1,
    uniformLevel: null,
  })[0]!;
  return { snapshot, provenance: clone(record.provenance) };
}

/** Append one server-awarded XP transaction and its exact derived audits. */
export function appendArenaExperience(
  record: ArenaTeamRecord,
  event: Omit<ArenaExperienceEvent, "seq">,
  firstSeq: number,
  rules: ArenaTeamRules = {},
): ArenaProvenanceAppendResult {
  const { snapshot, provenance } = checkedAppendStart(record, firstSeq, rules);
  const errors: string[] = [];
  const reward = experienceSourceReward(snapshot, event.source, "experience source", errors);
  if (reward === null || reward.amount !== event.amount || errors.length > 0) {
    throw new Error(`arena experience rejected: ${errors.join("; ") || "amount does not match source"}`);
  }
  const normalized = normalizeRules({ ...rules, minSize: 1, maxSize: 1, uniformLevel: null }, errors);
  const progression = applyRewardProgression(snapshot, reward, normalized.levelCap);
  let seq = firstSeq;
  provenance.push({ ...clone(event), seq: seq++ });
  for (const level of progression.levels) {
    provenance.push({ seq: seq++, type: "level", level, step: event.step });
  }
  for (const learn of progression.learns) {
    provenance.push({ seq: seq++, type: "learn", ...learn, step: event.step });
  }
  return {
    record: arenaTeamRecordFromProvenance(record.species, provenance, rules),
    nextSeq: seq,
  };
}

/** Append one consumed expedition item, including TM or XP-derived audits. */
export function appendArenaItem(
  record: ArenaTeamRecord,
  event: Omit<ArenaItemEvent, "seq"> & { step: number },
  firstSeq: number,
  rules: ArenaTeamRules = {},
): ArenaProvenanceAppendResult {
  const { snapshot, provenance } = checkedAppendStart(record, firstSeq, rules);
  const errors: string[] = [];
  const normalized = normalizeRules({ ...rules, minSize: 1, maxSize: 1, uniformLevel: null }, errors);
  const applied = applyItem(snapshot, event.item, event.forget, normalized, "item", errors, true);
  if (errors.length > 0) throw new Error(`arena item rejected: ${errors.join("; ")}`);
  let seq = firstSeq;
  provenance.push({ seq: seq++, type: "item", item: event.item, step: event.step,
    ...(event.forget === undefined ? {} : { forget: event.forget }) });
  for (const learn of applied.learns) {
    provenance.push({ seq: seq++, type: "learn", ...learn, step: event.step });
  }
  if (applied.experienceItem) {
    const source = { kind: "item" as const, item: applied.experienceItem };
    const reward = experienceSourceReward(snapshot, source, "experience item", errors);
    if (reward === null || errors.length > 0) {
      throw new Error(`arena item rejected: ${errors.join("; ")}`);
    }
    const progression = applyRewardProgression(snapshot, reward, normalized.levelCap);
    provenance.push({ seq: seq++, type: "experience", step: event.step, amount: reward.amount, source });
    for (const level of progression.levels) {
      provenance.push({ seq: seq++, type: "level", level, step: event.step });
    }
    for (const learn of progression.learns) {
      provenance.push({ seq: seq++, type: "learn", ...learn, step: event.step });
    }
  }
  return {
    record: arenaTeamRecordFromProvenance(record.species, provenance, rules),
    nextSeq: seq,
  };
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

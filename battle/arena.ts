/**
 * Deterministic, JSON-only headless battle sessions for external players.
 *
 * The authoritative ArenaBattle deliberately contains private reducer state.
 * Callers hand that value back to submit(); only observe() is a player-facing
 * projection. No observation includes the seed, RNG cursor, reducer queues,
 * reserve monsters belonging to the opponent, or either side's pending action.
 */

import battleDbJson from "../data/battle-db.json";
import battleDbZhJson from "../data/battle-db.zh_CN.json";
import featureModesJson from "../data/feature-modes.json";
import { validateBattleDb, type BattleDb } from "../importer/battle-schema.ts";
import type { TitleBattleData } from "../ui/feature-modes-data.ts";
import { canonicalJson, utf8Encode } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import { sha256Bytes } from "../vendor/pocket-rpgkit/src/engine/map-repository.ts";
import { nextRandom, type RngState } from "./core.ts";
import {
  buildValidatedArenaTeam,
  DEFAULT_ARENA_TEAM_RULES,
  validateTeam,
  validateTeamRules,
  type ArenaProvenanceEvent,
  type ArenaTeamRecord,
  type ArenaTeamRules,
  type ArenaTeamValidation,
} from "./arena-team.ts";
import { battleDbToTuxemonBattleDb } from "./from-battle-db.ts";
import { spawnMonster } from "./spawn.ts";
import {
  canRun,
  canSwap,
  canUseBattleItem,
  createBattle,
  getSide,
  reduceBattleSimultaneous,
  usableMoves,
} from "./tuxemon.ts";
import type {
  BattleMonster,
  TuxemonBattleDecision,
  TuxemonBattleState,
} from "./types.ts";

export const ARENA_VERSION = 1 as const;
export const ARENA_DEADLINE_TICKS = 1_800;
/** One entry is one paired decision window. A double battle needs two windows
 * for a full reducer round. This cap bounds CPU, tape size, and replay work. */
export const ARENA_MAX_TURNS = 2_048;

export const ARENA_DIFFICULTIES = [
  "beginner",
  "easy",
  "normal",
  "hard",
  "expert",
] as const;
export type ArenaDifficulty = (typeof ARENA_DIFFICULTIES)[number];
export type ArenaSide = 0 | 1;
export type ArenaFormat = "single" | "double";

export type ArenaSideConfig =
  | { kind: "agent"; /** Omitted means the normal title recipe. */ difficulty?: ArenaDifficulty }
  | { kind: "agent"; team: ArenaTeamRecord[] }
  | { kind: "ai"; difficulty: ArenaDifficulty };

export {
  DEFAULT_ARENA_TEAM_RULES,
  validateTeam,
  validateTeamRules,
};
export type {
  ArenaProvenanceEvent,
  ArenaTeamRecord,
  ArenaTeamRules,
  ArenaTeamValidation,
};

export interface ArenaConfig {
  seed: string;
  format: ArenaFormat;
  sides: [ArenaSideConfig, ArenaSideConfig];
  /** Optional match-wide limits are recorded into the tape and applied to
   * every persistent team during reconstruction. */
  teamRules?: ArenaTeamRules;
}

export type ArenaAction =
  | { type: "move"; slot: number; target?: number }
  | { type: "swap"; party: number }
  | { type: "item"; item: string; target?: number }
  | { type: "run" };

export type ArenaErrorCode =
  | "INVALID_SIDE"
  | "INVALID_ACTION"
  | "ILLEGAL_ACTION"
  | "ALREADY_SUBMITTED"
  | "SIDE_NOT_AGENT"
  | "BATTLE_OVER";

export type ArenaResultReason = "knockout" | "draw" | "escape" | "capture" | "turn-limit";

export interface ArenaResult {
  winner: ArenaSide | null;
  turns: number;
  reason: ArenaResultReason;
}

export interface ArenaBattle {
  v: typeof ARENA_VERSION;
  seed: string;
  config: ArenaConfig;
  core: TuxemonBattleState;
  /** Paired decision windows already committed. */
  turn: number;
  pending: [ArenaAction | null, ArenaAction | null];
  actions: Array<[ArenaAction, ArenaAction]>;
  /** Actual techniques exposed only after their reducer round resolves. */
  revealedMoves: [Record<string, string[]>, Record<string, string[]>];
  revealEventCursor: number;
  /** Separate, domain-derived policy streams. They never enter observations. */
  policyRng: [number, number];
  terminal: ArenaResult | null;
}

export interface LocalizedArenaName {
  en_US: string;
  zh_CN: string;
}

export interface ArenaObservation {
  v: typeof ARENA_VERSION;
  side: ArenaSide;
  format: ArenaFormat;
  /** Paired decision-window index, starting at zero. */
  turn: number;
  /** Underlying Tuxemon round, starting at one. Doubles may have two decision
   * windows with the same round number. */
  round: number;
  deadlineTicks: number;
  actingParty: number | null;
  own: {
    active: number[];
    party: Array<{
      party: number;
      active: boolean;
      species: { slug: string; displayName: LocalizedArenaName };
      level: number;
      hp: { current: number; max: number; percent: number };
      status: string | null;
      types: string[];
      gender: string;
      base: BattleMonster["base"];
      stages: BattleMonster["stages"];
      moves: Array<{
        slot: number;
        slug: string;
        displayName: LocalizedArenaName;
        cooldown: number;
      }>;
    }>;
  };
  opponent: {
    active: Array<{
      position: number;
      species: { slug: string; displayName: LocalizedArenaName };
      level: number;
      hpPercent: number;
      status: string | null;
      revealedMoves: Array<{ slug: string; displayName: LocalizedArenaName }>;
    }>;
  };
  legalActions: ArenaAction[];
  result: ArenaResult | null;
}

export type ArenaSubmitResult =
  | { ok: true; battle: ArenaBattle; resolved: boolean }
  | { ok: false; battle: ArenaBattle; error: ArenaErrorCode };

export interface ArenaTapeConfig {
  format: ArenaFormat;
  sides: [ArenaSideConfig, ArenaSideConfig];
  teamRules?: ArenaTeamRules;
}

export interface BattleTape {
  v: typeof ARENA_VERSION;
  seed: string;
  config: ArenaTapeConfig;
  actions: Array<[ArenaAction, ArenaAction]>;
}

export type ArenaTapeValidation =
  | { ok: true; tape: BattleTape }
  | { ok: false; error: string };

export class ArenaTapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArenaTapeError";
  }
}

const SOURCE_DB = validateBattleDb(battleDbJson);
const ZH_DB = validateBattleDb(battleDbZhJson);
const RULES_DB = battleDbToTuxemonBattleDb(SOURCE_DB);
const TITLE_DATA = (featureModesJson as unknown as { titleBattle: TitleBattleData }).titleBattle;
const HEX_SEED = /^[0-9a-fA-F]{64}$/;
const DIFFICULTIES = new Set<string>(ARENA_DIFFICULTIES);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const expected = new Set(allowed);
  return Object.keys(value).every((key) => expected.has(key)) &&
    allowed.filter((key) => !optional.includes(key)).every((key) => key in value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeSideConfig(
  value: unknown,
  label: string,
  teamRules: ArenaTeamRules | undefined,
): ArenaSideConfig {
  if (!isRecord(value) || (value.kind !== "agent" && value.kind !== "ai")) {
    throw new Error(`${label}: side must be an agent or ai object`);
  }
  if (value.kind === "ai") {
    if (!exactKeys(value, ["kind", "difficulty"])) {
      throw new Error(`${label}: ai side has unknown or missing fields`);
    }
    if (typeof value.difficulty !== "string" || !DIFFICULTIES.has(value.difficulty)) {
      throw new Error(`${label}: ai difficulty is invalid`);
    }
    return { kind: "ai", difficulty: value.difficulty as ArenaDifficulty };
  }
  if ("team" in value) {
    if (!exactKeys(value, ["kind", "team"])) {
      throw new Error(`${label}: team agent has unknown or missing fields`);
    }
    const checked = validateTeam(value.team, teamRules ?? DEFAULT_ARENA_TEAM_RULES);
    if (!checked.ok) throw new Error(`${label}: ${checked.errors.join("; ")}`);
    return { kind: "agent", team: clone(value.team as ArenaTeamRecord[]) };
  }
  if (!exactKeys(value, ["kind", "difficulty"], ["difficulty"])) {
    throw new Error(`${label}: agent side has unknown or missing fields`);
  }
  if (value.difficulty !== undefined &&
      (typeof value.difficulty !== "string" || !DIFFICULTIES.has(value.difficulty))) {
    throw new Error(`${label}: agent difficulty is invalid`);
  }
  return value.difficulty === undefined
    ? { kind: "agent" }
    : { kind: "agent", difficulty: value.difficulty as ArenaDifficulty };
}

function normalizeConfig(value: unknown): ArenaConfig {
  if (!isRecord(value) || !exactKeys(value, ["seed", "format", "sides", "teamRules"], ["teamRules"])) {
    throw new Error("arena config must contain only seed, format, sides, and optional teamRules");
  }
  if (typeof value.seed !== "string" || !HEX_SEED.test(value.seed)) {
    throw new Error("arena seed must be exactly 64 hexadecimal characters");
  }
  if (value.format !== "single" && value.format !== "double") {
    throw new Error("arena format must be 'single' or 'double'");
  }
  if (!Array.isArray(value.sides) || value.sides.length !== 2) {
    throw new Error("arena config requires exactly two sides");
  }
  const teamRules = value.teamRules === undefined ? undefined : clone(value.teamRules as ArenaTeamRules);
  if (teamRules !== undefined) {
    const checked = validateTeamRules(teamRules);
    if (!checked.ok) throw new Error(`arena config teamRules: ${checked.errors.join("; ")}`);
  }
  return {
    seed: value.seed.toLowerCase(),
    format: value.format,
    sides: [
      normalizeSideConfig(value.sides[0], "arena config sides[0]", teamRules),
      normalizeSideConfig(value.sides[1], "arena config sides[1]", teamRules),
    ],
    ...(teamRules === undefined ? {} : { teamRules }),
  };
}

function domainSeed(seed: string, domain: string): number {
  const digest = sha256Bytes(utf8Encode(`pocket-tuxemon/arena/v1\n${domain}\n${seed}`));
  return Number.parseInt(digest.slice(0, 8), 16) >>> 0;
}

function recipe(config: ArenaSideConfig) {
  const difficulty = config.kind === "ai"
    ? config.difficulty
    : "difficulty" in config ? config.difficulty ?? "normal" : "normal";
  const found = TITLE_DATA.difficulties.find((entry) => entry.id === difficulty);
  if (!found) throw new Error(`arena: missing title recipe '${difficulty}'`);
  return found;
}

function team(
  seed: string,
  side: ArenaSide,
  config: ArenaSideConfig,
  teamRules: ArenaTeamRules | undefined,
) {
  if (config.kind === "agent" && "team" in config) {
    return buildValidatedArenaTeam(config.team, teamRules ?? DEFAULT_ARENA_TEAM_RULES);
  }
  const selected = recipe(config);
  const rng: RngState = { rng: domainSeed(seed, `team:${side}`), rngDraws: 0 };
  return Array.from({ length: selected.partySize }, (_, slot) => {
    const slug = selected.candidates[Math.floor(nextRandom(rng) * selected.candidates.length)]!;
    return spawnMonster(SOURCE_DB, RULES_DB, rng, slug, selected.level, {
      iid: `arena-${side}-${slot}`,
      experienceModifier: 0,
      moneyModifier: 0,
    });
  });
}

function displayName(table: BattleDb, kind: "monster" | "technique" | "item", slug: string): string {
  if (kind === "monster") return table.monsters[slug]?.name ?? slug;
  if (kind === "technique") return table.techniques[slug]?.name ?? slug;
  return table.items[slug]?.name ?? slug;
}

function localizedName(kind: "monster" | "technique" | "item", slug: string): LocalizedArenaName {
  return {
    en_US: displayName(SOURCE_DB, kind, slug),
    zh_CN: displayName(ZH_DB, kind, slug),
  };
}

function hpPercent(monster: BattleMonster): number {
  return monster.base.hp > 0
    ? Math.max(0, Math.min(100, Math.round(monster.currentHp * 100 / monster.base.hp)))
    : 0;
}

function actorUid(state: TuxemonBattleState, side: ArenaSide): number | null {
  return state.decisionQueue.find((uid) => getSide(state, uid) === side) ?? null;
}

function activeUids(state: TuxemonBattleState, side: ArenaSide): number[] {
  return state.field.filter((uid) => getSide(state, uid) === side);
}

function legalMoveRows(state: TuxemonBattleState, side: ArenaSide): Array<{
  action: ArenaAction;
  choice: number;
}> {
  const uid = actorUid(state, side);
  if (uid === null) return [];
  const actor = state.parties[side].find((monster) => monster.uid === uid)!;
  const opponents = activeUids(state, side === 0 ? 1 : 0)
    .map((targetUid) => state.parties[side === 0 ? 1 : 0].find((monster) => monster.uid === targetUid)!);
  const rows: Array<{ action: ArenaAction; choice: number }> = [];
  let choice = 0;
  for (const [slot, move] of actor.moves.entries()) {
    for (const [target, monster] of opponents.entries()) {
      if (move.cooldown !== 0 || !usableMoves(RULES_DB, actor, monster).some((entry) => entry.moveIndex === slot)) {
        continue;
      }
      rows.push({
        action: opponents.length > 1
          ? { type: "move", slot, target }
          : { type: "move", slot },
        choice: choice++,
      });
    }
  }
  // The reducer uses the monster's fallback technique when no move/target
  // candidate is ready. Slot zero is the protocol's deterministic forced-move
  // token; decisionAction ignores its choice when the candidate list is empty.
  if (rows.length === 0 && opponents.length > 0) {
    rows.push({ action: { type: "move", slot: 0 }, choice: 0 });
  }
  return rows;
}

function legalActions(state: TuxemonBattleState, side: ArenaSide): ArenaAction[] {
  if (state.phase === "ended") return [];
  const uid = actorUid(state, side);
  if (uid === null) return [];
  const result = legalMoveRows(state, side).map((row) => row.action);
  for (const [party, monster] of state.parties[side].entries()) {
    if (canSwap(state, uid, monster.uid)) result.push({ type: "swap", party });
  }
  for (const item of Object.keys(state.inventory).sort()) {
    if ((state.inventory[item] ?? 0) <= 0) continue;
    for (const [target, monster] of state.parties[side].entries()) {
      if (canUseBattleItem(RULES_DB, state, item, monster.uid, false, "MainCombatMenuState", side)) {
        result.push({ type: "item", item, target });
      }
    }
  }
  if (canRun(state, uid)) result.push({ type: "run" });
  return result;
}

function validActionShape(value: unknown): value is ArenaAction {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  const targetOk = value.target === undefined ||
    (Number.isSafeInteger(value.target) && (value.target as number) >= 0);
  if (value.type === "move") {
    return exactKeys(value, ["type", "slot", "target"], ["target"]) && Number.isSafeInteger(value.slot) &&
      (value.slot as number) >= 0 && (value.slot as number) <= 3 && targetOk;
  }
  if (value.type === "swap") {
    return exactKeys(value, ["type", "party"]) && Number.isSafeInteger(value.party) &&
      (value.party as number) >= 0;
  }
  if (value.type === "item") {
    return exactKeys(value, ["type", "item", "target"], ["target"]) && typeof value.item === "string" &&
      value.item.length > 0 && targetOk;
  }
  return value.type === "run" && exactKeys(value, ["type"]);
}

function actionEqual(left: ArenaAction, right: ArenaAction): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "run" && right.type === "run") return true;
  if (left.type === "swap" && right.type === "swap") return left.party === right.party;
  if (left.type === "move" && right.type === "move") {
    return left.slot === right.slot && left.target === right.target;
  }
  return left.type === "item" && right.type === "item" &&
    left.item === right.item && left.target === right.target;
}

function decisionForAction(
  state: TuxemonBattleState,
  side: ArenaSide,
  action: ArenaAction,
): TuxemonBattleDecision {
  const uid = actorUid(state, side);
  if (uid === null) throw new Error(`arena: side ${side} has no actor`);
  if (action.type === "move") {
    const row = legalMoveRows(state, side).find((entry) => actionEqual(entry.action, action));
    if (!row) throw new Error(`arena: side ${side} move disappeared`);
    return { type: "technique", choice: row.choice };
  }
  if (action.type === "swap") {
    const target = state.parties[side][action.party];
    if (!target) throw new Error(`arena: side ${side} swap target disappeared`);
    return { type: "replacement", uid: target.uid };
  }
  if (action.type === "item") {
    const target = state.parties[side][action.target ?? 0];
    if (!target) throw new Error(`arena: side ${side} item target disappeared`);
    return { type: "item", item: action.item, target: target.uid };
  }
  return { type: "run" };
}

function resultFromCore(battle: ArenaBattle, core: TuxemonBattleState): ArenaResult | null {
  if (core.phase !== "ended") return null;
  const outcome = core.outcome;
  if (outcome === "won") return { winner: 0, turns: battle.turn, reason: "knockout" };
  if (outcome === "lost") return { winner: 1, turns: battle.turn, reason: "knockout" };
  if (outcome === "ran") return { winner: 1, turns: battle.turn, reason: "escape" };
  if (outcome === "captured") return { winner: 0, turns: battle.turn, reason: "capture" };
  return { winner: null, turns: battle.turn, reason: "draw" };
}

function revealResolvedMoves(battle: ArenaBattle, core: TuxemonBattleState) {
  const revealed = [
    Object.fromEntries(Object.entries(battle.revealedMoves[0]).map(([uid, moves]) => [uid, [...moves]])),
    Object.fromEntries(Object.entries(battle.revealedMoves[1]).map(([uid, moves]) => [uid, [...moves]])),
  ] as ArenaBattle["revealedMoves"];
  for (const event of core.events.slice(battle.revealEventCursor)) {
    if (event.type !== "decision" || (event.side !== 0 && event.side !== 1) ||
        typeof event.user !== "number" || typeof event.technique !== "string") continue;
    const key = String(event.user);
    const moves = revealed[event.side][key] ?? (revealed[event.side][key] = []);
    if (!moves.includes(event.technique)) moves.push(event.technique);
  }
  return revealed;
}

function settlePair(battle: ArenaBattle): ArenaBattle {
  const pair = battle.pending;
  if (!pair[0] || !pair[1]) return battle;
  const beforeRound = battle.core.turn;
  const decisions: [TuxemonBattleDecision, TuxemonBattleDecision] = [
    decisionForAction(battle.core, 0, pair[0]),
    decisionForAction(battle.core, 1, pair[1]),
  ];
  const core = reduceBattleSimultaneous(RULES_DB, battle.core, decisions);
  const turn = battle.turn + 1;
  const roundResolved = core.phase === "ended" || core.turn !== beforeRound;
  const next: ArenaBattle = {
    ...battle,
    core,
    turn,
    pending: [null, null],
    actions: [...battle.actions, [clone(pair[0]), clone(pair[1])]],
    revealedMoves: roundResolved ? revealResolvedMoves(battle, core) : battle.revealedMoves,
    revealEventCursor: roundResolved ? core.events.length : battle.revealEventCursor,
    terminal: null,
  };
  next.terminal = resultFromCore(next, core) ?? (turn >= ARENA_MAX_TURNS
    ? { winner: null, turns: turn, reason: "turn-limit" }
    : null);
  return next;
}

function chooseAi(battle: ArenaBattle, side: ArenaSide): { action: ArenaAction; cursor: number } {
  const actions = legalActions(battle.core, side);
  if (actions.length === 0) throw new Error(`arena: AI side ${side} has no legal action`);
  const rng: RngState = { rng: battle.policyRng[side], rngDraws: 0 };
  const action = actions[Math.floor(nextRandom(rng) * actions.length)]!;
  return { action: clone(action), cursor: rng.rng };
}

function primeAi(battle: ArenaBattle): ArenaBattle {
  if (battle.terminal) return battle;
  let next = battle;
  const pending: ArenaBattle["pending"] = [battle.pending[0], battle.pending[1]];
  const policy: ArenaBattle["policyRng"] = [battle.policyRng[0], battle.policyRng[1]];
  let changed = false;
  for (const side of [0, 1] as const) {
    if (next.config.sides[side].kind !== "ai" || pending[side] !== null) continue;
    const picked = chooseAi(next, side);
    pending[side] = picked.action;
    policy[side] = picked.cursor;
    changed = true;
  }
  if (changed) next = { ...next, pending, policyRng: policy };
  return next;
}

function runAiOnly(battle: ArenaBattle): ArenaBattle {
  if (!battle.config.sides.every((side) => side.kind === "ai")) return battle;
  let next = battle;
  while (!next.terminal) {
    next = primeAi(next);
    if (!next.pending[0] || !next.pending[1]) throw new Error("arena: AI-only battle stalled");
    next = settlePair(next);
  }
  return next;
}

export function createArenaBattle(value: ArenaConfig): ArenaBattle {
  const config = normalizeConfig(value);
  const player = team(config.seed, 0, config.sides[0], config.teamRules);
  const enemy = team(config.seed, 1, config.sides[1], config.teamRules);
  const core = createBattle(RULES_DB, {
    seed: domainSeed(config.seed, "battle"),
    kind: "trainer",
    opponent: "arena",
    policy: "first",
    player,
    enemy,
    fieldSize: config.format === "double" ? 2 : 1,
    moneyMethod: "conserved",
    inventory: {},
    manualSides: [0, 1],
  });
  const battle: ArenaBattle = {
    v: ARENA_VERSION,
    seed: config.seed,
    config,
    core,
    turn: 0,
    pending: [null, null],
    actions: [],
    revealedMoves: [{}, {}],
    revealEventCursor: core.events.length,
    policyRng: [domainSeed(config.seed, "policy:0"), domainSeed(config.seed, "policy:1")],
    terminal: null,
  };
  return runAiOnly(primeAi(battle));
}

export function observe(battle: ArenaBattle, side: ArenaSide): ArenaObservation {
  if (side !== 0 && side !== 1) throw new Error("arena observe: side must be 0 or 1");
  const foe = side === 0 ? 1 : 0;
  const ownActive = activeUids(battle.core, side);
  const foeActive = activeUids(battle.core, foe);
  const actingUid = battle.terminal ? null : actorUid(battle.core, side);
  return {
    v: ARENA_VERSION,
    side,
    format: battle.config.format,
    turn: battle.turn,
    round: battle.core.turn,
    deadlineTicks: ARENA_DEADLINE_TICKS,
    actingParty: actingUid === null
      ? null
      : battle.core.parties[side].findIndex((monster) => monster.uid === actingUid),
    own: {
      active: ownActive.map((uid) => battle.core.parties[side].findIndex((monster) => monster.uid === uid)),
      party: battle.core.parties[side].map((monster, party) => ({
        party,
        active: ownActive.includes(monster.uid),
        species: { slug: monster.slug, displayName: localizedName("monster", monster.slug) },
        level: monster.level,
        hp: { current: monster.currentHp, max: monster.base.hp, percent: hpPercent(monster) },
        status: monster.status?.slug ?? null,
        types: [...monster.types],
        gender: monster.gender,
        base: { ...monster.base },
        stages: { ...monster.stages },
        moves: monster.moves.map((move, slot) => ({
          slot,
          slug: move.slug,
          displayName: localizedName("technique", move.slug),
          cooldown: move.cooldown,
        })),
      })),
    },
    opponent: {
      active: foeActive.map((uid, position) => {
        const monster = battle.core.parties[foe].find((candidate) => candidate.uid === uid)!;
        return {
          position,
          species: { slug: monster.slug, displayName: localizedName("monster", monster.slug) },
          level: monster.level,
          hpPercent: hpPercent(monster),
          status: monster.status?.slug ?? null,
          revealedMoves: (battle.revealedMoves[foe][String(uid)] ?? []).map((slug) => ({
            slug,
            displayName: localizedName("technique", slug),
          })),
        };
      }),
    },
    legalActions: battle.terminal ? [] : legalActions(battle.core, side).map(clone),
    result: battle.terminal ? { ...battle.terminal } : null,
  };
}

export function defaultAction(battle: ArenaBattle, side: ArenaSide): ArenaAction {
  if (side !== 0 && side !== 1) throw new Error("arena defaultAction: side must be 0 or 1");
  const action = legalActions(battle.core, side)[0];
  if (!action || battle.terminal) throw new Error(`arena defaultAction: side ${side} has no legal action`);
  return clone(action);
}

export function submit(battle: ArenaBattle, side: unknown, value: unknown): ArenaSubmitResult {
  if (side !== 0 && side !== 1) return { ok: false, battle, error: "INVALID_SIDE" };
  if (battle.terminal) return { ok: false, battle, error: "BATTLE_OVER" };
  if (battle.config.sides[side].kind !== "agent") {
    return { ok: false, battle, error: "SIDE_NOT_AGENT" };
  }
  if (battle.pending[side] !== null) return { ok: false, battle, error: "ALREADY_SUBMITTED" };
  if (!validActionShape(value)) return { ok: false, battle, error: "INVALID_ACTION" };
  const legal = legalActions(battle.core, side);
  if (!legal.some((action) => actionEqual(action, value))) {
    return { ok: false, battle, error: "ILLEGAL_ACTION" };
  }
  const pending: ArenaBattle["pending"] = [battle.pending[0], battle.pending[1]];
  pending[side] = clone(value);
  let next: ArenaBattle = { ...battle, pending };
  const resolved = next.pending[0] !== null && next.pending[1] !== null;
  if (resolved) {
    next = settlePair(next);
    if (!next.terminal) next = primeAi(next);
  }
  return { ok: true, battle: next, resolved };
}

export function isOver(battle: ArenaBattle): boolean {
  return battle.terminal !== null;
}

export function result(battle: ArenaBattle): ArenaResult | null {
  return battle.terminal ? { ...battle.terminal } : null;
}

export function tape(battle: ArenaBattle): BattleTape {
  return {
    v: ARENA_VERSION,
    seed: battle.seed,
    config: {
      format: battle.config.format,
      sides: clone(battle.config.sides),
      ...(battle.config.teamRules === undefined ? {} : { teamRules: clone(battle.config.teamRules) }),
    },
    actions: clone(battle.actions),
  };
}

function validateTapeAction(value: unknown, label: string): ArenaAction {
  if (!validActionShape(value)) throw new ArenaTapeError(`${label}: invalid action schema`);
  return clone(value);
}

export function validateBattleTape(value: unknown): ArenaTapeValidation {
  try {
    if (!isRecord(value) || !exactKeys(value, ["v", "seed", "config", "actions"])) {
      throw new ArenaTapeError("battle tape must contain only v, seed, config, and actions");
    }
    if (value.v !== ARENA_VERSION) throw new ArenaTapeError(`battle tape version must be ${ARENA_VERSION}`);
    if (!isRecord(value.config) || !exactKeys(value.config, ["format", "sides", "teamRules"], ["teamRules"])) {
      throw new ArenaTapeError("battle tape config must contain only format, sides, and optional teamRules");
    }
    const config = normalizeConfig({
      seed: value.seed,
      format: value.config.format,
      sides: value.config.sides,
      ...(value.config.teamRules === undefined ? {} : { teamRules: value.config.teamRules }),
    });
    if (!Array.isArray(value.actions) || value.actions.length > ARENA_MAX_TURNS) {
      throw new ArenaTapeError(`battle tape actions must be an array of at most ${ARENA_MAX_TURNS} pairs`);
    }
    const actions = value.actions.map((pair, turn): [ArenaAction, ArenaAction] => {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new ArenaTapeError(`battle tape actions[${turn}] must contain exactly two actions`);
      }
      return [
        validateTapeAction(pair[0], `battle tape actions[${turn}][0]`),
        validateTapeAction(pair[1], `battle tape actions[${turn}][1]`),
      ];
    });
    return {
      ok: true,
      tape: {
        v: ARENA_VERSION,
        seed: config.seed,
        config: {
          format: config.format,
          sides: config.sides,
          ...(config.teamRules === undefined ? {} : { teamRules: config.teamRules }),
        },
        actions,
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function replayAgentPair(battle: ArenaBattle, pair: [ArenaAction, ArenaAction], turn: number): ArenaBattle {
  if (battle.terminal) throw new ArenaTapeError(`battle tape has action pair ${turn} after the battle ended`);
  for (const side of [0, 1] as const) {
    if (battle.config.sides[side].kind === "ai") {
      const expected = battle.pending[side];
      if (!expected || !actionEqual(expected, pair[side])) {
        throw new ArenaTapeError(`battle tape actions[${turn}][${side}] does not match seeded AI policy`);
      }
    }
  }
  let next = battle;
  for (const side of [0, 1] as const) {
    if (next.config.sides[side].kind !== "agent") continue;
    const submitted = submit(next, side, pair[side]);
    if (!submitted.ok) {
      throw new ArenaTapeError(`battle tape actions[${turn}][${side}] was rejected: ${submitted.error}`);
    }
    next = submitted.battle;
  }
  const recorded = next.actions[turn];
  if (!recorded || !actionEqual(recorded[0], pair[0]) || !actionEqual(recorded[1], pair[1])) {
    throw new ArenaTapeError(`battle tape actions[${turn}] did not settle as one simultaneous pair`);
  }
  return next;
}

export function replay(value: unknown): ArenaBattle {
  const checked = validateBattleTape(value);
  if (!checked.ok) throw new ArenaTapeError(checked.error);
  const source = checked.tape;
  const battle = createArenaBattle({ seed: source.seed, ...source.config });
  if (battle.config.sides.every((side) => side.kind === "ai")) {
    if (canonicalJson(battle.actions) !== canonicalJson(source.actions)) {
      throw new ArenaTapeError("battle tape actions do not match the seeded AI-only battle");
    }
    return battle;
  }
  let next = battle;
  for (const [turn, pair] of source.actions.entries()) next = replayAgentPair(next, pair, turn);
  return next;
}

/** Canonical SHA-256 of the complete authoritative state. This includes RNG
 * cursors and pending actions, so services must not expose a mid-turn hash to
 * players; observations remain the only public projection. */
export function stateHash(battle: ArenaBattle): string {
  return sha256Bytes(utf8Encode(canonicalJson(battle)));
}


/** Self-contained public typings emitted beside the bundled Arena runtime. */
export const SERVER_RUNTIME_DECLARATION = `export declare const ARENA_VERSION: 1;
export declare const ARENA_DEADLINE_TICKS: 1800;
export declare const ARENA_MAX_TURNS: 2048;
export declare const ARENA_DIFFICULTIES: readonly ["beginner", "easy", "normal", "hard", "expert"];
export type ArenaDifficulty = (typeof ARENA_DIFFICULTIES)[number];
export type ArenaSide = 0 | 1;
export type ArenaFormat = "single" | "double";
type ArenaStatName = "armour" | "dodge" | "hp" | "melee" | "ranged" | "speed";
type ArenaStats = Record<ArenaStatName, number>;

type ArenaExpeditionCaptureResult =
  | { result: "starter" }
  | { result: "caught"; item: string; success: true; shakes: number; status: string | null };

interface ArenaExpeditionOrigin {
  kind: "expedition";
  area: string;
  step: number;
  experienceModifier?: number;
  capture: ArenaExpeditionCaptureResult;
}

interface ArenaAcquireEvent {
  seq: number;
  type: "acquire";
  seed: string;
  species: string;
  level: number;
  origin?: ArenaExpeditionOrigin;
}

interface ArenaExperienceEvent {
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
      trainingPoints: ArenaStatName[];
    }
    | { kind: "item"; item: string };
}

interface ArenaLevelEvent {
  seq: number;
  type: "level";
  level: number;
  step?: number;
}

interface ArenaLearnEvent {
  seq: number;
  type: "learn";
  move: string;
  forget?: string;
  step?: number;
}

interface ArenaItemEvent {
  seq: number;
  type: "item";
  item: string;
  forget?: string;
  step?: number;
}

export type ArenaProvenanceEvent =
  | ArenaAcquireEvent
  | ArenaExperienceEvent
  | ArenaLevelEvent
  | ArenaLearnEvent
  | ArenaItemEvent;

export interface ArenaTeamRecord {
  kind: "legacy" | "expedition";
  species: string;
  level: number;
  moves: string[];
  experience?: number;
  bond?: number;
  provenanceHash?: string;
  provenance: ArenaProvenanceEvent[];
}

export interface ArenaTeamRules {
  minSize?: number;
  maxSize?: number;
  levelCap?: number;
  uniformLevel?: number | null;
  bannedSpecies?: readonly string[];
  bannedMoves?: readonly string[];
  bannedItems?: readonly string[];
  requiredKind?: ArenaTeamRecord["kind"] | null;
}

export type ArenaTeamValidation =
  | { ok: true; errors: [] }
  | { ok: false; errors: string[] };

export type ArenaSideConfig =
  | { kind: "agent"; difficulty?: ArenaDifficulty }
  | { kind: "agent"; team: ArenaTeamRecord[] }
  | { kind: "ai"; difficulty: ArenaDifficulty };

export interface ArenaConfig {
  seed: string;
  format: ArenaFormat;
  sides: [ArenaSideConfig, ArenaSideConfig];
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

interface ArenaCoreMove {
  slug: string;
  cooldown: number;
  power: number;
  potency: number;
  hit: boolean;
}

interface ArenaCoreStatus {
  slug: string;
  turn: number;
  stack: number;
  uses: number;
  linked: number | null;
  appliedEffects: string[];
}

interface ArenaCoreMonster {
  uid: number;
  iid?: string;
  slug: string;
  nickname?: string;
  heldItem?: string;
  level: number;
  stage: string;
  gender: string;
  tasteCold: string;
  tasteWarm: string;
  height: number;
  weight: number;
  individualValues: ArenaStats;
  birthdate: [number, number];
  acquisition: string;
  captureDevice: string;
  waitingToEvolve: boolean;
  originalTypes: string[];
  types: string[];
  base: ArenaStats;
  stages: Partial<Record<ArenaStatName, number>>;
  statusBoosts: Partial<Record<ArenaStatName, number>>;
  trainingPoints: ArenaStats;
  currentHp: number;
  totalExperience: number;
  experienceModifier: number;
  moneyModifier: number;
  bond: number;
  moves: ArenaCoreMove[];
  fallback: string;
  fallbackHit: boolean;
  status: ArenaCoreStatus | null;
  plagues: Record<string, "infected" | "inoculated" | "carrier" | "recovered">;
  outOfRange: boolean;
  isConfused: boolean;
}

interface ArenaCoreAction {
  kind: "technique" | "status" | "item" | "capture" | "run" | "swap";
  user: number | null;
  target: number;
  ref: string;
  moveIndex?: number;
  techniquePower?: number;
  parkCapture?: true;
  parkFlavor?: string;
  plaguePrechecked?: string;
  subPriority: number;
}

interface ArenaCoreEvent {
  type: string;
  turn: number;
  [key: string]: unknown;
}

interface ArenaCoreDecision {
  side: ArenaSide;
  uid: number;
  kind: "technique" | "replacement";
}

interface ArenaCorePendingAction {
  turn: number;
  action: ArenaCoreAction;
}

interface ArenaCoreRewardEvent {
  loser: number;
  participants?: number[];
  winners: Array<{
    uid: number;
    experience: number;
    effectiveExperience: number;
    levelsGained: number;
    learnedMoves: string[];
    forgottenMoves: string[];
    evolutionTarget: string | null;
    trainingPoints: ArenaStatName[];
  }>;
  prize: number;
}

interface ArenaCoreBattleResult {
  outcome: "won" | "lost" | "draw" | "ran" | "captured";
  playerDefeated: boolean;
  battleLastResult: "won" | "lost" | "draw" | "run" | "captured";
  gold: number;
  prize: number;
}

interface ArenaCoreState {
  version: 1;
  kind: "trainer" | "wild";
  opponent: string;
  policy: "first" | "cycle";
  inside: boolean;
  hour: number;
  weather: string | null;
  fieldSize: 1 | 2;
  moneyMethod: "participant_scaled" | "conserved";
  rng: number;
  rngDraws: number;
  turn: number;
  phase: "housekeeping" | "decision" | "action" | "postAction" | "resolve" | "ended";
  parties: [ArenaCoreMonster[], ArenaCoreMonster[]];
  field: number[];
  queue: ArenaCoreAction[];
  pending: ArenaCorePendingAction[];
  hitRolls: Record<string, number>;
  decisionQueue: number[];
  awaiting: ArenaCoreDecision | null;
  outcome: "won" | "lost" | "draw" | "ran" | "captured" | null;
  events: ArenaCoreEvent[];
  manualSides?: ArenaSide[];
  rewards: ArenaCoreRewardEvent[];
  prize: number;
  techniqueGold: number;
  damageByDefender: Record<string, number[]>;
  result: ArenaCoreBattleResult | null;
  runAttempts: number;
  inventory: Record<string, number>;
  variables: Record<string, string | number | boolean>;
  capturedUid: number | null;
}

export interface ArenaBattle {
  v: typeof ARENA_VERSION;
  seed: string;
  config: ArenaConfig;
  core: ArenaCoreState;
  turn: number;
  pending: [ArenaAction | null, ArenaAction | null];
  actions: Array<[ArenaAction, ArenaAction]>;
  revealedMoves: [Record<string, string[]>, Record<string, string[]>];
  revealEventCursor: number;
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
  turn: number;
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
      base: ArenaStats;
      stages: Partial<Record<ArenaStatName, number>>;
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

export declare class ArenaTapeError extends Error {
  constructor(message: string);
}

export declare const DEFAULT_ARENA_TEAM_RULES: Readonly<Required<ArenaTeamRules>>;
export declare const SERVER_ENGINE_REVISION: "pocket-tuxemon/arena-engine/v1";
export declare const SERVER_DATA_REVISION: "9e6258ff726b786040a267e8bdbbf037b560285e";
export declare const SERVER_DATA_DIGEST: "49cc9fc9b11899d511689ea9a59169bcaa41c86262f3e46f3b0a25a475e002a3";
export declare const SERVER_RUNTIME_IDENTITY: Readonly<{
  arenaVersion: typeof ARENA_VERSION;
  engineRevision: typeof SERVER_ENGINE_REVISION;
  dataRevision: typeof SERVER_DATA_REVISION;
  dataDigest: typeof SERVER_DATA_DIGEST;
}>;

export declare function createArenaBattle(value: ArenaConfig): ArenaBattle;
export declare function createArenaReplayStart(value: ArenaConfig): ArenaBattle;
export declare function observe(battle: ArenaBattle, side: ArenaSide): ArenaObservation;
export declare function defaultAction(battle: ArenaBattle, side: ArenaSide): ArenaAction;
export declare function submit(battle: ArenaBattle, side: unknown, value: unknown): ArenaSubmitResult;
export declare function isOver(battle: ArenaBattle): boolean;
export declare function result(battle: ArenaBattle): ArenaResult | null;
export declare function tape(battle: ArenaBattle): BattleTape;
export declare function validateBattleTape(value: unknown): ArenaTapeValidation;
export declare function replayArenaPair(
  battle: ArenaBattle,
  pair: [ArenaAction, ArenaAction],
  turn: number,
): ArenaBattle;
export declare function replay(value: unknown): ArenaBattle;
export declare function stateHash(battle: ArenaBattle): string;
export declare function validateTeam(records: unknown, rules?: ArenaTeamRules): ArenaTeamValidation;
export declare function validateTeamRules(rules: unknown): ArenaTeamValidation;
`;

import type {
  BattleAction,
  BattleCoreState,
  BattleDecision,
  BattleEvent,
  BattleOutcome,
  BattlePhase,
  PendingBattleAction,
} from "./core.ts";
import type { WeatherRow } from "../importer/battle-schema.ts";

export const STAT_NAMES = ["armour", "dodge", "hp", "melee", "ranged", "speed"] as const;
export type StatName = (typeof STAT_NAMES)[number];
export type Stats = Record<StatName, number>;

export interface DbRule {
  type: string;
  parameters: string[];
  operator?: string;
}

export interface DbStatModifier {
  value: number;
  operation: string;
  step: number | null;
  max_deviation: number;
  max_step_limit: number;
  scaling_mode: "linear" | "nonlinear";
  overridetofull: boolean;
}

export interface DbTechnique {
  slug: string;
  sort: string;
  range: string;
  speed: string;
  accuracy: number;
  potency: number;
  power: number;
  healing_power: number;
  recharge: number;
  min_recharge?: number;
  initial_delay?: number;
  cooldown_multiplier?: number;
  types: string[];
  effects: DbRule[];
  conditions: DbRule[];
  stat_modifiers: Partial<Record<StatName | "current_hp", DbStatModifier>>;
  target: Record<string, boolean>;
}

export interface DbMonster {
  slug: string;
  species: string;
  shape: string;
  /** Evolution stage gates some level-up moves. */
  stage?: string;
  types: string[];
  tags: string[];
  terrains: string[];
  catch_rate: number;
  catch_resistance: [number, number];
  evolutions: DbEvolution[];
  moveset: Array<{
    technique: string;
    learning_method: string;
    level_learned: number;
    evolution_stage_learned?: string;
  }>;
}

export interface DbEvolution extends Record<string, unknown> {
  monster_slug: string;
  at_level?: number;
  gender?: string;
  element?: string;
  acquisition?: string;
  inside?: boolean;
  tech?: string;
  moves?: string[];
  variables?: Array<{ key: string; value: string | number | boolean }>;
  tastes?: Record<string, string>;
  bond?: { comparison: string; value: number };
  stats?: {
    comparison: string;
    stat_type: StatName;
    target_stat?: StatName;
    target_value?: number;
  };
  party_conditions?: {
    monster_slugs?: Record<string, number>;
    monster_types?: Record<string, number>;
    genders?: Record<string, number>;
    alignment?: string;
    party_size?: number;
    party_level?: number;
    party_stages?: Record<string, number>;
  };
  item?: Record<string, number>;
}

export interface DbItem {
  slug: string;
  sort: string;
  category: string;
  usable_in: string[];
  consumable: boolean;
  effects: DbRule[];
  conditions: DbRule[];
  behaviors: Record<string, unknown>;
  stat_modifiers: Partial<Record<StatName | "current_hp", DbStatModifier>>;
  immunity_to_status: string[];
}

export interface DbCaptureEffect {
  target_attribute: string;
  operation: string;
  value: string | number;
}

export interface DbCaptureDevice {
  specific_capdev_modifier: number | null;
  positive_modifier: number;
  negative_modifier: number;
  specific_status_modifiers: Record<string, number> | null;
  fallback_element_malus: number;
  specific_element_modifiers: Record<string, number> | null;
  fallback_gender_malus: number;
  specific_gender_modifiers: Record<string, number> | null;
  fallback_variables_malus: number;
  fallback_variables_bonus: number;
  specific_variables_modifiers: Array<{ key: string; value: string | number | boolean }> | null;
  random_bounds: [number, number] | null;
  capdev_persistent_on_success: boolean;
  capdev_persistent_on_failure: boolean;
  capdev_effects: DbCaptureEffect[] | null;
}

export interface DbCaptureRules {
  max_catch_rate: number;
  total_shakes: number;
  shake_constant: number;
  shake_denominator: number;
  shake_divisor: number;
  shake_hp_multiplier: number;
  shake_current_hp_multiplier: number;
  shake_hp_divisor: number;
}

export interface DbStatus {
  slug: string;
  category: "positive" | "negative" | "neutral" | null;
  effects: DbRule[];
  conditions?: DbRule[];
  stat_modifiers?: Partial<Record<StatName | "current_hp", DbStatModifier>>;
  on_positive_status?: "replaced" | "removed" | "stacked" | "blocked" | null;
  on_negative_status?: "replaced" | "removed" | "stacked" | "blocked" | null;
  on_tech_use?: string | null;
  on_item_use?: string | null;
  duration?: number | null;
  max_stacks?: number;
  bond?: boolean | null;
  behaviors?: { persists_after_combat?: boolean };
  modifiers?: Array<{
    attribute: string;
    values: string[];
    multiplier: number;
  }>;
}

export interface TuxemonBattleDb {
  monster: Record<string, DbMonster>;
  technique: Record<string, DbTechnique>;
  item: Record<string, DbItem>;
  technique_speed: Record<string, number>;
  element: Record<string, { types: Array<{ against: string; multiplier: number }> }>;
  /** Source database insertion order, which random element-switch moves use. */
  element_order?: string[];
  taste: Record<string, {
    taste_type?: string;
    rarity_score?: number;
    modifiers: Array<{ values: string[]; multiplier: number }>;
  }>;
  /** Source database insertion order used by weighted taste generation. */
  taste_order?: string[];
  shape: Record<string, { attributes: Stats }>;
  status: Record<string, DbStatus>;
  /** The ten imported weather rows; empty modifier lists make every
   *  weather a damage no-op until upstream populates them. */
  weather: Record<string, WeatherRow>;
  capture: DbCaptureRules;
  capture_devices: {
    status_modifier: number;
    capdev_modifier: number;
    items: Record<string, DbCaptureDevice>;
  };
  /** Optional only for the legacy GB2 development fixture. */
  progression?: {
    level_range: [number, number];
    max_moves: number;
    acquisition_multipliers: Record<string, number>;
    experience_groups: Record<string, {
      multiplier: number;
      experience_coefficient: number;
    }>;
  };
}

export interface BattleMove {
  slug: string;
  cooldown: number;
  /** Mutable battle-only values rewritten by grabbed/stuck. */
  power: number;
  potency: number;
  /** Technique.hit persists when every effect is skipped for an absent target. */
  hit: boolean;
}

export interface BattleStatus {
  slug: string;
  turn: number;
  stack: number;
  uses: number;
  linked: number | null;
  appliedEffects: string[];
}

export interface BattleMonster {
  uid: number;
  /** Stable session identity for writing persistent player state back. */
  iid?: string;
  slug: string;
  /** Optional player-assigned name, preserved across battles and evolution. */
  nickname?: string;
  level: number;
  stage: string;
  gender: string;
  tasteCold: string;
  tasteWarm: string;
  height: number;
  weight: number;
  individualValues: Stats;
  birthdate: [number, number];
  acquisition: string;
  captureDevice: string;
  waitingToEvolve: boolean;
  originalTypes: string[];
  types: string[];
  base: Stats;
  /** Technique/item stages survive status replacement until battle cleanup. */
  stages: Partial<Record<StatName, number>>;
  /** ON_START status stat changes are withdrawn by ON_END. */
  statusBoosts: Partial<Record<StatName, number>>;
  trainingPoints: Stats;
  currentHp: number;
  totalExperience: number;
  experienceModifier: number;
  moneyModifier: number;
  bond: number;
  moves: BattleMove[];
  fallback: string;
  fallbackHit: boolean;
  status: BattleStatus | null;
  outOfRange: boolean;
  isConfused: boolean;
}

export interface MonsterSnapshot {
  /** Stable session identity. Spawn RNG never generates this value. */
  iid?: string;
  slug: string;
  /** Optional player-assigned name. Missing means use the localized species name. */
  nickname?: string;
  level: number;
  stage?: string;
  gender?: string;
  tasteCold?: string;
  tasteWarm?: string;
  height?: number;
  weight?: number;
  individualValues?: Stats;
  birthdate?: [number, number];
  base: Stats;
  currentHp?: number;
  moves: string[];
  types?: string[];
  totalExperience?: number;
  experienceModifier?: number;
  moneyModifier?: number;
  bond?: number;
  trainingPoints?: Partial<Stats>;
  status?: string | null;
  acquisition?: string;
  captureDevice?: string;
  waitingToEvolve?: boolean;
  /** Breeding lineage written by the daycare newborn pipeline. */
  motherIid?: string;
  /** Breeding lineage written by the daycare newborn pipeline. */
  fatherIid?: string;
}

/** Complete persistent snapshot produced by the Tuxemon spawn pipeline. */
export interface SpawnedMonsterSnapshot extends MonsterSnapshot {
  stage: string;
  gender: string;
  tasteCold: string;
  tasteWarm: string;
  height: number;
  weight: number;
  individualValues: Stats;
  birthdate: [number, number];
}

/** Sparse player daycare payload. It is absent until a monster is deposited
 *  and removed again after the last parent is withdrawn. */
export interface DaycareExtensionState {
  /** Upstream has exactly two slots and withdraws both at once. */
  parents: SpawnedMonsterSnapshot[];
  /** Breeding-only completed tile steps. */
  progressSteps: number;
  /** Fractional training EXP, in exact quarter-point increments. */
  pendingExperience: number;
  /** Settled EXP per training parent since the latest deposit. */
  lastTrainingExp: number;
  /** Money charged since the latest deposit. */
  lastTrainingCost: number;
}

export type PlayerPolicy = "first" | "cycle";

export interface RewardEvent {
  loser: number;
  winners: Array<{
    uid: number;
    experience: number;
    effectiveExperience: number;
    levelsGained: number;
    learnedMoves: string[];
    forgottenMoves: string[];
    evolutionTarget: string | null;
    trainingPoints: StatName[];
  }>;
  prize: number;
}

export interface BattleResult {
  outcome: BattleOutcome;
  /** Draw is deliberately player-defeating while retaining a distinct result. */
  playerDefeated: boolean;
  battleLastResult: "won" | "lost" | "draw" | "run" | "captured";
  /** Move/effect gold, awarded mid-battle: goes straight to the wallet,
   *  like upstream's modify_money path, and is never shared with bills. */
  gold: number;
  /** Trainer-battle prize on a player win; zero everywhere else. Only this
   *  stream is shared with the winner's bills (upstream _handle_win). */
  prize: number;
}

export interface TuxemonBattleState extends BattleCoreState<BattleMonster> {
  version: 1;
  kind: "trainer" | "wild";
  opponent: string;
  policy: PlayerPolicy;
  inside: boolean;
  hour: number;
  /** Overworld weather slug snapshotted at battle start. Null for battles
   *  started without a weather stream (fixtures, oracle baselines). */
  weather: string | null;
  fieldSize: 1 | 2;
  moneyMethod: "participant_scaled" | "conserved";
  rewards: RewardEvent[];
  prize: number;
  techniqueGold: number;
  damageByDefender: Record<string, number[]>;
  result: BattleResult | null;
  /** Reserved now; GB3's escape command keeps this across battles. */
  runAttempts: number;
  /** Battle-owned snapshot of the session backpack, written back on completion. */
  inventory: Record<string, number>;
  /** World variables consulted by day/night and other capture devices. */
  variables: Record<string, string | number | boolean>;
  capturedUid: number | null;
}

export interface BattleStart {
  seed: number;
  kind?: "trainer" | "wild";
  opponent?: string;
  policy?: PlayerPolicy;
  player: MonsterSnapshot[];
  enemy: MonsterSnapshot[];
  inside?: boolean;
  hour?: number;
  /** Weather slug to snapshot into the battle; defaults to null. */
  weather?: string | null;
  fieldSize?: 1 | 2;
  moneyMethod?: "participant_scaled" | "conserved";
  runAttempts?: number;
  inventory?: Record<string, number>;
  variables?: Record<string, string | number | boolean>;
}

export interface TechniqueDecision {
  type: "technique";
  /** Index in the current usable-move list, not necessarily the raw move slot. */
  choice: number;
}

export type FutureBattleDecision =
  | { type: "item"; item: string; target: number }
  | { type: "capture"; item: string; target: number }
  | { type: "run" }
  | { type: "replacement"; uid: number };

export type TuxemonBattleDecision = TechniqueDecision | FutureBattleDecision;

// Re-export the generic JSON-state vocabulary from one public entry point.
export type {
  BattleAction,
  BattleDecision,
  BattleEvent,
  BattleOutcome,
  BattlePhase,
  PendingBattleAction,
};

import type {
  BattleCompletion,
  BattleInput,
  BattleRules,
} from "../vendor/pocket-rpgkit/src/engine/battle.ts";
import type { ExtensionReadContext } from "../vendor/pocket-rpgkit/src/engine/extensions.ts";
import type { JsonValue } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import type { BattleAnimationRef, BattleDb, BattleImageRef } from "../importer/battle-schema.ts";
import {
  applyBattleSharesToBills,
  initialTuxemonExtensionState,
  KENNEL_LIMIT,
  nextMonsterIid,
  packTuxemonExtensionState,
  PARTY_LIMIT,
  registerCaughtMonster,
  releaseBattleDb,
  resolveBattleDb,
  tuxemonExtensionState,
  type BattleDbSource,
  type PendingMonster,
  type TuxemonExtensionState,
} from "./extension.ts";
import { battleDbToTuxemonBattleDb } from "./from-battle-db.ts";
import { endBattle, nextRandom, type RngState } from "./core.ts";
import { PARK_ENCOUNTER_TURNS, recordParkCapture, recordParkSighting } from "./park.ts";
import {
  BATTLE_EVENT_TICKS,
  battleEventDuration,
  presentationEventSkippable,
} from "./presentation.ts";
import { applyPendingOverrides, spawnMonster } from "./spawn.ts";
import {
  canRun,
  canSwap,
  canUseBattleItem,
  cloneBattleState,
  getMonster,
  getSide,
  createBattle,
  makeRules,
  reduceBattle,
  usableMoves,
} from "./tuxemon.ts";
import type {
  BattleEvent,
  BattleMonster,
  SpawnedMonsterSnapshot,
  TuxemonBattleDb,
  TuxemonBattleState,
} from "./types.ts";

export const TUXEMON_BATTLE_STATE_FORMAT = "pocket-tuxemon/battle-runtime/v1";
export { BATTLE_EVENT_TICKS } from "./presentation.ts";

export type VariableEnums = Readonly<Record<string, readonly string[]>>;

export interface BattlePartyMemberSetup {
  species: string;
  level: number;
  experienceModifier?: number;
  moneyModifier?: number;
  iid?: string;
}

export interface TrainerBattleSetup {
  kind: "trainer";
  opponent: string;
  party?: BattlePartyMemberSetup[];
  fieldSize?: 1 | 2;
  environment?: string;
  inside?: boolean;
  hour?: number;
}

export interface WildBattleSetup {
  kind: "wild";
  species: string;
  level: number;
  experienceModifier?: number;
  moneyModifier?: number;
  environment?: string;
  inside?: boolean;
  hour?: number;
}

export interface RandomBattleSetup {
  kind: "random";
  table: string;
  probability?: number;
  /** Optional already-resolved world values for encounter-row filtering. */
  variables?: Record<string, string | number | boolean>;
  environment?: string;
  inside?: boolean;
  hour?: number;
}

/** NPC-versus-NPC battle the player watches. Both parties come from the
 *  staged NPC parties (add_monster with a character argument); the player's
 *  own party is untouched. The battle runs on the seeded AI policy for both
 *  sides and auto-advances through the real battle scene. The result codes
 *  are the importer-computed enum indices written to battle_last_* on
 *  completion, matching the headless tux.npc_battle resolver exactly. */
export interface SpectatorBattleSetup {
  kind: "spectate";
  fighter: string;
  foe: string;
  fighterWinnerCode: number;
  foeWinnerCode: number;
  fighterLoserCode: number;
  foeLoserCode: number;
  fighterTrainerCode: number;
  foeTrainerCode: number;
  drawCode: number;
  environment?: string;
  inside?: boolean;
  hour?: number;
}

export type TuxemonBattleSetup = TrainerBattleSetup | WildBattleSetup | RandomBattleSetup | SpectatorBattleSetup;

/** Per-battle spectator state carried in the serialised RuntimeBattleState.
 *  speed is the presentation multiplier (1/2/4) toggled by confirm; cancel
 *  skips the remaining decisions and plays only the end beat. */
export interface SpectatorInfo {
  fighter: string;
  foe: string;
  speed: 1 | 2 | 4;
  codes: {
    fighterWinnerCode: number;
    foeWinnerCode: number;
    fighterLoserCode: number;
    foeLoserCode: number;
    fighterTrainerCode: number;
    foeTrainerCode: number;
    drawCode: number;
  };
}

export interface ParkBattleInfo {
  monster: string;
  turnsRemaining: number;
  fleeRate: number;
  /** True only when the opponent's pre-throw flee check ended the encounter. */
  monsterFled: boolean;
}

export interface RuntimeBattleState {
  format: typeof TUXEMON_BATTLE_STATE_FORMAT;
  battle: TuxemonBattleState;
  ext: TuxemonExtensionState;
  /** Session wallet at battle entry; rewards are added on completion. */
  startingGold: number;
  environment: string;
  visuals: {
    environment: BattleDb["environments"][string];
    ui: Pick<BattleDb["ui"], "hpBar" | "expBar">;
    trainers: {
      player: BattleImageRef | null;
      opponent: BattleImageRef | null;
    };
    monsters: Record<string, BattleDb["monsters"][string]["art"]>;
    techniques: Record<string, {
      range: string;
      types: string[];
      messages: BattleDb["techniques"][string]["messages"];
      animation?: BattleAnimationRef;
    }>;
    items: Record<string, {
      captureSprite?: BattleImageRef;
      animation?: BattleAnimationRef;
    }>;
    statusIcons: Record<string, BattleImageRef>;
  };
  presentationRewards: Array<{
    eventIndex: number;
    loser: number;
    winners: Array<{
      uid: number;
      effectiveExperience: number;
      levelsGained: number;
      before: { level: number; totalExperience: number; maxHp: number };
      after: { level: number; totalExperience: number; maxHp: number };
    }>;
  }>;
  menu: BattleMenuEntry[];
  menuMode: BattleMenuMode;
  eventCursor: number;
  eventTicks: number;
  menuIndex: number;
  /** Present only for NPC-versus-NPC spectator battles. When set, the step
   *  function auto-advances both sides on the seeded AI policy (no player
   *  menu), confirm toggles the presentation speed, and cancel skips to the
   *  end. The completion writes the battle_last_* result variables using
   *  the setup's codes rather than the player/trainer path. */
  spectator?: SpectatorInfo;
  /** Present only for a wild encounter inside an active Eclipse Park session. */
  park?: ParkBattleInfo;
}

export type BattleMenuMode = "root" | "technique" | "item" | "capture" | "swap";

export interface BattleMenuEntry {
  kind: "fight" | "technique" | "item" | "capture" | "run" | "replacement" | "forfeit";
  slug: string;
  cooldown: number;
  /** Disabled root commands stay serialised so the UI can show their labels. */
  available: boolean;
  /** Present in doubles, where each move/target pair is a distinct choice. */
  target?: number;
  targetSlug?: string;
  targetSlot?: number;
  quantity?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const safeInteger = (value: unknown): value is number =>
  finite(value) && Number.isSafeInteger(value);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asJson(value: RuntimeBattleState | TuxemonExtensionState): JsonValue {
  return value as unknown as JsonValue;
}

function setupRecord(value: JsonValue): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Tuxemon battle setup must be an object");
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Tuxemon battle setup ${label} must be a non-empty string`);
  }
  return value;
}

function optionalFinite(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!finite(value)) throw new Error(`Tuxemon battle setup ${label} must be finite`);
  return value;
}

function level(value: unknown): number {
  if (!safeInteger(value)) throw new Error("Tuxemon battle setup level must be an integer");
  return value;
}

function commonSetup(raw: Record<string, unknown>, db: BattleDb, activeEnvironment: string | null) {
  const environment = raw.environment === undefined
    ? activeEnvironment
    : requiredString(raw.environment, "environment");
  if (environment === null) return null;
  if (!(environment in db.environments)) {
    throw new Error(`Tuxemon battle setup references unknown environment '${environment}'`);
  }
  const hour = raw.hour === undefined ? 12 : raw.hour;
  if (!safeInteger(hour) || hour < 0 || hour > 23) {
    throw new Error("Tuxemon battle setup hour must be an integer in 0..23");
  }
  if (raw.inside !== undefined && typeof raw.inside !== "boolean") {
    throw new Error("Tuxemon battle setup inside must be boolean");
  }
  return { environment, hour, inside: raw.inside === true };
}

function parsePartyMember(value: unknown): BattlePartyMemberSetup {
  if (!isRecord(value)) throw new Error("Tuxemon battle party member must be an object");
  const member: BattlePartyMemberSetup = {
    species: requiredString(value.species, "party species"),
    level: level(value.level),
    experienceModifier: optionalFinite(value.experienceModifier, 1, "experienceModifier"),
    moneyModifier: optionalFinite(value.moneyModifier, 0, "moneyModifier"),
  };
  if (value.iid !== undefined) member.iid = requiredString(value.iid, "party iid");
  return member;
}

function parseSetup(value: JsonValue, db: BattleDb, activeEnvironment: string | null): TuxemonBattleSetup | null {
  const raw = setupRecord(value);
  const common = commonSetup(raw, db, activeEnvironment);
  if (common === null) return null;
  switch (raw.kind) {
    case "trainer": {
      const opponent = requiredString(raw.opponent ?? raw.npc, "opponent");
      if (raw.party !== undefined && !Array.isArray(raw.party)) {
        throw new Error("Tuxemon battle setup party must be an array");
      }
      if (raw.fieldSize !== undefined && raw.fieldSize !== 1 && raw.fieldSize !== 2) {
        throw new Error("Tuxemon battle setup fieldSize must be 1 or 2");
      }
      return {
        kind: "trainer",
        opponent,
        ...(raw.party === undefined ? {} : { party: raw.party.map(parsePartyMember) }),
        ...(raw.fieldSize === 2 ? { fieldSize: 2 as const } : {}),
        ...common,
      };
    }
    case "wild":
      return {
        kind: "wild",
        species: requiredString(raw.species, "species"),
        level: level(raw.level),
        experienceModifier: optionalFinite(raw.experienceModifier, 1, "experienceModifier"),
        moneyModifier: optionalFinite(raw.moneyModifier, 0, "moneyModifier"),
        ...common,
      };
    case "random": {
      const variables = raw.variables;
      if (variables !== undefined && !isRecord(variables)) {
        throw new Error("Tuxemon battle setup variables must be an object");
      }
      const resolved: Record<string, string | number | boolean> = {};
      for (const [key, entry] of Object.entries(variables ?? {})) {
        if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") {
          throw new Error(`Tuxemon battle setup variable '${key}' must be scalar`);
        }
        resolved[key] = entry;
      }
      return {
        kind: "random",
        table: requiredString(raw.table, "table"),
        probability: optionalFinite(raw.probability ?? raw.p, 1, "probability"),
        ...(variables === undefined ? {} : { variables: resolved }),
        ...common,
      };
    }
    case "spectate": {
      const fighter = requiredString(raw.fighter, "fighter");
      const foe = requiredString(raw.foe, "foe");
      const code = (value: unknown, label: string): number => {
        if (!safeInteger(value) || value < 1) {
          throw new Error(`Tuxemon spectator battle ${label} must be a positive integer`);
        }
        return value;
      };
      return {
        kind: "spectate",
        fighter,
        foe,
        fighterWinnerCode: code(raw.fighterWinnerCode, "fighterWinnerCode"),
        foeWinnerCode: code(raw.foeWinnerCode, "foeWinnerCode"),
        fighterLoserCode: code(raw.fighterLoserCode, "fighterLoserCode"),
        foeLoserCode: code(raw.foeLoserCode, "foeLoserCode"),
        fighterTrainerCode: code(raw.fighterTrainerCode, "fighterTrainerCode"),
        foeTrainerCode: code(raw.foeTrainerCode, "foeTrainerCode"),
        drawCode: code(raw.drawCode, "drawCode"),
        ...common,
      };
    }
    default:
      throw new Error(`Tuxemon battle setup kind '${String(raw.kind)}' is unsupported`);
  }
}

function legalParty(party: readonly { currentHp?: number; moves: readonly string[] }[]): boolean {
  return party.length > 0
    && party.some((monster) => (monster.currentHp ?? 1) > 0)
    && party.every((monster) => monster.moves.length > 0);
}

function enemySnapshot(
  db: BattleDb,
  rulesDb: TuxemonBattleDb,
  rng: RngState,
  member: BattlePartyMemberSetup | PendingMonster,
): SpawnedMonsterSnapshot {
  const species = "species" in member ? member.species : member.slug;
  const snapshot = spawnMonster(db, rulesDb, rng, species, member.level, {
    iid: member.iid,
    experienceModifier: member.experienceModifier,
    moneyModifier: member.moneyModifier,
  });
  // A staged NPC party member carries the event-time mutations upstream
  // applies to the live monster (set_monster_attribute / add_tech /
  // set_monster_health / set_monster_status).
  if (!("species" in member)) {
    const pending = member as PendingMonster;
    applyPendingOverrides(snapshot, {
      ...(pending.gender === undefined ? {} : { gender: pending.gender }),
      ...(pending.acquisition === undefined ? {} : { acquisition: pending.acquisition }),
      ...(pending.nickname === undefined ? {} : { nickname: pending.nickname }),
      ...(pending.moves === undefined ? {} : { moves: pending.moves }),
      ...(pending.health === undefined ? {} : { health: pending.health }),
      ...(pending.status === undefined ? {} : { status: pending.status }),
    });
  }
  return snapshot;
}

function encounterRows(
  db: BattleDb,
  table: string,
  variables: RandomBattleSetup["variables"],
): BattleDb["encounters"][string]["monsters"] {
  const encounter = db.encounters[table];
  if (!encounter) throw new Error(`Tuxemon battle setup references unknown encounter '${table}'`);
  if (variables === undefined) return encounter.monsters;
  return encounter.monsters.filter((row) => row.variables.every(({ key, value }) =>
    String(variables[key]) === value
  ));
}

function weightedEncounter<T extends { weight: number }>(rng: RngState, rows: readonly T[]): T {
  if (rows.length === 0) throw new Error("Tuxemon random encounter has no eligible monsters");
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  if (!(total > 0) || !Number.isFinite(total)) {
    throw new Error("Tuxemon random encounter has no positive finite weight");
  }
  const wanted = nextRandom(rng) * total;
  let cumulative = 0;
  for (const row of rows) {
    cumulative += row.weight;
    if (wanted < cumulative) return row;
  }
  return rows[rows.length - 1]!;
}

function randomLevel(rng: RngState, range: readonly [number, number]): number {
  return range[0] + Math.floor(nextRandom(rng) * (range[1] - range[0] + 1));
}

function runtimeState(value: JsonValue): RuntimeBattleState {
  if (!isRecord(value) || value.format !== TUXEMON_BATTLE_STATE_FORMAT
    || !isRecord(value.battle) || !isRecord(value.ext)
    || !isRecord(value.visuals) || !isRecord(value.visuals.environment)
    || !isRecord(value.visuals.ui) || !isRecord(value.visuals.trainers)
    || !isRecord(value.visuals.monsters) || !Array.isArray(value.presentationRewards)
    || !Array.isArray(value.menu)
    || !["root", "technique", "item", "capture", "swap"].includes(String(value.menuMode))
    || !safeInteger(value.eventCursor) || value.eventCursor < 0
    || !safeInteger(value.eventTicks) || value.eventTicks < 0
    || !safeInteger(value.menuIndex) || value.menuIndex < 0
    || !safeInteger(value.startingGold) || value.startingGold < 0
    || typeof value.environment !== "string"
    || value.park !== undefined && (!isRecord(value.park)
      || typeof value.park.monster !== "string" || value.park.monster.length === 0
      || !safeInteger(value.park.turnsRemaining) || value.park.turnsRemaining < 0
      || !finite(value.park.fleeRate) || value.park.fleeRate < 0 || value.park.fleeRate > 1
      || typeof value.park.monsterFled !== "boolean")) {
    throw new Error("Tuxemon battle runtime state is invalid");
  }
  return value as unknown as RuntimeBattleState;
}

function activeOpponents(state: TuxemonBattleState, uid: number): BattleMonster[] {
  const side = getSide(state, uid);
  const targetSide = side === 0 ? 1 : 0;
  return state.field
    .filter((candidate) => getSide(state, candidate) === targetSide)
    .map((candidate) => getMonster(state, candidate));
}

export function battleMenuEntries(
  state: RuntimeBattleState,
  db: TuxemonBattleDb,
  mode: BattleMenuMode = "technique",
): BattleMenuEntry[] {
  const awaiting = state.battle.awaiting;
  if (!awaiting) return [];
  const monster = getMonster(state.battle, awaiting.uid);
  const targets = activeOpponents(state.battle, awaiting.uid);
  if (state.park && mode === "root") {
    const target = targets[0];
    const quantity = state.battle.inventory.tuxeball_park ?? 0;
    const ballAvailable = target !== undefined && canUseBattleItem(
      db,
      state.battle,
      "tuxeball_park",
      target.uid,
      true,
      "MainParkMenuState",
    );
    return [
      {
        kind: "capture",
        slug: "park_ball",
        cooldown: 0,
        available: ballAvailable,
        quantity,
        ...(target ? { target: target.uid, targetSlug: target.slug, targetSlot: 1 } : {}),
      },
      { kind: "item", slug: "park_food", cooldown: 0, available: false },
      { kind: "item", slug: "park_doll", cooldown: 0, available: false },
      { kind: "run", slug: "run", cooldown: 0, available: true },
    ];
  }
  const techniqueEntries = (): BattleMenuEntry[] => {
    if (targets.length === 0) return [];
    const usableByTarget = new Map(targets.map((target) => [
      target.uid,
      new Set(usableMoves(db, monster, target).map(({ moveIndex }) => moveIndex)),
    ]));
    // Keep the reducer/oracle's move-major, target-minor candidate order. This
    // makes a menu index an explicit move/target choice without hidden state.
    const entries = monster.moves.flatMap((move, index) => targets.flatMap((target, targetIndex) =>
      usableByTarget.get(target.uid)!.has(index)
        ? [{
            kind: "technique" as const,
            slug: move.slug,
            cooldown: move.cooldown,
            available: true,
            ...(targets.length > 1 ? {
              target: target.uid,
              targetSlug: target.slug,
              targetSlot: targetIndex + 1,
            } : {}),
          }]
        : []
    ));
    return entries.length > 0
      ? entries
      : [{ kind: "technique", slug: monster.fallback, cooldown: 0, available: true }];
  };
  const itemEntries = (capture: boolean): BattleMenuEntry[] => {
    const itemTargets = capture ? targets : state.battle.parties[0];
    return Object.keys(state.battle.inventory).sort().flatMap((slug) => {
      const quantity = state.battle.inventory[slug] ?? 0;
      if (quantity <= 0) return [];
      return itemTargets.flatMap((target, targetIndex) =>
        canUseBattleItem(db, state.battle, slug, target.uid, capture)
          ? [{
              kind: capture ? "capture" as const : "item" as const,
              slug,
              cooldown: 0,
              available: true,
              quantity,
              target: target.uid,
              targetSlug: target.slug,
              targetSlot: targetIndex + 1,
            }]
          : []
      );
    });
  };
  const swapEntries = (): BattleMenuEntry[] => state.battle.parties[0].flatMap((target, index) =>
    canSwap(state.battle, monster.uid, target.uid)
      ? [{
          kind: "replacement" as const,
          slug: target.slug,
          cooldown: 0,
          available: true,
          target: target.uid,
          targetSlug: target.slug,
          targetSlot: index + 1,
        }]
      : []
  );

  if (mode === "technique") return techniqueEntries();
  if (mode === "item") return itemEntries(false);
  if (mode === "capture") return itemEntries(true);
  if (mode === "swap") return swapEntries();

  // Tuxemon's menu profile always constructs Fight, Tuxemon, Item, and the
  // battle-kind-specific final command in this order. Visibility is the
  // command's enabled state, not permission to remove its label. Capture is
  // split out from Item by this runtime and therefore sits beside Item, but is
  // only part of the wild-battle profile.
  const entries: BattleMenuEntry[] = [
    { kind: "fight", slug: "fight", cooldown: 0, available: true },
    { kind: "replacement", slug: "swap", cooldown: 0, available: swapEntries().length > 0 },
    { kind: "item", slug: "item", cooldown: 0, available: itemEntries(false).length > 0 },
  ];
  if (state.battle.kind === "trainer") {
    // Upstream only enables this when the opposing trainer offers to forfeit;
    // that state has no reducer equivalent yet, so retain the original label
    // in its default disabled state.
    entries.push({ kind: "forfeit", slug: "forfeit", cooldown: 0, available: false });
  } else {
    entries.push(
      { kind: "capture", slug: "capture", cooldown: 0, available: itemEntries(true).length > 0 },
      { kind: "run", slug: "run", cooldown: 0, available: canRun(state.battle, monster.uid) },
    );
  }
  return entries;
}

function movedMenuIndex(entries: readonly BattleMenuEntry[], current: number, delta: -1 | 1): number {
  if (entries.length === 0) return 0;
  const start = Math.min(current, entries.length - 1);
  let candidate = start;
  do {
    candidate = (candidate + delta + entries.length) % entries.length;
    if (entries[candidate]!.available) return candidate;
  } while (candidate !== start);
  return start;
}

function setMenu(state: RuntimeBattleState, db: TuxemonBattleDb, mode: BattleMenuMode): void {
  state.menuMode = mode;
  state.menu = battleMenuEntries(state, db, mode);
  const firstAvailable = state.menu.findIndex((entry) => entry.available);
  state.menuIndex = firstAvailable < 0 ? 0 : firstAvailable;
}

function presentationDone(state: RuntimeBattleState): boolean {
  return state.eventCursor >= state.battle.events.length;
}

function advancePresentation(state: RuntimeBattleState, ticks: number, skip: boolean): void {
  let remaining = ticks;
  while (!presentationDone(state)) {
    const event = state.battle.events[state.eventCursor]!;
    const duration = battleEventDuration(state, event);
    if (skip && presentationEventSkippable(event)) state.eventTicks = duration;
    if (remaining <= 0 && state.eventTicks < duration) return;
    const required = Math.max(0, duration - state.eventTicks);
    if (required > remaining) {
      state.eventTicks += remaining;
      return;
    }
    remaining -= required;
    state.eventCursor++;
    state.eventTicks = 0;
  }
}

function boundedInteger(value: number, label: string): number {
  const integer = Math.trunc(value);
  if (!Number.isSafeInteger(integer)) throw new Error(`Tuxemon battle ${label} exceeds safe integer range`);
  return integer;
}

function writeBackMonster(
  snapshot: SpawnedMonsterSnapshot,
  monster: BattleMonster,
): SpawnedMonsterSnapshot {
  return {
    iid: snapshot.iid,
    slug: monster.slug,
    ...(monster.nickname === undefined ? {} : { nickname: monster.nickname }),
    level: boundedInteger(monster.level, "level"),
    stage: monster.stage,
    gender: monster.gender,
    tasteCold: monster.tasteCold,
    tasteWarm: monster.tasteWarm,
    height: monster.height,
    weight: monster.weight,
    individualValues: { ...monster.individualValues },
    birthdate: [...monster.birthdate],
    base: { ...monster.base },
    currentHp: Math.max(0, Math.min(monster.base.hp, boundedInteger(monster.currentHp, "HP"))),
    moves: monster.moves.map((move) => move.slug),
    types: [...monster.originalTypes],
    totalExperience: Math.max(0, boundedInteger(monster.totalExperience, "experience")),
    experienceModifier: monster.experienceModifier,
    moneyModifier: monster.moneyModifier,
    bond: Math.max(0, Math.min(100, boundedInteger(monster.bond, "bond"))),
    trainingPoints: Object.fromEntries(
      Object.entries(monster.trainingPoints).map(([stat, amount]) => [
        stat,
        Math.max(0, boundedInteger(amount, `training point ${stat}`)),
      ]),
    ) as SpawnedMonsterSnapshot["trainingPoints"],
    status: monster.status?.slug ?? null,
    acquisition: monster.acquisition,
    captureDevice: monster.captureDevice,
    waitingToEvolve: monster.waitingToEvolve,
  };
}

function capturedSnapshot(monster: BattleMonster, iid: string): SpawnedMonsterSnapshot {
  return writeBackMonster({
    iid,
    slug: monster.slug,
    level: monster.level,
    stage: monster.stage,
    gender: monster.gender,
    tasteCold: monster.tasteCold,
    tasteWarm: monster.tasteWarm,
    height: monster.height,
    weight: monster.weight,
    individualValues: { ...monster.individualValues },
    birthdate: [...monster.birthdate],
    base: { ...monster.base },
    moves: monster.moves.map((move) => move.slug),
  }, monster);
}

function nextCapturedIid(state: TuxemonExtensionState): [string, number] {
  if (!Number.isSafeInteger(state.nextMonsterId + 1)) {
    throw new Error("Tuxemon battle capture exhausted the monster id space");
  }
  return [
    `txmn-${state.nextMonsterId.toString(36).padStart(6, "0")}`,
    state.nextMonsterId + 1,
  ];
}

function completedExtension(state: RuntimeBattleState): TuxemonExtensionState {
  const result = state.battle.result;
  if (!result) throw new Error("Tuxemon battle ended without a result");
  const byIid = new Map(
    state.battle.parties[0]
      .filter((monster): monster is BattleMonster & { iid: string } => typeof monster.iid === "string")
      .map((monster) => [monster.iid, monster]),
  );
  const party = state.ext.party.map((snapshot) => {
    const monster = byIid.get(snapshot.iid!);
    return monster ? writeBackMonster(snapshot, monster) : snapshot;
  });
  const kennel = [...state.ext.kennel];
  let ext = clone(state.ext);
  let nextMonsterId = state.ext.nextMonsterId;
  if (state.battle.capturedUid !== null) {
    const captured = getMonster(state.battle, state.battle.capturedUid);
    const allocated = nextCapturedIid({ ...state.ext, nextMonsterId });
    nextMonsterId = allocated[1];
    const snapshot = capturedSnapshot(captured, allocated[0]);
    if (party.length < PARTY_LIMIT) party.push(snapshot);
    else if (kennel.length < KENNEL_LIMIT) kennel.push(snapshot);
    ext = registerCaughtMonster(ext, captured.slug);
  }
  const history = [...state.ext.history];
  if (state.battle.kind === "trainer") {
    const outcome = result.battleLastResult as "won" | "lost" | "draw";
    const opponentOutcome = outcome === "won" ? "lost" : outcome === "lost" ? "won" : "draw";
    history.push(
      { fighter: "player", opponent: state.battle.opponent, outcome },
      { fighter: state.battle.opponent, opponent: "player", outcome: opponentOutcome },
    );
  }
  return {
    ...ext,
    party,
    kennel,
    ...(kennel.length > 0 ? { kennelBox: true as const } : {}),
    runAttempts: state.battle.runAttempts,
    history,
    nextMonsterId,
  };
}

function enumCode(enums: VariableEnums, variable: string, value: string): number {
  const index = enums[variable]?.indexOf(value) ?? -1;
  if (index < 0) throw new Error(`Tuxemon battle variable enum lacks ${variable}:${value}`);
  return index + 1;
}

function completionFor(state: RuntimeBattleState, enums: VariableEnums): BattleCompletion {
  const result = state.battle.result;
  if (!result) throw new Error("Tuxemon battle ended without a result");
  const ext = completedExtension(state);
  const kitResult = result.outcome === "won" ? "win"
    : result.outcome === "lost" ? "lose"
      : result.outcome === "draw" ? "draw" : "escape";
  const moveGold = Math.max(0, boundedInteger(result.gold, "gold"));
  const prize = Math.max(0, boundedInteger(result.prize, "prize"));
  // Upstream (_handle_win) diverts a share of the prize to pay down the
  // winner's bills before the remainder reaches the wallet, and only for a
  // trainer-battle win. Move gold lands in the wallet directly (upstream's
  // modify_money) and is never shared; wild battles, losses and draws carry
  // no prize, so their bills are untouched.
  const trainerWin = state.battle.kind === "trainer" && result.outcome === "won";
  const shared = trainerWin
    ? applyBattleSharesToBills(ext.bills, prize)
    : { bills: ext.bills, earnings: prize };
  const gold = state.startingGold + moveGold + shared.earnings;
  if (!Number.isFinite(gold)) throw new Error("Tuxemon battle gold is not finite");
  const sharedExt = packTuxemonExtensionState({ ...ext, bills: shared.bills });
  const built = {
    ext: sharedExt,
    result: kitResult,
    items: { ...state.battle.inventory },
    gold,
  } as const;
  if (state.battle.kind !== "trainer") {
    return {
      ...built,
      writes: {
        "v.battle_last_result": enumCode(enums, "battle_last_result", result.battleLastResult),
      },
    };
  }

  const opponent = state.battle.opponent;
  const outcome = result.battleLastResult as "won" | "lost" | "draw";
  const count = ext.history.filter((entry) =>
    entry.fighter === "player" && entry.opponent === opponent && entry.outcome === outcome
  ).length;
  const writes: Record<string, number> = {
    "v.battle_last_result": enumCode(enums, "battle_last_result", outcome),
    "v.battle_last_trainer": enumCode(enums, "battle_last_trainer", opponent),
    [`boc.${opponent}.${outcome}`]: count,
  };
  if (outcome !== "draw") {
    const winner = outcome === "won" ? "player" : opponent;
    const loser = outcome === "won" ? opponent : "player";
    writes["v.battle_last_winner"] = enumCode(enums, "battle_last_winner", winner);
    writes["v.battle_last_loser"] = enumCode(enums, "battle_last_loser", loser);
  }
  const switches: Record<string, boolean> = { [`bo.${opponent}.${outcome}`]: true };
  if (outcome === "won") switches[`defeated.${opponent}`] = true;
  else if (outcome === "lost") switches["defeated.player"] = true;
  return { ...built, writes, switches };
}

/** Snapshot the per-monster progression values a decision may change, so
 *  the presentation can interpolate XP/level gains on the faint beat. */
function progressionSnapshot(state: TuxemonBattleState): Map<number, { level: number; totalExperience: number; maxHp: number }> {
  return new Map(state.parties.flat().map((monster) => [monster.uid, {
    level: monster.level,
    totalExperience: monster.totalExperience,
    maxHp: monster.base.hp,
  }]));
}

/** Record the rewards a decision produced into presentationRewards, matching
 *  the player technique path so the UI interpolates XP/level gains. Shared by
 *  the player menu and the spectator auto-advance. */
function recordDecisionRewards(
  state: RuntimeBattleState,
  rewardCount: number,
  beforeProgression: Map<number, { level: number; totalExperience: number; maxHp: number }>,
): void {
  if (state.battle.rewards.length > rewardCount) state.presentationRewards = [...state.presentationRewards];
  for (const reward of state.battle.rewards.slice(rewardCount)) {
    const eventIndex = state.battle.events.findIndex((event, eventIndex) =>
      eventIndex >= state.eventCursor && event.type === "faint" && event.monster === reward.loser
    );
    state.presentationRewards.push({
      eventIndex,
      loser: reward.loser,
      winners: reward.winners.map((winner) => {
        const before = beforeProgression.get(winner.uid);
        const after = state.battle.parties.flat().find((monster) => monster.uid === winner.uid);
        if (!before || !after) throw new Error(`Tuxemon battle reward references unknown winner ${winner.uid}`);
        return {
          uid: winner.uid,
          effectiveExperience: winner.effectiveExperience,
          levelsGained: winner.levelsGained,
          before,
          after: {
            level: after.level,
            totalExperience: after.totalExperience,
            maxHp: after.base.hp,
          },
        };
      }),
    });
  }
}

/** Run a spectator battle from its current state to the ended phase, driving
 *  both sides through the seeded AI policy (choice 0 is ignored when the
 *  battle policy is "ai"). This is the skip path: the presentation then jumps
 *  straight to the end beat. */
function runSpectatorToCompletion(rulesDb: TuxemonBattleDb, battle: TuxemonBattleState): TuxemonBattleState {
  let current = battle;
  for (let guard = 0; current.phase !== "ended" && guard < 10_000; guard++) {
    if (!current.awaiting) throw new Error(`battle: stalled in ${current.phase}`);
    current = reduceBattle(rulesDb, current, { type: "technique", choice: 0 });
  }
  if (current.phase !== "ended") throw new Error("battle: decision limit exceeded");
  return current;
}

/** Completion for a spectator (NPC-versus-NPC) battle. Writes the same
 *  battle_last_* variables as the headless tux.npc_battle resolver, using the
 *  importer-computed enum codes, and pushes the fighter/foe history pair. The
 *  player's party and wallet are untouched. */
function spectatorCompletion(state: RuntimeBattleState): BattleCompletion {
  const result = state.battle.result;
  if (!result) throw new Error("Tuxemon battle ended without a result");
  const info = state.spectator!;
  const outcome = result.battleLastResult as "won" | "lost" | "draw";
  const history = [...state.ext.history];
  if (outcome === "won") {
    history.push({ fighter: info.fighter, opponent: info.foe, outcome: "won" });
    history.push({ fighter: info.foe, opponent: info.fighter, outcome: "lost" });
  } else if (outcome === "lost") {
    history.push({ fighter: info.foe, opponent: info.fighter, outcome: "won" });
    history.push({ fighter: info.fighter, opponent: info.foe, outcome: "lost" });
  } else {
    history.push({ fighter: info.fighter, opponent: info.foe, outcome: "draw" });
    history.push({ fighter: info.foe, opponent: info.fighter, outcome: "draw" });
  }
  const writes: Record<string, number> = {};
  if (outcome !== "draw") {
    const fighterWon = outcome === "won";
    writes["v.battle_last_winner"] = fighterWon ? info.codes.fighterWinnerCode : info.codes.foeWinnerCode;
    writes["v.battle_last_loser"] = fighterWon ? info.codes.foeLoserCode : info.codes.fighterLoserCode;
    // Upstream's loser handling overwrites the winner's trainer write, so the
    // stable trainer value is the loser's code.
    writes["v.battle_last_trainer"] = fighterWon ? info.codes.foeTrainerCode : info.codes.fighterTrainerCode;
  } else {
    writes["v.battle_last_result"] = info.codes.drawCode;
    writes["v.battle_last_trainer"] = info.codes.fighterTrainerCode;
  }
  return {
    ext: packTuxemonExtensionState({ ...state.ext, history }),
    result: outcome === "won" ? "win" : outcome === "lost" ? "lose" : "draw",
    writes,
  };
}

/** One host-frame fold for a spectator battle. The presentation advances at
 *  the current speed multiplier; when it finishes and the battle is awaiting
 *  a decision, the next AI move is made immediately (both sides run on the
 *  "ai" policy, so choice 0 is ignored by the reducer). confirmEdge cycles
 *  the speed 1→2→4→1; cancelEdge skips the remaining decisions and plays
 *  only the end beat. The player cannot open menus or influence the fight. */
function stepSpectatorBattle(
  previous: RuntimeBattleState,
  input: Readonly<BattleInput>,
  ticks: number,
  resources: () => { db: BattleDb; rulesDb: TuxemonBattleDb },
): JsonValue {
  const state = { ...previous };
  const info = state.spectator!;

  // Skip: run the remaining decisions headlessly and jump the presentation
  // to the end so the next done() call completes the battle.
  if (input.cancelEdge === true && state.battle.phase !== "ended") {
    state.battle = runSpectatorToCompletion(resources().rulesDb, state.battle);
    state.eventCursor = state.battle.events.length;
    state.eventTicks = 0;
    return asJson(state);
  }

  // Fast-forward: cycle the presentation speed multiplier.
  if (input.confirmEdge === true) {
    const nextSpeed = info.speed === 1 ? 2 : info.speed === 2 ? 4 : 1;
    state.spectator = { ...info, speed: nextSpeed };
  }

  // Advance the presentation at the current speed.
  if (!presentationDone(state)) {
    advancePresentation(state, ticks * state.spectator!.speed, false);
  }

  // Auto-decide: when the presentation has caught up and the battle is
  // awaiting a decision, make the next AI move so the fight progresses
  // without player input.
  if (presentationDone(state) && state.battle.phase !== "ended" && state.battle.awaiting) {
    const { rulesDb } = resources();
    const rewardCount = state.battle.rewards.length;
    const beforeProgression = progressionSnapshot(state.battle);
    state.battle = reduceBattle(rulesDb, state.battle, { type: "technique", choice: 0 });
    recordDecisionRewards(state, rewardCount, beforeProgression);
    state.eventTicks = 0;
  }

  return asJson(state);
}

/**
 * Game-owned adapter between Pocket RPG Kit's Battle Processing lifecycle and
 * the deterministic Tuxemon reducer. Every mutable byte is carried in the
 * returned JSON state; no module-level cursor or clock participates.
 */
export function createTuxemonBattleRules(source: BattleDbSource, enums: VariableEnums): BattleRules {
  let active: { db: BattleDb; rulesDb: TuxemonBattleDb } | null = null;
  // Plain databases and non-releasing providers are immutable for the
  // registration lifetime. Keep their converted rule view (including its
  // lazy per-slug caches) across battles; rebuilding it at every exit made a
  // long journey repeatedly allocate the element/taste/shape tables and
  // eventually pushed QuickJS transition frames over budget. Function
  // sources and explicitly releasing providers retain the old acquire/release
  // lifecycle because they are allowed to return a different database.
  const reusable = typeof source !== "function"
    && (!("load" in source) || source.release === undefined);
  const resources = () => {
    if (active) return active;
    const db = resolveBattleDb(source);
    active = { db, rulesDb: battleDbToTuxemonBattleDb(db) };
    return active;
  };
  const release = () => {
    if (reusable) return;
    active = null;
    releaseBattleDb(source);
  };
  return {
    immutableState: true,
    start(extValue, setupValue, seed, context: ExtensionReadContext) {
      // A releasable/dynamic source may have changed since the prior battle.
      // Stable providers keep the same lazy view and its warmed shard cache.
      if (!reusable) active = null;
      const { db, rulesDb } = resources();
      try {
        const ext = tuxemonExtensionState(extValue, db);
        let setup = parseSetup(setupValue, db, ext.environment);
        // Spectator battles pit two NPC parties against each other; the
        // player's own party is irrelevant and may be empty.
        if (setup === null || (setup.kind !== "spectate" && !legalParty(ext.party))) {
          release();
          return null;
        }

        const rng: RngState = { rng: seed >>> 0, rngDraws: 0 };
        let opponent: string;
        let enemy: SpawnedMonsterSnapshot[];
        let kind: "trainer" | "wild";
        let startedExt = clone(ext);
        let playerParty: SpawnedMonsterSnapshot[] = ext.party;
        let spectatorInfo: SpectatorInfo | null = null;

        if (setup.kind === "trainer") {
          opponent = setup.opponent;
          kind = "trainer";
          const staged = ext.npcParties[opponent] ?? [];
          const inline = setup.party ?? [];
          if (staged.length + inline.length === 0) {
            release();
            return null;
          }
          // Upstream keeps an NPC's party for the NPC's lifetime: the
          // monsters the event added (folded into setup.party) join the ones
          // already staged for this NPC, capped at the party limit like
          // upstream's add_monster, and the merged party stays in npcParties
          // so later get_party_monster / remove_monster commands can address
          // them. The importer clears every NPC party on a map change
          // (tux.clear_npc_parties) and this NPC's when it is created afresh
          // or removed (tux.clear_npc_party), so a later visit's battle
          // starts from that visit's add_monster calls only.
          let nextMonsterId = ext.nextMonsterId;
          const persistedParty: PendingMonster[] = staged.map((member) => ({ ...member }));
          for (const member of inline) {
            if (persistedParty.length >= PARTY_LIMIT) break;
            const [iid, following] = nextMonsterIid(nextMonsterId);
            nextMonsterId = following;
            persistedParty.push({
              iid,
              slug: member.species,
              level: member.level,
              experienceModifier: member.experienceModifier ?? 1,
              moneyModifier: member.moneyModifier ?? 0,
            });
          }
          enemy = persistedParty.map((member) => enemySnapshot(db, rulesDb, rng, member));
          if (setup.fieldSize === 2 && ext.party.length + enemy.length < 3) {
            release();
            return null;
          }
          startedExt = clone({
            ...ext,
            npcParties: { ...ext.npcParties, [opponent]: persistedParty },
            nextMonsterId,
          });
        } else if (setup.kind === "wild") {
          opponent = `wild:${setup.species}`;
          kind = "wild";
          enemy = [enemySnapshot(db, rulesDb, rng, {
            species: setup.species,
            level: setup.level,
            experienceModifier: setup.experienceModifier,
            moneyModifier: setup.moneyModifier,
          })];
        } else if (setup.kind === "random") {
          if (nextRandom(rng) * 100 > (setup.probability ?? 1)) {
            release();
            return null;
          }
          // Upstream filters encounter rows by the live clock's daytime
          // (update_time: 6 <= hour < 18 is day). Resolve it from the saved
          // calendar instead of the old hard-coded "true", so night-only rows
          // are eligible at night. The battle hour follows the same clock.
          const clockHour = Math.floor(ext.clock.minuteOfDay / 60);
          const variables: Record<string, string | number | boolean> = {
            ...(setup.variables ?? {}),
          };
          if (variables.daytime === undefined) {
            variables.daytime = clockHour >= 6 && clockHour < 18 ? "true" : "false";
          }
          const row = weightedEncounter(rng, encounterRows(db, setup.table, variables));
          const chosenLevel = randomLevel(rng, row.level);
          opponent = `wild:${row.monster}`;
          kind = "wild";
          enemy = [enemySnapshot(db, rulesDb, rng, {
            species: row.monster,
            level: chosenLevel,
            experienceModifier: row.experienceModifier,
            moneyModifier: 0,
          })];
          setup = { ...setup, hour: setup.hour ?? clockHour };
        } else {
          // Spectator (NPC-versus-NPC) battle. Spawn both staged parties on
          // the local cursor starting from the saved seed, then create the
          // battle with the post-spawn cursor — the same RNG economy as the
          // headless tux.npc_battle resolver, so the outcome is identical.
          const spectate = setup;
          const fighterParty = ext.npcParties[spectate.fighter] ?? [];
          const foeParty = ext.npcParties[spectate.foe] ?? [];
          if (fighterParty.length === 0 || foeParty.length === 0) {
            release();
            return null;
          }
          const fighterSnapshots = fighterParty.map((member) => enemySnapshot(db, rulesDb, rng, member));
          const foeSnapshots = foeParty.map((member) => enemySnapshot(db, rulesDb, rng, member));
          if (!legalParty(fighterSnapshots) || !legalParty(foeSnapshots)) {
            release();
            return null;
          }
          opponent = spectate.foe;
          kind = "trainer";
          enemy = foeSnapshots;
          playerParty = fighterSnapshots;
          spectatorInfo = {
            fighter: spectate.fighter,
            foe: spectate.foe,
            speed: 1,
            codes: {
              fighterWinnerCode: spectate.fighterWinnerCode,
              foeWinnerCode: spectate.foeWinnerCode,
              fighterLoserCode: spectate.fighterLoserCode,
              foeLoserCode: spectate.foeLoserCode,
              fighterTrainerCode: spectate.fighterTrainerCode,
              foeTrainerCode: spectate.foeTrainerCode,
              drawCode: spectate.drawCode,
            },
          };
        }
        if (!legalParty(enemy)) {
          release();
          return null;
        }

        let parkInfo: ParkBattleInfo | null = null;
        if (kind === "wild" && ext.parkSession?.active
          && (setup.environment === "park" || setup.environment === "night_park")) {
          const parkMonster = enemy[0]!.slug;
          const parkSession = recordParkSighting(startedExt.parkSession ?? ext.parkSession, parkMonster);
          startedExt = clone({ ...startedExt, parkSession });
          parkInfo = {
            monster: parkMonster,
            turnsRemaining: PARK_ENCOUNTER_TURNS,
            fleeRate: enemy[0]!.base.speed > 80 ? 0.1 : 0.05,
            monsterFled: false,
          };
        }

        const battle = createBattle(rulesDb, {
          seed: rng.rng,
          kind,
          opponent,
          player: playerParty,
          enemy,
          inside: setup.inside,
          hour: setup.hour,
          weather: ext.weather.slug,
          fieldSize: setup.kind === "trainer" ? setup.fieldSize ?? 1 : 1,
          moneyMethod: "conserved",
          inventory: context.items,
          runAttempts: ext.runAttempts,
          // Spectator battles run both sides on the seeded AI policy. The
          // cast mirrors tux.npc_battle: PlayerPolicy is "first"|"cycle" but
          // the reducer's selectAction accepts "ai" at runtime.
          ...(spectatorInfo ? { policy: "ai" as unknown as "first" } : {}),
        });
        const environment = setup.environment ?? ext.environment!;
        const battleEnvironment = db.environments[environment] ?? db.environments.grass;
        if (!battleEnvironment?.background || !battleEnvironment.island) {
          throw new Error(`Tuxemon battle environment '${environment}' has incomplete presentation art`);
        }
        const monsters = Object.fromEntries(
          battle.parties.flat().map((monster) => [monster.slug, db.monsters[monster.slug]!.art]),
        );
        const techniqueSlugs = new Set(battle.parties.flat().flatMap((monster) => [
          monster.fallback,
          ...monster.moves.map((move) => move.slug),
        ]));
        const techniques = Object.fromEntries([...techniqueSlugs].map((slug) => {
          const technique = db.techniques[slug]!;
          return [slug, {
            range: technique.range,
            types: [...technique.types],
            messages: technique.messages,
            ...(technique.animation ? { animation: technique.animation } : {}),
          }];
        }));
        const items = Object.fromEntries(Object.keys(context.items).map((slug) => {
          const item = db.items[slug];
          return [slug, {
            ...(item?.captureSprite ? { captureSprite: item.captureSprite } : {}),
            ...(item?.animation ? { animation: item.animation } : {}),
          }];
        }));
        const indexedStatusIcons = typeof source !== "function" && "load" in source
          ? source.statusIcons
          : undefined;
        const statusIcons = indexedStatusIcons
          ? { ...indexedStatusIcons }
          : Object.fromEntries(Object.entries(db.statuses).flatMap(([slug, status]) =>
            status.icon ? [[slug, status.icon] as const] : []
          ));
        const state: RuntimeBattleState = {
          format: TUXEMON_BATTLE_STATE_FORMAT,
          battle,
          ext: startedExt,
          startingGold: context.gold,
          environment,
          visuals: {
            environment: battleEnvironment,
            ui: { hpBar: db.ui.hpBar, expBar: db.ui.expBar },
            trainers: spectatorInfo
              ? {
                  player: db.npcs?.[spectatorInfo.fighter]?.art ?? null,
                  opponent: db.npcs?.[spectatorInfo.foe]?.art ?? null,
                }
              : {
                  // The player's battle back-sheet follows the race choice:
                  // set_template's combat_sheet is saved as the appearance
                  // baseline (defaultCombatSheet), with a runtime override
                  // (combatSheet); absent either, the baked adventurer sheet.
                  player: db.ui.trainerSheets[
                    context.playerAppearance?.combatSheet
                      ?? context.playerAppearance?.defaultCombatSheet
                      ?? "adventurer"
                  ] ?? db.ui.trainerSheets.adventurer ?? null,
                  opponent: db.npcs?.[opponent]?.art ?? null,
                },
            monsters,
            techniques,
            items,
            statusIcons,
          },
          presentationRewards: [],
          menu: [],
          menuMode: "root",
          eventCursor: 0,
          eventTicks: 0,
          menuIndex: 0,
          ...(spectatorInfo ? { spectator: spectatorInfo } : {}),
          ...(parkInfo ? { park: parkInfo } : {}),
        };
        state.menu = battleMenuEntries(state, rulesDb, "root");
        return { state: asJson(state), ext: packTuxemonExtensionState(startedExt) };
      } catch (error) {
        release();
        throw error;
      }
    },

    step(value, input: Readonly<BattleInput>, ticks) {
      if (!safeInteger(ticks) || ticks < 0) throw new Error("Tuxemon battle ticks must be non-negative integer");
      const previous = runtimeState(value);
      if (previous.spectator) {
        return stepSpectatorBattle(previous, input, ticks, resources);
      }
      if (!presentationDone(previous)) {
        const state = { ...previous };
        advancePresentation(state, ticks, input.confirmEdge === true);
        return asJson(state);
      }
      if (previous.battle.phase === "ended" || !previous.battle.awaiting) return value;
      if (!input.confirmEdge && !input.cancelEdge && !input.upEdge && !input.downEdge) return value;
      const state = { ...previous };

      const { rulesDb } = resources();
      const choices = state.menu;
      if (input.cancelEdge && state.menuMode !== "root") {
        setMenu(state, rulesDb, "root");
        return asJson(state);
      }
      if (choices.length === 0) return asJson(state);
      if (input.upEdge) state.menuIndex = movedMenuIndex(choices, state.menuIndex, -1);
      if (input.downEdge) state.menuIndex = movedMenuIndex(choices, state.menuIndex, 1);
      if (input.confirmEdge) {
        const index = Math.min(state.menuIndex, choices.length - 1);
        const selected = choices[index]!;
        if (!selected.available) return asJson(state);
        if (state.park && state.menuMode === "root") {
          if (selected.kind === "capture") {
            // Upstream checks whether the wild monster flees immediately
            // before enqueueing the Park Ball. A flee consumes no item.
            const battle = cloneBattleState(state.battle);
            const roll = nextRandom(battle);
            if (state.park.turnsRemaining === 0 || roll < state.park.fleeRate) {
              const target = getMonster(battle, selected.target!);
              const user = getMonster(battle, battle.awaiting!.uid);
              battle.events.push({
                type: "run",
                turn: battle.turn,
                user: target.uid,
                target: user.uid,
                chance: state.park.fleeRate,
                roll,
                success: true,
                runAttempts: battle.runAttempts,
              });
              state.park = { ...state.park, monsterFled: true };
              state.battle = endBattle(battle, makeRules(rulesDb), "ran");
            } else {
              state.battle = reduceBattle(rulesDb, battle, {
                type: "capture",
                item: "tuxeball_park",
                target: selected.target!,
                menuState: "MainParkMenuState",
              });
              state.ext = {
                ...state.ext,
                parkSession: recordParkCapture(
                  state.ext.parkSession!,
                  state.park.monster,
                  state.battle.capturedUid !== null,
                  state.park.turnsRemaining,
                ),
              };
            }
          } else if (selected.kind === "run") {
            // Park Run always leaves the encounter; it is not ordinary combat's
            // level-based escape roll.
            const battle = cloneBattleState(state.battle);
            const user = getMonster(battle, battle.awaiting!.uid);
            const target = activeOpponents(battle, user.uid)[0]!;
            battle.events.push({
              type: "run",
              turn: battle.turn,
              user: user.uid,
              target: target.uid,
              chance: 1,
              roll: 0,
              success: true,
              runAttempts: battle.runAttempts,
            });
            state.battle = endBattle(battle, makeRules(rulesDb), "ran");
          }
          state.eventTicks = 0;
          setMenu(state, rulesDb, "root");
          return asJson(state);
        }
        if (state.menuMode === "root" && selected.kind !== "run" && selected.kind !== "forfeit") {
          const mode = selected.kind === "fight" ? "technique"
            : selected.kind === "replacement" ? "swap"
              : selected.kind;
          setMenu(state, rulesDb, mode);
          return asJson(state);
        }
        const rewardCount = state.battle.rewards.length;
        const beforeProgression = progressionSnapshot(state.battle);
        if (selected.kind === "technique") {
          state.battle = reduceBattle(rulesDb, state.battle, { type: "technique", choice: index });
        } else if (selected.kind === "item" || selected.kind === "capture") {
          state.battle = reduceBattle(rulesDb, state.battle, {
            type: selected.kind,
            item: selected.slug,
            target: selected.target!,
          });
        } else if (selected.kind === "replacement") {
          state.battle = reduceBattle(rulesDb, state.battle, { type: "replacement", uid: selected.target! });
        } else if (selected.kind === "run") {
          state.battle = reduceBattle(rulesDb, state.battle, { type: "run" });
        }
        recordDecisionRewards(state, rewardCount, beforeProgression);
        state.eventTicks = 0;
        setMenu(state, rulesDb, "root");
      }
      return asJson(state);
    },

    done(value) {
      const state = runtimeState(value);
      if (state.battle.phase !== "ended" || !presentationDone(state)) return null;
      try {
        return state.spectator ? spectatorCompletion(state) : completionFor(state, enums);
      } finally {
        release();
      }
    },
  };
}

export function currentBattleEvent(state: RuntimeBattleState): BattleEvent | null {
  return state.battle.events[state.eventCursor] ?? null;
}

/** Test/UI helper: validates and narrows the opaque scene JSON. */
export function tuxemonRuntimeBattleState(value: JsonValue): RuntimeBattleState {
  return runtimeState(value);
}

/** Allows isolated renderer fixtures to start from a valid empty extension. */
export function emptyRuntimeExtension(): JsonValue {
  return packTuxemonExtensionState(initialTuxemonExtensionState());
}

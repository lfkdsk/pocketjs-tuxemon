import type {
  ExtensionCommandContext,
  ExtensionOptions,
  ExtensionReadContext,
} from "../vendor/pocket-rpgkit/src/engine/extensions.ts";
import type { JsonValue } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import type { BattleDb, BattleImageRef } from "../importer/battle-schema.ts";
import { type RngState } from "./core.ts";
import {
  DAYLIGHT_STAGE_VARIABLE,
  DAYLIGHT_TARGET_VARIABLE,
  DAYLIGHT_TINT_PROFILES,
} from "./daylight.ts";
import { advanceDaycareStep } from "./daycare.ts";
import {
  formatVariableCommand,
  setVariableTextCommand,
  variableMathCommand,
  variableTextCondition,
} from "./text-variables.ts";
import {
  addStepTracker,
  markMilestoneShown,
  milestonePending,
  removeStepTracker,
  stepCharacterTrackers,
  stepTrackersProblem,
  type StepTrackers,
} from "./step-tracker.ts";
import { battleDbToTuxemonBattleDb } from "./from-battle-db.ts";
import { evolveMonsterSnapshot } from "./progression.ts";
import { applyPendingOverrides, spawnMonster, spawnMonsterWithRandom } from "./spawn.ts";
import { runPolicyBattle } from "./tuxemon.ts";
import {
  advanceClock,
  advanceTimeWeather,
  DEFAULT_WEATHER_SLUGS,
  initialTimeWeatherState,
  stageOfDayFromMinute,
  timeIs,
  timeWeatherProblem,
  updateTimeWrites,
  type ClockState,
  type Hemisphere,
  type TimeWeatherState,
  type WeatherSchedule,
  type WeatherState,
} from "./time-weather.ts";
import type { DaycareExtensionState, SpawnedMonsterSnapshot, Stats } from "./types.ts";
import { STAT_NAMES } from "./types.ts";

export const PARTY_LIMIT = 6;
export const KENNEL_LIMIT = 30;
/** Upstream MAX_LOCKER: at most 30 distinct item types per PC item box. */
export const LOCKER_LIMIT = 30;
/** Upstream item quantities are plain ints; the kit backpack caps a single
 *  item id at SHOP_ITEM_CAP (99), so the locker uses the same bound. */
export const LOCKER_ITEM_CAP = 99;
export const TUXEMON_EXT_SAVE_FORMAT = "pocket-tuxemon/ext/v1";
const TUXEMON_EXT_RUNTIME_PREFIX = "pocket-tuxemon/ext-runtime/v1:";
export const TUXEMON_EXT_RUNTIME_V2_PREFIX = "pocket-tuxemon/ext-runtime/v2:";

interface TuxemonRuntimeEnvelope {
  wire: string;
  coreWire: string;
  corePrefix: string;
  refTick: number;
  epochDay: number;
  minuteOfDay: number;
  subMinuteTicks: number;
  ticksPerGameMinute: number;
  weatherSlug: string;
  weatherSlugWire: string;
  weatherEnteredAtTick: number;
  weatherNextTransitionTick: number;
  weatherRngCursor: number;
}

/** Forward-compatible cache contract consumed by the reducer optimization.
 * Older kit revisions accept the registration structurally and ignore the
 * extra hook; the companion engine patch gives it meaning. */
export interface TuxemonExtensionOptions extends ExtensionOptions {
  conditionCacheKey(value: JsonValue): unknown;
  entryConditionCacheKey(context: ExtensionReadContext, call?: string, args?: JsonValue): unknown;
}

export interface PendingMonster {
  iid: string;
  slug: string;
  level: number;
  experienceModifier: number;
  moneyModifier: number;
  /** Upstream set_monster_attribute overrides, applied at battle snapshot. */
  gender?: string;
  acquisition?: string;
  nickname?: string;
  /** Extra techniques taught by add_tech before the battle (deduped). */
  moves?: string[];
  /** Upstream set_monster_health override, applied at battle snapshot. */
  health?: { kind: "full" | "fraction" | "points"; value: number };
  /** Upstream set_monster_status override, applied at battle snapshot. */
  status?: string | null;
}

export interface BattleHistoryEntry {
  fighter: string;
  opponent: string;
  outcome: "won" | "lost" | "draw";
}

export interface FaintPoint {
  map: string;
  x: number;
  y: number;
}

export interface BillEntry {
  amount: number;
  /** Upstream set_bill interest_rate (e.g. 0.1 = 10%): applied per
   *  adjust_bill_penalty interest trigger, truncating, compounding. */
  interestRate?: number;
  /** Upstream set_bill late_fee: a flat amount added per fee trigger. */
  lateFee?: number;
  /** Upstream set_bill share_rate (e.g. 0.5 = 50%): the fraction of
   *  trainer-battle winnings diverted to pay this bill down. */
  shareRate?: number;
}

export interface TuxemonExtensionState {
  version: 1;
  party: SpawnedMonsterSnapshot[];
  kennel: SpawnedMonsterSnapshot[];
  /** Seen-only Tuxepedia entries. Caught species live in `caught` instead. */
  seen: string[];
  caught: string[];
  /** Upstream keeps failed escape attempts on the player between battles. */
  runAttempts: number;
  npcParties: Record<string, PendingMonster[]>;
  history: BattleHistoryEntry[];
  /** Active Tuxemon battle backdrop; null matches an unloaded environment. */
  environment: string | null;
  faintPoints: Record<string, FaintPoint>;
  nextMonsterId: number;
  /** Per-monster plague state, keyed by iid: plagueSlug -> infected|inoculated|carrier|recovered. */
  plagueByIid: Record<string, Record<string, string>>;
  /** Per-character debt tabs: billSlug -> entry. */
  bills: Record<string, Record<string, BillEntry>>;
  /** Deterministic virtual calendar; advanced only by active world ticks. */
  clock: ClockState;
  /** Saved weather stream, deliberately independent from the battle RNG. */
  weather: WeatherState;
  /** Sparse: present once the player's main "Kennel" box exists. Upstream
   *  creates it on the first PC visit or the first party overflow; its
   *  monsters always live in `kennel`. */
  kennelBox?: true;
  /** Sparse named boxes other than the main Kennel, in creation order
   *  (for example the story's hidden "quarantine" box). */
  boxes?: Record<string, MonsterBox>;
  /** Sparse monster-shop sales per `<economy>:<slug>` stock label. */
  shopSold?: Record<string, number>;
  /** Sparse PC item locker: saved item stacks keyed by item slug, matching
   *  the session backpack's `Record<slug, quantity>` shape. Upstream creates
   *  the "Locker" item box on the first PC visit; it holds at most
   *  LOCKER_LIMIT distinct item types. */
  itemLocker?: Record<string, number>;
  /** Sparse two-slot daycare, created on first deposit. */
  daycare?: DaycareExtensionState;
  /** Sparse per-character step trackers (character -> tracker id). */
  stepTrackers?: StepTrackers;
}

export interface MonsterBox {
  /** Hidden boxes are excluded from PC storage menus. */
  hidden: boolean;
  capacity: number;
  monsters: SpawnedMonsterSnapshot[];
}

export const KENNEL_BOX = "Kennel";
/** The story's hidden plague box; `tux.create_kennel` builds it from the
 *  spyder scenario and `tux.quarantine` creates it lazily, matching upstream. */
export const QUARANTINE_BOX = "quarantine";

/** True when the player's main Kennel box exists (upstream `has_box`). */
export function kennelExists(state: Readonly<TuxemonExtensionState>): boolean {
  return state.kennelBox === true || state.kennel.length > 0;
}

export interface TuxemonExtensionRuntimeOptions {
  /** Fresh-game clock/weather sampled or fixed by the effect shell. */
  initialTimeWeather?: TimeWeatherState;
  /** Imported weather slugs and deterministic duration bounds. */
  weatherSchedule?: WeatherSchedule;
  hemisphere?: Hemisphere;
  /** Content language the save is written with; recorded in the encoded ext
   *  so a load in the other language can be refused with a clear message. */
  lang?: GameLang;
}

/** The game's content languages. Kept in the battle layer so the save codec
 *  and the runtime share one type without a UI dependency. */
export type GameLang = "en_US" | "zh_CN";

export interface BattleDbProvider {
  load(): BattleDb;
  release?(): void;
  /** Stable shell projection used by presentation without forcing all status
   * rule shards to parse. Key order matches the canonical status index. */
  readonly statusIcons?: Readonly<Record<string, BattleImageRef>>;
}

export type BattleDbSource = BattleDb | (() => BattleDb) | BattleDbProvider;

export function resolveBattleDb(source: BattleDbSource): BattleDb {
  if (typeof source === "function") return source();
  return "load" in source ? source.load() : source;
}

export function releaseBattleDb(source: BattleDbSource): void {
  if (typeof source !== "function" && "load" in source) source.release?.();
}

export function initialTuxemonExtensionState(
  timeWeather: Readonly<TimeWeatherState> = initialTimeWeatherState(),
): TuxemonExtensionState {
  return {
    version: 1,
    party: [],
    kennel: [],
    seen: [],
    caught: [],
    runAttempts: 0,
    npcParties: {},
    history: [],
    environment: null,
    faintPoints: {},
    nextMonsterId: 1,
    plagueByIid: {},
    bills: {},
    clock: { ...timeWeather.clock },
    weather: { ...timeWeather.weather },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function safeInteger(value: unknown): value is number {
  return finite(value) && Number.isSafeInteger(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function statsProblem(value: unknown, label: string): string | null {
  const object = record(value);
  if (!object) return `${label} must be an object`;
  for (const stat of STAT_NAMES) {
    if (!safeInteger(object[stat]) || (object[stat] as number) < 0) {
      return `${label}.${stat} must be a non-negative safe integer`;
    }
  }
  return null;
}

function monsterProblem(value: unknown, label: string, db?: BattleDb): string | null {
  const monster = record(value);
  if (!monster) return `${label} must be an object`;
  if (!nonEmptyString(monster.iid)) return `${label}.iid must be a non-empty string`;
  if (!nonEmptyString(monster.slug) || (db && !(monster.slug in db.monsters))) {
    return `${label}.slug must name an imported monster`;
  }
  if (monster.nickname !== undefined
    && (!nonEmptyString(monster.nickname) || monster.nickname.length > 15)) {
    return `${label}.nickname must contain 1..15 characters`;
  }
  if (!safeInteger(monster.level) || monster.level < 1) return `${label}.level must be a positive safe integer`;
  for (const field of ["stage", "gender", "tasteCold", "tasteWarm"] as const) {
    if (!nonEmptyString(monster[field])) return `${label}.${field} must be a non-empty string`;
  }
  for (const field of ["motherIid", "fatherIid"] as const) {
    if (monster[field] !== undefined && !nonEmptyString(monster[field])) {
      return `${label}.${field} must be a non-empty string when present`;
    }
  }
  for (const field of ["height", "weight", "experienceModifier", "moneyModifier", "bond"] as const) {
    if (!finite(monster[field])) return `${label}.${field} must be finite`;
  }
  if (!Array.isArray(monster.birthdate)
    || monster.birthdate.length !== 2
    || !monster.birthdate.every(safeInteger)) return `${label}.birthdate must be an integer pair`;
  const baseProblem = statsProblem(monster.base, `${label}.base`);
  if (baseProblem) return baseProblem;
  const ivProblem = statsProblem(monster.individualValues, `${label}.individualValues`);
  if (ivProblem) return ivProblem;
  const tpProblem = statsProblem(monster.trainingPoints, `${label}.trainingPoints`);
  if (tpProblem) return tpProblem;
  const base = monster.base as unknown as Stats;
  if (!safeInteger(monster.currentHp) || monster.currentHp < 0 || monster.currentHp > base.hp) {
    return `${label}.currentHp must be an integer in 0..base.hp`;
  }
  if (!safeInteger(monster.totalExperience) || monster.totalExperience < 0) {
    return `${label}.totalExperience must be a non-negative safe integer`;
  }
  if (!Array.isArray(monster.moves) || !monster.moves.every(nonEmptyString)) {
    return `${label}.moves must contain strings`;
  }
  if (!Array.isArray(monster.types) || !monster.types.every(nonEmptyString)) {
    return `${label}.types must contain strings`;
  }
  if (monster.status !== null && !nonEmptyString(monster.status)) {
    return `${label}.status must be null or a non-empty string`;
  }
  return null;
}

function pendingProblem(value: unknown, label: string, db?: BattleDb): string | null {
  const pending = record(value);
  if (!pending) return `${label} must be an object`;
  if (!nonEmptyString(pending.iid)) return `${label}.iid must be a non-empty string`;
  if (!nonEmptyString(pending.slug) || (db && !(pending.slug in db.monsters))) {
    return `${label}.slug must name an imported monster`;
  }
  if (!safeInteger(pending.level) || pending.level < 1) return `${label}.level must be a positive safe integer`;
  if (!finite(pending.experienceModifier) || !finite(pending.moneyModifier)) {
    return `${label} modifiers must be finite`;
  }
  if (pending.gender !== undefined && !nonEmptyString(pending.gender)) {
    return `${label}.gender must be a non-empty string`;
  }
  if (pending.acquisition !== undefined && !nonEmptyString(pending.acquisition)) {
    return `${label}.acquisition must be a non-empty string`;
  }
  if (pending.nickname !== undefined && !nonEmptyString(pending.nickname)) {
    return `${label}.nickname must be a non-empty string`;
  }
  if (pending.moves !== undefined && (!Array.isArray(pending.moves)
    || !pending.moves.every((move) => nonEmptyString(move) && (!db || move in db.techniques)))) {
    return `${label}.moves must list imported technique slugs`;
  }
  return null;
}

let lastRuntimeEnvelope: TuxemonRuntimeEnvelope | null = null;

function runtimeEnvelope(value: JsonValue): TuxemonRuntimeEnvelope | null {
  if (typeof value !== "string" || !value.startsWith(TUXEMON_EXT_RUNTIME_V2_PREFIX)) return null;
  if (value === lastRuntimeEnvelope?.wire) return lastRuntimeEnvelope;
  const fields = value.slice(TUXEMON_EXT_RUNTIME_V2_PREFIX.length).split("\n");
  if (fields.length !== 10) return null;
  const numbers = [fields[1], fields[2], fields[3], fields[4], fields[5], fields[7], fields[8], fields[9]];
  if (!numbers.every((part) => /^(?:0|[1-9]\d*)$/.test(part!))) return null;
  const parsed = numbers.map(Number);
  if (!parsed.every(Number.isSafeInteger)) return null;
  let weatherSlug: unknown;
  try {
    weatherSlug = JSON.parse(fields[6]!);
  } catch {
    return null;
  }
  if (typeof weatherSlug !== "string") return null;
  const envelope: TuxemonRuntimeEnvelope = {
    wire: value,
    coreWire: fields[0]!,
    corePrefix: `${TUXEMON_EXT_RUNTIME_V2_PREFIX}${fields[0]!}\n`,
    refTick: parsed[0]!,
    epochDay: parsed[1]!,
    minuteOfDay: parsed[2]!,
    subMinuteTicks: parsed[3]!,
    ticksPerGameMinute: parsed[4]!,
    weatherSlug,
    weatherSlugWire: fields[6]!,
    weatherEnteredAtTick: parsed[5]!,
    weatherNextTransitionTick: parsed[6]!,
    weatherRngCursor: parsed[7]!,
  };
  lastRuntimeEnvelope = envelope;
  return envelope;
}

/** Minimal weather/clock view for render-only consumers (the particle
 *  overlay). Parses the packed wire only when it changed; returns null for
 *  legacy object states, which then simply show no overlay. */
export interface WeatherEnvelope {
  slug: string;
  enteredAtTick: number;
  refTick: number;
  minuteOfDay: number;
}

let lastWeatherWire: string | null = null;
let lastWeatherEnvelope: WeatherEnvelope | null = null;

export function weatherEnvelopeAt(value: JsonValue): WeatherEnvelope | null {
  if (typeof value !== "string" || !value.startsWith(TUXEMON_EXT_RUNTIME_V2_PREFIX)) return null;
  if (value === lastWeatherWire) return lastWeatherEnvelope;
  const fields = value.slice(TUXEMON_EXT_RUNTIME_V2_PREFIX.length).split("\n");
  if (fields.length !== 10) return null;
  const numbers = [fields[1], fields[2], fields[3], fields[4], fields[5], fields[7], fields[8], fields[9]];
  if (!numbers.every((part) => /^(?:0|[1-9]\d*)$/.test(part!))) return null;
  const parsed = numbers.map(Number);
  if (!parsed.every(Number.isSafeInteger)) return null;
  let slug: unknown;
  try {
    slug = JSON.parse(fields[6]!);
  } catch {
    return null;
  }
  if (typeof slug !== "string") return null;
  const envelope: WeatherEnvelope = {
    slug,
    enteredAtTick: parsed[5]!,
    refTick: parsed[0]!,
    minuteOfDay: parsed[2]!,
  };
  lastWeatherWire = value;
  lastWeatherEnvelope = envelope;
  return envelope;
}

/** Parse a non-negative base-10 integer from a wire region without
 *  allocating. Returns -1 for an empty region, a non-digit, or an unsafe
 *  value — the same acceptance rule as the /^(?:0|[1-9]\d*)$/ check in
 *  weatherEnvelopeAt (a leading zero is only accepted for the literal "0"). */
function wireRegionInt(value: string, start: number, end: number): number {
  if (end <= start) return -1;
  if (end - start > 1 && value.charCodeAt(start) === 48) return -1;
  let n = 0;
  for (let i = start; i < end; i++) {
    const code = value.charCodeAt(i);
    if (code < 48 || code > 57) return -1;
    n = n * 10 + (code - 48);
  }
  return Number.isSafeInteger(n) ? n : -1;
}

/** Match a JSON-string wire region (the quotes included, e.g. `"rain"`)
 *  against a table of interned slugs without allocating. Returns the
 *  interned slug on match, or "" when the region names no known slug. A
 *  slug with JSON escapes can never match a simple-identifier table entry,
 *  which is the safe "no profile" outcome for the overlay. */
function matchWireSlug(
  value: string,
  start: number,
  end: number,
  knownSlugs: readonly string[],
): string {
  if (end - start < 2 || value.charCodeAt(start) !== 34 || value.charCodeAt(end - 1) !== 34) {
    return "";
  }
  // Index traversal, not for...of: the ESNext bundle keeps the array
  // iterator and QuickJS builds one per call (~4 allocations), and this
  // runs on the overlay's every-frame path.
  for (let tableIndex = 0; tableIndex < knownSlugs.length; tableIndex++) {
    const slug = knownSlugs[tableIndex]!;
    if (end - start !== slug.length + 2) continue;
    let i = 0;
    while (i < slug.length && value.charCodeAt(start + 1 + i) === slug.charCodeAt(i)) i++;
    if (i === slug.length) return slug;
  }
  return "";
}

/**
 * Zero-allocation envelope reader for the particle overlay's per-frame path.
 * `weatherEnvelopeAt` parses the wire into a fresh object and caches it by
 * wire identity, but the packed wire changes every reference tick because it
 * carries the clock, so the cache misses every frame and the parse allocates
 * ~17 objects/frame even when the overlay is hidden. This variant scans the
 * wire with indexOf + charCode arithmetic, validates the same eight numeric
 * fields and the 10-field shape, writes the four fields the overlay needs
 * into a caller-owned `out`, and interns the slug against a caller-provided
 * table (the profile slugs). Returns false for legacy object states and
 * malformed wires, which the overlay treats as "no overlay".
 */
export function weatherEnvelopeInto(
  value: JsonValue,
  out: WeatherEnvelope,
  knownSlugs: readonly string[],
): boolean {
  if (typeof value !== "string" || !value.startsWith(TUXEMON_EXT_RUNTIME_V2_PREFIX)) return false;
  // Field layout (packTuxemonExtensionState): 0 coreWire, 1 refTick,
  // 2 epochDay, 3 minuteOfDay, 4 subMinuteTicks, 5 ticksPerGameMinute,
  // 6 weatherSlugJson, 7 weatherEnteredAtTick, 8 weatherNextTransitionTick,
  // 9 weatherRngCursor. Scan separators with indexOf (no substrings).
  let fieldStart = TUXEMON_EXT_RUNTIME_V2_PREFIX.length;
  let sep = value.indexOf("\n", fieldStart);
  if (sep < 0) return false;
  // Field 1: refTick.
  fieldStart = sep + 1;
  sep = value.indexOf("\n", fieldStart);
  if (sep < 0) return false;
  const refTick = wireRegionInt(value, fieldStart, sep);
  if (refTick < 0) return false;
  // Field 2: epochDay.
  fieldStart = sep + 1;
  sep = value.indexOf("\n", fieldStart);
  if (sep < 0) return false;
  if (wireRegionInt(value, fieldStart, sep) < 0) return false;
  // Field 3: minuteOfDay.
  fieldStart = sep + 1;
  sep = value.indexOf("\n", fieldStart);
  if (sep < 0) return false;
  const minuteOfDay = wireRegionInt(value, fieldStart, sep);
  if (minuteOfDay < 0) return false;
  // Fields 4, 5: subMinuteTicks, ticksPerGameMinute.
  for (let skipped = 0; skipped < 2; skipped++) {
    fieldStart = sep + 1;
    sep = value.indexOf("\n", fieldStart);
    if (sep < 0) return false;
    if (wireRegionInt(value, fieldStart, sep) < 0) return false;
  }
  // Field 6: weatherSlugJson.
  fieldStart = sep + 1;
  sep = value.indexOf("\n", fieldStart);
  if (sep < 0) return false;
  const slug = matchWireSlug(value, fieldStart, sep, knownSlugs);
  // Field 7: weatherEnteredAtTick.
  fieldStart = sep + 1;
  sep = value.indexOf("\n", fieldStart);
  if (sep < 0) return false;
  const enteredAtTick = wireRegionInt(value, fieldStart, sep);
  if (enteredAtTick < 0) return false;
  // Fields 8, 9: weatherNextTransitionTick, weatherRngCursor; field 9 is the
  // last one (no trailing newline), so this also pins the field count at 10.
  fieldStart = sep + 1;
  sep = value.indexOf("\n", fieldStart);
  if (sep < 0) return false;
  if (wireRegionInt(value, fieldStart, sep) < 0) return false;
  fieldStart = sep + 1;
  if (fieldStart >= value.length || value.indexOf("\n", fieldStart) >= 0) return false;
  if (wireRegionInt(value, fieldStart, value.length) < 0) return false;
  out.slug = slug;
  out.enteredAtTick = enteredAtTick;
  out.refTick = refTick;
  out.minuteOfDay = minuteOfDay;
  return true;
}

function parseRuntimePart(value: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    throw new Error("runtime state contains malformed JSON");
  }
}

function unpackRuntimeExtension(value: JsonValue): JsonValue {
  const envelope = runtimeEnvelope(value);
  if (envelope) {
    const core = record(parseRuntimePart(envelope.coreWire));
    if (!core) throw new Error("runtime state core must be an object");
    return {
      ...core,
      clock: clockFromRuntimeEnvelope(envelope),
      weather: weatherFromRuntimeEnvelope(envelope),
    } as unknown as JsonValue;
  }
  if (typeof value !== "string") return value;
  if (!value.startsWith(TUXEMON_EXT_RUNTIME_PREFIX)) {
    throw new Error("runtime state has an unknown encoding");
  }
  return parseRuntimePart(value.slice(TUXEMON_EXT_RUNTIME_PREFIX.length));
}

function clockFromRuntimeEnvelope(envelope: TuxemonRuntimeEnvelope): ClockState {
  return {
    mode: "game",
    refTick: envelope.refTick,
    epochDay: envelope.epochDay,
    minuteOfDay: envelope.minuteOfDay,
    subMinuteTicks: envelope.subMinuteTicks,
    ticksPerGameMinute: envelope.ticksPerGameMinute,
  };
}

function weatherFromRuntimeEnvelope(envelope: TuxemonRuntimeEnvelope): WeatherState {
  return {
    slug: envelope.weatherSlug,
    enteredAtTick: envelope.weatherEnteredAtTick,
    nextTransitionTick: envelope.weatherNextTransitionTick,
    rngCursor: envelope.weatherRngCursor,
  };
}

function tuxemonStateProblem(
  value: JsonValue,
  db?: BattleDb,
  weatherSlugs?: ReadonlySet<string>,
): string | null {
  const state = record(value);
  if (!state || state.version !== 1) return "version must be 1";
  if (!Array.isArray(state.party) || state.party.length > PARTY_LIMIT) {
    return `party must contain at most ${PARTY_LIMIT} monsters`;
  }
  if (!Array.isArray(state.kennel) || state.kennel.length > KENNEL_LIMIT) {
    return `kennel must contain at most ${KENNEL_LIMIT} monsters`;
  }
  const identities = new Set<string>();
  const groups: [string, unknown[]][] = [["party", state.party], ["kennel", state.kennel]];
  if (state.kennelBox !== undefined && state.kennelBox !== true) return "kennelBox must be true when present";
  if (state.boxes !== undefined) {
    const boxes = record(state.boxes);
    if (!boxes) return "boxes must be an object";
    for (const [id, rawBox] of Object.entries(boxes)) {
      const box = record(rawBox);
      if (!nonEmptyString(id) || id === KENNEL_BOX || !box || typeof box.hidden !== "boolean"
        || !safeInteger(box.capacity) || box.capacity < 1 || box.capacity > KENNEL_LIMIT
        || !Array.isArray(box.monsters) || box.monsters.length > box.capacity) {
        return `boxes.${id} is invalid`;
      }
      groups.push([`boxes.${id}`, box.monsters]);
    }
  }
  if (state.shopSold !== undefined) {
    const sold = record(state.shopSold);
    if (!sold || !Object.entries(sold).every(([key, count]) =>
      nonEmptyString(key) && safeInteger(count) && count > 0)) {
      return "shopSold must map stock labels to positive integers";
    }
  }
  if (state.itemLocker !== undefined) {
    const locker = record(state.itemLocker);
    if (!locker) return "itemLocker must be an object";
    const kinds = Object.keys(locker);
    if (kinds.length > LOCKER_LIMIT) return `itemLocker must contain at most ${LOCKER_LIMIT} item types`;
    for (const [slug, quantity] of Object.entries(locker)) {
      if (!nonEmptyString(slug) || !safeInteger(quantity) || quantity < 1 || quantity > LOCKER_ITEM_CAP) {
        return `itemLocker.${slug} must be an integer between 1 and ${LOCKER_ITEM_CAP}`;
      }
    }
  }
  if (state.daycare !== undefined) {
    const daycare = record(state.daycare);
    if (!daycare || !Array.isArray(daycare.parents) || daycare.parents.length < 1
      || daycare.parents.length > 2) {
      return "daycare.parents must contain 1..2 monsters";
    }
    if (!safeInteger(daycare.progressSteps) || daycare.progressSteps < 0) {
      return "daycare.progressSteps must be a non-negative safe integer";
    }
    if (!finite(daycare.pendingExperience) || daycare.pendingExperience < 0
      || !safeInteger(daycare.pendingExperience * 4)) {
      return "daycare.pendingExperience must be a non-negative quarter increment";
    }
    for (const field of ["lastTrainingExp", "lastTrainingCost"] as const) {
      if (!safeInteger(daycare[field]) || daycare[field] < 0) {
        return `daycare.${field} must be a non-negative safe integer`;
      }
    }
    groups.push(["daycare.parents", daycare.parents]);
  }
  if (state.stepTrackers !== undefined) {
    const problem = stepTrackersProblem(state.stepTrackers);
    if (problem) return problem;
  }
  for (const [group, values] of groups) {
    for (let index = 0; index < values.length; index++) {
      const problem = monsterProblem(values[index], `${group}[${index}]`, db);
      if (problem) return problem;
      const iid = (values[index] as SpawnedMonsterSnapshot).iid!;
      if (identities.has(iid)) return `duplicate monster iid ${iid}`;
      identities.add(iid);
    }
  }
  if (!Array.isArray(state.seen) || !state.seen.every(nonEmptyString)) return "seen must contain strings";
  if (!Array.isArray(state.caught) || !state.caught.every(nonEmptyString)) return "caught must contain strings";
  const seen = state.seen as string[];
  const caught = state.caught as string[];
  if (new Set(seen).size !== seen.length) return "seen must not contain duplicates";
  if (new Set(caught).size !== caught.length) return "caught must not contain duplicates";
  if (seen.some((slug) => caught.includes(slug))) return "seen and caught must be disjoint";
  if (db) {
    if (seen.some((slug) => !(slug in db.monsters))) return "seen must name imported monsters";
    if (caught.some((slug) => !(slug in db.monsters))) return "caught must name imported monsters";
  }
  if (!safeInteger(state.runAttempts) || state.runAttempts < 0) {
    return "runAttempts must be a non-negative safe integer";
  }
  const npcParties = record(state.npcParties);
  if (!npcParties) return "npcParties must be an object";
  for (const [npc, values] of Object.entries(npcParties)) {
    if (!nonEmptyString(npc) || !Array.isArray(values) || values.length > PARTY_LIMIT) {
      return `npcParties.${npc} must contain at most ${PARTY_LIMIT} monsters`;
    }
    for (let index = 0; index < values.length; index++) {
      const problem = pendingProblem(values[index], `npcParties.${npc}[${index}]`, db);
      if (problem) return problem;
      const iid = (values[index] as PendingMonster).iid;
      if (identities.has(iid)) return `duplicate monster iid ${iid}`;
      identities.add(iid);
    }
  }
  if (!Array.isArray(state.history)) return "history must be an array";
  for (let index = 0; index < state.history.length; index++) {
    const entry = record(state.history[index]);
    if (!entry || !nonEmptyString(entry.fighter) || !nonEmptyString(entry.opponent)
      || !["won", "lost", "draw"].includes(String(entry.outcome))) {
      return `history[${index}] is invalid`;
    }
  }
  if (state.environment !== null && !nonEmptyString(state.environment)) {
    return "environment must be null or a non-empty string";
  }
  const faintPoints = record(state.faintPoints);
  if (!faintPoints) return "faintPoints must be an object";
  for (const [character, rawPoint] of Object.entries(faintPoints)) {
    const point = record(rawPoint);
    if (!nonEmptyString(character) || !point || !nonEmptyString(point.map)
      || !safeInteger(point.x) || point.x < 0 || !safeInteger(point.y) || point.y < 0) {
      return `faintPoints.${character} is invalid`;
    }
  }
  if (!safeInteger(state.nextMonsterId) || state.nextMonsterId < 1) {
    return "nextMonsterId must be a positive safe integer";
  }
  const plagueByIid = record(state.plagueByIid);
  if (!plagueByIid) return "plagueByIid must be an object";
  for (const [iid, plagues] of Object.entries(plagueByIid)) {
    if (!nonEmptyString(iid)) return "plagueByIid keys must be non-empty strings";
    const map = record(plagues);
    if (!map) return `plagueByIid.${iid} must be an object`;
    for (const [slug, phase] of Object.entries(map)) {
      if (!nonEmptyString(slug) || !["infected", "inoculated", "carrier", "recovered"].includes(String(phase))) {
        return `plagueByIid.${iid}.${slug} is invalid`;
      }
    }
  }
  const bills = record(state.bills);
  if (!bills) return "bills must be an object";
  for (const [character, tabs] of Object.entries(bills)) {
    if (!nonEmptyString(character)) return "bills keys must be non-empty strings";
    const entries = record(tabs);
    if (!entries) return `bills.${character} must be an object`;
    for (const [slug, entry] of Object.entries(entries)) {
      const bill = record(entry);
      if (!bill || !safeInteger(bill.amount) || bill.amount < 0) {
        return `bills.${character}.${slug} must have a non-negative integer amount`;
      }
      if (bill.interestRate !== undefined && (typeof bill.interestRate !== "number" || !Number.isFinite(bill.interestRate) || bill.interestRate < 0)) {
        return `bills.${character}.${slug}.interestRate must be a non-negative finite number`;
      }
      if (bill.lateFee !== undefined && (!safeInteger(bill.lateFee) || bill.lateFee < 0)) {
        return `bills.${character}.${slug}.lateFee must be a non-negative integer`;
      }
      if (bill.shareRate !== undefined && (typeof bill.shareRate !== "number" || !Number.isFinite(bill.shareRate) || bill.shareRate < 0 || bill.shareRate > 1)) {
        return `bills.${character}.${slug}.shareRate must be a finite number between 0 and 1`;
      }
    }
  }
  const timeProblem = timeWeatherProblem(
    { clock: state.clock, weather: state.weather },
    weatherSlugs,
  );
  if (timeProblem) return timeProblem;
  return null;
}

export function tuxemonExtensionProblem(
  value: JsonValue,
  db?: BattleDb,
  weatherSlugs?: ReadonlySet<string>,
): string | null {
  try {
    return tuxemonStateProblem(unpackRuntimeExtension(value), db, weatherSlugs);
  } catch (error) {
    return error instanceof Error ? error.message : "runtime state cannot be decoded";
  }
}

export function tuxemonExtensionState(
  value: JsonValue,
  db?: BattleDb,
  weatherSlugs?: ReadonlySet<string>,
): TuxemonExtensionState {
  let unpacked: JsonValue;
  try {
    unpacked = unpackRuntimeExtension(value);
  } catch (error) {
    throw new Error(`Tuxemon extension state: ${error instanceof Error ? error.message : "cannot decode"}`);
  }
  const problem = tuxemonStateProblem(unpacked, db, weatherSlugs);
  if (problem) throw new Error(`Tuxemon extension state: ${problem}`);
  return unpacked as unknown as TuxemonExtensionState;
}

/** Extension handlers receive state that cloneExtension validated at the
 * start of the current reducer frame. Avoid re-walking the full party once
 * for every page condition; command results are validated by the engine
 * before they become the following frame's state. */
let lastRuntimeState: TuxemonExtensionState | null = null;
let lastRuntimeStateWire: string | null = null;
let lastRuntimeCoreWire: string | null = null;
let lastRuntimeCore: Record<string, unknown> | null = null;
function currentExtensionState(value: JsonValue): TuxemonExtensionState {
  const envelope = runtimeEnvelope(value);
  if (envelope) {
    if (envelope.wire === lastRuntimeStateWire && lastRuntimeState) {
      return lastRuntimeState;
    }
    const core = envelope.coreWire === lastRuntimeCoreWire && lastRuntimeCore
      ? lastRuntimeCore
      : record(parseRuntimePart(envelope.coreWire))!;
    const state = {
      ...core,
      clock: clockFromRuntimeEnvelope(envelope),
      weather: weatherFromRuntimeEnvelope(envelope),
    } as unknown as TuxemonExtensionState;
    lastRuntimeEnvelope = envelope;
    lastRuntimeState = state;
    lastRuntimeStateWire = envelope.wire;
    lastRuntimeCoreWire = envelope.coreWire;
    lastRuntimeCore = core;
    return state;
  }
  if (typeof value === "string") {
    const state = unpackRuntimeExtension(value) as unknown as TuxemonExtensionState;
    lastRuntimeEnvelope = null;
    lastRuntimeState = state;
    lastRuntimeStateWire = value;
    return state;
  }
  return value as unknown as TuxemonExtensionState;
}

/**
 * Keep the whole runtime in one immutable primitive so the kit's mandatory
 * frame clone is O(1). The large battle core precedes a newline-delimited
 * clock/weather suffix; ordinary ticks reuse the cached prefix and never
 * parse or serialize JSON.
 */
export function packTuxemonExtensionState(state: TuxemonExtensionState): JsonValue {
  const { clock, weather, ...core } = state;
  const coreWire = JSON.stringify(core);
  return `${TUXEMON_EXT_RUNTIME_V2_PREFIX}${coreWire}\n${clock.refTick}\n${clock.epochDay}`
    + `\n${clock.minuteOfDay}\n${clock.subMinuteTicks}\n${clock.ticksPerGameMinute}`
    + `\n${JSON.stringify(weather.slug)}\n${weather.enteredAtTick}`
    + `\n${weather.nextTransitionTick}\n${weather.rngCursor}`;
}

function json(state: TuxemonExtensionState): JsonValue {
  const wire = packTuxemonExtensionState(state) as string;
  const envelope = runtimeEnvelope(wire)!;
  lastRuntimeEnvelope = envelope;
  lastRuntimeState = state;
  lastRuntimeStateWire = wire;
  lastRuntimeCoreWire = envelope.coreWire;
  const { clock: _clock, weather: _weather, ...core } = state;
  lastRuntimeCore = core;
  return wire;
}

interface PackedTimeWeatherAdvance {
  wire: string;
  minuteOfDay: number;
  subMinuteTicks: number;
}

/**
 * Clock ticks are the only extension mutation that runs on every active
 * reference tick. Reuse the immutable battle-core string, advance the flat
 * primitive fields directly, and invoke the general weather reducer only at
 * a saved deadline.
 */
function packTimeWeatherAdvance(
  currentWire: JsonValue,
  schedule: Readonly<WeatherSchedule>,
): PackedTimeWeatherAdvance {
  const currentEnvelope = runtimeEnvelope(currentWire);
  if (!currentEnvelope) {
    const current = currentExtensionState(currentWire);
    const advanced = advanceTimeWeather(current, 1, schedule);
    const state = { ...current, ...advanced };
    return {
      wire: json(state) as string,
      minuteOfDay: advanced.clock.minuteOfDay,
      subMinuteTicks: advanced.clock.subMinuteTicks,
    };
  }

  const refTick = currentEnvelope.refTick + 1;
  let epochDay = currentEnvelope.epochDay;
  let minuteOfDay = currentEnvelope.minuteOfDay;
  let subMinuteTicks = currentEnvelope.subMinuteTicks + 1;
  const ticksPerGameMinute = currentEnvelope.ticksPerGameMinute;
  if (!Number.isSafeInteger(refTick)) throw new Error("time-weather: clock overflow");
  if (subMinuteTicks === ticksPerGameMinute) {
    subMinuteTicks = 0;
    minuteOfDay++;
    if (minuteOfDay === 1_440) {
      minuteOfDay = 0;
      epochDay++;
      if (!Number.isSafeInteger(epochDay)) throw new Error("time-weather: clock overflow");
    }
  }
  let weatherSlug = currentEnvelope.weatherSlug;
  let weatherSlugWire = currentEnvelope.weatherSlugWire;
  let weatherEnteredAtTick = currentEnvelope.weatherEnteredAtTick;
  let weatherNextTransitionTick = currentEnvelope.weatherNextTransitionTick;
  let weatherRngCursor = currentEnvelope.weatherRngCursor;
  if (weatherNextTransitionTick <= refTick) {
    const weather = advanceTimeWeather({
      clock: {
        mode: "game",
        refTick,
        epochDay,
        minuteOfDay,
        subMinuteTicks,
        ticksPerGameMinute,
      },
      weather: weatherFromRuntimeEnvelope(currentEnvelope),
    }, 0, schedule).weather;
    weatherSlug = weather.slug;
    weatherSlugWire = JSON.stringify(weather.slug);
    weatherEnteredAtTick = weather.enteredAtTick;
    weatherNextTransitionTick = weather.nextTransitionTick;
    weatherRngCursor = weather.rngCursor;
  }
  const wire = `${currentEnvelope.corePrefix}${refTick}\n${epochDay}\n${minuteOfDay}`
    + `\n${subMinuteTicks}\n${ticksPerGameMinute}\n${weatherSlugWire}`
    + `\n${weatherEnteredAtTick}\n${weatherNextTransitionTick}\n${weatherRngCursor}`;
  lastRuntimeEnvelope = {
    wire,
    coreWire: currentEnvelope.coreWire,
    corePrefix: currentEnvelope.corePrefix,
    refTick,
    epochDay,
    minuteOfDay,
    subMinuteTicks,
    ticksPerGameMinute,
    weatherSlug,
    weatherSlugWire,
    weatherEnteredAtTick,
    weatherNextTransitionTick,
    weatherRngCursor,
  };
  lastRuntimeState = null;
  lastRuntimeStateWire = null;
  return { wire, minuteOfDay, subMinuteTicks };
}

function migrateV1(value: JsonValue): JsonValue {
  const state = record(value);
  if (state?.version !== 1) return value;
  // KB5 makes SessionState.items/gold the only bag and wallet. Older saves
  // may still carry the former battle-only mirrors; discard those fields
  // while preserving every Tuxemon-specific extension value.
  const { inventory: _legacyInventory, money: _legacyMoney, ...extension } = state;
  const hasClock = state.clock !== undefined;
  const hasWeather = state.weather !== undefined;
  if (hasClock !== hasWeather) {
    throw new Error("Tuxemon extension state: clock and weather must either both be present or both be absent");
  }
  return {
    ...extension,
    ...(state.seen === undefined ? { seen: [] } : {}),
    ...(state.environment === undefined ? { environment: null } : {}),
    ...(state.runAttempts === undefined ? { runAttempts: 0 } : {}),
    ...(state.plagueByIid === undefined ? { plagueByIid: {} } : {}),
    ...(state.bills === undefined ? { bills: {} } : {}),
    ...(!hasClock
      ? initialTimeWeatherState()
      : {}),
  } as JsonValue;
}

function argsRecord(value: JsonValue, call: string): Record<string, unknown> {
  const args = record(value);
  if (!args) throw new Error(`${call}: arguments must be an object`);
  return args;
}

function nextIid(state: TuxemonExtensionState): [string, number] {
  return nextMonsterIid(state.nextMonsterId);
}

/** Deterministic iid for a monster spawned outside tux.add_monster (for
 *  example a trainer party folded into the battle setup), sharing the same
 *  id space so persisted NPC parties stay addressable by iid. */
export function nextMonsterIid(nextMonsterId: number): [string, number] {
  if (!Number.isSafeInteger(nextMonsterId + 1)) throw new Error("monster id space exhausted");
  return [`txmn-${nextMonsterId.toString(36).padStart(6, "0")}`, nextMonsterId + 1];
}

/** Register a sighting without weakening an existing caught entry. */
export function registerSeenMonster(
  state: TuxemonExtensionState,
  slug: string,
): TuxemonExtensionState {
  if (state.caught.includes(slug) || state.seen.includes(slug)) return state;
  return { ...state, seen: [...state.seen, slug] };
}

/** Register ownership monotonically: caught wins over seen-only. */
export function registerCaughtMonster(
  state: TuxemonExtensionState,
  slug: string,
): TuxemonExtensionState {
  const seen = state.seen.includes(slug)
    ? state.seen.filter((candidate) => candidate !== slug)
    : state.seen;
  const caught = state.caught.includes(slug) ? state.caught : [...state.caught, slug];
  if (seen === state.seen && caught === state.caught) return state;
  return { ...state, seen, caught };
}

function resolveSpecies(
  context: ExtensionReadContext,
  raw: unknown,
  db: BattleDb,
): string {
  if (typeof raw === "string") {
    if (!(raw in db.monsters)) throw new Error(`tux.add_monster: unknown monster '${raw}'`);
    return raw;
  }
  const reference = record(raw);
  if (!reference || !nonEmptyString(reference.variable)
    || !Array.isArray(reference.values) || !reference.values.every(nonEmptyString)) {
    throw new Error("tux.add_monster: species must be a slug or variable reference");
  }
  const selected = context.variables[reference.variable];
  let slug: string | undefined;
  if (typeof selected === "string") slug = selected;
  else if (safeInteger(selected) && selected >= 1) slug = reference.values[selected - 1] as string | undefined;
  if (!slug || !(slug in db.monsters)) {
    throw new Error(`tux.add_monster: ${reference.variable} does not select an imported monster`);
  }
  return slug;
}

function addMonsterCommand(source: BattleDbSource) {
  return (context: ExtensionCommandContext, value: JsonValue) => {
    const db = resolveBattleDb(source);
    const rulesDb = battleDbToTuxemonBattleDb(db);
    const args = argsRecord(value, "tux.add_monster");
    const character = args.character === undefined ? "player" : args.character;
    if (!nonEmptyString(character)) throw new Error("tux.add_monster: character must be a string");
    const slug = resolveSpecies(context, args.species, db);
    if (!safeInteger(args.level)) throw new Error("tux.add_monster: level must be an integer");
    const experienceModifier = args.experienceModifier === undefined ? 1 : args.experienceModifier;
    const moneyModifier = args.moneyModifier === undefined ? 0 : args.moneyModifier;
    if (!finite(experienceModifier) || !finite(moneyModifier)) {
      throw new Error("tux.add_monster: modifiers must be finite");
    }
    const current = currentExtensionState(context.ext);
    const [iid, followingId] = nextIid(current);
    if (character !== "player") {
      const party = [...(current.npcParties[character] ?? [])];
      if (party.length < PARTY_LIMIT) {
        party.push({
          iid,
          slug,
          level: Math.max(db.rules.levelRange[0], Math.min(db.rules.levelRange[1], args.level)),
          experienceModifier,
          moneyModifier,
        });
      }
      return {
        ext: json({
          ...current,
          npcParties: { ...current.npcParties, [character]: party },
          nextMonsterId: followingId,
        }),
        writes: { "v.add_monster": iid },
      };
    }

    const monster = spawnMonsterWithRandom(db, rulesDb, context.random, slug, args.level, {
      iid,
      experienceModifier,
      moneyModifier,
    });
    const party = [...current.party];
    const kennel = [...current.kennel];
    if (party.length < PARTY_LIMIT) party.push(monster);
    else if (kennel.length < KENNEL_LIMIT) kennel.push(monster);
    return {
      ext: json(registerCaughtMonster({
        ...current,
        party,
        kennel,
        ...(kennel.length > 0 ? { kennelBox: true as const } : {}),
        nextMonsterId: followingId,
      }, slug)),
      writes: { "v.add_monster": iid },
    };
  };
}

function monsterTarget(
  context: ExtensionReadContext,
  args: Record<string, unknown>,
): string | null {
  if (args.variable === undefined) return null;
  if (!nonEmptyString(args.variable)) throw new Error("monster target variable must be a string");
  const iid = context.variables[args.variable];
  return typeof iid === "string" && iid.length > 0 ? iid : "";
}

function updatePlayerMonsters(
  current: TuxemonExtensionState,
  target: string | null,
  update: (monster: SpawnedMonsterSnapshot) => SpawnedMonsterSnapshot,
): TuxemonExtensionState {
  if (target === "") return current;
  const apply = (monster: SpawnedMonsterSnapshot) =>
    target === null || monster.iid === target ? update(monster) : monster;
  return {
    ...current,
    party: current.party.map(apply),
    kennel: target === null ? current.kennel : current.kennel.map(apply),
  };
}

/** Upstream `get_monster_by_iid` resolves an iid across the player's party,
 *  every on-map NPC party and (for set_monster_attribute) the player's boxes.
 *  iids are unique across storages, so the first hit is the only hit. The
 *  pending updater mutates the staged NPC party member; its overrides reach
 *  the battle snapshot through enemySnapshot. */
function updateMonsterByIid(
  current: TuxemonExtensionState,
  iid: string,
  update: (monster: SpawnedMonsterSnapshot) => SpawnedMonsterSnapshot,
  updatePending: (monster: PendingMonster) => PendingMonster,
  options: { boxes?: boolean } = {},
): TuxemonExtensionState {
  const apply = (monster: SpawnedMonsterSnapshot) =>
    monster.iid === iid ? update(monster) : monster;
  const party = current.party.map(apply);
  if (party.some((monster, index) => monster !== current.party[index])) {
    return { ...current, party };
  }
  for (const [character, monsters] of Object.entries(current.npcParties)) {
    const next = monsters.map((monster) =>
      monster.iid === iid ? updatePending(monster) : monster);
    if (next.some((monster, index) => monster !== monsters[index])) {
      return { ...current, npcParties: { ...current.npcParties, [character]: next } };
    }
  }
  const kennel = current.kennel.map(apply);
  if (kennel.some((monster, index) => monster !== current.kennel[index])) {
    return { ...current, kennel };
  }
  if (options.boxes && current.boxes) {
    let changed = false;
    const boxes: Record<string, MonsterBox> = {};
    for (const [id, box] of Object.entries(current.boxes)) {
      const monsters = box.monsters.map(apply);
      if (monsters.some((monster, index) => monster !== box.monsters[index])) changed = true;
      boxes[id] = { ...box, monsters };
    }
    if (changed) return { ...current, boxes };
  }
  return current;
}

/** Upstream set_health: clamp the wanted HP into [0, max] and flag a faint.
 *  Shared by the live-snapshot path and the staged-NPC override path. */
function applyHealth(
  monster: SpawnedMonsterSnapshot,
  health: { kind: "full" | "fraction" | "points"; value: number },
): SpawnedMonsterSnapshot {
  const wanted = health.kind === "full" ? monster.base.hp
    : health.kind === "fraction" ? Math.trunc(monster.base.hp * health.value)
    : Math.trunc(health.value);
  const currentHp = Math.max(0, Math.min(monster.base.hp, wanted));
  return { ...monster, currentHp, ...(currentHp === 0 ? { status: "faint" } : {}) };
}

function healthCommand() {
  return (context: ExtensionCommandContext, value: JsonValue) => {
    const args = argsRecord(value, "tux.set_monster_health");
    const target = monsterTarget(context, args);
    const rawHealth = args.health;
    let kind: "full" | "fraction" | "points" = "full";
    let amount = 1;
    if (rawHealth !== undefined) {
      const health = record(rawHealth);
      if (!health || (health.kind !== "fraction" && health.kind !== "points") || !finite(health.value)) {
        throw new Error("tux.set_monster_health: health must be {kind,value}");
      }
      kind = health.kind;
      amount = health.value;
    }
    const current = currentExtensionState(context.ext);
    if (target === null) {
      // No variable: upstream heals every monster in the player's party
      // (player.monsters), not the kennel or boxes.
      return { ext: json({ ...current, party: current.party.map((monster) => applyHealth(monster, { kind, value: amount })) }) };
    }
    if (target === "") return { ext: json(current) };
    const health = { kind, value: amount };
    return {
      ext: json(updateMonsterByIid(
        current,
        target,
        (monster) => applyHealth(monster, health),
        (monster) => ({ ...monster, health }),
      )),
    };
  };
}

function statusCommand(source: BattleDbSource) {
  return (context: ExtensionCommandContext, value: JsonValue) => {
    const db = resolveBattleDb(source);
    const args = argsRecord(value, "tux.set_monster_status");
    const target = monsterTarget(context, args);
    const status = args.status === undefined || args.status === "" ? null : args.status;
    if (status !== null && (!nonEmptyString(status) || !(status in db.statuses))) {
      throw new Error("tux.set_monster_status: status must name an imported status");
    }
    const current = currentExtensionState(context.ext);
    if (target === null) {
      // No variable: upstream sets/clears status on every player party monster.
      return { ext: json({ ...current, party: current.party.map((monster) => ({ ...monster, status })) }) };
    }
    if (target === "") return { ext: json(current) };
    return {
      ext: json(updateMonsterByIid(
        current,
        target,
        (monster) => ({ ...monster, status }),
        (monster) => ({ ...monster, status }),
      )),
    };
  };
}

function firstWaitingIndex(state: TuxemonExtensionState): number {
  return state.party.findIndex((monster) => monster.waitingToEvolve === true);
}

function clearPendingEvolution(state: TuxemonExtensionState): TuxemonExtensionState {
  const index = firstWaitingIndex(state);
  if (index < 0) return state;
  const party = [...state.party];
  party[index] = { ...party[index]!, waitingToEvolve: false };
  return { ...state, party };
}

function evolutionVariables(
  values: ExtensionReadContext["variables"],
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(values)) {
    result[key] = value;
    if (key.startsWith("v.")) result[key.slice(2)] = value;
  }
  return result;
}

function evolutionCommand(source: BattleDbSource) {
  return (context: ExtensionCommandContext, value: JsonValue) => {
    const args = argsRecord(value, "tux.evolution");
    const character = args.character === undefined ? "player" : args.character;
    if (!nonEmptyString(character)) throw new Error("tux.evolution: character must be a string");
    if (args.inside !== undefined && typeof args.inside !== "boolean") {
      throw new Error("tux.evolution: inside must be boolean");
    }
    const current = currentExtensionState(context.ext);
    // The imported story only invokes this action for the player. Staged NPC
    // parties do not carry full persistent monster state and cannot evolve.
    if (character !== "player") return { ext: json(current) };
    const index = firstWaitingIndex(current);
    if (index < 0) return { ext: json(current) };
    const db = resolveBattleDb(source);
    const evolved = evolveMonsterSnapshot(
      db,
      battleDbToTuxemonBattleDb(db),
      current.party[index]!,
      current.party,
      {
        variables: evolutionVariables(context.variables),
        inside: args.inside === true,
      },
      context.random,
    );
    if (!evolved) return { ext: json(clearPendingEvolution(current)) };
    const party = [...current.party];
    party[index] = evolved.monster;
    return { ext: json(registerCaughtMonster({
      ...current,
      party,
    }, evolved.target)) };
  };
}

function tuxepediaCommand(source: BattleDbSource) {
  return (context: ExtensionCommandContext, value: JsonValue) => {
    const args = argsRecord(value, "tux.set_tuxepedia");
    const character = args.character === undefined ? "player" : args.character;
    if (!nonEmptyString(character)) throw new Error("tux.set_tuxepedia: character must be a string");
    if (!nonEmptyString(args.species)) throw new Error("tux.set_tuxepedia: species must be a string");
    const db = resolveBattleDb(source);
    if (!(args.species in db.monsters)) {
      throw new Error(`tux.set_tuxepedia: unknown monster '${args.species}'`);
    }
    if (args.status !== "seen" && args.status !== "caught" && args.status !== "unseen") {
      throw new Error("tux.set_tuxepedia: status must be unseen, seen, or caught");
    }
    const current = currentExtensionState(context.ext);
    if (character !== "player" || args.status === "unseen") return { ext: json(current) };
    return {
      ext: json(args.status === "caught"
        ? registerCaughtMonster(current, args.species)
        : registerSeenMonster(current, args.species)),
    };
  };
}

function renameTarget(
  context: ExtensionReadContext,
  args: Record<string, unknown>,
  call: string,
): { state: TuxemonExtensionState; monster: SpawnedMonsterSnapshot } | null {
  if (!nonEmptyString(args.variable)) throw new Error(`${call}: variable must be a string`);
  const iid = context.variables[args.variable];
  if (typeof iid !== "string" || iid.length === 0) return null;
  const state = currentExtensionState(context.ext);
  const monster = state.party.find((candidate) => candidate.iid === iid);
  return monster ? { state, monster } : null;
}

function prepareMonsterRenameCommand(source: BattleDbSource) {
  return (context: ExtensionCommandContext, value: JsonValue) => {
    const args = argsRecord(value, "tux.prepare_monster_rename");
    if (!nonEmptyString(args.nameVariable)) {
      throw new Error("tux.prepare_monster_rename: nameVariable must be a string");
    }
    const target = renameTarget(context, args, "tux.prepare_monster_rename");
    if (!target) return;
    const name = resolveBattleDb(source).monsters[target.monster.slug]?.name;
    if (!nonEmptyString(name)) {
      throw new Error(`tux.prepare_monster_rename: unknown monster '${target.monster.slug}'`);
    }
    return { writes: { [args.nameVariable]: name.slice(0, 15) } };
  };
}

function applyMonsterRenameCommand() {
  return (context: ExtensionCommandContext, value: JsonValue) => {
    const args = argsRecord(value, "tux.apply_monster_rename");
    if (!nonEmptyString(args.nameVariable)) {
      throw new Error("tux.apply_monster_rename: nameVariable must be a string");
    }
    const target = renameTarget(context, args, "tux.apply_monster_rename");
    if (!target) return;
    const nickname = context.variables[args.nameVariable];
    if (!nonEmptyString(nickname) || nickname.length > 15) {
      throw new Error("tux.apply_monster_rename: name must contain 1..15 characters");
    }
    return {
      ext: json(updatePlayerMonsters(target.state, target.monster.iid!, (monster) => ({ ...monster, nickname }))),
    };
  };
}

function partyFor(state: TuxemonExtensionState, character: string): readonly (SpawnedMonsterSnapshot | PendingMonster)[] {
  return character === "player" ? state.party : state.npcParties[character] ?? [];
}

function negate(result: boolean, args: Record<string, unknown>): boolean {
  return args.negate === true ? !result : result;
}

function compare(operator: unknown, left: number, right: number): boolean {
  switch (operator) {
    case "less_than": return left < right;
    case "less_or_equal": return left <= right;
    case "greater_than": return left > right;
    case "greater_or_equal": return left >= right;
    case "equals": return left === right;
    case "not_equals": return left !== right;
    default: throw new Error(`tux.party_size: unknown operator '${String(operator)}'`);
  }
}

/** Upstream get_player_monster filter, baked by the importer. String fields
 *  compare equality; numeric fields carry an explicit operator. */
interface PartyFilter {
  field: string;
  value: string | number;
  op?: string;
}

const title = (slug: string): string => slug
  .split("_")
  .map((part) => part ? part[0]!.toUpperCase() + part.slice(1) : part)
  .join(" ");

function filterArgs(value: JsonValue, call: string): { variable?: string; cancelCode?: number; filters: PartyFilter[] } {
  const args = record(value);
  if (!args) throw new Error(`${call}: arguments must be an object`);
  const out: { variable?: string; cancelCode?: number; filters: PartyFilter[] } = { filters: [] };
  if (args.variable !== undefined) {
    if (!nonEmptyString(args.variable)) throw new Error(`${call}: variable must be a non-empty string`);
    out.variable = args.variable;
  }
  if (args.cancelCode !== undefined) {
    if (!safeInteger(args.cancelCode)) throw new Error(`${call}: cancelCode must be a safe integer`);
    out.cancelCode = args.cancelCode;
  }
  if (args.filters !== undefined) {
    if (!Array.isArray(args.filters)) throw new Error(`${call}: filters must be an array`);
    for (const [index, raw] of args.filters.entries()) {
      const filter = record(raw);
      if (!filter || !nonEmptyString(filter.field)) {
        throw new Error(`${call}: filters[${index}] must be an object with a string field`);
      }
      const entry: PartyFilter = { field: filter.field, value: filter.value as string | number };
      if (filter.op !== undefined) {
        if (!nonEmptyString(filter.op)) throw new Error(`${call}: filters[${index}].op must be a string`);
        entry.op = filter.op;
      }
      out.filters.push(entry);
    }
  }
  return out;
}

function monsterMatches(
  monster: SpawnedMonsterSnapshot,
  db: BattleDb,
  filter: PartyFilter,
): boolean {
  const { field, value } = filter;
  switch (field) {
    case "slug": return monster.slug === value;
    case "gender": return monster.gender === value;
    case "evolution_stage": return monster.stage === value;
    case "element": return monster.types?.includes(String(value)) ?? false;
    case "shape": return db.monsters[monster.slug]?.shape === value;
    case "taste_warm": return monster.tasteWarm === value;
    case "taste_cold": return monster.tasteCold === value;
    case "level": return compare(filter.op, monster.level, Number(value));
    case "weight": return compare(filter.op, Math.trunc(monster.weight), Number(value));
    case "height": return compare(filter.op, Math.trunc(monster.height), Number(value));
    case "max_hp": return compare(filter.op, monster.base.hp, Number(value));
    case "current_hp": return compare(filter.op, monster.currentHp ?? 0, Number(value));
    case "armour":
    case "dodge":
    case "melee":
    case "ranged":
    case "speed":
      return compare(filter.op, monster.base[field], Number(value));
    default: return false;
  }
}

function matchingParty(
  state: TuxemonExtensionState,
  db: BattleDb,
  filters: readonly PartyFilter[],
): SpawnedMonsterSnapshot[] {
  return state.party.filter((monster) => filters.every((filter) => monsterMatches(monster, db, filter)));
}

/** KC1: get_player_monster. The importer guards the empty case (upstream
 *  writes "no_options" without opening a menu), so the modal only opens with
 *  at least one row. Cancel writes the enum code for "no_choice"; a select
 *  writes the monster iid, which remove_monster and the monster ext commands
 *  read back. */
function partyMonstersChoice(source: BattleDbSource): NonNullable<ExtensionOptions["choices"]>[string] {
  return {
    options(context, args) {
      const parsed = filterArgs(args, "tux.party_monsters");
      const db = resolveBattleDb(source);
      const state = currentExtensionState(context.ext);
      return matchingParty(state, db, parsed.filters).map((monster) => ({
        key: monster.iid!,
        label: title(monster.slug),
        data: { slug: monster.slug, level: monster.level },
      }));
    },
    resolve(context, args, result) {
      const parsed = filterArgs(args, "tux.party_monsters");
      if (!parsed.variable) throw new Error("tux.party_monsters: resolve requires a variable destination");
      if (result.kind === "cancel") {
        return { writes: { [parsed.variable]: parsed.cancelCode ?? "no_choice" } };
      }
      return { writes: { [parsed.variable]: result.key } };
    },
  };
}

/** KC1: the importer's empty-list guard for get_player_monster. True when at
 *  least one party monster passes every baked filter. */
function partyMatchCondition(source: BattleDbSource) {
  return (context: ExtensionReadContext, value: JsonValue): boolean => {
    const parsed = filterArgs(value, "tux.party_match");
    const db = resolveBattleDb(source);
    const state = currentExtensionState(context.ext);
    return matchingParty(state, db, parsed.filters).length > 0;
  };
}

/** KC1: remove_monster. The variable holds a monster iid (written by
 *  get_player_monster's resolver, get_party_monsters or add_monster).
 *  Upstream looks the iid up globally and removes it from its owner, which
 *  may be an NPC: search the player party, then the kennel, then every NPC
 *  party. A missing iid is a no-op, matching upstream's logged stop. */
function removeMonsterCommand() {
  return (context: ExtensionCommandContext, value: JsonValue) => {
    const args = argsRecord(value, "tux.remove_monster");
    if (!nonEmptyString(args.variable)) throw new Error("tux.remove_monster: variable must be a non-empty string");
    const iid = context.variables[args.variable];
    if (typeof iid !== "string" || iid.length === 0) return;
    const current = currentExtensionState(context.ext);
    const party = current.party.filter((monster) => monster.iid !== iid);
    if (party.length !== current.party.length) {
      return { ext: json({ ...current, party }) };
    }
    const kennel = current.kennel.filter((monster) => monster.iid !== iid);
    if (kennel.length !== current.kennel.length) {
      return { ext: json({ ...current, kennel, kennelBox: true }) };
    }
    for (const [id, box] of Object.entries(current.boxes ?? {})) {
      const monsters = box.monsters.filter((monster) => monster.iid !== iid);
      if (monsters.length !== box.monsters.length) {
        return { ext: json({ ...current, boxes: { ...current.boxes, [id]: { ...box, monsters } } }) };
      }
    }
    for (const [character, monsters] of Object.entries(current.npcParties)) {
      const next = monsters.filter((monster) => monster.iid !== iid);
      if (next.length !== monsters.length) {
        return { ext: json({ ...current, npcParties: { ...current.npcParties, [character]: next } }) };
      }
    }
  };
}

/** An NPC's party lives as long as the NPC. Upstream builds a fresh NPC on
 *  every `create_npc` (all non-persistent NPCs are dropped on each map
 *  transition) and discards it on `remove_npc`; the importer calls this at
 *  both points, and `tux.clear_npc_parties` drops every other NPC's party
 *  on map entry, so a later visit never inherits an earlier visit's party. */
function clearNpcPartyCommand() {
  return (context: ExtensionCommandContext, value: JsonValue) => {
    const args = argsRecord(value, "tux.clear_npc_party");
    if (!nonEmptyString(args.character) || args.character === "player") {
      throw new Error("tux.clear_npc_party: character must name an NPC");
    }
    const current = currentExtensionState(context.ext);
    if (!Object.hasOwn(current.npcParties, args.character)) return;
    const npcParties = { ...current.npcParties };
    delete npcParties[args.character];
    return { ext: json({ ...current, npcParties }) };
  };
}

/** Upstream `change_map` calls `npc_manager.clear_npcs()`, which drops every
 *  NPC without `persistence` (and with it the NPC's party). The importer runs
 *  this once per map entry, before any other event on the new map, passing
 *  the source's persistent NPC slugs in `keep`. */
function clearNpcPartiesCommand() {
  return (context: ExtensionCommandContext, value: JsonValue) => {
    const args = argsRecord(value, "tux.clear_npc_parties");
    const keep = args.keep ?? [];
    if (!Array.isArray(keep) || !keep.every(nonEmptyString)) {
      throw new Error("tux.clear_npc_parties: keep must list NPC slugs");
    }
    const current = currentExtensionState(context.ext);
    const characters = Object.keys(current.npcParties);
    if (characters.every((character) => keep.includes(character))) return;
    const npcParties: typeof current.npcParties = {};
    for (const character of characters) {
      if (keep.includes(character)) npcParties[character] = current.npcParties[character]!;
    }
    return { ext: json({ ...current, npcParties }) };
  };
}

/** KC1: get_party_monster. Upstream opens no menu: it writes each monster's
 *  instance id into the player's `iid_slot_<index>` game variables. The
 *  party is the named NPC's, or the player's when no name is given. */
function getPartyMonstersCommand() {
  return (context: ExtensionCommandContext, value: JsonValue) => {
    const args = argsRecord(value, "tux.get_party_monsters");
    const character = args.character === undefined || args.character === "" ? "player" : args.character;
    if (!nonEmptyString(character)) {
      throw new Error("tux.get_party_monsters: character must be a string");
    }
    const state = currentExtensionState(context.ext);
    const monsters = character === "player" ? state.party : (state.npcParties[character] ?? []);
    const writes: Record<string, string> = {};
    monsters.forEach((monster, index) => {
      writes[`v.iid_slot_${index}`] = monster.iid!;
    });
    return { writes };
  };
}

/** create_kennel: player boxes only (no source map gives an NPC a box).
 *  An existing box is left untouched, exactly like upstream. */
function createKennelCommand() {
  return (context: ExtensionCommandContext, value: JsonValue) => {
    const args = argsRecord(value, "tux.create_kennel");
    if (!nonEmptyString(args.character) || !nonEmptyString(args.kennel)) {
      throw new Error("tux.create_kennel: character and kennel must be strings");
    }
    if (args.character !== "player") return;
    const capacity = args.capacity === undefined ? KENNEL_LIMIT : args.capacity;
    if (!safeInteger(capacity) || capacity < 1 || capacity > KENNEL_LIMIT) {
      throw new Error(`tux.create_kennel: capacity must be 1..${KENNEL_LIMIT}`);
    }
    const current = currentExtensionState(context.ext);
    if (args.kennel === KENNEL_BOX) {
      return kennelExists(current) ? undefined : { ext: json({ ...current, kennelBox: true }) };
    }
    if (current.boxes?.[args.kennel]) return;
    return { ext: json({
      ...current,
      boxes: { ...current.boxes, [args.kennel]: { hidden: args.hidden === true, capacity, monsters: [] } },
    }) };
  };
}

/** set_kennel_visible: a missing box is a silent no-op; the importer folds
 *  the upstream ValueError for the main Kennel out of the event. */
function setKennelVisibleCommand() {
  return (context: ExtensionCommandContext, value: JsonValue) => {
    const args = argsRecord(value, "tux.set_kennel_visible");
    if (!nonEmptyString(args.character) || !nonEmptyString(args.kennel) || typeof args.visible !== "boolean") {
      throw new Error("tux.set_kennel_visible: character, kennel and visible are required");
    }
    if (args.character !== "player" || args.kennel === KENNEL_BOX) return;
    const current = currentExtensionState(context.ext);
    const box = current.boxes?.[args.kennel];
    if (!box || box.hidden === !args.visible) return;
    return { ext: json({
      ...current,
      boxes: { ...current.boxes, [args.kennel]: { ...box, hidden: !args.visible } },
    }) };
  };
}

/** One invocation represents one completed player tile: it advances the
 * daycare and the player's step trackers. The engine hook does not mutate
 * unused saves: without either sparse payload this returns no result at all. */
function playerStepCommand(source: BattleDbSource) {
  let cachedSource: BattleDb | null = null;
  let cachedRules: ReturnType<typeof battleDbToTuxemonBattleDb> | null = null;
  return (context: ExtensionCommandContext) => {
    const current = currentExtensionState(context.ext);
    if (!current.daycare && !current.stepTrackers?.player) return;
    let next = current;
    let gold = context.gold;
    if (current.daycare) {
      const db = resolveBattleDb(source);
      if (db !== cachedSource || cachedRules === null) {
        cachedSource = db;
        cachedRules = battleDbToTuxemonBattleDb(db);
      }
      const result = advanceDaycareStep(current.daycare, context.gold, cachedRules);
      next = { ...next, daycare: result.daycare };
      gold = result.gold;
    }
    const stepTrackers = stepCharacterTrackers(current.stepTrackers, "player");
    if (stepTrackers) next = { ...next, stepTrackers };
    return {
      ext: json(next),
      ...(gold === context.gold ? {} : { gold }),
    };
  };
}

function finiteArg(value: unknown, call: string, name: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) throw new Error(`${call}: ${name} must be a finite number`);
  return parsed;
}

function trackerArgs(value: JsonValue, call: string): { args: Record<string, unknown>; character: string; tracker: string } {
  const args = argsRecord(value, call);
  const character = args.character === undefined ? "player" : args.character;
  if (!nonEmptyString(character) || !nonEmptyString(args.tracker)) {
    throw new Error(`${call}: character and tracker must be strings`);
  }
  return { args, character, tracker: args.tracker };
}

function withStepTrackers(current: TuxemonExtensionState, stepTrackers: StepTrackers): JsonValue {
  const { stepTrackers: _old, ...rest } = current;
  return json(Object.keys(stepTrackers).length ? { ...rest, stepTrackers } : rest);
}

function addStepTrackerCommand() {
  return (context: ExtensionCommandContext, value: JsonValue) => {
    const { args, character, tracker } = trackerArgs(value, "tux.add_step_tracker");
    const milestones = args.milestones === undefined ? [] : args.milestones;
    if (!Array.isArray(milestones)) throw new Error("tux.add_step_tracker: milestones must be an array");
    if (args.autoReset !== undefined && typeof args.autoReset !== "boolean") {
      throw new Error("tux.add_step_tracker: autoReset must be boolean");
    }
    const current = currentExtensionState(context.ext);
    const next = addStepTracker(current.stepTrackers, character, tracker, {
      countdown: finiteArg(args.countdown, "tux.add_step_tracker", "countdown"),
      milestones: milestones.map((m) => finiteArg(m, "tux.add_step_tracker", "milestone")),
      autoReset: args.autoReset === true,
      ...(args.initialCountdown === undefined
        ? {}
        : { initialCountdown: finiteArg(args.initialCountdown, "tux.add_step_tracker", "initialCountdown") }),
    });
    return next ? { ext: withStepTrackers(current, next) } : undefined;
  };
}

function removeStepTrackerCommand() {
  return (context: ExtensionCommandContext, value: JsonValue) => {
    const { character, tracker } = trackerArgs(value, "tux.remove_step_tracker");
    const current = currentExtensionState(context.ext);
    const next = removeStepTracker(current.stepTrackers, character, tracker);
    return next ? { ext: withStepTrackers(current, next) } : undefined;
  };
}

function milestoneShownCommand() {
  return (context: ExtensionCommandContext, value: JsonValue) => {
    const { args, character, tracker } = trackerArgs(value, "tux.set_step_tracker_milestone_shown");
    const milestone = finiteArg(args.milestone, "tux.set_step_tracker_milestone_shown", "milestone");
    const current = currentExtensionState(context.ext);
    const next = markMilestoneShown(current.stepTrackers, character, tracker, milestone);
    return next ? { ext: withStepTrackers(current, next) } : undefined;
  };
}

function stepTrackerCondition(context: ExtensionReadContext, value: JsonValue): boolean {
  const { args, character, tracker } = trackerArgs(value, "tux.step_tracker");
  const milestone = finiteArg(args.milestone, "tux.step_tracker", "milestone");
  const current = currentExtensionState(context.ext);
  return negate(milestonePending(current.stepTrackers, character, tracker, milestone), args);
}

function boxOf(
  state: Readonly<TuxemonExtensionState>,
  id: string,
): { hidden: boolean; monsters: readonly SpawnedMonsterSnapshot[] } | null {
  if (id === KENNEL_BOX) return kennelExists(state) ? { hidden: false, monsters: state.kennel } : null;
  return state.boxes?.[id] ?? null;
}

/** KC1: choice_monster/choice_npc. The importer bakes the static option list
 *  (key, translated label, enum code) so the resolver can write the same
 *  enum code the variable_set conditions compare against. */
interface EnumChoiceOption {
  key: string;
  label: string;
  code: number;
}

function enumChoiceArgs(value: JsonValue): {
  variable: string;
  options: EnumChoiceOption[];
  cancelCode?: number;
} {
  const args = record(value);
  if (!args) throw new Error("tux.enum_choice: arguments must be an object");
  if (!nonEmptyString(args.variable)) throw new Error("tux.enum_choice: variable must be a non-empty string");
  if (!Array.isArray(args.options)) throw new Error("tux.enum_choice: options must be an array");
  const options: EnumChoiceOption[] = [];
  for (const [index, raw] of args.options.entries()) {
    const option = record(raw);
    if (!option || !nonEmptyString(option.key) || !nonEmptyString(option.label)
      || !safeInteger(option.code)) {
      throw new Error(`tux.enum_choice: options[${index}] must have string key/label and integer code`);
    }
    options.push({ key: option.key, label: option.label, code: option.code });
  }
  const out: { variable: string; options: EnumChoiceOption[]; cancelCode?: number } = {
    variable: args.variable,
    options,
  };
  if (args.cancelCode !== undefined) {
    if (!safeInteger(args.cancelCode)) throw new Error("tux.enum_choice: cancelCode must be a safe integer");
    out.cancelCode = args.cancelCode;
  }
  return out;
}

function enumChoiceHandler(): NonNullable<ExtensionOptions["choices"]>[string] {
  return {
    options(_context, args) {
      return enumChoiceArgs(args).options;
    },
    resolve(_context, args, result) {
      const parsed = enumChoiceArgs(args);
      if (result.kind === "cancel") {
        if (parsed.cancelCode === undefined) return;
        return { writes: { [parsed.variable]: parsed.cancelCode } };
      }
      const option = parsed.options.find((candidate) => candidate.key === result.key);
      if (!option) throw new Error(`tux.enum_choice: selected key '${result.key}' is not in the option list`);
      return { writes: { [parsed.variable]: option.code } };
    },
  };
}

/** ui/save-game.ts LEGACY_SAVE_EXT_FORMAT, repeated here so the battle
 * module stays free of UI imports. */
const GAME_SAVE_EXT_FORMAT = "pocket-tuxemon/save-ext/v1";

// ---------------------------------------------------------------------------
// COV-B: monster mechanics (attributes, techniques, plague, bills, random)

const PLAGUE_STATES = new Set(["infected", "inoculated", "carrier", "recovered"]);

/** Find a player-owned monster (party or kennel) by iid. */
function findPlayerMonster(
  state: TuxemonExtensionState,
  iid: string,
): SpawnedMonsterSnapshot | null {
  return state.party.find((monster) => monster.iid === iid)
    ?? state.kennel.find((monster) => monster.iid === iid)
    ?? null;
}

/** set_monster_attribute: the corpus only sets gender, acquisition and the
 *  custom nickname. Upstream no-ops (with a warning) for unknown attributes,
 *  so unsupported names leave the monster untouched. */
function setMonsterAttributeCommand() {
  return (context: ExtensionCommandContext, value: JsonValue) => {
    const args = argsRecord(value, "tux.set_monster_attribute");
    const target = monsterTarget(context, args);
    if (target === null || target === "") return;
    if (!nonEmptyString(args.attribute) || typeof args.value !== "string") {
      throw new Error("tux.set_monster_attribute: attribute and value must be strings");
    }
    const attribute = args.attribute;
    const raw = args.value;
    if (attribute !== "gender" && attribute !== "acquisition" && attribute !== "name") return;
    if (attribute === "gender" && !["male", "female", "neuter"].includes(raw)) {
      throw new Error(`tux.set_monster_attribute: invalid gender '${raw}'`);
    }
    if (attribute === "name" && (raw.length < 1 || raw.length > 15)) {
      throw new Error("tux.set_monster_attribute: name must contain 1..15 characters");
    }
    const current = currentExtensionState(context.ext);
    const patch = attribute === "name"
      ? { nickname: raw }
      : attribute === "gender"
        ? { gender: raw }
        : { acquisition: raw };
    return {
      ext: json(updateMonsterByIid(
        current,
        target,
        (monster) => ({ ...monster, ...patch }),
        (monster) => ({ ...monster, ...patch }),
        { boxes: true },
      )),
    };
  };
}

/** add_tech: teach a technique to the monster named by an iid variable.
 *  Upstream dedupes by slug, enforces no move cap and resolves the iid only
 *  across on-map parties (player and NPC), never the boxes. */
function addTechCommand(source: BattleDbSource) {
  return (context: ExtensionCommandContext, value: JsonValue) => {
    const db = resolveBattleDb(source);
    const args = argsRecord(value, "tux.add_tech");
    const target = monsterTarget(context, args);
    if (target === null || target === "") return;
    if (!nonEmptyString(args.technique) || !(args.technique in db.techniques)) {
      throw new Error(`tux.add_tech: unknown technique '${String(args.technique)}'`);
    }
    const technique = args.technique;
    const current = currentExtensionState(context.ext);
    return {
      ext: json(updateMonsterByIid(
        current,
        target,
        (monster) => monster.moves.includes(technique)
          ? monster
          : { ...monster, moves: [...monster.moves, technique] },
        (monster) => (monster.moves ?? []).includes(technique)
          ? monster
          : { ...monster, moves: [...(monster.moves ?? []), technique] },
      )),
    };
  };
}

/** char_plague: set or clear a plague on every monster in a character's
 *  party. The corpus only uses spyderbite with infected/inoculated/clear. */
function charPlagueCommand() {
  return (context: ExtensionCommandContext, value: JsonValue) => {
    const args = argsRecord(value, "tux.char_plague");
    if (!nonEmptyString(args.plague)) throw new Error("tux.char_plague: plague must be a string");
    const plague = args.plague;
    const condition = args.condition === undefined || args.condition === null || args.condition === ""
      ? null
      : String(args.condition).toLowerCase();
    if (condition !== null && condition !== "infected" && condition !== "inoculated") {
      throw new Error(`tux.char_plague: unsupported condition '${String(args.condition)}'`);
    }
    const character = args.character === undefined ? "player" : args.character;
    if (!nonEmptyString(character)) throw new Error("tux.char_plague: character must be a string");
    const current = currentExtensionState(context.ext);
    const party = character === "player" ? current.party : (current.npcParties[character] ?? []);
    if (party.length === 0) return;
    const plagueByIid = { ...current.plagueByIid };
    for (const monster of party) {
      const iid = monster.iid;
      if (!iid) continue;
      if (condition === null) {
        if (!Object.hasOwn(plagueByIid, iid)) continue;
        const rest = { ...plagueByIid[iid]! };
        delete rest[plague];
        if (Object.keys(rest).length === 0) delete plagueByIid[iid];
        else plagueByIid[iid] = rest;
      } else {
        plagueByIid[iid] = { ...(plagueByIid[iid] ?? {}), [plague]: condition };
      }
    }
    return { ext: json({ ...current, plagueByIid }) };
  };
}

/** Upstream `quarantine <character>,<plague>,<in|out>[,amount]`: moves
 *  infected party monsters into the story's hidden "quarantine" named box
 *  and releases them back. "in" confiscates infected monsters (inoculating
 *  them first); "out" releases quarantined monsters back to the party.
 *  Lossless: the hidden box is created before anything is confiscated (so
 *  even an empty admission leaves the box behind), a monster leaves the
 *  party only after it is in the box, and a released monster leaves the box
 *  only after it lands in the party or the kennel (party overflow goes to
 *  the kennel, like upstream).
 *
 *  Degraded from upstream in two deliberate ways: admission honours the
 *  box's own `capacity` (a full box keeps the monster, inoculated, in the
 *  party) instead of upstream's routing policy, which renames a full
 *  preferred box and merges it into a successor; and release to a full party
 *  plus a full kennel leaves the monster, inoculated, in the quarantine box,
 *  whereas upstream's `_release_to_kennel` appends past the Kennel capacity. */
function quarantineCommand() {
  return (context: ExtensionCommandContext, value: JsonValue) => {
    const args = argsRecord(value, "tux.quarantine");
    const character = args.character === undefined ? "player" : args.character;
    if (!nonEmptyString(args.plague) || !nonEmptyString(character)) {
      throw new Error("tux.quarantine: character and plague must be strings");
    }
    if (character !== "player") return; // boxes are player-only upstream
    const plague = args.plague;
    const action = String(args.action ?? "");
    if (action !== "in" && action !== "out") {
      throw new Error(`tux.quarantine: action must be "in" or "out"`);
    }
    const current = currentExtensionState(context.ext);
    const isInfected = (monster: SpawnedMonsterSnapshot) =>
      current.plagueByIid[monster.iid!]?.[plague] === "infected";
    if (action === "in") {
      // Upstream creates the hidden box before it looks for infected
      // monsters, so even an empty admission leaves the box behind.
      const existing = current.boxes?.[QUARANTINE_BOX];
      // Honour the box's own capacity (upstream reads per-box capacity in
      // boxes.py); a fresh box gets KENNEL_LIMIT, matching upstream's
      // BoxMetadata(max_capacity=MAX_KENNEL).
      const capacity = existing?.capacity ?? KENNEL_LIMIT;
      const boxMonsters = [...(existing?.monsters ?? [])];
      const staying: SpawnedMonsterSnapshot[] = [];
      const plagueByIid = { ...current.plagueByIid };
      for (const monster of current.party) {
        if (!isInfected(monster)) { staying.push(monster); continue; }
        // Inoculate first, exactly like upstream; only a monster that
        // actually entered the box leaves the party.
        if (monster.iid) {
          plagueByIid[monster.iid] = { ...(plagueByIid[monster.iid] ?? {}), [plague]: "inoculated" };
        }
        if (boxMonsters.length < capacity) boxMonsters.push(monster);
        else staying.push(monster);
      }
      const box = { hidden: true, capacity: KENNEL_LIMIT, ...existing, monsters: boxMonsters };
      return { ext: json({ ...current, party: staying, plagueByIid,
        boxes: { ...current.boxes, [QUARANTINE_BOX]: box } }) };
    }
    // action === "out": upstream stops when the box does not exist.
    const box = current.boxes?.[QUARANTINE_BOX];
    if (!box || box.monsters.length === 0) return;
    const candidates = box.monsters.filter((monster) =>
      monster.iid !== undefined && Object.hasOwn(current.plagueByIid[monster.iid] ?? {}, plague));
    if (candidates.length === 0) return;
    let amount = candidates.length;
    if (args.amount !== undefined && args.amount !== null) {
      const requested = Number(args.amount);
      if (Number.isFinite(requested) && requested >= 0) amount = Math.min(candidates.length, Math.trunc(requested));
    }
    // Upstream draws a random sample for a partial release.
    const releasing = amount >= candidates.length ? candidates : sampleMonsters(context.random, candidates, amount);
    const plagueByIid = { ...current.plagueByIid };
    const party = [...current.party];
    const kennel = [...current.kennel];
    const removedIids = new Set<string>();
    for (const monster of releasing) {
      if (!monster.iid) continue;
      // Inoculate before the move, like upstream; the monster leaves the
      // box only once it has a home (the party, or the kennel on party
      // overflow). A full party and kennel leaves it inoculated in the box.
      plagueByIid[monster.iid] = { ...(plagueByIid[monster.iid] ?? {}), [plague]: "inoculated" };
      if (party.length < PARTY_LIMIT) { party.push(monster); removedIids.add(monster.iid); }
      else if (kennel.length < KENNEL_LIMIT) { kennel.push(monster); removedIids.add(monster.iid); }
    }
    const monsters = box.monsters.filter((monster) =>
      monster.iid === undefined || !removedIids.has(monster.iid));
    return { ext: json({ ...current, party, kennel, plagueByIid,
      boxes: { ...current.boxes, [QUARANTINE_BOX]: { ...box, monsters } } }) };
  };
}

/** Deterministic partial sample mirroring random.sample over the box. */
function sampleMonsters(
  random: () => number,
  candidates: SpawnedMonsterSnapshot[],
  amount: number,
): SpawnedMonsterSnapshot[] {
  const pool = [...candidates];
  const picked: SpawnedMonsterSnapshot[] = [];
  for (let remaining = amount; remaining > 0 && pool.length > 0; remaining--) {
    const index = Math.floor(random() * pool.length);
    picked.push(pool[index]!);
    pool.splice(index, 1);
  }
  return picked;
}

/** Upstream check_battle_legal (combat/utils.py): a party may fight only if
 *  it is non-empty, not every monster is fainted, and every monster has at
 *  least one technique. Exported for direct tests because every imported
 *  monster learns a level-1 move, so the no-tech branch is unreachable
 *  through the staged-party path. */
export function isPartyBattleLegal(party: SpawnedMonsterSnapshot[]): boolean {
  return party.length > 0
    && !party.every((monster) => (monster.currentHp ?? 0) <= 0)
    && party.every((monster) => monster.moves.length > 0);
}

/** npc_battle: run a headless AI-vs-AI battle between two staged NPC parties
 *  and record the outcome the way upstream's CombatState does. Upstream
 *  validates both parties (check_battle_legal) and enters a real CombatState
 *  the player watches; we run the same battle reducer to completion with both
 *  sides on the seeded AI policy. The seed is one draw from the saved RNG, so
 *  save/load, rewind and multi-Hz replay reproduce the same winner. An
 *  illegal party (missing, empty, all fainted, or no techniques) stops the
 *  battle before the seed is drawn, matching check_battle_legal's
 *  pre-battle RNG economy.
 *
 *  RNG economy: the seed draw starts a local cursor that materializes both
 *  parties (thirteen draws each), and the battle starts from that same cursor
 *  after spawning — exactly like the trainer/wild path, which seeds the battle
 *  with the post-enemy-spawn cursor. Restarting from the pre-spawn seed would
 *  replay the spawn draw sequence inside the battle.
 *
 *  Result variables (upstream combat/utils.py, invoked winner-then-loser): on
 *  a decisive fight the winner writes battle_last_winner and
 *  battle_last_trainer, then the loser writes battle_last_loser and overwrites
 *  battle_last_trainer with itself — so the stable trainer value is the loser.
 *  On a true draw upstream writes neither variable: track_battles passes
 *  _handle_draw the opponent list with the current fighter already removed,
 *  and _handle_draw tries to remove that fighter a second time, raising
 *  ValueError before either set_var call (combat/utils.py:184-198,276-291).
 *  This port does not reproduce the crash; it writes the draw code and the
 *  fighter (challenger) trainer code as a deterministic fallback — a
 *  deliberate Degraded divergence, classified T1-lowered by the importer. */
function npcBattleCommand(source: BattleDbSource) {
  return (context: ExtensionCommandContext, value: JsonValue) => {
    const db = resolveBattleDb(source);
    const rulesDb = battleDbToTuxemonBattleDb(db);
    const args = argsRecord(value, "tux.npc_battle");
    const fighter = String(args.fighter ?? "");
    const foe = String(args.foe ?? "");
    if (!nonEmptyString(fighter) || !nonEmptyString(foe)) {
      throw new Error("tux.npc_battle: fighter and foe must be non-empty strings");
    }
    const current = currentExtensionState(context.ext);
    const fighterParty = current.npcParties[fighter] ?? [];
    const foeParty = current.npcParties[foe] ?? [];
    if (fighterParty.length === 0 || foeParty.length === 0) return;
    const spawnSide = (rng: RngState, party: PendingMonster[]): SpawnedMonsterSnapshot[] =>
      party.map((member) => {
        const snapshot = spawnMonster(db, rulesDb, rng, member.slug, member.level, {
          iid: member.iid,
          experienceModifier: member.experienceModifier,
          moneyModifier: member.moneyModifier,
        });
        return applyPendingOverrides(snapshot, {
          ...(member.gender === undefined ? {} : { gender: member.gender }),
          ...(member.acquisition === undefined ? {} : { acquisition: member.acquisition }),
          ...(member.nickname === undefined ? {} : { nickname: member.nickname }),
          ...(member.moves === undefined ? {} : { moves: member.moves }),
          ...(member.health === undefined ? {} : { health: member.health }),
          ...(member.status === undefined ? {} : { status: member.status }),
        });
      });
    // Upstream check_battle_legal (combat/utils.py) refuses a party that is
    // all fainted or includes a monster with no techniques before the battle
    // starts, so an illegal party consumes no battle RNG. Spawn legality
    // (moves and HP) is cursor-independent, so probe both parties on a
    // throwaway cursor and refuse before drawing the saved battle seed.
    const probeRng: RngState = { rng: 0, rngDraws: 0 };
    if (!isPartyBattleLegal(spawnSide(probeRng, fighterParty))
      || !isPartyBattleLegal(spawnSide(probeRng, foeParty))) return;
    const seed = Math.floor(context.random() * 0x100000000) >>> 0;
    const spawnRng = { rng: seed, rngDraws: 0 };
    // Both sides run on the battle's seeded AI policy: side 1 is auto-AI in
    // the phase machine, side 0 is driven here through playerAction, which
    // selects with the same "ai" policy when state.policy is "ai". Spawn
    // both parties first so the battle seed is the post-spawn cursor.
    const playerParty = spawnSide(spawnRng, fighterParty);
    const enemyParty = spawnSide(spawnRng, foeParty);
    // Backstop for the cursor-dependent corner: a tiny positive health
    // fraction can round to 0 HP only for some spawn IVs, so re-check the
    // real snapshots. No imported NPC battle is illegal, so this is
    // unexercised; the probe above already covers every reachable case
    // without consuming the saved seed.
    if (!isPartyBattleLegal(playerParty) || !isPartyBattleLegal(enemyParty)) return;
    const ended = runPolicyBattle(rulesDb, {
      seed: spawnRng.rng,
      kind: "trainer",
      opponent: foe,
      policy: "ai" as unknown as "first",
      player: playerParty,
      enemy: enemyParty,
      inside: false,
      hour: 12,
      fieldSize: 1,
      moneyMethod: "conserved",
      inventory: {},
      variables: {},
    });
    const outcome = ended.result?.outcome ?? "draw";
    const winner = outcome === "won" ? fighter : outcome === "lost" ? foe : null;
    const history = [...current.history];
    if (winner === fighter) {
      history.push({ fighter, opponent: foe, outcome: "won" });
      history.push({ fighter: foe, opponent: fighter, outcome: "lost" });
    } else if (winner === foe) {
      history.push({ fighter: foe, opponent: fighter, outcome: "won" });
      history.push({ fighter, opponent: foe, outcome: "lost" });
    } else {
      history.push({ fighter, opponent: foe, outcome: "draw" });
      history.push({ fighter: foe, opponent: fighter, outcome: "draw" });
    }
    // Winner handling then loser handling: winner and loser land in their
    // own enum domains, and the loser's trainer write is the one that sticks.
    const writes: Record<string, number | string> = {};
    if (winner !== null) {
      writes["v.battle_last_winner"] = Number(winner === fighter ? args.fighterWinnerCode : args.foeWinnerCode);
      writes["v.battle_last_loser"] = Number(winner === fighter ? args.foeLoserCode : args.fighterLoserCode);
      writes["v.battle_last_trainer"] = Number(winner === fighter ? args.foeTrainerCode : args.fighterTrainerCode);
    } else {
      writes["v.battle_last_result"] = Number(args.drawCode);
      // Upstream raises before either variable write on a true draw; writing
      // the draw code and the fighter (challenger) trainer code is a
      // deterministic fallback (Degraded), not upstream parity.
      writes["v.battle_last_trainer"] = Number(args.fighterTrainerCode);
    }
    return {
      ext: json({ ...current, history }),
      writes,
    };
  };
}

/** random_monster: pick a species from the upstream-qualified pool and add
 *  it to the player's party or an NPC's staged team. The pool excludes
 *  txmn_id<=0, randomly=false, monsters that evolve at or before the level,
 *  and underleveled forms. The single choice draw precedes the spawn draws. */
function randomMonsterCommand(source: BattleDbSource) {
  return (context: ExtensionCommandContext, value: JsonValue) => {
    const db = resolveBattleDb(source);
    const rulesDb = battleDbToTuxemonBattleDb(db);
    const args = argsRecord(value, "tux.random_monster");
    if (!safeInteger(args.level) || args.level < 1) {
      throw new Error("tux.random_monster: level must be a positive integer");
    }
    const level = args.level;
    const character = args.character === undefined ? "player" : args.character;
    if (!nonEmptyString(character)) throw new Error("tux.random_monster: character must be a string");
    const experienceModifier = args.experienceModifier === undefined ? 1 : args.experienceModifier;
    const moneyModifier = args.moneyModifier === undefined ? 0 : args.moneyModifier;
    if (!finite(experienceModifier) || !finite(moneyModifier)) {
      throw new Error("tux.random_monster: modifiers must be finite");
    }
    const pool = randomMonsterPool(db, level);
    if (pool.length === 0) return; // upstream logs an error and stops
    const slug = pool[Math.floor(context.random() * pool.length)]!;
    const current = currentExtensionState(context.ext);
    const [iid, followingId] = nextIid(current);
    if (character !== "player") {
      const party = [...(current.npcParties[character] ?? [])];
      if (party.length < PARTY_LIMIT) {
        party.push({
          iid,
          slug,
          level: Math.max(db.rules.levelRange[0], Math.min(db.rules.levelRange[1], level)),
          experienceModifier,
          moneyModifier,
        });
      }
      return {
        ext: json({ ...current, npcParties: { ...current.npcParties, [character]: party }, nextMonsterId: followingId }),
        writes: { "v.add_monster": iid },
      };
    }
    const monster = spawnMonsterWithRandom(db, rulesDb, context.random, slug, level, {
      iid,
      experienceModifier,
      moneyModifier,
    });
    const party = [...current.party];
    const kennel = [...current.kennel];
    if (party.length < PARTY_LIMIT) party.push(monster);
    else if (kennel.length < KENNEL_LIMIT) kennel.push(monster);
    return {
      ext: json(registerCaughtMonster({ ...current, party, kennel, nextMonsterId: followingId }, slug)),
      writes: { "v.add_monster": iid },
    };
  };
}

const randomMonsterPoolCache = new WeakMap<BattleDb, Map<number, string[]>>();

/** Upstream-qualified random_monster pool for a level, sorted for a
 *  deterministic draw. */
function randomMonsterPool(db: BattleDb, level: number): string[] {
  let byLevel = randomMonsterPoolCache.get(db);
  if (!byLevel) {
    byLevel = new Map();
    randomMonsterPoolCache.set(db, byLevel);
  }
  const cached = byLevel.get(level);
  if (cached) return cached;
  // Parent -> evolutions targeting a slug, for the underleveled-form check.
  const evolvesInto = new Map<string, Array<{ slug: string; atLevel: number | null }>>();
  for (const [parentSlug, species] of Object.entries(db.monsters)) {
    for (const evolution of species.evolutions) {
      const target = String((evolution as Record<string, unknown>).monster_slug ?? "");
      const atLevel = (evolution as Record<string, unknown>).at_level;
      if (!target) continue;
      const list = evolvesInto.get(parentSlug) ?? [];
      list.push({ slug: target, atLevel: typeof atLevel === "number" ? atLevel : null });
      evolvesInto.set(parentSlug, list);
    }
  }
  const pool: string[] = [];
  for (const [slug, species] of Object.entries(db.monsters)) {
    if (species.txmnId <= 0) continue;
    if (species.randomly === false) continue;
    const evolvesAtLevel = species.evolutions.some((evolution) => {
      const atLevel = (evolution as Record<string, unknown>).at_level;
      return typeof atLevel === "number" && atLevel <= level;
    });
    if (evolvesAtLevel) continue;
    const underleveled = (species.evolvesFrom ?? []).some((parent) => {
      const evolution = evolvesInto.get(parent)?.find((entry) => entry.slug === slug);
      return evolution?.atLevel !== undefined && evolution.atLevel !== null && level < evolution.atLevel;
    });
    if (underleveled) continue;
    pool.push(slug);
  }
  pool.sort();
  byLevel.set(level, pool);
  return pool;
}

/** set_bill: create or replace a character's bill, keeping the authored
 *  interest rate, late fee and battle-earnings share (upstream stores all
 *  four; interest and fees are applied by adjust_bill_penalty, the share
 *  by trainer-battle winnings). */
function setBillCommand() {
  return (context: ExtensionCommandContext, value: JsonValue) => {
    const args = argsRecord(value, "tux.set_bill");
    const character = args.character === undefined ? "player" : args.character;
    if (!nonEmptyString(character) || !nonEmptyString(args.bill)) {
      throw new Error("tux.set_bill: character and bill must be strings");
    }
    const amount = args.amount === undefined ? 0 : args.amount;
    if (!safeInteger(amount) || amount < 0) {
      throw new Error("tux.set_bill: amount must be a non-negative integer");
    }
    const rate = (name: string): number | undefined => {
      const raw = args[name];
      if (raw === undefined || raw === null || raw === "") return undefined;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`tux.set_bill: ${name} must be a non-negative number`);
      }
      return parsed;
    };
    const interestRate = rate("interestRate");
    const shareRate = rate("shareRate");
    if (shareRate !== undefined && shareRate > 1) {
      throw new Error("tux.set_bill: shareRate must be at most 1");
    }
    const lateFeeRaw = args.lateFee;
    let lateFee: number | undefined;
    if (lateFeeRaw !== undefined && lateFeeRaw !== null && lateFeeRaw !== "") {
      lateFee = Number(lateFeeRaw);
      if (!safeInteger(lateFee) || lateFee < 0) {
        throw new Error("tux.set_bill: lateFee must be a non-negative integer");
      }
    }
    const entry: BillEntry = { amount };
    if (interestRate !== undefined) entry.interestRate = interestRate;
    if (lateFee !== undefined) entry.lateFee = lateFee;
    if (shareRate !== undefined) entry.shareRate = shareRate;
    const current = currentExtensionState(context.ext);
    const tabs = { ...(current.bills[character] ?? {}) };
    tabs[args.bill] = entry;
    return { ext: json({ ...current, bills: { ...current.bills, [character]: tabs } }) };
  };
}

/** modify_bill: add to (or subtract from) a bill. A negative amount that
 *  brings the bill to zero or below deletes it. A float variable is
 *  upstream's ratio mode: the delta is the bill's current amount times the
 *  variable, truncated (whole-valued variables are direct deltas). */
function modifyBillCommand() {
  return (context: ExtensionCommandContext, value: JsonValue) => {
    const args = argsRecord(value, "tux.modify_bill");
    const character = args.character === undefined ? "player" : args.character;
    if (!nonEmptyString(character) || !nonEmptyString(args.bill)) {
      throw new Error("tux.modify_bill: character and bill must be strings");
    }
    const current = currentExtensionState(context.ext);
    const existing = current.bills[character]?.[args.bill];
    if (!existing) return; // upstream raises KeyError and stops
    let delta: number;
    if (args.amount !== undefined && args.amount !== null && args.amount !== "") {
      delta = Number(args.amount);
      if (!Number.isFinite(delta)) throw new Error("tux.modify_bill: amount must be numeric");
      delta = Math.trunc(delta);
    } else if (nonEmptyString(args.variable)) {
      const resolved = context.variables[args.variable];
      let value: number | undefined;
      if (typeof resolved === "number") value = resolved;
      else if (typeof resolved === "string" && resolved.trim() !== "") {
        const parsed = Number(resolved);
        if (Number.isFinite(parsed)) value = parsed;
      }
      if (value === undefined) return;
      delta = Number.isInteger(value)
        ? value
        : Math.trunc(existing.amount * value);
    } else {
      delta = 0;
    }
    const amount = existing.amount + delta;
    const tabs = { ...(current.bills[character] ?? {}) };
    if (amount <= 0) delete tabs[args.bill];
    else tabs[args.bill] = { ...existing, amount };
    return { ext: json({ ...current, bills: { ...current.bills, [character]: tabs } }) };
  };
}

/** adjust_bill_penalty: apply a bill's stored interest (truncating,
 *  compounding on the current amount) or its flat late fee once. Upstream
 *  logs and skips a missing bill, character or unknown method; the kit
 *  treats those as a no-op like its other bill commands. */
function adjustBillPenaltyCommand() {
  return (context: ExtensionCommandContext, value: JsonValue) => {
    const args = argsRecord(value, "tux.adjust_bill_penalty");
    const character = args.character === undefined ? "player" : args.character;
    if (!nonEmptyString(character) || !nonEmptyString(args.bill)) return;
    const method = String(args.penalty ?? "");
    if (method !== "interest" && method !== "fee") return;
    const current = currentExtensionState(context.ext);
    const existing = current.bills[character]?.[args.bill];
    if (!existing || existing.amount <= 0) return;
    let amount = existing.amount;
    if (method === "interest") {
      if (!existing.interestRate || existing.interestRate <= 0) return;
      amount += Math.trunc(existing.amount * existing.interestRate);
    } else {
      if (!existing.lateFee || existing.lateFee <= 0) return;
      amount += existing.lateFee;
    }
    const tabs = { ...(current.bills[character] ?? {}) };
    tabs[args.bill] = { ...existing, amount };
    return { ext: json({ ...current, bills: { ...current.bills, [character]: tabs } }) };
  };
}

/** Upstream MoneyManager.apply_all_battle_shares: each of the winner's
 *  bills with a shareRate diverts trunc(earnings * rate) of the battle
 *  winnings to pay itself down (a bill reaching zero is deleted), and
 *  bills cascade on the remainder. The caller gates on trainer battles
 *  won by the player; wild battles and losses never share. */
export function applyBattleSharesToBills(
  bills: TuxemonExtensionState["bills"],
  earnings: number,
): { bills: TuxemonExtensionState["bills"]; earnings: number } {
  const playerTabs = bills.player;
  if (!playerTabs || earnings <= 0) return { bills, earnings };
  let remaining = earnings;
  let changed = false;
  const tabs = { ...playerTabs };
  for (const [slug, entry] of Object.entries(playerTabs)) {
    if (entry.amount <= 0 || !entry.shareRate || entry.shareRate <= 0) continue;
    const deduction = Math.trunc(remaining * entry.shareRate);
    if (deduction <= 0) continue;
    changed = true;
    remaining -= deduction;
    const amount = entry.amount - deduction;
    if (amount <= 0) delete tabs[slug];
    else tabs[slug] = { ...entry, amount };
  }
  if (!changed) return { bills, earnings };
  return { bills: { ...bills, player: tabs }, earnings: remaining };
}

/** check_party_parameter: count party members whose attribute equals the
 *  value, then compare the count against `times` with the given operator. */
function checkPartyParameterCondition(source: BattleDbSource) {
  return (context: ExtensionReadContext, value: JsonValue) => {
    const db = resolveBattleDb(source);
    const args = argsRecord(value, "tux.check_party_parameter");
    if (!nonEmptyString(args.character) || !nonEmptyString(args.attribute)) return false;
    const attribute = args.attribute as string;
    const party = partyFor(currentExtensionState(context.ext), args.character);
    if (party.length === 0) return negate(false, args);
    const wanted = String(args.value ?? "");
    const matches = party.filter((monster) => {
      const snapshot = monster as SpawnedMonsterSnapshot;
      const species = db.monsters[monster.slug];
      const actual = monsterAttribute(snapshot, species, attribute);
      return actual !== undefined && String(actual) === wanted;
    }).length;
    const times = Math.min(Number(args.times ?? 1), party.length);
    return negate(compare(args.operator, matches, times), args);
  };
}

function monsterAttribute(
  snapshot: SpawnedMonsterSnapshot,
  species: BattleDb["monsters"][string] | undefined,
  attribute: string,
): string | number | undefined {
  switch (attribute) {
    case "stage": return snapshot.stage ?? species?.stage;
    case "gender": return snapshot.gender;
    case "slug": return snapshot.slug;
    case "level": return snapshot.level;
    case "acquisition": return snapshot.acquisition;
    case "name": return snapshot.nickname ?? species?.name;
    case "txmn_id": return species?.txmnId;
    default: return undefined;
  }
}

/** check_max_tech: true when at least one party monster knows more techniques
 *  than its species max (default 4). */
function checkMaxTechCondition(source: BattleDbSource) {
  return (context: ExtensionReadContext, value: JsonValue) => {
    const db = resolveBattleDb(source);
    const args = argsRecord(value, "tux.check_max_tech");
    const character = args.character === undefined ? "player" : args.character;
    if (!nonEmptyString(character)) return false;
    const party = partyFor(currentExtensionState(context.ext), character);
    const threshold = args.number === undefined || args.number === null
      ? null
      : Number(args.number);
    const over = party.some((monster) => {
      const snapshot = monster as SpawnedMonsterSnapshot;
      const max = threshold !== null && Number.isFinite(threshold)
        ? threshold
        : (db.rules.maxMoves ?? 4);
      return snapshot.moves.length > max;
    });
    return negate(over, args);
  };
}

/** party_infected: count party monsters infected with a plague and compare
 *  against all/some/none. */
function partyInfectedCondition() {
  return (context: ExtensionReadContext, value: JsonValue) => {
    const args = argsRecord(value, "tux.party_infected");
    if (!nonEmptyString(args.character) || !nonEmptyString(args.plague)) return false;
    const character = args.character as string;
    const plague = args.plague as string;
    const state = currentExtensionState(context.ext);
    const party = partyFor(state, character);
    const infected = party.filter((monster) =>
      monster.iid !== undefined
      && state.plagueByIid[monster.iid]?.[plague] === "infected").length;
    const mode = String(args.value ?? "none");
    let result: boolean;
    if (mode === "all") result = infected === party.length;
    else if (mode === "some") result = party.length > infected && infected > 0;
    else if (mode === "none") result = infected === 0;
    else result = false;
    return negate(result, args);
  };
}

/** bill_is: compare a bill's amount against a value. A missing or zero
 *  bill is always false upstream. */
function billIsCondition() {
  return (context: ExtensionReadContext, value: JsonValue) => {
    const args = argsRecord(value, "tux.bill_is");
    if (!nonEmptyString(args.character) || !nonEmptyString(args.bill)) return false;
    const state = currentExtensionState(context.ext);
    const bill = state.bills[args.character]?.[args.bill];
    if (!bill || bill.amount === 0) return negate(false, args);
    const amount = typeof args.amount === "number" ? args.amount : Number(args.amount ?? 0);
    if (!Number.isFinite(amount)) return negate(false, args);
    return negate(compare(args.operator, bill.amount, amount), args);
  };
}
/** Pure game registration used by createSession, GameView and attract replay. */
export function createTuxemonExtensions(
  source: BattleDbSource,
  options: Readonly<TuxemonExtensionRuntimeOptions> = {},
): TuxemonExtensionOptions {
  const weatherSchedule: WeatherSchedule = {
    slugs: [...new Set(options.weatherSchedule?.slugs ?? DEFAULT_WEATHER_SLUGS)].sort(),
    ...(options.weatherSchedule?.minDurationMinutes === undefined
      ? {}
      : { minDurationMinutes: options.weatherSchedule.minDurationMinutes }),
    ...(options.weatherSchedule?.maxDurationMinutes === undefined
      ? {}
      : { maxDurationMinutes: options.weatherSchedule.maxDurationMinutes }),
  };
  const weatherSlugs = new Set(weatherSchedule.slugs);
  const hemisphere = options.hemisphere ?? "northern";
  if (hemisphere !== "northern" && hemisphere !== "southern") {
    throw new Error(`Tuxemon extension: unsupported hemisphere '${String(hemisphere)}'`);
  }
  const initial = json(initialTuxemonExtensionState(options.initialTimeWeather));
  const validationDb = typeof source !== "function" && !("load" in source) ? source : undefined;
  // cloneExtension invokes the validator on every frame. The envelope's
  // packed strings are immutable, so validating each distinct tuple once
  // retains the full boundary check without reparsing an unchanged party.
  let lastValidatedRuntime: string | null = null;
  // A tick result derives from the already validated current state and only
  // replaces clock/weather after checking their complete invariants. Keep a
  // one-shot marker so applyExtensionResult need not parse and re-walk the
  // unchanged party/history before publishing that exact result.
  let trustedTickRuntime: string | null = null;
  // The packed clock changes every reference tick, while every extension
  // condition except tux.time_is reads only coreWire. time_is observes civil
  // minutes (plus an optional one-tick lookahead), so its truth table can
  // change only at the pre-minute boundary or when the minute/day rolls.
  // Reuse an opaque identity between those points so the kit can retain page,
  // trigger-scan and sleeping-guard condition results without parsing the
  // full extension state on every tick.
  let conditionKeyCoreWire: string | null = null;
  let conditionKeyEpochDay = -1;
  let conditionKeyMinuteOfDay = -1;
  let conditionKeyPreMinuteBoundary = false;
  let conditionKey: object = Object.freeze({});
  const conditionCacheKey = (value: JsonValue): unknown => {
    const envelope = runtimeEnvelope(value);
    if (!envelope) return value;
    const preMinuteBoundary = envelope.subMinuteTicks === envelope.ticksPerGameMinute - 1;
    if (envelope.coreWire !== conditionKeyCoreWire ||
        envelope.epochDay !== conditionKeyEpochDay ||
        envelope.minuteOfDay !== conditionKeyMinuteOfDay ||
        preMinuteBoundary !== conditionKeyPreMinuteBoundary) {
      conditionKeyCoreWire = envelope.coreWire;
      conditionKeyEpochDay = envelope.epochDay;
      conditionKeyMinuteOfDay = envelope.minuteOfDay;
      conditionKeyPreMinuteBoundary = preMinuteBoundary;
      conditionKey = Object.freeze({});
    }
    return conditionKey;
  };
  let entryConditionExtKey: unknown;
  let entryConditionPlayerName: string | null = null;
  let entryConditionKey: object = Object.freeze({});
  let registration: TuxemonExtensionOptions;
  registration = {
    initial,
    immutableConditions: true,
    deterministicConditions: true,
    conditionCacheKey,
    // The exact boolean is a minimal complete dependency key. Parsing the
    // packed state is shared across these calls, so this is far cheaper than
    // serializing every built-in bank or rebuilding all entry characters.
    entryConditionCacheKey: (context, call, args) => {
      // Source compatibility with older kits that ask for one complete
      // entry key. Newer kits pass the exact condition and get its boolean
      // outcome, avoiding invalidation from unrelated packed-state changes.
      if (call === undefined || args === undefined) {
        const extKey = conditionCacheKey(context.ext);
        if (extKey !== entryConditionExtKey || context.playerName !== entryConditionPlayerName) {
          entryConditionExtKey = extKey;
          entryConditionPlayerName = context.playerName;
          entryConditionKey = Object.freeze({});
        }
        return entryConditionKey;
      }
      const handler = registration.conditions?.[call];
      if (!handler) throw new Error(`unknown Tuxemon extension condition ${JSON.stringify(call)}`);
      return handler(context, args);
    },
    playerStep: { call: "tux.player_step", args: {} },
    commands: {
      "tux.add_monster": addMonsterCommand(source),
      "tux.set_monster_health": healthCommand(),
      "tux.set_monster_status": statusCommand(source),
      "tux.set_tuxepedia": tuxepediaCommand(source),
      "tux.prepare_monster_rename": prepareMonsterRenameCommand(source),
      "tux.apply_monster_rename": applyMonsterRenameCommand(),
      "tux.evolution": evolutionCommand(source),
      "tux.cancel_evolution": (context, value) => {
        const args = argsRecord(value, "tux.cancel_evolution");
        const character = args.character === undefined ? "player" : args.character;
        if (!nonEmptyString(character)) throw new Error("tux.cancel_evolution: character must be a string");
        const current = currentExtensionState(context.ext);
        return { ext: json(character === "player" ? clearPendingEvolution(current) : current) };
      },
      "tux.set_environment": (context, value) => {
        const args = argsRecord(value, "tux.set_environment");
        const environment = args.environment === undefined || args.environment === ""
          ? null
          : args.environment;
        if (environment !== null && !nonEmptyString(environment)) {
          throw new Error("tux.set_environment: environment must be a string");
        }
        const current = currentExtensionState(context.ext);
        return { ext: json({ ...current, environment }) };
      },
      "tux.remove_monster": removeMonsterCommand(),
      "tux.get_party_monsters": getPartyMonstersCommand(),
      "tux.clear_npc_party": clearNpcPartyCommand(),
      "tux.clear_npc_parties": clearNpcPartiesCommand(),
      "tux.set_monster_attribute": setMonsterAttributeCommand(),
      "tux.add_tech": addTechCommand(source),
      "tux.char_plague": charPlagueCommand(),
      "tux.quarantine": quarantineCommand(),
      "tux.npc_battle": npcBattleCommand(source),
      "tux.random_monster": randomMonsterCommand(source),
      "tux.set_bill": setBillCommand(),
      "tux.modify_bill": modifyBillCommand(),
      "tux.adjust_bill_penalty": adjustBillPenaltyCommand(),
      "tux.create_kennel": createKennelCommand(),
      "tux.set_kennel_visible": setKennelVisibleCommand(),
      "tux.player_step": playerStepCommand(source),
      "tux.add_step_tracker": addStepTrackerCommand(),
      "tux.remove_step_tracker": removeStepTrackerCommand(),
      "tux.set_step_tracker_milestone_shown": milestoneShownCommand(),
      "tux.set_variable_text": setVariableTextCommand,
      "tux.variable_math": variableMathCommand,
      "tux.format_variable": formatVariableCommand,
      "tux.tick_time_weather": (context, value) => {
        const args = argsRecord(value, "tux.tick_time_weather");
        if (args.daylight !== undefined && typeof args.daylight !== "boolean") {
          throw new Error("tux.tick_time_weather: daylight must be boolean");
        }
        const sourceWasValidated = typeof context.ext === "string"
          && context.ext === lastValidatedRuntime;
        const packed = packTimeWeatherAdvance(context.ext, weatherSchedule);
        // Only an engine-validated predecessor may authorize the one-shot
        // fast validation of its derived tick. Direct handler callers and
        // forged contexts still take the complete validator path.
        trustedTickRuntime = sourceWasValidated ? packed.wire : null;
        if (args.daylight !== true) return { ext: packed.wire };
        // A stage can only change on a game-minute boundary. The initial
        // undefined target is still published immediately after boot.
        if (packed.subMinuteTicks !== 0
          && context.variables[DAYLIGHT_STAGE_VARIABLE] !== undefined) {
          return { ext: packed.wire };
        }
        const stage = stageOfDayFromMinute(packed.minuteOfDay);
        const marker = DAYLIGHT_TINT_PROFILES.find((profile) => profile.stage === stage)!.marker;
        return context.variables[DAYLIGHT_STAGE_VARIABLE] === marker
          ? { ext: packed.wire }
          : { ext: packed.wire, writes: { [DAYLIGHT_TARGET_VARIABLE]: marker } };
      },
      "tux.update_time": (context, value) => {
        const args = argsRecord(value, "tux.update_time");
        const character = args.character === undefined ? "player" : args.character;
        if (!nonEmptyString(character)) {
          throw new Error("tux.update_time: character must be a string");
        }
        const current = currentExtensionState(context.ext);
        return { writes: updateTimeWrites(current.clock, hemisphere) };
      },
      "tux.set_faint_point": (context, value) => {
        const args = argsRecord(value, "tux.set_faint_point");
        const character = args.character === undefined ? "player" : args.character;
        if (!nonEmptyString(character) || !nonEmptyString(args.map)
          || !safeInteger(args.x) || args.x < 0 || !safeInteger(args.y) || args.y < 0) {
          throw new Error("tux.set_faint_point: invalid character/map/coordinates");
        }
        const current = currentExtensionState(context.ext);
        return { ext: json({
          ...current,
          faintPoints: { ...current.faintPoints, [character]: { map: args.map, x: args.x, y: args.y } },
        }) };
      },
      "tux.prepare_faint_transfer": (context, value) => {
        const args = argsRecord(value, "tux.prepare_faint_transfer");
        const character = args.character === undefined ? "player" : args.character;
        if (!nonEmptyString(character)) throw new Error("tux.prepare_faint_transfer: invalid character");
        const current = currentExtensionState(context.ext);
        const point = current.faintPoints[character];
        if (!point) return;
        const healHere = args.healing === true && args.currentMap === point.map;
        const ext = healHere
          ? updatePlayerMonsters(current, null, (monster) => ({
              ...monster,
              currentHp: monster.base.hp,
              status: null,
            }))
          : current;
        return { ext: json(ext), writes: {
          "tux.faint.map": point.map,
          "tux.faint.x": point.x,
          "tux.faint.y": point.y,
        } };
      },
    },
    conditions: {
      "tux.check_evolution": (context, value) => {
        const args = argsRecord(value, "tux.check_evolution");
        const character = args.character === undefined ? "player" : args.character;
        if (!nonEmptyString(character)) return false;
        const state = currentExtensionState(context.ext);
        const waiting = character === "player"
          && state.party.some((monster) => monster.waitingToEvolve === true);
        return negate(waiting, args);
      },
      "tux.environment_is": (context, value) => {
        const args = argsRecord(value, "tux.environment_is");
        if (!nonEmptyString(args.environment)) return false;
        const state = currentExtensionState(context.ext);
        return negate(state.environment === args.environment, args);
      },
      // `check_char_parameter <character>,name,<value>` for the player:
      // upstream reads the character's live name attribute when the condition
      // runs, and rename_player updates that same live name, so the check must
      // not be folded against the initial name at import time.
      "tux.player_name_is": (context, value) => {
        const args = argsRecord(value, "tux.player_name_is");
        if (typeof args.name !== "string") return false;
        return negate(context.playerName === args.name, args);
      },
      "tux.has_tuxepedia": (context, value) => {
        const args = argsRecord(value, "tux.has_tuxepedia");
        if (args.character !== "player" || !nonEmptyString(args.species)
          || (args.status !== "seen" && args.status !== "caught")) return false;
        const state = currentExtensionState(context.ext);
        const registered = args.status === "seen"
          ? state.seen.includes(args.species)
          : state.caught.includes(args.species);
        return negate(registered, args);
      },
      "tux.char_healed": (context, value) => {
        const args = argsRecord(value, "tux.char_healed");
        if (args.character !== "player") return false;
        const party = currentExtensionState(context.ext).party;
        const healed = party.length > 0 && party.every((monster) =>
          monster.base.hp > 0 && monster.currentHp === monster.base.hp
        );
        return negate(healed, args);
      },
      "tux.time_is": (context, value) => {
        const args = argsRecord(value, "tux.time_is");
        if (!nonEmptyString(args.property) || !nonEmptyString(args.operation)
          || typeof args.value !== "string") return false;
        const tickOffset = args.tickOffset === undefined ? 0 : args.tickOffset;
        if (tickOffset !== 0 && tickOffset !== 1) return false;
        const envelope = runtimeEnvelope(context.ext);
        const clock = envelope
          ? clockFromRuntimeEnvelope(envelope)
          : currentExtensionState(context.ext).clock;
        return negate(timeIs(
          tickOffset === 0 ? clock : advanceClock(clock, tickOffset),
          args.property,
          args.operation,
          args.value,
          hemisphere,
        ), args);
      },
      "tux.has_faint_point": (context, value) => {
        const args = argsRecord(value, "tux.has_faint_point");
        if (!nonEmptyString(args.character)) return false;
        const state = currentExtensionState(context.ext);
        return negate(state.faintPoints[args.character] !== undefined, args);
      },
      "tux.faint_point_is_map": (context, value) => {
        const args = argsRecord(value, "tux.faint_point_is_map");
        if (!nonEmptyString(args.character) || !nonEmptyString(args.map)) return false;
        const state = currentExtensionState(context.ext);
        return negate(state.faintPoints[args.character]?.map === args.map, args);
      },
      "tux.party_size": (context, value) => {
        const args = argsRecord(value, "tux.party_size");
        if (!nonEmptyString(args.character) || !safeInteger(args.value)) return false;
        const state = currentExtensionState(context.ext);
        return negate(compare(args.operator, partyFor(state, args.character).length, args.value), args);
      },
      "tux.has_monster": (context, value) => {
        const args = argsRecord(value, "tux.has_monster");
        if (!nonEmptyString(args.character) || !nonEmptyString(args.species)) return false;
        const state = currentExtensionState(context.ext);
        return negate(partyFor(state, args.character).some((monster) => monster.slug === args.species), args);
      },
      "tux.char_defeated": (context, value) => {
        const args = argsRecord(value, "tux.char_defeated");
        if (!nonEmptyString(args.character)) return false;
        const state = currentExtensionState(context.ext);
        const party = partyFor(state, args.character);
        const defeated = party.length > 0 && party.every((monster) =>
          "currentHp" in monster && monster.currentHp !== undefined && monster.currentHp <= 0
        );
        return negate(defeated, args);
      },
      "tux.battle_outcome": (context, value) => {
        const args = argsRecord(value, "tux.battle_outcome");
        if (!nonEmptyString(args.fighter) || !nonEmptyString(args.opponent)
          || !["won", "lost", "draw"].includes(String(args.outcome))) return false;
        const state = currentExtensionState(context.ext);
        const found = state.history.some((entry) => entry.fighter === args.fighter
          && entry.opponent === args.opponent && entry.outcome === args.outcome);
        return negate(found, args);
      },
      "tux.battle_outcome_count": (context, value) => {
        const args = argsRecord(value, "tux.battle_outcome_count");
        if (!nonEmptyString(args.fighter) || !nonEmptyString(args.opponent)
          || !["won", "lost", "draw"].includes(String(args.outcome))
          || !safeInteger(args.count) || args.count < 0) return false;
        const state = currentExtensionState(context.ext);
        const count = state.history.filter((entry) => entry.fighter === args.fighter
          && entry.opponent === args.opponent && entry.outcome === args.outcome).length;
        return negate(count >= args.count, args);
      },
      "tux.party_match": partyMatchCondition(source),
      "tux.check_party_parameter": checkPartyParameterCondition(source),
      "tux.check_max_tech": checkMaxTechCondition(source),
      "tux.party_infected": partyInfectedCondition(),
      "tux.bill_is": billIsCondition(),
      "tux.step_tracker": stepTrackerCondition,
      "tux.variable_text": variableTextCondition,
      // `kennel <character>,<box>,visible|hidden|exist`. A missing character
      // or option tests false, so the negated form is true.
      "tux.kennel": (context, value) => {
        const args = argsRecord(value, "tux.kennel");
        if (!nonEmptyString(args.character) || !nonEmptyString(args.kennel)) return negate(false, args);
        const box = args.character === "player"
          ? boxOf(currentExtensionState(context.ext), args.kennel)
          : null;
        const result = box !== null && (args.option === "exist"
          || (args.option === "visible" && !box.hidden)
          || (args.option === "hidden" && box.hidden));
        return negate(result, args);
      },
      // `has_kennel <character>,<box>,<op>,<n>` counts one box. Upstream
      // raises for a missing box and the evaluator then fails the condition
      // for both `is` and `not`, so a missing box is false either way.
      "tux.has_kennel": (context, value) => {
        const args = argsRecord(value, "tux.has_kennel");
        if (!nonEmptyString(args.character) || !nonEmptyString(args.kennel) || !safeInteger(args.value)) {
          return false;
        }
        if (args.character !== "player") return false;
        const box = boxOf(currentExtensionState(context.ext), args.kennel);
        if (box === null) return false;
        return negate(compare(args.operator, box.monsters.length, args.value), args);
      },
    },
    choices: {
      "tux.party_monsters": partyMonstersChoice(source),
      "tux.enum_choice": enumChoiceHandler(),
    },
    codec: {
      encode: (value) => ({
        format: TUXEMON_EXT_SAVE_FORMAT,
        state: tuxemonExtensionState(value, resolveBattleDb(source), weatherSlugs) as unknown as JsonValue,
        ...(options.lang ? { lang: options.lang } : {}),
      }),
      decode: (value) => {
        if (value === null) return initial;
        let saved = record(value);
        // Saves written before the kit stored map runtime wrapped this state
        // together with the character table (ui/save-game.ts). restoreSave()
        // migrates them; a generic kit restore reaches here with the wrapper
        // and loads the extension state alone.
        if (saved?.format === GAME_SAVE_EXT_FORMAT && saved.ext !== undefined) {
          value = saved.ext as JsonValue;
          saved = record(value);
        }
        if (saved?.format === TUXEMON_EXT_SAVE_FORMAT && saved.state !== undefined) {
          const migrated = migrateV1(saved.state as JsonValue);
          return json(tuxemonExtensionState(migrated, resolveBattleDb(source), weatherSlugs));
        }
        // Accept a direct v1 state for development snapshots made before the
        // save wrapper was introduced.
        if (saved?.version === 1) {
          return json(tuxemonExtensionState(migrateV1(value), resolveBattleDb(source), weatherSlugs));
        }
        throw new Error("unsupported Tuxemon extension save format");
      },
    },
    validate: (value) => {
      if (typeof value === "string" && value === lastValidatedRuntime) return;
      if (typeof value === "string" && value === trustedTickRuntime) {
        trustedTickRuntime = null;
        lastValidatedRuntime = value;
        return;
      }
      // Lazy production sources live in the pak. Commands and save restore
      // perform the database-backed check at their boundary; the hot-frame
      // validator still checks the complete numeric/shape invariants here.
      const problem = tuxemonExtensionProblem(value, validationDb, weatherSlugs);
      if (!problem && typeof value === "string") lastValidatedRuntime = value;
      return problem ?? undefined;
    },
  };
  return registration;
}

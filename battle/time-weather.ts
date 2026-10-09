// Deterministic Tuxemon calendar, clock and weather runtime.
//
// A host may sample its wall clock exactly once and pass the resulting civil
// fields to timeWeatherAt(). Everything after that point is a pure function
// of reducer state and fixed 60 Hz reference ticks.

import type { JsonValue, VariableValue } from "../vendor/pocket-rpgkit/src/engine/types.ts";

export const TIME_WEATHER_SAVE_FORMAT = "pocket-tuxemon/time-weather/v1";
export const DEFAULT_TICKS_PER_GAME_MINUTE = 3_600;
export const DEFAULT_WEATHER_MIN_MINUTES = 30;
export const DEFAULT_WEATHER_MAX_MINUTES = 90;
export const DEFAULT_WEATHER_SEED = 0x9e37_79b9;

/** Stable table order used when a caller has not supplied imported rows. */
export const DEFAULT_WEATHER_SLUGS = Object.freeze([
  "cloudy",
  "foggy",
  "freezing",
  "hot",
  "misty",
  "rain",
  "snow",
  "sunny",
  "thunderstorm",
  "windy",
]);

export type Hemisphere = "northern" | "southern";
export type StageOfDay = "dawn" | "morning" | "afternoon" | "dusk" | "night";
export type Season = "winter" | "spring" | "summer" | "autumn";

export interface ClockState {
  mode: "game";
  /** Number of active 60 Hz world ticks since this clock was created. */
  refTick: number;
  /** Gregorian days since 1970-01-01 in the sampled local calendar. */
  epochDay: number;
  /** Minutes since local midnight, 0..1439. */
  minuteOfDay: number;
  /** Reference ticks accumulated toward the next game minute. */
  subMinuteTicks: number;
  ticksPerGameMinute: number;
}

export interface WeatherState {
  slug: string;
  enteredAtTick: number;
  nextTransitionTick: number;
  /** Independent mulberry32 cursor; never touches SessionState.sw.rng. */
  rngCursor: number;
}

export interface TimeWeatherState {
  clock: ClockState;
  weather: WeatherState;
}

export interface CivilDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export interface TimeSnapshot extends CivilDateTime {
  dayOfYear: number;
  weekday: string;
  leapYear: "true" | "false";
  daytime: "true" | "false";
  stageOfDay: StageOfDay;
  season: Season;
}

export interface WeatherSchedule {
  slugs: readonly string[];
  minDurationMinutes?: number;
  maxDurationMinutes?: number;
}

/** Fixed test/journey/legacy-save start, deliberately not a source holiday. */
export const FIXED_INITIAL_CIVIL_TIME: Readonly<CivilDateTime> = Object.freeze({
  year: 2024,
  month: 6,
  day: 15,
  hour: 9,
  minute: 0,
});

/** Host globals injected by deterministic bundle tests before module eval.
 * The absent chapter-wrapper values are explicit so a prior bundle probe
 * cannot turn a fresh screenshot boot into a resumed journey segment. */
export const FIXED_TIME_HOST_GLOBALS = Object.freeze({
  __pocketTuxemonInitialCivilTime: FIXED_INITIAL_CIVIL_TIME,
  __pocketTuxemonBootSnapshot: undefined,
  __pocketTuxemonBootFrame: undefined,
  __pocketTuxemonBootReady: undefined,
});

const DAY_NAMES = Object.freeze([
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
]);

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

function nonNegativeSafeInteger(value: unknown, label: string): string | null {
  return !safeInteger(value) || value < 0
    ? `${label} must be a non-negative safe integer`
    : null;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function civilTimeProblem(value: Readonly<CivilDateTime>): string | null {
  if (!safeInteger(value.year) || value.year < 1970 || value.year > 9999) {
    return "year must be an integer in 1970..9999";
  }
  if (!safeInteger(value.month) || value.month < 1 || value.month > 12) {
    return "month must be an integer in 1..12";
  }
  if (!safeInteger(value.day) || value.day < 1 || value.day > daysInMonth(value.year, value.month)) {
    return "day must be valid for the selected month";
  }
  if (!safeInteger(value.hour) || value.hour < 0 || value.hour > 23) {
    return "hour must be an integer in 0..23";
  }
  if (!safeInteger(value.minute) || value.minute < 0 || value.minute > 59) {
    return "minute must be an integer in 0..59";
  }
  return null;
}

/** Howard Hinnant's proleptic-Gregorian days-from-civil transform. */
export function epochDayFromCivil(year: number, month: number, day: number): number {
  const problem = civilTimeProblem({ year, month, day, hour: 0, minute: 0 });
  if (problem) throw new Error(`time-weather: ${problem}`);
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const shiftedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * shiftedMonth + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4)
    - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

export function civilFromEpochDay(epochDay: number): { year: number; month: number; day: number } {
  if (!safeInteger(epochDay) || epochDay < 0) {
    throw new Error("time-weather: epochDay must be a non-negative safe integer");
  }
  const shifted = epochDay + 719_468;
  const era = Math.floor(shifted / 146_097);
  const dayOfEra = shifted - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1_460) + Math.floor(dayOfEra / 36_524)
      - Math.floor(dayOfEra / 146_096)) / 365,
  );
  let year = yearOfEra + era * 400;
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4)
    - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);
  year += month <= 2 ? 1 : 0;
  return { year, month, day };
}

export function timeWeatherAt(
  civil: Readonly<CivilDateTime> = FIXED_INITIAL_CIVIL_TIME,
  ticksPerGameMinute = DEFAULT_TICKS_PER_GAME_MINUTE,
  weatherSlug = "sunny",
  weatherSeed = DEFAULT_WEATHER_SEED,
): TimeWeatherState {
  const problem = civilTimeProblem(civil);
  if (problem) throw new Error(`time-weather: ${problem}`);
  if (!safeInteger(ticksPerGameMinute) || ticksPerGameMinute < 1) {
    throw new Error("time-weather: ticksPerGameMinute must be a positive safe integer");
  }
  const firstDeadline = DEFAULT_WEATHER_MAX_MINUTES * ticksPerGameMinute;
  if (!Number.isSafeInteger(firstDeadline)) throw new Error("time-weather: weather deadline overflow");
  return {
    clock: {
      mode: "game",
      refTick: 0,
      epochDay: epochDayFromCivil(civil.year, civil.month, civil.day),
      minuteOfDay: civil.hour * 60 + civil.minute,
      subMinuteTicks: 0,
      ticksPerGameMinute,
    },
    weather: {
      slug: weatherSlug,
      enteredAtTick: 0,
      nextTransitionTick: firstDeadline,
      rngCursor: weatherSeed >>> 0,
    },
  };
}

/** Effect-shell helper: the Date is supplied by the caller and read once. */
export function timeWeatherFromLocalDate(
  sampled: Date,
  ticksPerGameMinute = DEFAULT_TICKS_PER_GAME_MINUTE,
): TimeWeatherState {
  return timeWeatherAt({
    year: sampled.getFullYear(),
    month: sampled.getMonth() + 1,
    day: sampled.getDate(),
    hour: sampled.getHours(),
    minute: sampled.getMinutes(),
  }, ticksPerGameMinute);
}

export function initialTimeWeatherState(): TimeWeatherState {
  return timeWeatherAt();
}

export function snapshotFromClock(
  clock: Readonly<ClockState>,
  hemisphere: Hemisphere = "northern",
): TimeSnapshot {
  const { year, month, day } = civilFromEpochDay(clock.epochDay);
  const hour = Math.floor(clock.minuteOfDay / 60);
  const dayOfYear = clock.epochDay - epochDayFromCivil(year, 1, 1) + 1;
  const weekday = DAY_NAMES[(clock.epochDay + 4) % 7]!;
  const stageOfDay = stageOfDayAtHour(hour);
  let northern: Season = "winter";
  if (dayOfYear >= 81 && dayOfYear < 173) northern = "spring";
  else if (dayOfYear >= 173 && dayOfYear < 265) northern = "summer";
  else if (dayOfYear >= 265 && dayOfYear < 356) northern = "autumn";
  const southern: Readonly<Record<Season, Season>> = {
    winter: "summer",
    spring: "autumn",
    summer: "winter",
    autumn: "spring",
  };
  return {
    year,
    month,
    day,
    hour,
    minute: clock.minuteOfDay % 60,
    dayOfYear,
    weekday,
    leapYear: isLeapYear(year) ? "true" : "false",
    daytime: hour >= 6 && hour < 18 ? "true" : "false",
    stageOfDay,
    season: hemisphere === "northern" ? northern : southern[northern],
  };
}

function stageOfDayAtHour(hour: number): StageOfDay {
  return hour >= 4 && hour < 8 ? "dawn"
    : hour >= 8 && hour < 12 ? "morning"
      : hour >= 12 && hour < 16 ? "afternoon"
        : hour >= 16 && hour < 20 ? "dusk"
          : "night";
}

/** Cheap stage lookup for hot map-page and daylight dispatch paths. */
export function stageOfDayFromClock(clock: Readonly<ClockState>): StageOfDay {
  return stageOfDayFromMinute(clock.minuteOfDay);
}

/** Same lookup for packed runtimes that keep minuteOfDay as a flat field. */
export function stageOfDayFromMinute(minuteOfDay: number): StageOfDay {
  return stageOfDayAtHour(Math.floor(minuteOfDay / 60));
}

function compareNumber(operation: string, left: number, right: number): boolean {
  switch (operation) {
    case "less_than": case "<": return left < right;
    case "less_or_equal": case "<=": return left <= right;
    case "greater_than": case ">": return left > right;
    case "greater_or_equal": case ">=": return left >= right;
    case "equals": case "==": return left === right;
    case "not_equals": case "!=": return left !== right;
    default: throw new Error(`tux.time_is: unknown operation '${operation}'`);
  }
}

function compareDate(
  operation: string,
  left: readonly [number, number],
  right: readonly [number, number],
): boolean {
  const order = left[0] === right[0] ? left[1] - right[1] : left[0] - right[0];
  return compareNumber(operation, order, 0);
}

/** Python's float() accepts decimal/scientific spellings and inf/nan, but not
 * JavaScript-only numeric literals such as 0x10. */
function parsePythonFloat(raw: string): number | null {
  const value = raw.trim();
  if (/^[+-]?nan$/i.test(value)) return Number.NaN;
  if (/^[+-]?inf(?:inity)?$/i.test(value)) return value.startsWith("-") ? -Infinity : Infinity;
  if (!/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?$/i.test(value)) return null;
  return Number(value);
}

const NUMERIC_PROPERTIES = new Set(["hour", "day_of_year", "year", "month", "day"]);

/** Mirrors TimeIsCondition's numeric, string and month-day tuple paths. */
export function timeIs(
  clock: Readonly<ClockState>,
  property: string,
  operation: string,
  target: string,
  hemisphere: Hemisphere = "northern",
): boolean {
  // These are the hot page-condition properties. They depend only on the
  // minute of day, so avoid Gregorian date reconstruction on every map tick.
  const hour = Math.floor(clock.minuteOfDay / 60);
  if (property === "hour") {
    const numericTarget = parsePythonFloat(target);
    if (numericTarget === null) return false;
    return compareNumber(operation, hour, numericTarget);
  }
  if (property === "daytime" || property === "stage_of_day") {
    const current = property === "daytime"
      ? (hour >= 6 && hour < 18 ? "true" : "false")
      : stageOfDayFromClock(clock);
    if (operation === "equals" || operation === "==") return current === target;
    if (operation === "not_equals" || operation === "!=") return current !== target;
    return false;
  }
  const snapshot = snapshotFromClock(clock, hemisphere);
  if (property === "date") {
    const parts = target.split("-");
    if (parts.length !== 2 || !parts.every((part) => /^[+-]?\d+$/.test(part.trim()))) return false;
    const month = Number(parts[0]);
    const day = Number(parts[1]);
    return compareDate(operation, [snapshot.month, snapshot.day], [month, day]);
  }
  const names: Readonly<Record<string, string | number>> = {
    hour: snapshot.hour,
    day_of_year: snapshot.dayOfYear,
    year: snapshot.year,
    month: snapshot.month,
    day: snapshot.day,
    weekday: snapshot.weekday,
    leap_year: snapshot.leapYear,
    daytime: snapshot.daytime,
    stage_of_day: snapshot.stageOfDay,
    season: snapshot.season,
  };
  if (!(property in names)) return false;
  const current = names[property]!;
  if (NUMERIC_PROPERTIES.has(property)) {
    const numericTarget = parsePythonFloat(target);
    if (numericTarget === null) return false;
    return compareNumber(operation, Number(current), numericTarget);
  }
  if (operation === "equals" || operation === "==") return String(current) === target;
  if (operation === "not_equals" || operation === "!=") return String(current) !== target;
  return false;
}

export function updateTimeWrites(
  clock: Readonly<ClockState>,
  hemisphere: Hemisphere = "northern",
): Readonly<Record<string, VariableValue>> {
  const snapshot = snapshotFromClock(clock, hemisphere);
  return {
    "v.hour": String(snapshot.hour),
    "v.day_of_year": String(snapshot.dayOfYear),
    "v.year": String(snapshot.year),
    "v.weekday": snapshot.weekday,
    "v.leap_year": snapshot.leapYear,
    "v.daytime": snapshot.daytime,
    "v.stage_of_day": snapshot.stageOfDay,
    "v.season": snapshot.season,
  };
}

function weatherRandom(cursor: number): { value: number; next: number } {
  let next = cursor >>> 0;
  next = (next + 0x6d2b79f5) | 0;
  let mixed = Math.imul(next ^ (next >>> 15), 1 | next);
  mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
  return { value: ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296, next: next >>> 0 };
}

function transitionWeather(
  weather: Readonly<WeatherState>,
  atTick: number,
  ticksPerGameMinute: number,
  schedule: Readonly<WeatherSchedule>,
): WeatherState {
  const unique = [...new Set(schedule.slugs)].sort();
  const candidates = unique.filter((slug) => slug !== weather.slug);
  const choice = weatherRandom(weather.rngCursor);
  const duration = weatherRandom(choice.next);
  const nextSlug = candidates.length > 0
    ? candidates[Math.min(candidates.length - 1, Math.floor(choice.value * candidates.length))]!
    : weather.slug;
  const min = schedule.minDurationMinutes ?? DEFAULT_WEATHER_MIN_MINUTES;
  const max = schedule.maxDurationMinutes ?? DEFAULT_WEATHER_MAX_MINUTES;
  if (!safeInteger(min) || !safeInteger(max) || min < 1 || max < min) {
    throw new Error("time-weather: invalid weather duration range");
  }
  const minutes = min + Math.floor(duration.value * (max - min + 1));
  const nextTransitionTick = atTick + minutes * ticksPerGameMinute;
  if (!Number.isSafeInteger(nextTransitionTick)) throw new Error("time-weather: weather deadline overflow");
  return {
    slug: nextSlug,
    enteredAtTick: atTick,
    nextTransitionTick,
    rngCursor: duration.next,
  };
}

/** Advance only the saved calendar on the fixed reference clock. */
export function advanceClock(clock: Readonly<ClockState>, ticks: number): ClockState {
  if (!safeInteger(ticks) || ticks < 0) {
    throw new Error("time-weather: ticks must be a non-negative safe integer");
  }
  const refTick = clock.refTick + ticks;
  const subMinuteTotal = clock.subMinuteTicks + ticks;
  const elapsedMinutes = Math.floor(subMinuteTotal / clock.ticksPerGameMinute);
  const totalMinutes = clock.minuteOfDay + elapsedMinutes;
  const elapsedDays = Math.floor(totalMinutes / 1_440);
  if (!Number.isSafeInteger(refTick) || !Number.isSafeInteger(clock.epochDay + elapsedDays)) {
    throw new Error("time-weather: clock overflow");
  }
  return {
    ...clock,
    refTick,
    epochDay: clock.epochDay + elapsedDays,
    minuteOfDay: totalMinutes % 1_440,
    subMinuteTicks: subMinuteTotal % clock.ticksPerGameMinute,
  };
}

/** Advance any number of active-world reference ticks without frame loops. */
export function advanceTimeWeather(
  state: Readonly<TimeWeatherState>,
  ticks: number,
  schedule: Readonly<WeatherSchedule> = { slugs: DEFAULT_WEATHER_SLUGS },
): TimeWeatherState {
  const clock = advanceClock(state.clock, ticks);
  let weather = { ...state.weather };
  while (weather.nextTransitionTick <= clock.refTick) {
    weather = transitionWeather(weather, weather.nextTransitionTick, clock.ticksPerGameMinute, schedule);
  }
  return { clock, weather };
}

export function clockProblem(value: unknown, label = "clock"): string | null {
  const clock = record(value);
  if (!clock) return `${label} must be an object`;
  if (clock.mode !== "game") return `${label}.mode must be "game"`;
  const tick = nonNegativeSafeInteger(clock.refTick, `${label}.refTick`);
  if (tick) return tick;
  const day = nonNegativeSafeInteger(clock.epochDay, `${label}.epochDay`);
  if (day) return day;
  if (!safeInteger(clock.minuteOfDay) || clock.minuteOfDay < 0 || clock.minuteOfDay > 1_439) {
    return `${label}.minuteOfDay must be an integer in 0..1439`;
  }
  if (!safeInteger(clock.ticksPerGameMinute) || clock.ticksPerGameMinute < 1) {
    return `${label}.ticksPerGameMinute must be a positive safe integer`;
  }
  if (!safeInteger(clock.subMinuteTicks) || clock.subMinuteTicks < 0
      || clock.subMinuteTicks >= clock.ticksPerGameMinute) {
    return `${label}.subMinuteTicks must be an integer in 0..ticksPerGameMinute-1`;
  }
  return null;
}

export function weatherProblem(
  value: unknown,
  label = "weather",
  slugs?: ReadonlySet<string>,
): string | null {
  const weather = record(value);
  if (!weather) return `${label} must be an object`;
  if (typeof weather.slug !== "string" || !weather.slug) {
    return `${label}.slug must be a non-empty string`;
  }
  if (slugs && !slugs.has(weather.slug)) {
    return `${label}.slug must name an imported weather (got ${weather.slug})`;
  }
  const entered = nonNegativeSafeInteger(weather.enteredAtTick, `${label}.enteredAtTick`);
  if (entered) return entered;
  const next = nonNegativeSafeInteger(weather.nextTransitionTick, `${label}.nextTransitionTick`);
  if (next) return next;
  if ((weather.nextTransitionTick as number) < (weather.enteredAtTick as number)) {
    return `${label}.nextTransitionTick must be >= enteredAtTick`;
  }
  if (!safeInteger(weather.rngCursor) || weather.rngCursor < 0 || weather.rngCursor > 0xffff_ffff) {
    return `${label}.rngCursor must be a uint32`;
  }
  return null;
}

export function timeWeatherProblem(value: unknown, slugs?: ReadonlySet<string>): string | null {
  const state = record(value);
  if (!state) return "time-weather state must be an object";
  const clockIssue = clockProblem(state.clock);
  if (clockIssue) return clockIssue;
  const weatherIssue = weatherProblem(state.weather, "weather", slugs);
  if (weatherIssue) return weatherIssue;
  const clock = state.clock as unknown as ClockState;
  const weather = state.weather as unknown as WeatherState;
  if (weather.enteredAtTick > clock.refTick) {
    return "weather.enteredAtTick must be <= clock.refTick";
  }
  // Runtime snapshots are folded through every due transition before they
  // are published. Reject stale deadlines at the codec boundary so a forged
  // save cannot make the first active tick replay an unbounded history.
  if (weather.nextTransitionTick <= clock.refTick) {
    return "weather.nextTransitionTick must be > clock.refTick";
  }
  return null;
}

export function encodeTimeWeather(state: TimeWeatherState): JsonValue {
  return {
    format: TIME_WEATHER_SAVE_FORMAT,
    clock: { ...state.clock },
    weather: { ...state.weather },
  } as unknown as JsonValue;
}

export function decodeTimeWeather(value: JsonValue, slugs?: ReadonlySet<string>): TimeWeatherState {
  const state = record(value);
  if (!state) throw new Error("time-weather state must be an object");
  if ("format" in state && state.format !== TIME_WEATHER_SAVE_FORMAT) {
    throw new Error(
      `time-weather state: unsupported format ${JSON.stringify(state.format)}`
      + ` (expected ${TIME_WEATHER_SAVE_FORMAT})`,
    );
  }
  const problem = timeWeatherProblem(state, slugs);
  if (problem) throw new Error(`time-weather state: ${problem}`);
  return {
    clock: { ...record(state.clock)! } as unknown as ClockState,
    weather: { ...record(state.weather)! } as unknown as WeatherState,
  };
}

// Hooks for the kit's sandboxed neighbour character preview
// (createWorldRenderer({ npcPreview: { sandbox } })). The sandbox enters a
// neighbouring map in a private copy of the state and paints its first target
// tick; these hooks tell it which part of the extension state a map entry can
// observe (the cache key) and how to move the volatile part (a probe that
// rejects characters depending on it).
//
// The packed runtime (packTuxemonExtensionState) is
//   V2 prefix + JSON core + "\n" + clock/weather fields ("\n"-separated).
// The clock changes every reference tick, so the key does not hold it. It
// holds what the clock-reading event code can see instead: every
// `tux.time_is` property (stage_of_day, daytime, hour, date, weekday,
// season, ...) and every variable `tux.update_time` writes is a function of
// the calendar day and the hour, so the key holds those two, taken one
// reference tick ahead as map pages read them, and the weather slug. A new
// hour or a weather change re-runs the neighbour previews; minutes, the
// sub-minute counter and the weather timer do not. The step counters (each
// tracker's `countdown` in the core's top-level `stepTrackers`) change on
// every player step; the key drops them too and keeps the rest of the
// trackers. The wire format itself is unchanged, so saves and recorded tapes
// stay valid.
//
// The volatile probe moves exactly the part of the clock the key leaves
// out: the minute inside the hour and the sub-minute counter. No event
// condition reads those today (time_is has no minute property), so it
// rejects nothing; it stays as the safety net for code that would.

import type { JsonValue } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import {
  packTuxemonExtensionState,
  TUXEMON_EXT_RUNTIME_V2_PREFIX,
  tuxemonExtensionState,
} from "./extension.ts";
import type { StepTrackerState } from "./step-tracker.ts";
import { advanceClock, type ClockState } from "./time-weather.ts";

/** How far the volatile probe moves the minute inside the hour. */
export const PREVIEW_MINUTE_SHIFT = 15;

/** The clock one reference tick ahead, as map page conditions read it
 * (tux.time_is with tickOffset 1). */
function projected(clock: Readonly<ClockState>): ClockState {
  return advanceClock(clock, 1);
}

/** The clock/weather part of the key. */
function timeKey(epochDay: number, hour: number, weatherSlugWire: string): string {
  return `\n${epochDay}\n${hour}\n${weatherSlugWire}`;
}

/** The extension state with its volatile part moved: the clock set to
 * another minute of the same day and hour (both one tick ahead), with no
 * sub-minute ticks. The weather and everything else the key holds stay.
 * Pure: the argument is decoded, never written. */
export function perturbTuxemonExt(ext: JsonValue): JsonValue {
  const state = tuxemonExtensionState(ext);
  const ahead = projected(state.clock);
  const minute = ahead.minuteOfDay % 60;
  const moved = minute < 30 ? minute + PREVIEW_MINUTE_SHIFT : minute - PREVIEW_MINUTE_SHIFT;
  return packTuxemonExtensionState({
    ...state,
    clock: {
      ...state.clock,
      epochDay: ahead.epochDay,
      minuteOfDay: ahead.minuteOfDay - minute + moved,
      subMinuteTicks: 0,
    },
  });
}

const STEP_TRACKERS_KEY = "\"stepTrackers\":";
// A tracker's countdown, with the comma that separates it from a neighbour
// member (both commas are kept as one when it sits between two members).
const COUNTDOWN_MEMBER = /(,?)"countdown":-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(,?)/g;

function dropCountdowns(trackers: string): string {
  return trackers.replace(COUNTDOWN_MEMBER, (_member, before: string, after: string) => (before && after ? "," : ""));
}

/** The core JSON text without the step counters: every tracker's
 * `countdown` member removed from the top-level `stepTrackers` value, which
 * keeps the milestones, their triggered/shown status and the reset cycles
 * (the `tux.step_tracker` condition reads those). Works on the text: inside
 * JSON strings a quote is always escaped, so an unescaped `"stepTrackers":`
 * is an object key, and the extension only writes that key at the top level.
 * Returns null when the text does not have the expected shape. */
export function previewCore(core: string): string | null {
  const at = core.indexOf(STEP_TRACKERS_KEY);
  if (at < 0) return core;
  const valueStart = at + STEP_TRACKERS_KEY.length;
  if (core.charCodeAt(valueStart) !== 123 /* { */) return null;
  let depth = 0;
  let inString = false;
  let i = valueStart;
  for (; i < core.length; i++) {
    const c = core.charCodeAt(i);
    if (inString) {
      if (c === 92 /* \ */) i++;
      else if (c === 34 /* " */) inString = false;
    } else if (c === 34) inString = true;
    else if (c === 123 || c === 91) depth++;
    else if (c === 125 || c === 93) {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return null;
  const valueEnd = i + 1;
  return core.slice(0, valueStart) + dropCountdowns(core.slice(valueStart, valueEnd)) + core.slice(valueEnd);
}


/** Reference key by full decode (also the path for unpacked states). */
export function tuxemonPreviewKeySlow(ext: JsonValue): string {
  const { clock, weather, ...rest } = tuxemonExtensionState(ext);
  if (rest.stepTrackers) {
    const trackers: Record<string, Record<string, Omit<StepTrackerState, "countdown">>> = {};
    for (const [character, owned] of Object.entries(rest.stepTrackers)) {
      trackers[character] = {};
      for (const [id, { countdown: _countdown, ...kept }] of Object.entries(owned)) trackers[character][id] = kept;
    }
    (rest as Record<string, unknown>).stepTrackers = trackers;
  }
  const ahead = projected(clock);
  return JSON.stringify(rest) + timeKey(ahead.epochDay, Math.floor(ahead.minuteOfDay / 60), JSON.stringify(weather.slug));
}

/** Non-negative integer in `wire[start, end)`, or -1. */
function wireInt(wire: string, start: number, end: number): number {
  if (end <= start) return -1;
  let n = 0;
  for (let i = start; i < end; i++) {
    const code = wire.charCodeAt(i);
    if (code < 48 || code > 57) return -1;
    n = n * 10 + (code - 48);
  }
  return Number.isSafeInteger(n) ? n : -1;
}

let lastInput: JsonValue | undefined;
let lastKey: string = "";
let lastCorePrefix: string | null = null;
let lastCoreKey: string = "";
/** Day and hour (one tick ahead) of the last scanned suffix; -1 when it
 * was malformed. */
let lastEpochDay = -1;
let lastHour = -1;
/** The weather slug field of the last scanned suffix, as on the wire. */
let lastSlugWire = "";
const suffixEnds: number[] = [0, 0, 0, 0, 0, 0];

/** Scan the clock/weather suffix that starts at `from` (just after the
 * core's newline) into lastEpochDay/lastHour/lastSlugWire. Returns true
 * when the day, the hour and the weather slug are unchanged since the last
 * scan. Allocates only when the slug changed. */
function scanTimeKey(wire: string, from: number): boolean {
  // Fields: refTick, epochDay, minuteOfDay, subMinuteTicks,
  // ticksPerGameMinute, weather slug JSON, then the weather timer.
  let at = from;
  for (let i = 0; i < 6; i++) {
    const end = wire.indexOf("\n", at);
    if (end < 0) {
      lastEpochDay = -1;
      return false;
    }
    suffixEnds[i] = end;
    at = end + 1;
  }
  let epochDay = wireInt(wire, suffixEnds[0]! + 1, suffixEnds[1]!);
  let minute = wireInt(wire, suffixEnds[1]! + 1, suffixEnds[2]!);
  const sub = wireInt(wire, suffixEnds[2]! + 1, suffixEnds[3]!);
  const perMinute = wireInt(wire, suffixEnds[3]! + 1, suffixEnds[4]!);
  if (epochDay < 0 || minute < 0 || sub < 0 || perMinute <= 0) {
    lastEpochDay = -1;
    return false;
  }
  // One reference tick ahead, as advanceClock(clock, 1).
  minute += Math.floor((sub + 1) / perMinute);
  epochDay += Math.floor(minute / 1440);
  const hour = Math.floor((minute % 1440) / 60);
  const slugStart = suffixEnds[4]! + 1;
  const slugEnd = suffixEnds[5]!;
  let sameSlug = slugEnd - slugStart === lastSlugWire.length;
  for (let i = 0; sameSlug && i < lastSlugWire.length; i++) {
    sameSlug = wire.charCodeAt(slugStart + i) === lastSlugWire.charCodeAt(i);
  }
  const same = sameSlug && epochDay === lastEpochDay && hour === lastHour;
  lastEpochDay = epochDay;
  lastHour = hour;
  if (!sameSlug) lastSlugWire = wire.slice(slugStart, slugEnd);
  return same;
}

/** The extension state a map entry can observe, as a string (compared with
 * Object.is): everything but the clock, the weather timer and the step
 * trackers' countdowns, plus the calendar day, the hour and the weather
 * slug. The reader calls this whenever the wire changes, which is every
 * reference tick because the suffix carries the clock; the core changes
 * only on battle, party or story writes and on steps. So the last core
 * prefix is kept: an unchanged core costs one prefix comparison and a scan
 * of the short suffix, and allocates nothing until the hour or the weather
 * changes. */
export function tuxemonPreviewKey(ext: JsonValue): string {
  if (ext === lastInput && lastInput !== undefined) return lastKey;
  if (typeof ext === "string" && ext.startsWith(TUXEMON_EXT_RUNTIME_V2_PREFIX)) {
    if (lastCorePrefix !== null && ext.startsWith(lastCorePrefix)) {
      const same = scanTimeKey(ext, lastCorePrefix.length);
      if (lastEpochDay >= 0) {
        lastInput = ext;
        if (!same) lastKey = lastCoreKey + timeKey(lastEpochDay, lastHour, lastSlugWire);
        return lastKey;
      }
    } else {
      const newline = ext.indexOf("\n", TUXEMON_EXT_RUNTIME_V2_PREFIX.length);
      const stripped = newline > 0 ? previewCore(ext.slice(TUXEMON_EXT_RUNTIME_V2_PREFIX.length, newline)) : null;
      if (stripped !== null) {
        scanTimeKey(ext, newline + 1);
        if (lastEpochDay >= 0) {
          lastInput = ext;
          lastCorePrefix = ext.slice(0, newline + 1);
          lastCoreKey = stripped;
          lastKey = stripped + timeKey(lastEpochDay, lastHour, lastSlugWire);
          return lastKey;
        }
      }
    }
  }
  lastInput = ext;
  lastCorePrefix = null;
  lastEpochDay = -1;
  lastKey = tuxemonPreviewKeySlow(ext);
  return lastKey;
}

/** The game's sandbox hooks, as passed to the world renderer and to the
 * coverage report. */
export const TUXEMON_PREVIEW_HOOKS = Object.freeze({
  previewKey: tuxemonPreviewKey,
  perturbExt: perturbTuxemonExt,
});

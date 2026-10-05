import { describe, expect, test } from "bun:test";

import {
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
  tuxemonExtensionState,
  type TuxemonExtensionState,
} from "../battle/extension.ts";
import {
  PREVIEW_MINUTE_SHIFT,
  previewCore,
  perturbTuxemonExt,
  tuxemonPreviewKey,
  tuxemonPreviewKeySlow,
} from "../battle/preview-hooks.ts";
import { createTuxemonExtensions } from "../battle/extension.ts";
import { TUXEMON_PREVIEW_HOOKS } from "../battle/preview-hooks.ts";
import { createSession, startSession, stepSession, type SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { GameEvent, JsonValue, MapDef, Project } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { createSandboxPreviewReader } from "../vendor/pocket-rpgkit/src/engine/world-preview-sandbox.ts";

function withTrackers(countdown: number, status: Record<string, boolean> = {}): TuxemonExtensionState {
  return {
    ...initialTuxemonExtensionState(),
    stepTrackers: {
      player: {
        "walk\"quoted": { countdown, initialCountdown: 500, milestones: [250, 100], status },
        daycare: { countdown: countdown * 2, initialCountdown: 1000, milestones: [], status: {}, autoReset: true },
      },
      // A character id that looks like the counter is kept.
      countdown: { t: { countdown: 1, initialCountdown: 1, milestones: [], status: {} } },
    },
  };
}

function tick(state: TuxemonExtensionState, minutes: number): TuxemonExtensionState {
  return {
    ...state,
    clock: { ...state.clock, minuteOfDay: (state.clock.minuteOfDay + minutes) % 1440, refTick: state.clock.refTick + 1 },
  };
}

describe("tuxemonPreviewKey", () => {
  test("ignores minutes, the weather timer and step countdowns", () => {
    const a = packTuxemonExtensionState(withTrackers(400));
    const b = packTuxemonExtensionState(tick(withTrackers(399), 1));
    const c = packTuxemonExtensionState({ ...withTrackers(12), weather: { ...withTrackers(12).weather, rngCursor: 5, enteredAtTick: 3 } });
    expect(a).not.toBe(b);
    expect(tuxemonPreviewKey(a)).toBe(tuxemonPreviewKey(b));
    expect(tuxemonPreviewKey(b)).toBe(tuxemonPreviewKey(c));
  });

  test("holds the calendar day, the hour one tick ahead and the weather slug", () => {
    const base = withTrackers(400);
    const key = tuxemonPreviewKey(packTuxemonExtensionState(base));
    const clock = base.clock;
    const variants: TuxemonExtensionState[] = [
      { ...base, weather: { ...base.weather, slug: base.weather.slug === "rain" ? "snow" : "rain" } },
      { ...base, clock: { ...clock, minuteOfDay: clock.minuteOfDay + 60 } },
      { ...base, clock: { ...clock, epochDay: clock.epochDay + 1 } },
      // The last tick of the hour already reads the next one.
      { ...base, clock: { ...clock, minuteOfDay: clock.minuteOfDay + 59, subMinuteTicks: clock.ticksPerGameMinute - 1 } },
    ];
    for (const variant of variants) {
      const wire = packTuxemonExtensionState(variant);
      expect(tuxemonPreviewKey(wire)).not.toBe(key);
      expect(tuxemonPreviewKey(wire)).toBe(tuxemonPreviewKeySlow(wire));
    }
    // The last tick before midnight reads the next day.
    const late = { ...base, clock: { ...clock, minuteOfDay: 1439, subMinuteTicks: clock.ticksPerGameMinute - 1 } };
    const midnight = { ...base, clock: { ...clock, epochDay: clock.epochDay + 1, minuteOfDay: 0, subMinuteTicks: 5 } };
    expect(tuxemonPreviewKey(packTuxemonExtensionState(late))).toBe(tuxemonPreviewKey(packTuxemonExtensionState(midnight)));
    expect(tuxemonPreviewKey(packTuxemonExtensionState(late))).toBe(tuxemonPreviewKeySlow(packTuxemonExtensionState(late)));
    expect(tuxemonPreviewKey(packTuxemonExtensionState(base))).toBe(key);
  });

  test("changes with what an entry can observe", () => {
    const base = withTrackers(400);
    const key = tuxemonPreviewKey(packTuxemonExtensionState(base));
    // A triggered milestone is read by the tux.step_tracker condition.
    expect(tuxemonPreviewKey(packTuxemonExtensionState(withTrackers(400, { "250": false })))).not.toBe(key);
    expect(tuxemonPreviewKey(packTuxemonExtensionState({ ...base, seen: ["rockitten"] }))).not.toBe(key);
    expect(tuxemonPreviewKey(packTuxemonExtensionState({ ...base, environment: "night_grass" }))).not.toBe(key);
    const { stepTrackers: _removed, ...withoutTrackers } = base;
    expect(tuxemonPreviewKey(packTuxemonExtensionState(withoutTrackers))).not.toBe(key);
  });

  test("agrees with the decoding reference", () => {
    const states = [
      initialTuxemonExtensionState(),
      withTrackers(3),
      withTrackers(7, { "250": true, "100": false }),
      { ...withTrackers(9), caught: ["a"], seen: ["b"] },
    ];
    for (const state of states) {
      const wire = packTuxemonExtensionState(state);
      expect(tuxemonPreviewKey(wire)).toBe(tuxemonPreviewKeySlow(wire));
      expect(tuxemonPreviewKeySlow(state as unknown as JsonValue)).toBe(tuxemonPreviewKeySlow(wire));
    }
  });

  test("memoized on the core prefix returns the key of the current core", () => {
    const first = packTuxemonExtensionState(withTrackers(5));
    const second = packTuxemonExtensionState(tick(withTrackers(5), 1));
    const other = packTuxemonExtensionState({ ...withTrackers(5), caught: ["x"] });
    const k1 = tuxemonPreviewKey(first);
    expect(tuxemonPreviewKey(second)).toBe(k1);
    expect(tuxemonPreviewKey(other)).toBe(tuxemonPreviewKeySlow(other));
    expect(tuxemonPreviewKey(first)).toBe(k1);
  });

  test("previewCore keeps the members around the trackers and rejects malformed text", () => {
    expect(previewCore("{\"a\":1}")).toBe("{\"a\":1}");
    expect(previewCore("{\"stepTrackers\":{\"p\":{\"t\":{\"countdown\":3}}},\"z\":1}"))
      .toBe("{\"stepTrackers\":{\"p\":{\"t\":{}}},\"z\":1}");
    expect(previewCore("{\"stepTrackers\":{\"p\":{\"t\":{\"a\":1,\"countdown\":3,\"b\":2}}}}"))
      .toBe("{\"stepTrackers\":{\"p\":{\"t\":{\"a\":1,\"b\":2}}}}");
    expect(previewCore("{\"stepTrackers\":{\"p\":{\"t\":{\"a\":1,\"countdown\":-3.5e2}}}}"))
      .toBe("{\"stepTrackers\":{\"p\":{\"t\":{\"a\":1}}}}");
    expect(previewCore("{\"stepTrackers\":7}")).toBeNull();
    expect(previewCore("{\"stepTrackers\":{\"p\":")).toBeNull();
  });
});

describe("perturbTuxemonExt", () => {
  test("moves the minute inside the hour and keeps the key", () => {
    const state = initialTuxemonExtensionState();
    const cases: [number, number, number][] = [
      // minuteOfDay, subMinuteTicks -> minuteOfDay of the probe
      [9 * 60, 0, 9 * 60 + PREVIEW_MINUTE_SHIFT],
      [9 * 60 + 40, 7, 9 * 60 + 40 - PREVIEW_MINUTE_SHIFT],
      [9 * 60 + 59, state.clock.ticksPerGameMinute - 1, 10 * 60 + PREVIEW_MINUTE_SHIFT],
    ];
    for (const [minuteOfDay, subMinuteTicks, expected] of cases) {
      const wire = packTuxemonExtensionState({ ...state, clock: { ...state.clock, minuteOfDay, subMinuteTicks } });
      const moved = tuxemonExtensionState(perturbTuxemonExt(wire));
      expect(moved.clock.minuteOfDay).toBe(expected);
      expect(moved.clock.subMinuteTicks).toBe(0);
      expect(moved.weather).toEqual(state.weather);
      // Everything the preview key covers is untouched.
      expect(tuxemonPreviewKey(perturbTuxemonExt(wire))).toBe(tuxemonPreviewKey(wire));
    }
  });

  test("never writes its argument", () => {
    const state = withTrackers(20) as unknown as JsonValue;
    const before = JSON.stringify(state);
    perturbTuxemonExt(state);
    expect(JSON.stringify(state)).toBe(before);
  });
});

// Reader level: the hooks wired into the kit's cached neighbour preview the
// way main.tsx wires them. A preview computed at one time of day must be
// replaced once the clock reaches a time an entry condition reads
// differently (the review probe: cached at 05:00, observed at 21:00).
describe("sandbox preview reader with the game hooks", () => {
  const IDLE = { buttons: 0, confirmEdge: false, cancelEdge: false, upEdge: false, downEdge: false };

  function timePage(sprite: string, args: Record<string, JsonValue>): GameEvent["pages"][number] {
    return {
      trigger: "action",
      commands: [],
      sprite,
      condition: { all: [{ kind: "ext", call: "tux.time_is", args: { ...args, tickOffset: 1 } }] },
    } as unknown as GameEvent["pages"][number];
  }

  function person(id: string, x: number, page: GameEvent["pages"][number]): GameEvent {
    return { id, x, y: 2, pages: [{ trigger: "action", commands: [] }, page] };
  }

  const EVENTS: GameEvent[] = [
    // Upstream's most common shape: shown unless it is night.
    person("day-person", 1, timePage("day", { property: "stage_of_day", operation: "equals", value: "night", negate: true })),
    person("midnight", 3, timePage("midnight", { property: "hour", operation: "equals", value: "0", negate: false })),
    person("birthday", 5, timePage("birthday", { property: "date", operation: "equals", value: "6-16", negate: false })),
  ];

  function project(): Project {
    const map = (id: string, events: GameEvent[]): MapDef => ({
      id,
      name: id,
      width: 8,
      height: 8,
      sheets: ["plain"],
      ground: new Array(64).fill("plain.0"),
      events,
    });
    return {
      format: "rpgkit-project/v1",
      title: "preview hooks",
      tileSize: 16,
      start: { map: "home", x: 1, y: 1, dir: "down" },
      sheets: [{ id: "plain", cols: 1, rows: 1, defaultPassage: "pass" }],
      items: [],
      maps: [map("home", []), map("town", EVENTS)],
    } as unknown as Project;
  }

  function at(state: SessionState, minuteOfDay: number, patch: Partial<TuxemonExtensionState> = {}, epochDays = 0): SessionState {
    const ext = tuxemonExtensionState(state.ext);
    return {
      ...state,
      ext: packTuxemonExtensionState({
        ...ext,
        ...patch,
        clock: { ...ext.clock, minuteOfDay, subMinuteTicks: 0, epochDay: ext.clock.epochDay + epochDays },
      }),
    };
  }

  function setup() {
    const p = project();
    const session = createSession(p, 60, { immutableState: true, extensions: createTuxemonExtensions({} as never) });
    const state = stepSession(session, startSession(p, session), IDLE);
    const reader = createSandboxPreviewReader(session, TUXEMON_PREVIEW_HOOKS);
    const map = session.maps.get("town")!;
    const settle = (live: SessionState) => {
      reader.observe(live);
      reader.read(map);
      for (let guard = 0; reader.stats.pending > 0; guard++) {
        if (guard > 100) throw new Error("reader never settled");
        reader.pump();
      }
      const preview = reader.read(map)!;
      return { ids: preview.actors.map((actor) => actor.eventId), rejected: preview.rejected };
    };
    return { session, state, settle, reader, map };
  }

  test("cached at 05:00, the night reaches the preview at 21:00", () => {
    const { state, settle } = setup();
    const dawn = settle(at(state, 5 * 60));
    expect(dawn.ids).toEqual(["day-person"]);
    expect(dawn.rejected).toEqual([]);
    const night = settle(at(state, 21 * 60));
    expect(night.ids).toEqual([]);
    expect(night.rejected).toEqual([]);
    // And back at 09:00.
    expect(settle(at(state, 9 * 60)).ids).toEqual(["day-person"]);
  });

  test("hour and calendar-day conditions are re-read when they change", () => {
    const { state, settle } = setup();
    // 2024-06-15 23:30, then midnight (a new day, hour 0), then 01:00.
    expect(settle(at(state, 23 * 60 + 30)).ids).toEqual([]);
    expect(settle(at(state, 0, {}, 1)).ids).toEqual(["midnight", "birthday"]);
    expect(settle(at(state, 60, {}, 1)).ids).toEqual(["birthday"]);
    expect(settle(at(state, 60, {}, 2)).ids).toEqual([]);
  });

  test("minutes inside the hour and the weather timing reuse the cached preview", () => {
    const { state, settle, reader, map } = setup();
    settle(at(state, 9 * 60));
    const cached = reader.read(map);
    const invalidations = reader.stats.invalidations;
    for (const minute of [9 * 60 + 1, 9 * 60 + 30, 9 * 60 + 59]) {
      reader.observe(at(state, minute));
      expect(reader.read(map)).toBe(cached);
    }
    const ext = tuxemonExtensionState(state.ext);
    // The weather timer (enteredAtTick, rngCursor) is not in the cache key.
    // Advance the refTick — also not in the key — so the weather can have
    // entered at a legal past tick that still differs from the initial 0.
    const refTick = 8;
    reader.observe({
      ...state,
      ext: packTuxemonExtensionState({
        ...ext,
        clock: { ...ext.clock, minuteOfDay: 9 * 60 + 5, subMinuteTicks: 0, refTick },
        weather: { ...ext.weather, enteredAtTick: refTick - 1, rngCursor: 99 },
      }),
    });
    expect(reader.stats.invalidations).toBe(invalidations);
    expect(reader.read(map)).toBe(cached);
  });

  test("the volatile probe rejects a character that reads the minute", () => {
    // No imported condition reads finer than the hour; a game condition
    // that did must be rejected rather than cached for the whole hour.
    // A fresh registration per call: adding to it changes no other session.
    const extensions = createTuxemonExtensions({} as never);
    (extensions.conditions as Record<string, NonNullable<typeof extensions.conditions>[string]>)["test.odd_minute"] = (context) => tuxemonExtensionState(context.ext).clock.minuteOfDay % 2 === 1;
    const p = project();
    const watcher: GameEvent = {
      id: "watcher",
      x: 6,
      y: 5,
      pages: [{ trigger: "action", commands: [] }, {
        trigger: "action",
        commands: [],
        sprite: "watcher",
        condition: { all: [{ kind: "ext", call: "test.odd_minute", args: null }] },
      } as unknown as GameEvent["pages"][number]],
    };
    const town = p.maps.find((map) => map.id === "town")!;
    (town as { events: GameEvent[] }).events = [...EVENTS, watcher];
    const session = createSession(p, 60, { immutableState: true, extensions });
    const state = stepSession(session, startSession(p, session), IDLE);
    const reader = createSandboxPreviewReader(session, TUXEMON_PREVIEW_HOOKS);
    const map = session.maps.get("town")!;
    reader.observe(at(state, 9 * 60 + 2));
    reader.read(map);
    while (reader.stats.pending > 0) reader.pump();
    const preview = reader.read(map)!;
    expect(preview.actors.map((actor) => actor.eventId)).toEqual(["day-person"]);
    expect(preview.rejected).toEqual([{ eventId: "watcher", reason: "volatile-dependent" }]);
  });

  test("a weather change invalidates the preview", () => {
    const { state, settle, reader } = setup();
    settle(at(state, 9 * 60));
    const invalidations = reader.stats.invalidations;
    const ext = tuxemonExtensionState(state.ext);
    const other = ext.weather.slug === "rain" ? "snow" : "rain";
    settle(at(state, 9 * 60, { weather: { ...ext.weather, slug: other } }));
    expect(reader.stats.invalidations).toBe(invalidations + 1);
  });
});

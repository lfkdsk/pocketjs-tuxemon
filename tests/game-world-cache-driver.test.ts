import { describe, expect, test } from "bun:test";

import {
  createGameWorldCacheDriver,
  createWorldLookaheadIndex,
  GAME_WORLD_ENTRY_SETTLE_FRAMES,
  GAME_WORLD_PREFETCH_AUDIO_COOLDOWN_FRAMES,
  GAME_WORLD_PREFETCH_BUDGET_MS,
  GAME_WORLD_PREFETCH_RECOVERY_MS,
  withTwoHopWorldLookahead,
} from "../ui/game-world-cache-driver.ts";
import { createJsonMapRepository } from "../vendor/pocket-rpgkit/src/engine/map-repository.ts";
import {
  acquireSessionMap,
  createSession,
  startSession,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { splitProjectMaps } from "../vendor/pocket-rpgkit/tools/lib/map-project.ts";
import type {
  CameraState,
  MapDef,
  Project,
  WorldComponent,
  WorldLayout,
  WorldOpening,
} from "../vendor/pocket-rpgkit/src/engine/types.ts";
import type { WorldCacheStats } from "../vendor/pocket-rpgkit/src/ui/world-cache-driver.ts";
import type {
  ImminentMap,
  WorldWorkingSet,
} from "../vendor/pocket-rpgkit/src/engine/world-working-set.ts";

const opening = (portalId: string, source: string, target: string): WorldOpening => ({
  portalId,
  source: { mapId: source, side: "east", span: { start: 0, end: 1 } },
  target: { mapId: target, side: "west", span: { start: 0, end: 1 } },
  axis: "y",
  offset: 0,
  compatibility: "coordinate-preserving",
});

const mapIds = ["a", "b", "c", "d", "e", "f"];
const component: WorldComponent = {
  worldId: "test",
  componentId: "test:0",
  bounds: { minTileX: 0, minTileY: 0, maxTileX: 60, maxTileY: 10 },
  placements: mapIds.map((mapId, index) => ({
    mapId,
    originTileX: index * 10,
    originTileY: 0,
    width: 10,
    height: 10,
  })),
  seams: [],
  openings: [
    opening("a-b", "a", "b"),
    opening("a-c", "a", "c"),
    opening("b-a", "b", "a"),
    opening("b-e", "b", "e"),
    opening("b-d", "b", "d"),
    opening("c-f", "c", "f"),
  ],
};
const layout: WorldLayout = { topologyHash: "test", components: [component] };
const imminent = (mapId: string, portalId: string): ImminentMap => ({
  mapId,
  portalId,
  side: "east",
  distance: 1,
  compatibility: "coordinate-preserving",
});

const map = (id: string): MapDef => ({
  id,
  name: id,
  width: 10,
  height: 10,
  sheets: ["tiles"],
  ground: new Array(100).fill("tiles.0"),
  events: [],
});

function setupSession() {
  const project: Project = {
    format: "rpgkit-project/v1",
    title: "focused lookahead fixture",
    tileSize: 16,
    start: { map: "a", x: 1, y: 1, dir: "right" },
    sheets: [{ id: "tiles", pak: "tiles", cols: 1, rows: 1, defaultPassage: "pass" }],
    items: [],
    maps: [...mapIds, "inside"].map(map),
  };
  const split = splitProjectMaps(project);
  const files = new Map(split.entries.map((entry) => [entry.meta.id, entry.bytes]));
  const repository = createJsonMapRepository(split.shell.mapIndex, {
    read: (entry) => {
      const meta = split.shell.mapIndex.find((candidate) => candidate.entry === entry);
      return meta ? files.get(meta.id) : undefined;
    },
  });
  const session = createSession(split.shell, 60, repository);
  startSession(split.shell, session);
  return session;
}

describe("two-hop game world-cache lookahead", () => {
  test("the immutable topology index is stable, sorted, and duplicate-free", () => {
    const index = createWorldLookaheadIndex(layout);
    expect(index.get("a")).toEqual(["b", "c"]);
    expect(index.get("b")).toEqual(["a", "d", "e"]);
    expect(index.get("f")).toEqual([]);
  });

  test("every direct exit retains a stable second hop without eagerly preparing it", () => {
    const base: WorldWorkingSet = {
      active: "a",
      visible: ["a", "b"],
      imminent: [imminent("b", "a-b"), imminent("c", "a-c")],
      parsedKeep: ["a", "b", "c"],
      compiledKeep: ["a", "b", "c"],
    };
    const expanded = withTwoHopWorldLookahead(base, createWorldLookaheadIndex(layout));
    expect(expanded.parsedKeep).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(expanded.compiledKeep).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(expanded.imminent).toBe(base.imminent);
    expect(base.compiledKeep).toEqual(["a", "b", "c"]);
  });

  test("no exit preserves the original set and the default runs one stage", () => {
    const base: WorldWorkingSet = {
      active: "f",
      visible: ["f"],
      imminent: [],
      parsedKeep: ["f"],
      compiledKeep: ["f"],
    };
    expect(withTwoHopWorldLookahead(base, createWorldLookaheadIndex(layout))).toBe(base);
    expect(GAME_WORLD_PREFETCH_BUDGET_MS).toBe(0);
  });

  test("the driver reports two-hop keep-sets and advances only one cold stage", () => {
    const session = setupSession();
    const stats: WorldCacheStats[] = [];
    const activity: boolean[] = [];
    const driver = createGameWorldCacheDriver(session, layout, {
      now: () => 0,
      onStats: (snapshot) => stats.push(snapshot),
      onPrefetchActivity: (active) => activity.push(active),
    });
    const state = {
      mapId: "a",
      move: { tx: 8, ty: 1, facing: 3 },
    } as SessionState;
    const camera: CameraState = { x: 0, y: 0, facing: 3 };

    driver.sync(state, camera, { w: 160, h: 160 });

    expect(stats).toHaveLength(1);
    expect(stats[0]!.compiledKeep).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(stats[0]!.preparing).toBe(1);
    expect(session.preparingMaps.has("b")).toBe(true);
    expect(session.preparingMaps.get("b")!.map).toBeUndefined();
    expect(session.preparingMaps.has("c")).toBe(false);
    expect(activity).toEqual([true]);
  });

  test("stable tile windows reuse retention while pending prefetch still advances", () => {
    const session = setupSession();
    const repository = session.repository!;
    const releaseExcept = repository.releaseExcept.bind(repository);
    let releases = 0;
    repository.releaseExcept = (ids) => {
      releases++;
      releaseExcept(ids);
    };
    const stats: WorldCacheStats[] = [];
    const driver = createGameWorldCacheDriver(session, layout, {
      now: () => 0,
      onStats: (snapshot) => stats.push(snapshot),
    });
    const state = {
      mapId: "a",
      move: { tx: 8, ty: 1, facing: 3 },
    } as SessionState;

    driver.sync(state, { x: 1, y: 1, facing: 3 }, { w: 128, h: 128 });
    expect(session.preparingMaps.get("b")?.map).toBeUndefined();
    driver.sync(state, { x: 2, y: 2, facing: 3 }, { w: 128, h: 128 });

    expect(session.preparingMaps.get("b")?.map).toBeDefined();
    expect(stats[1]!.compiledKeep).toBe(stats[0]!.compiledKeep);
    expect(releases).toBe(1);

    driver.sync({
      ...state,
      move: { ...state.move, facing: 1 },
    } as SessionState, { x: 2, y: 2, facing: 1 }, { w: 128, h: 128 });

    expect(stats[2]!.compiledKeep).not.toBe(stats[1]!.compiledKeep);
    expect(stats[2]!.compiledKeep).toEqual(stats[1]!.compiledKeep);
    expect(releases).toBe(1);
  });

  test("an expensive preparation stage leaves one frame for boundary GC", () => {
    const session = setupSession();
    const stats: WorldCacheStats[] = [];
    const activity: boolean[] = [];
    let now = 0;
    const driver = createGameWorldCacheDriver(session, layout, {
      now: () => {
        const value = now;
        now += GAME_WORLD_PREFETCH_RECOVERY_MS;
        return value;
      },
      onStats: (snapshot) => stats.push(snapshot),
      onPrefetchActivity: (active) => activity.push(active),
    });
    const state = {
      mapId: "a",
      move: { tx: 8, ty: 1, facing: 3 },
    } as SessionState;
    const camera: CameraState = { x: 0, y: 0, facing: 3 };

    driver.sync(state, camera, { w: 160, h: 160 });
    expect(session.preparingMaps.get("b")?.map).toBeUndefined();
    driver.sync(state, camera, { w: 160, h: 160 });
    expect(session.preparingMaps.get("b")?.map).toBeUndefined();
    driver.sync(state, camera, { w: 160, h: 160 });
    expect(session.preparingMaps.get("b")?.map).toBeDefined();

    expect(stats).toHaveLength(3);
    expect(activity).toEqual([true, true, true]);
  });

  test("crossing a camera tile boundary recomputes and releases a changed keep-set", () => {
    const session = setupSession();
    const repository = session.repository!;
    const releaseExcept = repository.releaseExcept.bind(repository);
    let releases = 0;
    repository.releaseExcept = (ids) => {
      releases++;
      releaseExcept(ids);
    };
    const stats: WorldCacheStats[] = [];
    const driver = createGameWorldCacheDriver(session, layout, {
      now: () => 0,
      onStats: (snapshot) => stats.push(snapshot),
    });
    const state = {
      mapId: "f",
      move: { tx: 1, ty: 1, facing: 3 },
    } as SessionState;

    driver.sync(state, { x: 1, y: 1, facing: 3 }, { w: 128, h: 128 });
    driver.sync(state, { x: 2, y: 2, facing: 3 }, { w: 128, h: 128 });
    expect(stats[1]!.visible).toBe(stats[0]!.visible);
    expect(releases).toBe(1);

    driver.sync(state, { x: 161, y: 1, facing: 3 }, { w: 128, h: 128 });
    expect(stats[2]!.visible).toEqual(["b"]);
    expect(releases).toBe(2);
  });

  test("deferred work waits through two settled frames after prefetch completes", () => {
    const session = setupSession();
    const stats: WorldCacheStats[] = [];
    const activity: boolean[] = [];
    const driver = createGameWorldCacheDriver(session, layout, {
      now: () => 0,
      onStats: (snapshot) => stats.push(snapshot),
      onPrefetchActivity: (active) => activity.push(active),
    });
    const state = {
      mapId: "a",
      move: { tx: 8, ty: 1, facing: 3 },
    } as SessionState;
    const camera: CameraState = { x: 0, y: 0, facing: 3 };

    for (let frame = 0; frame < 64; frame++) {
      driver.sync(state, camera, { w: 160, h: 160 });
      const current = stats.at(-1)!;
      if (current.pending === 0 && current.staged > 0) break;
    }
    expect(stats.at(-1)!.staged).toBe(2);
    expect(session.preparingMaps.has("d")).toBeFalse();
    expect(session.preparingMaps.has("e")).toBeFalse();
    expect(session.preparingMaps.has("f")).toBeFalse();
    expect(activity.at(-1)).toBeTrue();
    for (let frame = 0; frame < GAME_WORLD_PREFETCH_AUDIO_COOLDOWN_FRAMES; frame++) {
      driver.sync(state, camera, { w: 160, h: 160 });
      expect(activity.at(-1)).toBeTrue();
    }
    driver.sync(state, camera, { w: 160, h: 160 });
    expect(activity.at(-1)).toBeFalse();
  });

  test("transition frames retain lookahead and reserve deferred work", () => {
    const session = setupSession();
    const stats: WorldCacheStats[] = [];
    const activity: boolean[] = [];
    const driver = createGameWorldCacheDriver(session, layout, {
      now: () => 0,
      onStats: (snapshot) => stats.push(snapshot),
      onPrefetchActivity: (active) => activity.push(active),
    });
    const state = {
      mapId: "a",
      move: { tx: 8, ty: 1, facing: 3 },
      fade: { phase: "out", left: 8, half: 8 },
    } as SessionState;

    driver.sync(state, { x: 0, y: 0, facing: 3 }, { w: 160, h: 160 });

    expect(stats[0]!.compiledKeep).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(stats[0]!.pending).toBe(2);
    expect(stats[0]!.preparing).toBe(0);
    expect(session.preparingMaps.size).toBe(0);
    expect(activity).toEqual([true]);
  });

  test("the first frame after a map change retains lookahead without stacking a cold stage", () => {
    const session = setupSession();
    const stats: WorldCacheStats[] = [];
    let nowCalls = 0;
    const driver = createGameWorldCacheDriver(session, layout, {
      now: () => {
        nowCalls++;
        return 0;
      },
      onStats: (snapshot) => stats.push(snapshot),
    });
    const camera: CameraState = { x: 0, y: 0, facing: 3 };

    driver.sync({
      mapId: "a",
      move: { tx: 8, ty: 1, facing: 3 },
    } as SessionState, camera, { w: 160, h: 160 });
    const preparingBeforeChange = session.preparingMaps.size;
    const nowCallsBeforeChange = nowCalls;
    driver.sync({
      mapId: "b",
      move: { tx: 1, ty: 1, facing: 1 },
    } as SessionState, camera, { w: 160, h: 160 });

    expect(stats).toHaveLength(2);
    expect(nowCalls).toBe(nowCallsBeforeChange);
    expect(session.preparingMaps.size).toBeLessThanOrEqual(preparingBeforeChange);
  });

  test("entry settling keeps cold preparation off short-lived parallel work", () => {
    const session = setupSession();
    const driver = createGameWorldCacheDriver(session, layout, { now: () => 0 });
    driver.sync({
      mapId: "a",
      move: { tx: 8, ty: 1, facing: 3 },
      interp: { frame: GAME_WORLD_ENTRY_SETTLE_FRAMES - 1 },
    } as SessionState, { x: 0, y: 0, facing: 3 }, { w: 160, h: 160 });

    expect(session.preparingMaps.size).toBe(0);
  });

  test("map-change eviction waits until the destination entry has settled", () => {
    const session = setupSession();
    const activity: boolean[] = [];
    const driver = createGameWorldCacheDriver(session, layout, {
      now: () => 0,
      onPrefetchActivity: (active) => activity.push(active),
    });
    const camera: CameraState = { x: 0, y: 0, facing: 3 };
    driver.sync({ mapId: "a", move: { tx: 1, ty: 1, facing: 3 } } as SessionState, camera, { w: 160, h: 160 });
    acquireSessionMap(session, "inside");

    driver.sync({
      mapId: "inside",
      move: { tx: 1, ty: 1, facing: 3 },
      interp: { frame: 0 },
    } as SessionState, camera, { w: 160, h: 160 });
    expect(session.maps.has("a")).toBe(true);

    driver.sync({
      mapId: "inside",
      move: { tx: 1, ty: 1, facing: 3 },
      interp: { frame: GAME_WORLD_ENTRY_SETTLE_FRAMES },
    } as SessionState, camera, { w: 160, h: 160 });
    expect([...session.maps.keys()]).toEqual(["inside"]);
    expect(activity.at(-1)).toBeTrue();

    driver.sync({
      mapId: "inside",
      move: { tx: 1, ty: 1, facing: 3 },
      interp: { frame: GAME_WORLD_ENTRY_SETTLE_FRAMES + 1 },
    } as SessionState, camera, { w: 160, h: 160 });
    expect(activity.at(-1)).toBeFalse();
  });

  test("player movement does not stack prefetch on the reducer", () => {
    const session = setupSession();
    const stats: WorldCacheStats[] = [];
    const driver = createGameWorldCacheDriver(session, layout, {
      now: () => 0,
      onStats: (snapshot) => stats.push(snapshot),
    });
    const state = {
      mapId: "a",
      move: { tx: 8, ty: 1, facing: 3, moving: true, walking: true },
    } as SessionState;

    driver.sync(state, { x: 0, y: 0, facing: 3 }, { w: 160, h: 160 });

    expect(stats[0]!.pending).toBe(2);
    expect(stats[0]!.preparing).toBe(0);
    expect(session.preparingMaps.size).toBe(0);
  });
});

import { describe, expect, test } from "bun:test";
import type { MapDef, WorldLayout } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import type { WorldCacheStats } from "../vendor/pocket-rpgkit/src/ui/world-cache-driver.ts";
import { lazyEntryStats, lazyEntryTable } from "../ui/lazy-entry-table.ts";
import { createGameWorldAssetCache, npcArtKeepSet } from "../ui/world-cache.ts";

const MAP_IDS = ["outdoor_a", "outdoor_b", "outdoor_c", "indoor"] as const;
const NPC_IDS = ["npc.a", "npc.b", "npc.shared"] as const;

function table<T>(ids: readonly string[], value: (id: string) => T): Readonly<Record<string, T>> {
  return lazyEntryTable(
    ids.map((id) => ({ id, entry: `${id}.json` })),
    { read: (entry) => JSON.stringify(value(entry.slice(0, -5))) },
    "fixture",
  );
}

const layout: WorldLayout = {
  topologyHash: "a".repeat(64),
  components: [{
    worldId: "fixture",
    componentId: "fixture",
    bounds: { minTileX: 0, minTileY: 0, maxTileX: 30, maxTileY: 10 },
    placements: [
      { mapId: "outdoor_a", originTileX: 0, originTileY: 0, width: 10, height: 10 },
      { mapId: "outdoor_b", originTileX: 10, originTileY: 0, width: 10, height: 10 },
      { mapId: "outdoor_c", originTileX: 20, originTileY: 0, width: 10, height: 10 },
    ],
    seams: [],
    openings: [],
  }],
};

const map = (id: string, ...sprites: string[]): MapDef => ({
  id,
  name: id,
  width: 1,
  height: 1,
  ground: [null],
  events: sprites.map((sprite, index) => ({
    id: `event-${index}`,
    x: 0,
    y: 0,
    pages: [{ sprite, trigger: "action", commands: [] }],
  })),
});

const driverStats = (active: string, visible: readonly string[]): WorldCacheStats => ({
  active,
  visible,
  parsedKeep: [...visible],
  compiledKeep: [active],
  maps: visible.length,
  worlds: 1,
  tables: 1,
  staged: 0,
  pending: 0,
  preparing: 0,
  runtime: 0,
  repoCached: visible.length,
  failures: {},
});

describe("game world asset cache", () => {
  test("terrain and animation follow visible maps while NPC art follows the active map", () => {
    const ground = table(MAP_IDS, (id) => [`${id}-ground`]);
    const upper = table(MAP_IDS, (id) => [`${id}-upper`]);
    const animated = table(MAP_IDS, () => []);
    const npcSrc = table(NPC_IDS, (id) => `${id}.png`);
    const snapshots: unknown[] = [];
    const cache = createGameWorldAssetCache(layout, {
      stream: { chunkPx: 256, columns: {}, ground, upper },
      animated,
      npcSrc,
    }, (stats) => snapshots.push(stats));

    for (const id of MAP_IDS) {
      void ground[id];
      void upper[id];
      void animated[id];
    }
    for (const id of NPC_IDS) void npcSrc[id];

    cache.onMapChange("outdoor_a", map("outdoor_a", "npc.shared", "npc.a", "npc.shared"));
    cache.onWorldCacheStats(driverStats("outdoor_a", ["outdoor_a", "outdoor_b"]));
    cache.onVisibleMaps(["outdoor_a", "outdoor_b"]);

    expect(lazyEntryStats(ground).resident).toBe(2);
    expect(lazyEntryStats(upper).resident).toBe(2);
    expect(lazyEntryStats(animated).resident).toBe(2);
    expect(lazyEntryStats(npcSrc).resident).toBe(2);
    expect(npcArtKeepSet(map("outdoor_a", "npc.shared", "npc.a", "npc.shared")))
      .toEqual(["npc.a", "npc.shared"]);
    expect(snapshots).toHaveLength(2);
    expect(snapshots.at(-1)).toMatchObject({
      driver: { active: "outdoor_a", visible: ["outdoor_a", "outdoor_b"] },
      visualKeep: ["outdoor_a", "outdoor_b"],
      npcKeep: ["npc.a", "npc.shared"],
      assets: { ground: { resident: 2 }, upper: { resident: 2 }, animated: { resident: 2 } },
    });
  });

  test("an unplaced map collapses render shards to the legacy one-map set", () => {
    const ground = table(MAP_IDS, (id) => [`${id}-ground`]);
    const upper = table(MAP_IDS, (id) => [`${id}-upper`]);
    const animated = table(MAP_IDS, () => []);
    const npcSrc = table(NPC_IDS, (id) => `${id}.png`);
    const cache = createGameWorldAssetCache(layout, {
      stream: { chunkPx: 256, columns: {}, ground, upper },
      animated,
      npcSrc,
    });

    for (const id of MAP_IDS) {
      void ground[id];
      void upper[id];
      void animated[id];
    }
    for (const id of NPC_IDS) void npcSrc[id];
    cache.onMapChange("indoor", map("indoor", "npc.b"));

    expect(cache.stats()).toMatchObject({
      ground: { resident: 1 },
      upper: { resident: 1 },
      animated: { resident: 1 },
      npcSrc: { resident: 1 },
    });
  });

  test("NPC art also covers the visible neighbour maps the session holds", () => {
    const ground = table(MAP_IDS, (id) => [`${id}-ground`]);
    const upper = table(MAP_IDS, (id) => [`${id}-upper`]);
    const animated = table(MAP_IDS, () => []);
    const npcSrc = table(NPC_IDS, (id) => `${id}.png`);
    const cache = createGameWorldAssetCache(layout, {
      stream: { chunkPx: 256, columns: {}, ground, upper },
      animated,
      npcSrc,
    });
    const resident = new Map<string, MapDef>([
      ["outdoor_a", map("outdoor_a", "npc.a")],
      ["outdoor_b", map("outdoor_b", "npc.b", "npc.shared")],
      ["outdoor_c", map("outdoor_c", "npc.shared")],
    ]);
    const touchAll = () => {
      for (const id of NPC_IDS) void npcSrc[id];
    };

    touchAll();
    cache.onMapChange("outdoor_a", resident.get("outdoor_a")!);
    cache.onVisibleMaps(["outdoor_a", "outdoor_b"]);
    // Not bound yet: the active map alone.
    expect(lazyEntryStats(npcSrc).resident).toBe(1);

    cache.bindMaps((id) => resident.get(id));
    touchAll();
    cache.onVisibleMaps(["outdoor_a", "outdoor_b"]);
    expect(lazyEntryStats(npcSrc).resident).toBe(3);

    // outdoor_b scrolls away: its art is released, outdoor_c's kept.
    cache.onVisibleMaps(["outdoor_a", "outdoor_c"]);
    expect(lazyEntryStats(npcSrc).resident).toBe(2);
    touchAll();
    // An unchanged visible set does not release again.
    cache.onVisibleMaps(["outdoor_a", "outdoor_c"]);
    expect(lazyEntryStats(npcSrc).resident).toBe(3);

    // A neighbour the session does not hold contributes nothing.
    resident.delete("outdoor_b");
    cache.onVisibleMaps(["outdoor_a", "outdoor_b"]);
    expect(lazyEntryStats(npcSrc).resident).toBe(1);

    // An unplaced active map keeps only its own art.
    touchAll();
    cache.onMapChange("indoor", map("indoor", "npc.b"));
    expect(lazyEntryStats(npcSrc).resident).toBe(1);
  });
});

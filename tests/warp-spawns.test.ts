import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { buildPassage } from "../vendor/pocket-rpgkit/src/engine/passability.ts";
import type { MapDef, Project, Sheet } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { buildWarpIndex, WARP_FORMAT, type WarpIndex } from "../importer/warp.ts";
import { readInlineProject } from "../tools/generated-project.ts";

const ROOT = resolve(import.meta.dir, "..");
const warp = JSON.parse(readFileSync(join(ROOT, "data/warp.json"), "utf8")) as WarpIndex;
const project = readInlineProject(ROOT);

/** Cells covered by ANY static event body (the event's x/y/w/h footprint,
 *  regardless of its pages). A spawn must not sit on an event area: a
 *  playerTouch page fires on the next step and an action page faces the
 *  player, so a warp landing on an event triggers it. */
function eventCells(map: MapDef): Set<number> {
  const cells = new Set<number>();
  for (const event of map.events ?? []) {
    const w = event.w ?? 1;
    const h = event.h ?? 1;
    for (let y = event.y; y < event.y + h; y++) {
      for (let x = event.x; x < event.x + w; x++) cells.add(y * map.width + x);
    }
  }
  return cells;
}

// Maps with no standable event-free cell. classic_route_4 is solid
// everywhere (its only ground tile carries surfable:0); the other 17 are
// blanketed by Tuxemon's full-map one-shot visit-tracker regions (e.g. the
// "Track route1" object is a 40x20 playerTouch sensor), faithfully
// imported. They are honestly marked blocked rather than spawning on an
// event area; exempting one-shot trackers is a spec-owner decision.
const BLOCKED_MAPS = [
  "classic_route_4",
  "spyder_citypark",
  "spyder_dragonscave",
  "spyder_dryadsgrove",
  "spyder_mansion",
  "spyder_route1",
  "spyder_route2",
  "spyder_route3",
  "spyder_route4",
  "spyder_route5",
  "spyder_route6",
  "spyder_routea",
  "spyder_routeb",
  "spyder_routec",
  "spyder_routed",
  "spyder_routee",
  "spyder_tunnel",
  "spyder_tunnel_below",
].sort();

describe("warp spawn index", () => {
  test("has the committed format and one spawn per imported map", () => {
    expect(warp.format).toBe(WARP_FORMAT);
    expect(warp.maps.length).toBe(project.maps.length);
    const ids = warp.maps.map((spawn) => spawn.id);
    expect(ids).toEqual([...new Set(ids)]);
    expect(ids.slice().sort()).toEqual(project.maps.map((map) => map.id).sort());
  });

  test("rebuilds byte-identically from the imported project", () => {
    expect(buildWarpIndex(project)).toEqual(warp);
  });

  test("every spawn is standable and clear of every event area", () => {
    const sheets = new Map<string, Sheet>(project.sheets.map((sheet) => [sheet.id, sheet]));
    const byId = new Map(project.maps.map((map) => [map.id, map]));
    const counts = { transfer: 0, fallback: 0, blocked: 0 };
    for (const spawn of warp.maps) {
      const map = byId.get(spawn.id);
      expect(map, `missing map ${spawn.id}`).toBeDefined();
      const table = buildPassage(map!, sheets);
      expect(spawn.x, `${spawn.id} x in bounds`).toBeGreaterThanOrEqual(0);
      expect(spawn.x, `${spawn.id} x in bounds`).toBeLessThan(table.width);
      expect(spawn.y, `${spawn.id} y in bounds`).toBeGreaterThanOrEqual(0);
      expect(spawn.y, `${spawn.id} y in bounds`).toBeLessThan(table.height);
      expect(spawn.name.length, `${spawn.id} has a display name`).toBeGreaterThan(0);
      counts[spawn.from]++;
      if (spawn.from === "blocked") {
        // The marker is only honest when the map really has no standable
        // cell outside an event area.
        const cells = eventCells(map!);
        let clear = false;
        for (let i = 0; i < table.solid.length; i++) {
          if (table.solid[i] === 0 && !cells.has(i)) { clear = true; break; }
        }
        expect(clear, `${spawn.id} marked blocked but has a standable event-free cell`).toBe(false);
        continue;
      }
      const cells = eventCells(map!);
      const index = spawn.y * table.width + spawn.x;
      expect(table.solid[index], `${spawn.id}@${spawn.x},${spawn.y} is solid terrain`).toBe(0);
      expect(cells.has(index), `${spawn.id}@${spawn.x},${spawn.y} sits on an event area`).toBe(false);
    }
    // The distribution is a property of the imported corpus: most incoming
    // transfer landings sit on an event area (a teleport pad or a visit
    // tracker), so a bare majority of spawns keep a transfer landing while
    // the rest fall back to the nearest event-free cell. A jump here means
    // the importer's event geometry or landing set changed, not just the data.
    // Route 3's repaired south-edge event occupies one former transfer
    // landing. Its promoted Route 4 Surf opening now also preserves each
    // lane's opposite-edge target instead of contributing the authored fixed
    // (20,19) landing; the remaining incoming landings are event cells, so
    // the demo index chooses the nearest clear fallback cell.
    expect(counts.transfer).toBe(133);
    expect(counts.fallback).toBe(112);
    expect(counts.blocked).toBe(BLOCKED_MAPS.length);
  });

  test("blocked spawns name exactly the maps with no event-free standable cell", () => {
    const blocked = warp.maps.filter((spawn) => spawn.from === "blocked").map((spawn) => spawn.id).sort();
    expect(blocked).toEqual(BLOCKED_MAPS);
  });
});

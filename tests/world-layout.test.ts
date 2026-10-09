import { describe, expect, test } from "bun:test";
import {
  buildPassage,
  canEnter,
  cellBlocksExit,
  compile,
  localToWorld,
  validateWorldLayout,
  worldToLocal,
  type Command,
  type Dir4,
  type Project,
  type WorldComponent,
} from "../vendor/pocket-rpgkit/src/engine/index.ts";
import { createWorldHandoffResolver } from "../vendor/pocket-rpgkit/src/engine/world-handoff.ts";
import { splitProjectMaps } from "../vendor/pocket-rpgkit/tools/lib/map-project.ts";
import { createTuxemonSessionOptions } from "../battle/game.ts";
import { availableMapIds, buildProject, G6_IMPORT_OPTIONS } from "../importer/project.ts";
import { loadAllMaps } from "../importer/source.ts";
import { buildOutdoorWorldIndex } from "../importer/world.ts";
import { projectOutdoorWorldLayout } from "../importer/world-layout.ts";

const SOURCE_REVISION = "9e6258ff726b786040a267e8bdbbf037b560285e";
const source = buildOutdoorWorldIndex(loadAllMaps(), { sourceRevision: SOURCE_REVISION }).index;
const layout = projectOutdoorWorldLayout(source)!;

const pairKey = (a: string, b: string): string => [a, b].sort().join("--");
const seamKey = (seam: { mapA: string; sideA: string; mapB: string; sideB: string }): string =>
  `${seam.mapA}:${seam.sideA}--${seam.mapB}:${seam.sideB}`;
const sourceSeamKey = (seam: { a: string; sideA: string; b: string; sideB: string }): string =>
  `${seam.a}:${seam.sideA}--${seam.b}:${seam.sideB}`;

function components(worldId: string): WorldComponent[] {
  return layout.components.filter((component) => component.worldId === worldId);
}

type TransferCommand = Extract<Command, { op: "transfer" }>;

function markedTransfers(commands: readonly Command[]): TransferCommand[] {
  const marked: TransferCommand[] = [];
  for (const command of commands) {
    if (command.op === "transfer" && command.handoff) marked.push(command);
    if (command.op === "if") {
      marked.push(...markedTransfers(command.then), ...markedTransfers(command.else ?? []));
    } else if (command.op === "loop") {
      marked.push(...markedTransfers(command.commands));
    } else if (command.op === "choices") {
      for (const option of command.options) marked.push(...markedTransfers(option.commands));
      marked.push(...markedTransfers(command.cancel?.commands ?? []));
    } else if (command.op === "battle") {
      marked.push(...markedTransfers(command.onWin ?? []));
      marked.push(...markedTransfers(command.onLose ?? []));
      marked.push(...markedTransfers(command.onEscape ?? []));
    } else if (command.op === "scene") {
      marked.push(...markedTransfers(command.onDone ?? []));
      marked.push(...markedTransfers(command.onCancel ?? []));
    }
  }
  return marked;
}

describe("runtime WorldLayout projection", () => {
  test("preserves the complete topology census and exact source membership", () => {
    expect(validateWorldLayout(layout)).toBe(layout);
    expect(layout.topologyHash).toBe("c681c230fe432bbbf8809fe11a5bbc42fc8eb4f62c2ec1a6be141fd0c35f2143");
    expect([...new Set(layout.components.map((component) => component.worldId))]).toEqual([
      "classic",
      "eclipse",
      "normal",
      "spyder",
    ]);

    const census = ["classic", "eclipse", "normal", "spyder"].map((worldId) => {
      const group = components(worldId);
      const openings = group.flatMap((component) => component.openings);
      return {
        worldId,
        componentSizes: group.map((component) => component.placements.length).sort((a, b) => b - a),
        placements: group.reduce((sum, component) => sum + component.placements.length, 0),
        seams: group.reduce((sum, component) => sum + component.seams.length, 0),
        safe: openings.filter((opening) => opening.compatibility === "coordinate-preserving").length,
        portalOnly: openings.filter((opening) => opening.compatibility === "portal-only").length,
      };
    });
    expect(census).toEqual([
      { worldId: "classic", componentSizes: [15], placements: 15, seams: 15, safe: 0, portalOnly: 30 },
      { worldId: "eclipse", componentSizes: [8, 1, 1, 1, 1], placements: 12, seams: 9, safe: 0, portalOnly: 0 },
      { worldId: "normal", componentSizes: [16, 1], placements: 17, seams: 15, safe: 104, portalOnly: 4 },
      { worldId: "spyder", componentSizes: [23], placements: 23, seams: 32, safe: 154, portalOnly: 5 },
    ]);

    const projectedSeams = layout.components.flatMap((component) => component.seams.map(seamKey)).sort();
    const sourceSeams = source.worlds.flatMap((world) => world.seams.map(sourceSeamKey)).sort();
    expect(projectedSeams).toEqual(sourceSeams);
    const projectedOpeningIds = layout.components.flatMap((component) =>
      component.openings.map((opening) => opening.portalId)
    ).sort();
    const sourceOpeningIds = source.worlds.flatMap((world) =>
      world.seams.flatMap((seam) => seam.handoff.openings.map((opening) => opening.portalId))
    ).sort();
    expect(projectedOpeningIds).toEqual(sourceOpeningIds);
  });

  test("keeps negative origins and directional offsets signed", () => {
    const normal = components("normal");
    const route1 = normal.flatMap((component) => component.placements)
      .find((placement) => placement.mapId === "route1")!;
    expect(route1).toEqual({
      mapId: "route1",
      originTileX: -1,
      originTileY: 0,
      width: 59,
      height: 42,
    });
    expect(localToWorld(route1, { x: 0, y: 0 })).toEqual({ x: -1, y: 0 });
    expect(worldToLocal(route1, { x: -1, y: 0 })).toEqual({ x: 0, y: 0 });

    const reverse = normal.flatMap((component) => component.openings)
      .find((opening) => opening.portalId === "leather_town:tmx:leather_town.tmx:75:a0")!;
    expect(reverse).toMatchObject({
      source: { mapId: "leather_town" },
      target: { mapId: "citypark" },
      axis: "y",
      offset: -20,
      compatibility: "coordinate-preserving",
    });
  });

  test("retains per-opening safety on the one mixed seam", () => {
    const mixed = components("normal").flatMap((component) => component.seams)
      .find((seam) => seam.mapA === "flower_city" && seam.mapB === "routea")!;
    const openingById = new Map(components("normal").flatMap((component) => component.openings)
      .map((opening) => [opening.portalId, opening]));
    const openings = mixed.openingIds.map((id) => openingById.get(id)!);
    expect(openings).toHaveLength(5);
    expect(openings.filter((opening) => opening.compatibility === "coordinate-preserving")).toHaveLength(4);
    expect(openings.filter((opening) => opening.compatibility === "portal-only").map((opening) => opening.portalId))
      .toEqual(["routea:tmx:routea.tmx:45:a0"]);
  });

  test("marks every reachable safe opening and every marker is a passable runtime-direct transfer", () => {
    const imported = buildProject(availableMapIds(), G6_IMPORT_OPTIONS);
    const project = imported.project;
    expect(project.worldTraversal).toBe("seamless-v1");
    expect(imported.report.seamlessHandoff).toMatchObject({
      topologySafeOpenings: 258,
      runtimeEligibleOpenings: 283,
      enabledTransfers: 283,
      partialSeamlessCells: 75,
      partialLegacyCells: 0,
    });
    expect(imported.report.seamlessHandoff.notEnabledSafePortalIds).toEqual([]);
    expect(imported.report.seamlessHandoff.fullyLegacyPortalOnlyPortalIds).toEqual([
      "classic_route_2:tmx:classic_route_2.tmx:285:a0",
      "classic_route_3:tmx:classic_route_3.tmx:285:a0",
      "classic_route_4:tmx:classic_route_4.tmx:285:a0",
      "classic_route_4:tmx:classic_route_4.tmx:286:a0",
      "classic_stormpeak_city:tmx:classic_stormpeak_city.tmx:290:a0",
      "route1_sanglorian:tmx:route1_sanglorian.tmx:129:a0",
      "route1_sanglorian:tmx:route1_sanglorian.tmx:130:a0",
      "route1_sanglorian:tmx:route1_sanglorian.tmx:160:a0",
      "routea:tmx:routea.tmx:45:a0",
      "spyder_candy_town:tmx:spyder_candy_town.tmx:100:a0",
      "spyder_paper_town:tmx:spyder_paper_town.tmx:217:a0",
      "spyder_routec:tmx:spyder_routec.tmx:155:a0",
      "spyder_routec:tmx:spyder_routec.tmx:156:a0",
      "spyder_routec:tmx:spyder_routec.tmx:275:a0",
    ]);
    expect(imported.report.seamlessHandoff.notEnabled).not.toContainEqual(
      expect.objectContaining({ reason: "unreachable-source-facing" }),
    );
    expect(imported.report.seamlessHandoff.partialPromotions).toHaveLength(25);
    const route3Ids = [153, 154, 155, 156, 157]
      .map((id) => `route3:tmx:route3.tmx:${id}:a0`);
    expect(route3Ids.every((portalId) => imported.report.seamlessHandoff.enabledPortalIds.includes(portalId)))
      .toBeTrue();

    const safeIds = new Set(project.worldLayout!.components.flatMap((component) =>
      component.openings.filter((opening) => opening.compatibility === "coordinate-preserving")
        .map((opening) => opening.portalId)
    ));
    const portalOnlyIds = new Set(project.worldLayout!.components.flatMap((component) =>
      component.openings.filter((opening) => opening.compatibility === "portal-only")
        .map((opening) => opening.portalId)
    ));
    const openingById = new Map(project.worldLayout!.components.flatMap((component) =>
      component.openings.map((opening) => [opening.portalId, opening] as const)
    ));
    const mapById = new Map(project.maps.map((map) => [map.id, map] as const));
    const sheets = new Map(project.sheets.map((sheet) => [sheet.id, sheet] as const));
    const passage = new Map(project.maps.map((map) => [map.id, buildPassage(map, sheets)] as const));
    const resolver = createWorldHandoffResolver(project.worldLayout!);
    const partialById = new Map(imported.report.seamlessHandoff.partialPromotions
      .map((promotion) => [promotion.portalId, promotion] as const));
    const markedIds = new Set<string>();
    const compiledDirectIds = new Set<string>();
    const sideDirection = { south: 0, west: 1, north: 2, east: 3 } as const;
    const opposite = [2, 3, 0, 1] as const;

    for (const map of project.maps) {
      for (const event of map.events ?? []) {
        for (const page of event.pages) {
          const raw = markedTransfers(page.commands);
          for (const transfer of raw) {
            const portalId = transfer.handoff!.portalId;
            markedIds.add(portalId);
            expect(page.trigger, portalId).toBe("playerTouch");
            expect(safeIds.has(portalId), portalId).toBeTrue();
            expect(portalOnlyIds.has(portalId), portalId).toBeFalse();
            if (typeof transfer.map !== "string" || typeof transfer.x !== "number" ||
                typeof transfer.y !== "number") throw new Error(`${portalId}: dynamic marked endpoint`);
            const transferDirection = transfer.dir ?? "keep";
            if (typeof transferDirection !== "string") throw new Error(`${portalId}: dynamic marked direction`);
            const opening = openingById.get(portalId)!;
            const target = mapById.get(transfer.map)!;
            const facing = sideDirection[opening.source.side] as Dir4;
            const partial = partialById.get(portalId);
            // Every promoted lane is its own 1x1 event at its source cell.
            const sourceX = event.x;
            const sourceY = event.y;
            if (partial) {
              expect([event.w ?? 1, event.h ?? 1], portalId).toEqual([1, 1]);
              expect(partial.lanes, portalId).toContainEqual(expect.objectContaining({
                source: { x: sourceX, y: sourceY },
                target: { x: transfer.x, y: transfer.y },
              }));
            }
            const resolved = resolver.resolve({
              portalId,
              sourceMapId: map.id,
              targetMapId: transfer.map,
              sourceX,
              sourceY,
              targetX: transfer.x,
              targetY: transfer.y,
              sourceWidth: map.width,
              sourceHeight: map.height,
              targetWidth: target.width,
              targetHeight: target.height,
              facing,
              transferDirection,
            });
            expect(resolved, portalId).toEqual({ direction: facing });
            expect(cellBlocksExit(passage.get(map.id)!, sourceX, sourceY, facing), portalId).toBeFalse();
            expect(canEnter(passage.get(target.id)!, transfer.x, transfer.y, opposite[facing]), portalId).toBeTrue();
            for (const legacy of partial?.legacyLanes ?? []) {
              expect(resolver.resolve({
                portalId,
                sourceMapId: map.id,
                targetMapId: transfer.map,
                sourceX: legacy.x,
                sourceY: legacy.y,
                targetX: partial!.target.x,
                targetY: partial!.target.y,
                sourceWidth: map.width,
                sourceHeight: map.height,
                targetWidth: target.width,
                targetHeight: target.height,
                facing,
                transferDirection,
              }), `${portalId} legacy lane`).toBeNull();
            }
          }
          for (const instruction of compile(page.commands)) {
            if (instruction.op === "transfer" && instruction.handoff) {
              compiledDirectIds.add(instruction.handoff.portalId);
            }
          }
        }
      }
    }

    expect([...markedIds].sort()).toEqual(imported.report.seamlessHandoff.enabledPortalIds);
    expect([...compiledDirectIds].sort()).toEqual(imported.report.seamlessHandoff.enabledPortalIds);
    expect(markedIds.size).toBe(283);
    expect([...safeIds].filter((id) => !markedIds.has(id)).sort())
      .toEqual(imported.report.seamlessHandoff.notEnabledSafePortalIds);
  });

  test("builds explicit seamless and legacy headless session options without silent fallback", () => {
    const project = buildProject(["spyder_paper_town", "spyder_route1"], G6_IMPORT_OPTIONS).project;
    const seamless = createTuxemonSessionOptions(project);
    expect(seamless.worldTraversal).toBe("seamless-v1");
    expect(seamless.handoff?.topologyHash).toBe(project.worldLayout?.topologyHash);

    const legacy = createTuxemonSessionOptions(project, "legacy-transfer");
    expect(legacy.worldTraversal).toBe("legacy-transfer");
    expect(legacy.handoff).toBeUndefined();

    expect(() => createTuxemonSessionOptions(
      { ...project, worldTraversal: undefined },
      "seamless-v1",
    )).toThrow("requires a seamless project with WorldLayout");
  });

  test("does not promote gaps, rejected contacts or overlaps into layout seams", () => {
    const gaps = source.worlds.flatMap((world) => world.diagnostics.rejectedContacts)
      .filter((contact) => contact.geometry === "gap");
    const rejected = source.worlds.flatMap((world) => world.diagnostics.rejectedContacts)
      .filter((contact) => contact.geometry === "edge");
    const overlaps = source.worlds.flatMap((world) => world.diagnostics.rejectedContacts)
      .filter((contact) => contact.geometry === "overlap");
    expect(gaps.map((gap) => pairKey(gap.a, gap.b)).sort()).toEqual([
      "dryadsgrove--leather_town",
      "dryadsgrove--taba_town",
      "flower_city--leather_town",
      "flower_city--timber_town",
      "spyder_candy_port--spyder_flower_city",
      "spyder_candy_port--spyder_leather_town",
      "spyder_candy_port--spyder_paper_town",
      "spyder_candy_port--spyder_timber_town",
      "spyder_diamond_hill--spyder_routec",
      "spyder_flower_city--spyder_leather_town",
      "spyder_flower_city--spyder_paper_town",
      "spyder_leather_town--spyder_paper_town",
      "spyder_leather_town--spyder_timber_town",
      "spyder_paper_town--spyder_timber_town",
    ]);
    expect(rejected).toHaveLength(20);
    expect(overlaps).toHaveLength(0);
    const projectedPairs = new Set(layout.components.flatMap((component) =>
      component.seams.map((seam) => pairKey(seam.mapA, seam.mapB))
    ));
    for (const contact of [...gaps, ...rejected]) {
      expect(projectedPairs.has(pairKey(contact.a, contact.b)), `${contact.a}/${contact.b}`).toBeFalse();
    }

    const mutated = structuredClone(layout);
    const normal = mutated.components.find((component) => component.worldId === "normal")!;
    const route1 = normal.placements.find((placement) => placement.mapId === "route1")!;
    const neighbor = normal.placements.find((placement) => placement.mapId !== "route1")!;
    route1.originTileX = neighbor.originTileX;
    route1.originTileY = neighbor.originTileY;
    expect(() => validateWorldLayout(mutated)).toThrow("overlap");
  });

  test("is deterministic and stays outside every MapDef shard", () => {
    const before = JSON.stringify(source);
    expect(JSON.stringify(projectOutdoorWorldLayout(source))).toBe(JSON.stringify(layout));
    expect(JSON.stringify(source)).toBe(before);

    const imported = buildProject(["spyder_paper_town"]);
    expect(imported.project.worldLayout?.topologyHash).toBe(source.contentHash);
    expect(imported.project.worldLayout?.components.flatMap((component) => component.placements)
      .map((placement) => placement.mapId)).toEqual(["spyder_paper_town"]);
    const withLayout = splitProjectMaps(imported.project);
    const { worldLayout: _worldLayout, ...withoutLayoutGlobals } = imported.project;
    const withoutLayout = splitProjectMaps(withoutLayoutGlobals as Project);
    expect(withLayout.entries.map((entry) => entry.text)).toEqual(withoutLayout.entries.map((entry) => entry.text));
    expect(withLayout.entries.map((entry) => entry.meta.sha256)).toEqual(
      withoutLayout.entries.map((entry) => entry.meta.sha256),
    );
    expect(withLayout.shell.mapManifestHash).not.toBe(withoutLayout.shell.mapManifestHash);

    const changedTopology = structuredClone(imported.project);
    changedTopology.worldLayout!.topologyHash = "f".repeat(64);
    const changed = splitProjectMaps(changedTopology);
    expect(changed.entries.map((entry) => entry.meta.sha256)).toEqual(
      withLayout.entries.map((entry) => entry.meta.sha256),
    );
    expect(changed.shell.mapManifestHash).not.toBe(withLayout.shell.mapManifestHash);
  });
});

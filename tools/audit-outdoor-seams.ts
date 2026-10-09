// Deterministic inventory of every TMX outdoor-to-outdoor transfer after the
// generated seamless-handoff policy is applied. This is an audit artifact,
// not importer input: changing a map rule requires changing the importer and
// regenerating the whole project before this report changes.
//
// Usage: TUXEMON_SRC=/path/to/Tuxemon bun tools/audit-outdoor-seams.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  availableMapIds,
  buildProject,
  G6_IMPORT_OPTIONS,
  type PartialSeamPromotion,
} from "../importer/project.ts";
import { loadAllMaps, type TuxEvent, type TuxMap } from "../importer/source.ts";
import { importTerrainSurfaceLabels } from "../importer/terrain.ts";
import { buildOutdoorWorldIndex, outdoorWorldPortalId } from "../importer/world.ts";
import type {
  OutdoorWorldIndex,
  RejectedWorldContact,
  WorldPortal,
  WorldSeamOpening,
} from "../importer/world-schema.ts";

const ROOT = resolve(import.meta.dir, "..");
const OUTPUT = join(ROOT, "reports/outdoor-seam-audit.json");

interface SourcePortal {
  map: TuxMap;
  event: TuxEvent;
  actionIndex: number;
}

function fail(message: string): never {
  throw new Error(`outdoor seam audit: ${message}`);
}

function expectCount(label: string, actual: number, expected: number): void {
  if (actual !== expected) fail(`${label}: expected ${expected}, got ${actual}`);
}

function sourcePortals(maps: readonly TuxMap[]): Map<string, SourcePortal> {
  const out = new Map<string, SourcePortal>();
  for (const map of maps) for (const [eventIndex, event] of map.events.entries()) {
    if (event.origin !== "tmx") continue;
    for (const [actionIndex, action] of event.acts.entries()) {
      if (action.type !== "transition_teleport") continue;
      out.set(outdoorWorldPortalId(map.slug, event, eventIndex, actionIndex), {
        map,
        event,
        actionIndex,
      });
    }
  }
  return out;
}

function cells(portal: Readonly<WorldPortal>): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let y = portal.source.y; y < portal.source.y + portal.source.height; y++) {
    for (let x = portal.source.x; x < portal.source.x + portal.source.width; x++) out.push({ x, y });
  }
  return out;
}

function sourceShape(portal: Readonly<WorldPortal>, source: Readonly<SourcePortal>) {
  const facingGuard = source.event.conds.find((condition) =>
    condition.op === "is" && condition.type === "char_facing" && condition.args[0] === "player"
  )?.args[1] ?? null;
  const trailingFace = source.event.acts.slice(source.actionIndex + 1).find((action) =>
    action.type === "char_face" && action.args[0] === "player"
  )?.args[1] ?? null;
  return {
    map: portal.sourceMap,
    event: portal.event,
    objectId: portal.objectId,
    rect: { ...portal.source },
    cells: cells(portal),
    touchingSides: [...portal.touchingSides],
    facingGuard,
    trailingFace,
  };
}

function targetShape(portal: Readonly<WorldPortal>) {
  return { map: portal.targetMap, x: portal.target.x, y: portal.target.y };
}

/** Every source cell and its continuous target cell are Surf water. */
function surfOnly(portal: Readonly<WorldPortal>, opening: Readonly<WorldSeamOpening>): boolean {
  const sourceWater = surfable(portal.sourceMap);
  const targetWater = surfable(portal.targetMap);
  const sourceWidth = mapsById.get(portal.sourceMap)!.width;
  const targetWidth = mapsById.get(portal.targetMap)!.width;
  const offset = opening.expectedTargetSpan.start - opening.sourceSpan.start;
  return cells(portal).every((cell) => {
    const tangent = opening.sourceSide === "north" || opening.sourceSide === "south" ? cell.x : cell.y;
    const target = tangent + offset;
    const targetCell = opening.targetSide === "north" ? { x: target, y: 0 }
      : opening.targetSide === "south" ? { x: target, y: mapsById.get(portal.targetMap)!.height - 1 }
      : opening.targetSide === "west" ? { x: 0, y: target }
      : { x: targetWidth - 1, y: target };
    return sourceWater.has(cell.y * sourceWidth + cell.x) &&
      targetWater.has(targetCell.y * targetWidth + targetCell.x);
  });
}

function portalOnlyAssessment(
  portal: Readonly<WorldPortal>,
  opening: Readonly<WorldSeamOpening>,
  source: Readonly<SourcePortal>,
): string {
  const guard = source.event.conds.find((condition) =>
    condition.op === "is" && condition.type === "char_facing" && condition.args[0] === "player"
  )?.args[1];
  if (portal.sourceMap === "classic_route_2" && portal.touchingSides.includes("west") && guard === "right") {
    return "unsafe: the west-edge event requires/faces right, so it is not an outward physical crossing and its source intent is ambiguous";
  }
  const water = surfOnly(portal, opening);
  if (opening.issues.includes("wrong-target-edge")) {
    return "unsafe: the authored destination is inside the target or on its same-side edge, not the adjacent opposite edge" +
      (water ? "; every lane is also Surf water on both sides" : "");
  }
  if (water) {
    return "unsafe: every lane is Surf water on both sides; the runtime proves a crossing against immutable terrain, where water stays solid until a map visit opens it, so a seamless surf crossing needs a kit-level surface-aware proof";
  }
  if (opening.issues.includes("offset-mismatch")) {
    return "unsafe: the authored destination changes the tangent coordinate, so a direct crossing would change placement semantics";
  }
  if (opening.issues.includes("fixed-destination")) {
    return "unsafe: no generated coordinate-aligned lane passed the simple outward-walk and passability proof";
  }
  return "unsafe: the topology classified this opening as portal-only";
}

function contactFor(
  index: Readonly<OutdoorWorldIndex>,
  portalId: string,
  geometry: "gap" | "rejected",
): RejectedWorldContact | undefined {
  return index.worlds.flatMap((world) => world.diagnostics.rejectedContacts).find((contact) =>
    contact.portalIds.includes(portalId) &&
    (geometry === "gap" ? contact.geometry === "gap" : contact.geometry !== "gap")
  );
}

const maps = loadAllMaps();
const mapsById = new Map(maps.map((map) => [map.slug, map] as const));
const surfaceLabels = importTerrainSurfaceLabels(maps.map((map) => map.slug));
const surfable = (mapId: string): Set<number> => new Set(surfaceLabels[mapId]?.surfable ?? []);
const sources = sourcePortals(maps);
const { index } = buildOutdoorWorldIndex(maps);
const imported = buildProject(availableMapIds(), G6_IMPORT_OPTIONS);
const handoff = imported.report.seamlessHandoff;

const outdoorMapIds = new Set(index.worlds.flatMap((world) => world.maps.map((map) => map.mapId)));
const portals = index.worlds.flatMap((world) => world.portals)
  .filter((portal) => outdoorMapIds.has(portal.targetMap))
  .sort((a, b) => a.id.localeCompare(b.id));
const portalById = new Map(portals.map((portal) => [portal.id, portal] as const));
const openingById = new Map(index.worlds.flatMap((world) => world.seams.flatMap((seam) =>
  seam.handoff.openings.map((opening) => [opening.portalId, opening] as const)
)));
const safeIds = new Set([...openingById].filter(([, opening]) =>
  opening.compatibility === "coordinate-preserving"
).map(([portalId]) => portalId));
const portalOnlyIds = new Set([...openingById].filter(([, opening]) =>
  opening.compatibility === "portal-only"
).map(([portalId]) => portalId));
const gapIds = new Set(index.worlds.flatMap((world) => world.diagnostics.rejectedContacts
  .filter((contact) => contact.geometry === "gap")
  .flatMap((contact) => contact.portalIds)));
const rejectedIds = new Set(index.worlds.flatMap((world) => world.diagnostics.rejectedContacts
  .filter((contact) => contact.geometry !== "gap")
  .flatMap((contact) => contact.portalIds)));
const promotionById = new Map(handoff.partialPromotions.map((promotion) =>
  [promotion.portalId, promotion] as const
));

const partial = handoff.partialPromotions.map((promotion: PartialSeamPromotion) => {
  const portal = portalById.get(promotion.portalId) ?? fail(`${promotion.portalId}: missing portal`);
  const source = sources.get(promotion.portalId) ?? fail(`${promotion.portalId}: missing source event`);
  return {
    portalId: promotion.portalId,
    category: "lane-mapped-fixed-destination" as const,
    source: sourceShape(portal, source),
    target: targetShape(portal),
    seamlessLanes: promotion.lanes.map((lane) => ({ ...lane })),
    legacyCells: promotion.legacyLanes.map((cell) => ({ ...cell })),
    assessment: promotion.legacyLanes.length === 0
      ? "safe: the maps sit edge to edge and every lane passes the terrain proof, so each lane lands on its own coordinate-continuous neighbour cell instead of the authored funnel landing"
      : "partially safe: lanes that pass the terrain proof land on their continuous neighbour cell; the rest keep the original fade and fixed landing",
  };
});

const whollyLegacy = portals.filter((portal) =>
  !safeIds.has(portal.id) && !promotionById.has(portal.id)
).map((portal) => {
  const source = sources.get(portal.id) ?? fail(`${portal.id}: missing source event`);
  const opening = openingById.get(portal.id);
  if (portalOnlyIds.has(portal.id)) {
    if (!opening) fail(`${portal.id}: portal-only id has no opening`);
    return {
      portalId: portal.id,
      category: "portal-only" as const,
      source: sourceShape(portal, source),
      target: targetShape(portal),
      topologyIssues: [...opening.issues],
      assessment: portalOnlyAssessment(portal, opening, source),
    };
  }
  if (gapIds.has(portal.id)) {
    const contact = contactFor(index, portal.id, "gap");
    return {
      portalId: portal.id,
      category: "linked-gap" as const,
      source: sourceShape(portal, source),
      target: targetShape(portal),
      topologyReason: contact?.reason ?? "gap",
      assessment: "unsafe: the authored world placements have a gap, so the maps cannot be juxtaposed without changing geometry",
    };
  }
  if (rejectedIds.has(portal.id)) {
    const contact = contactFor(index, portal.id, "rejected");
    return {
      portalId: portal.id,
      category: "rejected-contact" as const,
      source: sourceShape(portal, source),
      target: targetShape(portal),
      topologyReason: contact?.reason ?? "rejected contact",
      assessment: "unsafe: the apparent edge contact was rejected by the topology proof; direct crossing would invent unsupported adjacency",
    };
  }
  return {
    portalId: portal.id,
    category: "outdoor-nonseam-or-story" as const,
    source: sourceShape(portal, source),
    target: targetShape(portal),
    assessment: "unsafe: no accepted adjacent world seam connects these endpoints, so the authored outdoor transfer retains story/portal semantics",
  };
});

const directionOnly = index.worlds.flatMap((world) => world.seams
  .filter((seam) => seam.handoff.mode === "direction-only")
  .map((seam) => ({
    worldId: world.worldId,
    source: { map: seam.a, side: seam.sideA, span: { ...seam.spanA } },
    target: { map: seam.b, side: seam.sideB, span: { ...seam.spanB } },
    assessment: "not a legacy fade: no transition_teleport portal exists; direct crossing would require a new eventless edge-trigger policy",
  })))
  .sort((a, b) => `${a.worldId}/${a.source.map}/${a.target.map}`.localeCompare(
    `${b.worldId}/${b.source.map}/${b.target.map}`,
  ));

const whollyLegacyByCategory = {
  "portal-only": whollyLegacy.filter((row) => row.category === "portal-only").length,
  "linked-gap": whollyLegacy.filter((row) => row.category === "linked-gap").length,
  "rejected-contact": whollyLegacy.filter((row) => row.category === "rejected-contact").length,
  "outdoor-nonseam-or-story": whollyLegacy.filter((row) =>
    row.category === "outdoor-nonseam-or-story"
  ).length,
};

expectCount("outdoor-to-outdoor portal actions", portals.length, 348);
expectCount("raw coordinate-preserving openings", safeIds.size, 258);
expectCount("runtime seamless portal ids", handoff.enabledTransfers, 283);
expectCount("partial portal ids", partial.length, 25);
expectCount("partial seamless cells", handoff.partialSeamlessCells, 75);
expectCount("partial legacy cells", handoff.partialLegacyCells, 0);
expectCount("wholly legacy portal ids", whollyLegacy.length, 65);
expectCount("legacy portal-only", whollyLegacyByCategory["portal-only"], 14);
expectCount("legacy linked gaps", whollyLegacyByCategory["linked-gap"], 33);
expectCount("legacy rejected contacts", whollyLegacyByCategory["rejected-contact"], 4);
expectCount("legacy story/nonseam", whollyLegacyByCategory["outdoor-nonseam-or-story"], 14);
expectCount("direction-only seams", directionOnly.length, 10);

const report = {
  format: "pocket-tuxemon/outdoor-seam-audit/v1" as const,
  sourceRevision: index.sourceRevision,
  topologyHash: index.contentHash,
  counts: {
    outdoorToOutdoorPortalActions: portals.length,
    rawCoordinatePreservingPortalIds: safeIds.size,
    runtimeSeamlessPortalIds: handoff.enabledTransfers,
    partialPortalIds: partial.length,
    partialSeamlessCells: handoff.partialSeamlessCells,
    partialLegacyCells: handoff.partialLegacyCells,
    whollyLegacyPortalIds: whollyLegacy.length,
    whollyLegacyByCategory,
    directionOnlySeamsWithoutPortalActions: directionOnly.length,
  },
  partial,
  whollyLegacy,
  directionOnly,
};

mkdirSync(join(ROOT, "reports"), { recursive: true });
writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `outdoor seam audit: ${portals.length} portal actions; ${handoff.enabledTransfers} runtime seamless ids; ` +
  `${partial.length} partial (${handoff.partialLegacyCells} legacy cells); ${whollyLegacy.length} wholly legacy; ` +
  `${directionOnly.length} direction-only seams -> ${OUTPUT}`,
);

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
function surfOnly(
  portal: Readonly<WorldPortal>,
  opening: Readonly<WorldSeamOpening>,
  audit: Readonly<AuditContext>,
): boolean {
  const sourceWater = audit.surfable(portal.sourceMap);
  const targetWater = audit.surfable(portal.targetMap);
  const sourceWidth = audit.mapsById.get(portal.sourceMap)!.width;
  const targetWidth = audit.mapsById.get(portal.targetMap)!.width;
  const offset = opening.expectedTargetSpan.start - opening.sourceSpan.start;
  return cells(portal).every((cell) => {
    const tangent = opening.sourceSide === "north" || opening.sourceSide === "south" ? cell.x : cell.y;
    const target = tangent + offset;
    const targetCell = opening.targetSide === "north" ? { x: target, y: 0 }
      : opening.targetSide === "south" ? { x: target, y: audit.mapsById.get(portal.targetMap)!.height - 1 }
      : opening.targetSide === "west" ? { x: 0, y: target }
      : { x: targetWidth - 1, y: target };
    return sourceWater.has(cell.y * sourceWidth + cell.x) &&
      targetWater.has(targetCell.y * targetWidth + targetCell.x);
  });
}

interface AuditContext {
  mapsById: ReadonlyMap<string, TuxMap>;
  surfable(mapId: string): Set<number>;
}

const pairKey = (a: string, b: string): string => [a, b].sort().join("/");

function endpoint(portal: Readonly<WorldPortal>): string {
  return `${portal.sourceMap} (${portal.source.x},${portal.source.y}) -> ` +
    `${portal.targetMap} (${portal.target.x},${portal.target.y})`;
}

function riverDestinationVariable(source: Readonly<SourcePortal>, portal: Readonly<WorldPortal>): string | null {
  const destination = source.event.conds.find((condition) =>
    condition.op === "is" && condition.type === "variable_set" &&
    condition.args[0]?.startsWith("rivergoto:")
  )?.args[0];
  const clearsDispatch = source.event.acts.slice(0, source.actionIndex).some((action) =>
    action.type === "set_variable" && action.args[0] === "rivergoto:nothing"
  );
  return source.event.name.startsWith("Destination - ") &&
      portal.touchingSides.length === 0 && destination && clearsDispatch
    ? destination
    : null;
}

function linkedGapAssessment(portal: Readonly<WorldPortal>): string {
  switch (pairKey(portal.sourceMap, portal.targetMap)) {
    case "dryadsgrove/taba_town":
      return "keep fade: the south/north Surf mouths are 40 tiles apart; aligning their authored lanes would move Taba Town into a large overlap with Route 1, which seamless-v1 forbids";
    case "dryadsgrove/leather_town":
      return "keep fade: the map rectangles meet only at one corner and the portals turn between Dryad's north edge and Leather Town's east edge; no translation can make those perpendicular sides one physical seam";
    case "flower_city/leather_town":
      return "keep fade: the maps have a 41-tile vertical gap and the portals turn between Flower City's south edge and Leather Town's east edge; the reverse authored target (59,0) is also outside Flower City's 40-tile width";
    case "flower_city/timber_town":
      return "keep fade: the maps have a 40-tile horizontal gap and the portals turn between Flower City's east edge and Timber Town's south edge; this needs a rotating corner transfer, not an axis-aligned seam";
    default:
      return fail(`${portal.id}: linked gap has no specific assessment`);
  }
}

function rejectedContactAssessment(portal: Readonly<WorldPortal>): string {
  if (pairKey(portal.sourceMap, portal.targetMap) !== "route1/taba_town") {
    return fail(`${portal.id}: rejected contact has no specific assessment`);
  }
  return "keep fade: Route 1 and Taba Town touch east/west, but both portal lanes sit eight tiles inside reciprocal preview strips; making the cells adjacent requires a forbidden 16-column map overlap across authored collision walls";
}

function storyAssessment(portal: Readonly<WorldPortal>, source: Readonly<SourcePortal>): string {
  const riverDestination = riverDestinationVariable(source, portal);
  if (riverDestination) {
    return `keep fade: interior river-captain destination dispatch ${riverDestination} clears rivergoto and teleports ${endpoint(portal)}; it is choice-driven story travel, not an outward edge crossing`;
  }
  switch (pairKey(portal.sourceMap, portal.targetMap)) {
    case "route1/route1_sanglorian":
      return `keep fade: ${endpoint(portal)} uses Route 1 row 4 behind four solid preview rows; seamless-v1 can cross the physical north/south edge only, not a four-row virtual overlap`;
    case "timber_town/tunnel":
      return `keep fade: ${endpoint(portal)} turns between Timber Town's north edge and Tunnel's west edge on Surf water; the separate south/north road seam is already seamless, while this perpendicular river bend is not`;
    case "flower_city/route5":
      if (portal.objectId === 203) {
        return "keep fade: Flower City object 203 triggers at interior cell (37,16) facing two collision columns; object 201 at the true east-edge opening (39,15) already supplies the coordinate-preserving Route 5 seam";
      }
      break;
  }
  return fail(`${portal.id}: story/non-seam portal has no specific assessment`);
}

function portalOnlyAssessment(
  portal: Readonly<WorldPortal>,
  opening: Readonly<WorldSeamOpening>,
  source: Readonly<SourcePortal>,
  audit: Readonly<AuditContext>,
): string {
  const guard = source.event.conds.find((condition) =>
    condition.op === "is" && condition.type === "char_facing" && condition.args[0] === "player"
  )?.args[1];
  if (portal.sourceMap === "classic_route_2" && portal.touchingSides.includes("west") && guard === "right") {
    return "keep fade: all three ground lanes are geometrically passable, but this west-edge event guards and faces right into Classic Route 2; promoting it would invent the un-authored outward-left trigger";
  }
  if (portal.sourceMap === "route1_sanglorian") {
    return `keep fade: Sanglorian south-edge lane x=${portal.source.x} is tangent-aligned, but its authored Route 1 landing (${portal.target.x},${portal.target.y}) skips four solid preview rows; the physical neighbour is the blocked north-edge cell (${portal.target.x},0)`;
  }
  if (portal.sourceMap === "routea" && portal.objectId === 45) {
    return "keep fade: Route A lane (13,39) should continue to Flower City (13,0), but the authored landing changes x to 12 and both continuous edge cells are non-Surf collision; adjacent objects 44 and 56 are the real seamless channel";
  }
  const water = surfOnly(portal, opening, audit);
  if (opening.issues.includes("wrong-target-edge")) {
    return "unsafe: the authored destination is inside the target or on its same-side edge, not the adjacent opposite edge" +
      (water ? "; every lane is also Surf water on both sides" : "");
  }
  if (water) {
    return "keep fade: every continuous lane is Surf water, but this opening did not pass the current whole-span Surf surface/exit/entry promotion proof; do not bypass the trusted movement-capability gate";
  }
  if (opening.issues.includes("offset-mismatch")) {
    return "unsafe: the authored destination changes the tangent coordinate, so a direct crossing would change placement semantics";
  }
  if (opening.issues.includes("fixed-destination")) {
    return "unsafe: no generated coordinate-aligned lane passed the simple outward-walk and passability proof";
  }
  return fail(`${portal.id}: portal-only opening has no specific assessment`);
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
const audit = { mapsById, surfable };
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
    category: promotion.movementCapability
      ? "surf-capability-lanes" as const
      : "lane-mapped-fixed-destination" as const,
    reason: promotion.reason,
    movementCapability: promotion.movementCapability ?? null,
    source: sourceShape(portal, source),
    target: targetShape(portal),
    seamlessLanes: promotion.lanes.map((lane) => ({ ...lane })),
    legacyCells: promotion.legacyLanes.map((cell) => ({ ...cell })),
    assessment: promotion.movementCapability
      ? "safe while Surf-capable: every lane is Surf water on both sides and the maps sit edge to edge; the trusted opening capability gates the atomic crossing and relaxes only target solidity, while every lane lands on its coordinate-continuous neighbour cell"
      : promotion.legacyLanes.length === 0
      ? "safe: the maps sit edge to edge and every lane passes the terrain proof, so each lane lands on its own coordinate-continuous neighbour cell instead of the authored funnel landing"
      : "partially safe: lanes that pass the terrain proof land on their continuous neighbour cell; the rest keep the original fade and fixed landing",
  };
});

const whollyLegacy = portals.filter((portal) =>
  !safeIds.has(portal.id) && !promotionById.has(portal.id)
).map((portal) => {
  const source = sources.get(portal.id) ?? fail(`${portal.id}: missing source event`);
  const opening = openingById.get(portal.id);
  const riverDestination = riverDestinationVariable(source, portal);
  if (riverDestination) {
    return {
      portalId: portal.id,
      category: "outdoor-nonseam-or-story" as const,
      recommendation: "keep-fade" as const,
      source: sourceShape(portal, source),
      target: targetShape(portal),
      assessment: storyAssessment(portal, source),
    };
  }
  if (portalOnlyIds.has(portal.id)) {
    if (!opening) fail(`${portal.id}: portal-only id has no opening`);
    return {
      portalId: portal.id,
      category: "portal-only" as const,
      recommendation: "keep-fade" as const,
      source: sourceShape(portal, source),
      target: targetShape(portal),
      topologyIssues: [...opening.issues],
      assessment: portalOnlyAssessment(portal, opening, source, audit),
    };
  }
  if (gapIds.has(portal.id)) {
    const contact = contactFor(index, portal.id, "gap");
    return {
      portalId: portal.id,
      category: "linked-gap" as const,
      recommendation: "keep-fade" as const,
      source: sourceShape(portal, source),
      target: targetShape(portal),
      topologyReason: contact?.reason ?? "gap",
      assessment: linkedGapAssessment(portal),
    };
  }
  if (rejectedIds.has(portal.id)) {
    const contact = contactFor(index, portal.id, "rejected");
    return {
      portalId: portal.id,
      category: "rejected-contact" as const,
      recommendation: "keep-fade" as const,
      source: sourceShape(portal, source),
      target: targetShape(portal),
      topologyReason: contact?.reason ?? "rejected contact",
      assessment: rejectedContactAssessment(portal),
    };
  }
  return {
    portalId: portal.id,
    category: "outdoor-nonseam-or-story" as const,
    recommendation: "keep-fade" as const,
    source: sourceShape(portal, source),
    target: targetShape(portal),
    assessment: storyAssessment(portal, source),
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
expectCount("runtime seamless portal ids", handoff.enabledTransfers, 292);
expectCount("partial portal ids", partial.length, 34);
expectCount("partial seamless cells", handoff.partialSeamlessCells, 137);
expectCount("partial legacy cells", handoff.partialLegacyCells, 0);
expectCount("wholly legacy portal ids", whollyLegacy.length, 56);
expectCount("legacy portal-only", whollyLegacyByCategory["portal-only"], 5);
expectCount("legacy linked gaps", whollyLegacyByCategory["linked-gap"], 19);
expectCount("legacy rejected contacts", whollyLegacyByCategory["rejected-contact"], 4);
expectCount("legacy story/nonseam", whollyLegacyByCategory["outdoor-nonseam-or-story"], 28);
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

export function buildOutdoorSeamAuditReport(): typeof report {
  return report;
}

export type OutdoorSeamAuditReport = ReturnType<typeof buildOutdoorSeamAuditReport>;

if (import.meta.main) {
  const report = buildOutdoorSeamAuditReport();
  mkdirSync(join(ROOT, "reports"), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `outdoor seam audit: ${report.counts.outdoorToOutdoorPortalActions} portal actions; ` +
    `${report.counts.runtimeSeamlessPortalIds} runtime seamless ids; ` +
    `${report.counts.partialPortalIds} partial (${report.counts.partialLegacyCells} legacy cells); ` +
    `${report.counts.whollyLegacyPortalIds} wholly legacy; ` +
    `${report.counts.directionOnlySeamsWithoutPortalActions} direction-only seams -> ${OUTPUT}`,
  );
}

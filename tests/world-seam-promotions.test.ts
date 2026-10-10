import { describe, expect, test } from "bun:test";

import { createTuxemonSessionOptions } from "../battle/game.ts";
import { TUXEMON_PREVIEW_HOOKS } from "../battle/preview-hooks.ts";
import { buildProject, G6_IMPORT_OPTIONS } from "../importer/project.ts";
import { importTerrainSurfaceLabels } from "../importer/terrain.ts";
import { BTN_BITS } from "../vendor/pocket-rpgkit/src/engine/camera.ts";
import { restoreSessionSnapshot } from "../vendor/pocket-rpgkit/src/engine/save-restore.ts";
import {
  canonicalJson,
  createSessionSnapshot,
} from "../vendor/pocket-rpgkit/src/engine/save.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { Dir, GameEvent, Project } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import {
  createSandboxPreviewReader,
  sandboxActors,
} from "../vendor/pocket-rpgkit/src/engine/world-preview-sandbox.ts";

const IDLE = { buttons: 0 } as const;

function projectAt(project: Project, map: string, x: number, y: number, dir: Dir): Project {
  return { ...project, start: { map, x, y, dir } };
}

function startSettled(project: Project, frames = 120): { session: Session; state: SessionState } {
  const session = createSession(project, 60, createTuxemonSessionOptions(project));
  let state = startSession(project, session);
  for (let frame = 0; frame < frames; frame++) state = stepSession(session, state, IDLE);
  expect(state.fade).toBeNull();
  expect(state.scene).toBeNull();
  return { session, state };
}

function approach(
  session: Session,
  initial: SessionState,
  button: number,
): SessionState {
  let state = initial;
  for (let guard = 0; guard < 240; guard++) {
    state = stepSession(session, state, { buttons: button });
    if (state.handoff || state.fade) return state;
  }
  throw new Error("world seam promotion: transition did not start");
}

function finishHandoff(session: Session, initial: SessionState): {
  state: SessionState;
  phases: number[];
} {
  let state = initial;
  const phases: number[] = [];
  while (state.handoff) {
    phases.push(state.handoff.phase);
    expect(state.fade).toBeNull();
    state = stepSession(session, state, IDLE);
  }
  return { state, phases };
}

function finishLegacyTransfer(session: Session, initial: SessionState, sourceMap: string): SessionState {
  let state = initial;
  for (let guard = 0; guard < 120 && (state.mapId === sourceMap || state.fade !== null); guard++) {
    expect(state.handoff).toBeUndefined();
    state = stepSession(session, state, IDLE);
  }
  return state;
}

function normalizeHostFrame(actual: SessionState, reference: SessionState): SessionState {
  // A map entry resets interp.frame; save restore derives the host-only frame
  // from it. The reducer never reads SessionState.frame.
  return { ...actual, frame: reference.frame };
}

const ROUTE3_BUILD = buildProject(["route3", "leather_town"], G6_IMPORT_OPTIONS);
const AEROLUME_BUILD = buildProject(
  ["classic_aerolume_city", "classic_route_5"],
  G6_IMPORT_OPTIONS,
);
const HEARTHROCK_BUILD = buildProject(
  ["classic_hearthrock_city", "classic_route_1"],
  G6_IMPORT_OPTIONS,
);
const SURF_MAP_IDS = [
  "classic_route_3",
  "classic_route_4",
  "classic_stormpeak_city",
  "spyder_candy_port",
  "spyder_candy_town",
  "spyder_paper_town",
  "spyder_routec",
] as const;
const SURF_BUILD = buildProject([...SURF_MAP_IDS], G6_IMPORT_OPTIONS);
const SURF_LABELS = importTerrainSurfaceLabels([...SURF_MAP_IDS]);
const EXPECTED_SURF_PORTALS: Array<[string, number]> = [
  ["classic_route_3:tmx:classic_route_3.tmx:285:a0", 8],
  ["classic_route_4:tmx:classic_route_4.tmx:285:a0", 7],
  ["classic_route_4:tmx:classic_route_4.tmx:286:a0", 8],
  ["classic_stormpeak_city:tmx:classic_stormpeak_city.tmx:290:a0", 7],
  ["spyder_candy_town:tmx:spyder_candy_town.tmx:100:a0", 8],
  ["spyder_paper_town:tmx:spyder_paper_town.tmx:217:a0", 4],
  ["spyder_routec:tmx:spyder_routec.tmx:155:a0", 8],
  ["spyder_routec:tmx:spyder_routec.tmx:156:a0", 4],
  ["spyder_routec:tmx:spyder_routec.tmx:275:a0", 8],
] as const;

const SURF_DIRECTIONS = {
  north: { dir: "up", button: BTN_BITS.UP, facing: 2, dx: 0, dy: -1 },
  east: { dir: "right", button: BTN_BITS.RIGHT, facing: 3, dx: 1, dy: 0 },
  south: { dir: "down", button: BTN_BITS.DOWN, facing: 0, dx: 0, dy: 1 },
  west: { dir: "left", button: BTN_BITS.LEFT, facing: 1, dx: -1, dy: 0 },
} as const;

function surfState(state: SessionState, mapId: string): SessionState {
  const tileProperties = Object.fromEntries(
    (SURF_LABELS[mapId]?.surfable ?? []).map((index) => [String(index), { passage: "pass" as const }]),
  );
  const sw = {
    ...state.sw,
    variables: { ...state.sw.variables, "v.swimming": 2 },
    playerAppearance: { sprite: "swimmer" },
  };
  return {
    ...state,
    sw,
    // SessionState.sw aliases the interpreter switch bank. Preserve that
    // invariant when seeding the exact steady state produced by Allow Swim.
    interp: { ...state.interp, sw, tileProperties },
  };
}

function withPreviewFixtures(project: Project): Project {
  const actor = (id: string, x: number, y: number, sprite: string): GameEvent => ({
    id,
    x,
    y,
    pages: [{ trigger: "action", sprite, blocks: false, moveType: "static", commands: [] }],
  });
  return {
    ...project,
    maps: project.maps.map((map) => map.id === "spyder_routec"
      ? { ...map, events: [...(map.events ?? []), actor("fixture_source_npc", 2, 8, "fixture.source")] }
      : map.id === "spyder_candy_town"
        ? { ...map, events: [...(map.events ?? []), actor("fixture_target_npc", 38, 28, "fixture.target")] }
        : map),
  };
}

describe("new seamless outdoor promotions", () => {
  test("Route 3's five repaired bottom-facing exits walk down through phases 0..7", () => {
    for (const [offset, x] of [30, 31, 32, 33, 34].entries()) {
      const project = projectAt(ROUTE3_BUILD.project, "route3", x, 38, "down");
      const started = startSettled(project);
      const onset = approach(started.session, started.state, BTN_BITS.DOWN);

      expect(onset.fade, `Route 3 x=${x}`).toBeNull();
      expect(onset.handoff, `Route 3 x=${x}`).toMatchObject({
        portalId: `route3:tmx:route3.tmx:${153 + offset}:a0`,
        sourceMapId: "route3",
        targetMapId: "leather_town",
        sourceX: x,
        sourceY: 39,
        targetX: x,
        targetY: 0,
        direction: 0,
        phase: 0,
        totalTicks: 8,
      });

      const landed = finishHandoff(started.session, onset);
      expect(landed.phases, `Route 3 x=${x}`).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect([landed.state.mapId, landed.state.move.tx, landed.state.move.ty], `Route 3 x=${x}`)
        .toEqual(["leather_town", x, 0]);
      expect(landed.state.move.facing, `Route 3 x=${x}`).toBe(0);
      expect(landed.state.leftMap?.mapId, `Route 3 x=${x}`).toBe("route3");
    }
  });

  test("every lane of a wide fixed-destination portal crosses onto its own continuous cell", () => {
    // The authored three-cell opening funnels y=16..18 to the fixed landing
    // y=17. The maps sit edge to edge and every lane passes the terrain
    // proof, so each lane now crosses to the neighbour cell beside it.
    for (const y of [16, 17, 18]) {
      const project = projectAt(AEROLUME_BUILD.project, "classic_aerolume_city", 1, y, "left");
      const started = startSettled(project);
      const onset = approach(started.session, started.state, BTN_BITS.LEFT);
      expect(onset.fade, `Aerolume y=${y}`).toBeNull();
      expect(onset.handoff, `Aerolume y=${y}`).toMatchObject({
        portalId: "classic_aerolume_city:tmx:classic_aerolume_city.tmx:286:a0",
        sourceMapId: "classic_aerolume_city",
        targetMapId: "classic_route_5",
        sourceX: 0,
        sourceY: y,
        targetX: 39,
        targetY: y,
        direction: 1,
        phase: 0,
        totalTicks: 8,
      });
      const landed = finishHandoff(started.session, onset);
      expect(landed.phases, `Aerolume y=${y}`).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect([landed.state.mapId, landed.state.move.tx, landed.state.move.ty], `Aerolume y=${y}`)
        .toEqual(["classic_route_5", 39, y]);
      expect(landed.state.move.facing, `Aerolume y=${y}`).toBe(1);
      expect(landed.state.leftMap?.mapId, `Aerolume y=${y}`).toBe("classic_aerolume_city");
    }
  });

  test("a vertical funnel lane crosses north without a fade", () => {
    for (const x of [32, 34]) {
      const project = projectAt(HEARTHROCK_BUILD.project, "classic_hearthrock_city", x, 1, "up");
      const started = startSettled(project);
      const onset = approach(started.session, started.state, BTN_BITS.UP);
      expect(onset.fade, `Hearthrock x=${x}`).toBeNull();
      expect(onset.handoff, `Hearthrock x=${x}`).toMatchObject({
        portalId: "classic_hearthrock_city:tmx:classic_hearthrock_city.tmx:300:a0",
        sourceX: x,
        sourceY: 0,
        targetMapId: "classic_route_1",
        targetX: x,
        targetY: 19,
        direction: 2,
      });
      const landed = finishHandoff(started.session, onset);
      expect(landed.phases, `Hearthrock x=${x}`).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect([landed.state.mapId, landed.state.move.tx, landed.state.move.ty], `Hearthrock x=${x}`)
        .toEqual(["classic_route_1", x, 19]);
    }
  });

  test("all 62 lanes of the nine Surf openings cross atomically only while swimming", () => {
    const promotions = SURF_BUILD.report.seamlessHandoff.partialPromotions
      .filter((promotion) => promotion.movementCapability === "surf");
    expect(promotions.map((promotion) => [promotion.portalId, promotion.lanes.length]))
      .toEqual(EXPECTED_SURF_PORTALS);
    expect(promotions.reduce((sum, promotion) => sum + promotion.lanes.length, 0)).toBe(62);

    const openings = new Map(SURF_BUILD.project.worldLayout!.components.flatMap((component) =>
      component.openings.map((opening) => [opening.portalId, opening] as const)
    ));
    for (const promotion of promotions) {
      const opening = openings.get(promotion.portalId)!;
      expect(opening.movementCapability, promotion.portalId).toBe("surf");
      const travel = SURF_DIRECTIONS[opening.source.side];
      const representative = promotion.lanes[Math.floor(promotion.lanes.length / 2)]!;

      // Without the imported swimming state, the capability must never create
      // an atomic walk. Compare every frame with the legacy traversal: Spyder
      // water remains solid, while Classic retains its authored fade behavior.
      const dryProject = projectAt(
        SURF_BUILD.project,
        promotion.sourceMap,
        representative.source.x - travel.dx,
        representative.source.y - travel.dy,
        travel.dir,
      );
      const dry = startSettled(dryProject);
      const legacySession = createSession(
        dryProject,
        60,
        createTuxemonSessionOptions(dryProject, "legacy-transfer"),
      );
      let legacy = startSession(dryProject, legacySession);
      for (let frame = 0; frame < 120; frame++) legacy = stepSession(legacySession, legacy, IDLE);
      let blocked = dry.state;
      for (let frame = 0; frame < 60; frame++) {
        blocked = stepSession(dry.session, blocked, { buttons: travel.button });
        legacy = stepSession(legacySession, legacy, { buttons: travel.button });
        expect(blocked.handoff, `${promotion.portalId} dry`).toBeUndefined();
        expect(canonicalJson(blocked), `${promotion.portalId} dry frame ${frame}`)
          .toBe(canonicalJson(legacy));
      }

      for (const lane of promotion.lanes) {
        const project = projectAt(
          SURF_BUILD.project,
          promotion.sourceMap,
          lane.source.x - travel.dx,
          lane.source.y - travel.dy,
          travel.dir,
        );
        const started = startSettled(project);
        const swimming = surfState(started.state, promotion.sourceMap);
        const onset = approach(started.session, swimming, travel.button);
        expect(onset.fade, `${promotion.portalId}@${lane.source.x},${lane.source.y}`).toBeNull();
        expect(onset.handoff, `${promotion.portalId}@${lane.source.x},${lane.source.y}`).toMatchObject({
          portalId: promotion.portalId,
          sourceMapId: promotion.sourceMap,
          targetMapId: promotion.targetMap,
          sourceX: lane.source.x,
          sourceY: lane.source.y,
          targetX: lane.target.x,
          targetY: lane.target.y,
          direction: travel.facing,
          phase: 0,
          totalTicks: 8,
        });
        const landed = finishHandoff(started.session, onset);
        expect(landed.phases, `${promotion.portalId}@${lane.source.x},${lane.source.y}`)
          .toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect([landed.state.mapId, landed.state.move.tx, landed.state.move.ty])
          .toEqual([promotion.targetMap, lane.target.x, lane.target.y]);
        expect(landed.state.leftMap?.mapId).toBe(promotion.sourceMap);
      }
    }
  });

  test("promoted crossings restore before and after the atomic map change", () => {
    const project = projectAt(
      AEROLUME_BUILD.project,
      "classic_aerolume_city",
      1,
      17,
      "left",
    );
    const baseline = startSettled(project);
    const beforeSnapshot = createSessionSnapshot(baseline.session, baseline.state, 0);
    const resumedSession = createSession(project, 60, createTuxemonSessionOptions(project));
    const resumedBefore = restoreSessionSnapshot(resumedSession, beforeSnapshot);
    expect(canonicalJson(resumedBefore)).toBe(canonicalJson(baseline.state));

    const baselineLanded = finishHandoff(
      baseline.session,
      approach(baseline.session, baseline.state, BTN_BITS.LEFT),
    ).state;
    const resumedLanded = finishHandoff(
      resumedSession,
      approach(resumedSession, resumedBefore, BTN_BITS.LEFT),
    ).state;
    expect(canonicalJson(resumedLanded)).toBe(canonicalJson(baselineLanded));

    let settled = baselineLanded;
    for (let frame = 0; frame < 30; frame++) settled = stepSession(baseline.session, settled, IDLE);
    const afterSnapshot = createSessionSnapshot(baseline.session, settled, 0);
    const afterSession = createSession(project, 60, createTuxemonSessionOptions(project));
    const restoredAfter = restoreSessionSnapshot(afterSession, afterSnapshot);
    expect(restoredAfter.leftMap).toEqual(settled.leftMap);
    expect(canonicalJson(normalizeHostFrame(restoredAfter, settled))).toBe(canonicalJson(settled));
  });

  test("a Surf seam previews the target and freezes source NPCs at commit", () => {
    const project = projectAt(
      withPreviewFixtures(SURF_BUILD.project),
      "spyder_routec",
      1,
      8,
      "left",
    );
    const started = startSettled(project);
    const swimming = surfState(started.state, "spyder_routec");
    const reader = createSandboxPreviewReader(started.session, TUXEMON_PREVIEW_HOOKS);
    const target = started.session.maps.get("spyder_candy_town")!;
    reader.observe(swimming);
    reader.read(target);
    for (let guard = 0; reader.stats.pending > 0; guard++) {
      if (guard > 1_000) throw new Error("world seam promotion: preview did not settle");
      reader.pump();
    }
    const preview = reader.read(target)!;
    expect(preview.rejected).toEqual([]);
    expect(preview.actors.map((actor) => actor.eventId)).toContain("fixture_target_npc");

    const onset = approach(started.session, swimming, BTN_BITS.LEFT);
    expect(onset.handoff).toMatchObject({
      portalId: "spyder_routec:tmx:spyder_routec.tmx:155:a0",
      sourceX: 0,
      sourceY: 8,
      targetX: 39,
      targetY: 28,
      totalTicks: 8,
    });
    let phase7 = onset;
    while (phase7.handoff?.phase !== 7) phase7 = stepSession(started.session, phase7, IDLE);
    const liveAtPhase7 = new Map(
      sandboxActors(started.session, phase7).map((actor) => [actor.eventId, actor] as const),
    );
    const committed = stepSession(started.session, phase7, IDLE);
    expect(committed.mapId).toBe("spyder_candy_town");
    expect(committed.leftMap?.mapId).toBe("spyder_routec");
    expect(committed.leftMap?.actors.map((actor) => actor.eventId)).toContain("fixture_source_npc");
    for (const actor of committed.leftMap!.actors) {
      const before = liveAtPhase7.get(actor.eventId);
      expect(before, actor.eventId).toBeDefined();
      expect(Math.max(Math.abs(actor.px - before!.px), Math.abs(actor.py - before!.py)), actor.eventId)
        .toBeLessThanOrEqual(2);
    }

    const frozen = canonicalJson(committed.leftMap);
    let after = stepSession(started.session, committed, IDLE);
    expect(sandboxActors(started.session, after)).toEqual([...preview.actors]);
    for (let frame = 0; frame < 29; frame++) after = stepSession(started.session, after, IDLE);
    expect(canonicalJson(after.leftMap)).toBe(frozen);
  });

  test("the areas=false importer profile keeps the same lane policy", () => {
    const expanded = buildProject(
      ["classic_aerolume_city", "classic_route_5"],
      { ...G6_IMPORT_OPTIONS, areas: false },
    );
    expect(expanded.report.seamlessHandoff.partialPromotions).toContainEqual({
      portalId: "classic_aerolume_city:tmx:classic_aerolume_city.tmx:286:a0",
      sourceMap: "classic_aerolume_city",
      source: { x: 0, y: 17 },
      targetMap: "classic_route_5",
      target: { x: 39, y: 17 },
      reason: "fixed-destination-continuous-lanes",
      lanes: [16, 17, 18].map((y) => ({
        source: { x: 0, y },
        target: { x: 39, y },
        authored: y === 17,
      })),
      legacyLanes: [],
      sourceCells: 3,
      legacyCells: 0,
    });
    for (const build of [expanded, AEROLUME_BUILD]) {
      const source = build.project.maps.find((map) => map.id === "classic_aerolume_city")!;
      const lanes = (source.events ?? [])
        .filter((event) => event.id.startsWith("e005_teleport_to_route5_"))
        .map((event) => {
          const transfer = event.pages[0]!.commands.find((command) => command.op === "transfer");
          return [event.x, event.y, event.w ?? 1, event.h ?? 1, transfer && "y" in transfer ? transfer.y : null];
        });
      expect(lanes).toEqual([[0, 16, 1, 1, 16], [0, 17, 1, 1, 17], [0, 18, 1, 1, 18]]);
    }
  });
});

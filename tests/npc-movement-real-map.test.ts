import { expect, test } from "bun:test";

import { TUXEMON_BATTLE_RULES, TUXEMON_EXTENSIONS, TUXEMON_SCENES } from "../battle/game.ts";
import { buildProject, G6_IMPORT_OPTIONS } from "../importer/project.ts";
import { applyTerrain, importTerrain } from "../importer/terrain.ts";
import { AttractController } from "../vendor/pocket-rpgkit/src/engine/attract.ts";
import { BTN_BITS } from "../vendor/pocket-rpgkit/src/engine/camera.ts";
import {
  canonicalJson,
  createSessionSnapshot,
  decodeEnvelopeText,
  encodeEnvelope,
} from "../vendor/pocket-rpgkit/src/engine/save.ts";
import { restoreSessionSnapshot } from "../vendor/pocket-rpgkit/src/engine/save-restore.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { GameEvent, Project } from "../vendor/pocket-rpgkit/src/engine/types.ts";

const BTN_L = 0x0100;
const BTN_CONFIRM = 0x2000;
const OPTIONS = {
  extensions: TUXEMON_EXTENSIONS,
  battle: TUXEMON_BATTLE_RULES,
  scenes: TUXEMON_SCENES,
} as const;

function realProject(mapId: string, keep?: (event: GameEvent) => boolean): Project {
  const built = buildProject([mapId], G6_IMPORT_OPTIONS);
  const project = applyTerrain(built.project, importTerrain({ mapIds: [mapId] }).fragment);
  if (keep) project.maps[0]!.events = project.maps[0]!.events?.filter(keep);
  return project;
}

function foldReferenceTicks(
  session: Session,
  state: SessionState,
  ticks: number,
  buttons = 0,
): SessionState {
  if (ticks % session.ticksPerFrame !== 0) throw new Error("reference ticks must fill host frames");
  let next = state;
  for (let frame = 0; frame < ticks / session.ticksPerFrame; frame++) {
    next = stepSession(session, next, { buttons });
  }
  return next;
}

function movementProjection(state: SessionState): unknown {
  return {
    move: state.move,
    chars: state.chars,
    rng: state.sw.rng,
    controls: state.interp.moveControls,
    variables: state.sw.variables,
    switches: state.sw.switches,
  };
}

test("real mansion moving guard is map-wide, multi-Hz, saveable, and rewindable", () => {
  const project = realProject("spyder_mansion_top", (event) => event.name === "Encounters");
  project.start = { map: "spyder_mansion_top", x: 1, y: 1, dir: "down" };
  const encounter = project.maps[0]!.events?.find((event) => event.name === "Encounters")!;
  expect(encounter).toMatchObject({ x: 4, y: 0 });
  expect(encounter.pages[0]?.trigger).toBe("parallel");
  expect(JSON.stringify(encounter)).toContain('"kind":"playerMoving"');

  const projections = ([60, 30, 20] as const).map((hz) => {
    const session = createSession(project, hz, OPTIONS);
    let state = startSession(project, session);
    const initialRng = state.sw.rng;
    state = foldReferenceTicks(session, state, 6, BTN_BITS.DOWN);
    // The source marker is (4,0), yet movement at (1,1) repeatedly evaluates
    // the 0.3 encounter roll. The first key press itself remains false.
    expect(state.move.moving).toBeTrue();
    expect(state.sw.rng).not.toBe(initialRng);

    // Formal saves are tile-boundary only. Release input and settle to the
    // common 12-reference-tick boundary before taking the snapshot.
    state = foldReferenceTicks(session, state, 6);
    expect(state.move.moving).toBeFalse();
    const snapshot = decodeEnvelopeText(encodeEnvelope(createSessionSnapshot(session, state, 0)));
    const restored = restoreSessionSnapshot(session, snapshot);
    const direct = foldReferenceTicks(session, state, 18, BTN_BITS.DOWN);
    const replay = foldReferenceTicks(session, restored, 18, BTN_BITS.DOWN);
    expect(replay.interp.frame).toBe(direct.interp.frame);
    expect(movementProjection(replay)).toEqual(movementProjection(direct));
    return movementProjection(direct);
  });
  expect(projections[1]).toEqual(projections[0]);
  expect(projections[2]).toEqual(projections[0]);

  const tape = new Array<number>(90).fill(BTN_BITS.DOWN);
  const rewind = { hz: 60, tapeHz: 60, rewindSeconds: 0.5, keyframeIntervalFrames: 11,
    idleFrames: 60_000, endHoldFrames: 60_000, ...OPTIONS } as const;
  const keyed = new AttractController(project, tape, rewind);
  const fromZero = new AttractController(project, tape, { ...rewind, keyframeMaxBytes: 0 });
  keyed.startAttract();
  fromZero.startAttract();
  for (let frame = 0; frame < 70; frame++) {
    keyed.step(0);
    fromZero.step(0);
  }
  keyed.step(BTN_L);
  fromZero.step(BTN_L);
  expect(canonicalJson(keyed.state)).toBe(canonicalJson(fromZero.state));
  expect(keyed.keyframeStats().lastRefoldStart).toBeGreaterThan(0);
});

test("real Route 1 char_stop lands safely at every Hz and replays through save/rewind", () => {
  const project = realProject("route1", (event) => event.id === "e045_hey_r013");
  project.start = { map: "route1", x: 23, y: 30, dir: "right" };
  const stopEvent = project.maps[0]!.events?.[0]!;
  expect(JSON.stringify(stopEvent)).toContain('"kind":"stop"');

  const projections = ([60, 30, 20] as const).map((hz) => {
    const session = createSession(project, hz, OPTIONS);
    const state = startSession(project, session);
    const restored = restoreSessionSnapshot(
      session,
      decodeEnvelopeText(encodeEnvelope(createSessionSnapshot(session, state, 0))),
    );
    const direct = foldReferenceTicks(session, state, 12, BTN_BITS.RIGHT);
    const replay = foldReferenceTicks(session, restored, 12, BTN_BITS.RIGHT);
    expect(canonicalJson(replay)).toBe(canonicalJson(direct));
    expect(direct.move).toMatchObject({ tx: 24, ty: 30, moving: false });
    expect(direct.interp.moveControls?.player.routeStopped).toBeTrue();
    expect(direct.interp.modal?.kind).toBe("text");
    return movementProjection(direct);
  });
  expect(projections[1]).toEqual(projections[0]);
  expect(projections[2]).toEqual(projections[0]);

  const options = { hz: 60, attractEnabled: false, rewindSeconds: 12 / 60,
    keyframeIntervalFrames: 4, idleFrames: 60_000, ...OPTIONS } as const;
  const rewind = new AttractController(project, [], options);
  for (let frame = 0; frame < 12; frame++) rewind.step(BTN_BITS.RIGHT);
  const stopped = canonicalJson(rewind.state);
  expect(rewind.state.interp.moveControls?.player.routeStopped).toBeTrue();
  rewind.step(BTN_L);
  expect(rewind.length).toBe(0);
  for (let frame = 0; frame < 12; frame++) rewind.step(BTN_BITS.RIGHT);
  expect(canonicalJson(rewind.state)).toBe(stopped);
});

test("real museum wander uses its 48-tick cadence at every Hz and across save/rewind", () => {
  const keep = new Set(["e003_create_historian", "npc_spyder_leathermuseum_historian"]);
  const project = realProject("spyder_leather_museum", (event) => keep.has(event.id));
  project.start = { map: "spyder_leather_museum", x: 1, y: 8, dir: "down" };
  const spawn = project.maps[0]!.events?.find((event) => event.id === "e003_create_historian")!;
  expect(JSON.stringify(spawn)).toContain('"kind":"wander","intervalTicks":48');

  const projections = ([60, 30, 20] as const).map((hz) => {
    const session = createSession(project, hz, OPTIONS);
    let state = startSession(project, session);
    state = foldReferenceTicks(session, state, 30);
    const historian = state.chars.chars.npc_spyder_leathermuseum_historian!;
    expect(historian.thinkIn).toBe(20);
    const restored = restoreSessionSnapshot(
      session,
      decodeEnvelopeText(encodeEnvelope(createSessionSnapshot(session, state, 0))),
    );
    const direct = foldReferenceTicks(session, state, 90);
    const replay = foldReferenceTicks(session, restored, 90);
    expect(movementProjection(replay)).toEqual(movementProjection(direct));
    return movementProjection(direct);
  });
  expect(projections[1]).toEqual(projections[0]);
  expect(projections[2]).toEqual(projections[0]);

  const tape = new Array<number>(180).fill(0);
  const rewind = { hz: 60, tapeHz: 60, rewindSeconds: 0.5, keyframeIntervalFrames: 17,
    idleFrames: 60_000, endHoldFrames: 60_000, ...OPTIONS } as const;
  const keyed = new AttractController(project, tape, rewind);
  const fromZero = new AttractController(project, tape, { ...rewind, keyframeMaxBytes: 0 });
  keyed.startAttract();
  fromZero.startAttract();
  for (let frame = 0; frame < 140; frame++) {
    keyed.step(0);
    fromZero.step(0);
  }
  keyed.step(BTN_L);
  fromZero.step(BTN_L);
  expect(canonicalJson(keyed.state)).toBe(canonicalJson(fromZero.state));
  expect(keyed.state.interp.moveControls?.events.npc_spyder_leathermuseum_historian?.wanderIntervalTicks)
    .toBe(48);
});

test("real Taba speed and facing lock are route-scoped and multi-Hz/save stable", () => {
  const speedKeep = new Set(["e032_listentime2", "npc_allie", "npc_knight4", "npc_knight3"]);
  const speedProject = realProject("taba_town", (event) => speedKeep.has(event.id));
  speedProject.start = { map: "taba_town", x: 36, y: 47, dir: "up" };
  const facingKeep = new Set(["e033_listentime3", "npc_allie", "npc_callie_wren", "npc_knight3"]);
  const facingProject = realProject("taba_town", (event) => facingKeep.has(event.id));
  facingProject.start = { map: "taba_town", x: 36, y: 47, dir: "up" };
  const nodes = JSON.stringify([
    ...(speedProject.maps[0]!.events ?? []),
    ...(facingProject.maps[0]!.events ?? []),
  ]);
  expect(nodes).toContain('"kind":"routeSpeed","value":5');
  expect(nodes).toContain('"kind":"facingMode","value":"locked"');

  const speedProjections = ([60, 30, 20] as const).map((hz) => {
    const session = createSession(speedProject, hz, OPTIONS);
    let state = startSession(speedProject, session);
    state.sw.variables["local.npc.allie"] = 1;
    state.sw.variables["local.npc.knight4"] = 1;
    state.sw.variables["v.goodbyeoldknight"] = 9;
    let sawRouteSpeed = false;
    for (let guard = 0; guard < 3_000 && state.sw.variables["v.goodbyeoldknight"] !== 8; guard++) {
      const modal = state.interp.modal;
      state = stepSession(session, state, {
        buttons: 0,
        confirmEdge: modal?.kind === "text" && modal.complete,
      });
      if (state.chars.chars.npc_allie?.route?.speed === 5) sawRouteSpeed = true;
    }
    expect(sawRouteSpeed).toBeTrue();
    expect(state.sw.variables["v.goodbyeoldknight"]).toBe(8);
    state = foldReferenceTicks(session, state, 12);
    const restored = restoreSessionSnapshot(
      session,
      decodeEnvelopeText(encodeEnvelope(createSessionSnapshot(session, state, 0))),
    );
    const direct = foldReferenceTicks(session, state, 12);
    const replay = foldReferenceTicks(session, restored, 12);
    expect(movementProjection(replay)).toEqual(movementProjection(direct));
    return movementProjection(direct);
  });
  expect(speedProjections[1]).toEqual(speedProjections[0]);
  expect(speedProjections[2]).toEqual(speedProjections[0]);

  const facingProjections = ([60, 30, 20] as const).map((hz) => {
    const session = createSession(facingProject, hz, OPTIONS);
    let state = startSession(facingProject, session);
    state.sw.variables["local.npc.allie"] = 1;
    state.sw.variables["local.npc.callie_wren"] = 1;
    state.sw.variables["v.goodbyeoldknight"] = 8;
    let sawLockedMotion = false;
    for (let guard = 0; guard < 3_000 && state.sw.variables["v.goodbyeoldknight"] !== 5; guard++) {
      const modal = state.interp.modal;
      state = stepSession(session, state, {
        buttons: 0,
        confirmEdge: modal?.kind === "text" && modal.complete,
      });
      const callie = state.chars.chars.npc_callie_wren;
      if (callie?.moving && state.interp.moveControls?.events.npc_callie_wren?.facingMode === "locked") {
        sawLockedMotion = true;
        expect(callie.facing).toBe(1); // keeps facing left while moving down
      }
    }
    expect(sawLockedMotion).toBeTrue();
    expect(state.chars.chars.npc_callie_wren).toMatchObject({ tx: 38, ty: 47, facing: 2 });
    expect(state.interp.moveControls?.events.npc_callie_wren?.facingMode).toBe("followMovement");
    state = foldReferenceTicks(session, state, 12);
    const restored = restoreSessionSnapshot(
      session,
      decodeEnvelopeText(encodeEnvelope(createSessionSnapshot(session, state, 0))),
    );
    expect(movementProjection(restored)).toEqual(movementProjection(state));
    return movementProjection(state);
  });
  expect(facingProjections[1]).toEqual(facingProjections[0]);
  expect(facingProjections[2]).toEqual(facingProjections[0]);

  // Rewind the real locked-facing cutscene across the one-tile locked move,
  // then replay the exact live suffix back to the same state.
  const prepSession = createSession(facingProject, 60, OPTIONS);
  let origin = startSession(facingProject, prepSession);
  origin.sw.variables["local.npc.allie"] = 1;
  origin.sw.variables["local.npc.callie_wren"] = 1;
  origin.sw.variables["v.goodbyeoldknight"] = 8;
  origin = restoreSessionSnapshot(
    prepSession,
    decodeEnvelopeText(encodeEnvelope(createSessionSnapshot(prepSession, origin, 0))),
  );
  const rewindOptions = { hz: 60, attractEnabled: false, rewindSeconds: 0.5,
    keyframeIntervalFrames: 17, idleFrames: 60_000, ...OPTIONS } as const;
  const keyed = new AttractController(facingProject, [], rewindOptions);
  const fromZero = new AttractController(facingProject, [], { ...rewindOptions, keyframeMaxBytes: 0 });
  keyed.loadState(origin, 0);
  fromZero.loadState(origin, 0);
  const masks: number[] = [];
  let previous = 0;
  let lockedAt = -1;
  for (let guard = 0; guard < 3_000; guard++) {
    const modal = keyed.state.interp.modal;
    const mask = modal?.kind === "text" && previous === 0 ? BTN_CONFIRM : 0;
    masks.push(mask);
    keyed.step(mask);
    fromZero.step(mask);
    previous = mask;
    if (keyed.state.chars.chars.npc_callie_wren?.moving &&
      keyed.state.interp.moveControls?.events.npc_callie_wren?.facingMode === "locked") {
      lockedAt = keyed.length;
    }
    if (lockedAt >= 0 && keyed.length >= lockedAt + 20) break;
  }
  expect(lockedAt).toBeGreaterThan(0);
  expect(canonicalJson(keyed.state)).toBe(canonicalJson(fromZero.state));
  const before = canonicalJson(keyed.state);
  const beforeLength = keyed.length;
  keyed.step(BTN_L);
  fromZero.step(BTN_L);
  expect(canonicalJson(keyed.state)).toBe(canonicalJson(fromZero.state));
  const target = keyed.length;
  expect(target).toBe(beforeLength - 30);
  for (const mask of masks.slice(target, beforeLength)) {
    keyed.step(mask);
    fromZero.step(mask);
  }
  expect(canonicalJson(keyed.state)).toBe(before);
  expect(canonicalJson(fromZero.state)).toBe(before);

  // Repeat the same rewind/refold check across Allie's imported route-speed
  // segment, so the degraded rate mapping still has real-map rewind proof.
  const speedPrep = createSession(speedProject, 60, OPTIONS);
  let speedOrigin = startSession(speedProject, speedPrep);
  speedOrigin.sw.variables["local.npc.allie"] = 1;
  speedOrigin.sw.variables["local.npc.knight4"] = 1;
  speedOrigin.sw.variables["v.goodbyeoldknight"] = 9;
  speedOrigin = restoreSessionSnapshot(
    speedPrep,
    decodeEnvelopeText(encodeEnvelope(createSessionSnapshot(speedPrep, speedOrigin, 0))),
  );
  const speedKeyed = new AttractController(speedProject, [], rewindOptions);
  const speedZero = new AttractController(speedProject, [], { ...rewindOptions, keyframeMaxBytes: 0 });
  speedKeyed.loadState(speedOrigin, 0);
  speedZero.loadState(speedOrigin, 0);
  const speedMasks: number[] = [];
  previous = 0;
  let speedAt = -1;
  for (let guard = 0; guard < 3_000; guard++) {
    const modal = speedKeyed.state.interp.modal;
    const mask = modal?.kind === "text" && previous === 0 ? BTN_CONFIRM : 0;
    speedMasks.push(mask);
    speedKeyed.step(mask);
    speedZero.step(mask);
    previous = mask;
    if (speedKeyed.state.chars.chars.npc_allie?.route?.speed === 5) speedAt = speedKeyed.length;
    if (speedAt >= 0 && speedKeyed.length >= speedAt + 20) break;
  }
  expect(speedAt).toBeGreaterThan(0);
  const speedBefore = canonicalJson(speedKeyed.state);
  const speedBeforeLength = speedKeyed.length;
  speedKeyed.step(BTN_L);
  speedZero.step(BTN_L);
  expect(canonicalJson(speedKeyed.state)).toBe(canonicalJson(speedZero.state));
  const speedTarget = speedKeyed.length;
  for (const mask of speedMasks.slice(speedTarget, speedBeforeLength)) {
    speedKeyed.step(mask);
    speedZero.step(mask);
  }
  expect(canonicalJson(speedKeyed.state)).toBe(speedBefore);
  expect(canonicalJson(speedZero.state)).toBe(speedBefore);
});

test("real beachcomber char_run is an idle no-op with no saved speed latch", () => {
  const keep = new Set(["e016_create_beachcomber", "npc_spyder_route1_bjorn"]);
  const project = realProject("spyder_route1", (event) => keep.has(event.id));
  project.start = { map: "spyder_route1", x: 13, y: 10, dir: "down" };
  const bjorn = project.maps[0]!.events?.find((event) => event.id === "npc_spyder_route1_bjorn")!;
  expect(bjorn.pages.some((page) => JSON.stringify(page.commands).includes("routeSpeed"))).toBeFalse();

  for (const hz of [60, 30, 20] as const) {
    const session = createSession(project, hz, OPTIONS);
    let state = startSession(project, session);
    state = foldReferenceTicks(session, state, 6);
    expect(state.chars.chars.npc_spyder_route1_bjorn).toBeDefined();
    state = stepSession(session, state, { buttons: 0, confirmEdge: true });
    for (let guard = 0; guard < 600; guard++) {
      const modal = state.interp.modal;
      state = stepSession(session, state, {
        buttons: 0,
        confirmEdge: modal?.kind === "text" && modal.complete,
      });
      if (!state.interp.main && !state.interp.modal) break;
    }
    expect(state.interp.main).toBeNull();
    expect(state.interp.moveControls?.events.npc_spyder_route1_bjorn?.routeSpeed).toBeUndefined();
    const restored = restoreSessionSnapshot(
      session,
      decodeEnvelopeText(encodeEnvelope(createSessionSnapshot(session, state, 0))),
    );
    expect(restored.interp.moveControls?.events.npc_spyder_route1_bjorn?.routeSpeed).toBeUndefined();
  }
});

test("real TV direct placement is exact at every Hz and survives save/replay", () => {
  const project = realProject("spyder_paper_rival_downstairs", (event) => event.id === "e010_tv_yes");
  // The importer-wide default start is blocked on this interior. The real
  // char_position destination is standable, so use it as the formal save and
  // rewind origin while retaining a different initial facing.
  project.start = { map: "spyder_paper_rival_downstairs", x: 6, y: 8, dir: "down" };
  const projections = ([60, 30, 20] as const).map((hz) => {
    const session = createSession(project, hz, OPTIONS);
    let state = startSession(project, session);
    state.sw.variables["v.billie_tv"] = 2;
    state = foldReferenceTicks(session, state, 6);
    expect(state.move).toMatchObject({ tx: 6, ty: 8, facing: 1, moving: false });
    const restored = restoreSessionSnapshot(
      session,
      decodeEnvelopeText(encodeEnvelope(createSessionSnapshot(session, state, 0))),
    );
    expect(movementProjection(restored)).toEqual(movementProjection(state));
    return movementProjection(state);
  });
  expect(projections[1]).toEqual(projections[0]);
  expect(projections[2]).toEqual(projections[0]);

  const prep = createSession(project, 60, OPTIONS);
  let origin = startSession(project, prep);
  origin.sw.variables["v.billie_tv"] = 2;
  origin = restoreSessionSnapshot(
    prep,
    decodeEnvelopeText(encodeEnvelope(createSessionSnapshot(prep, origin, 0))),
  );
  const rewind = new AttractController(project, [], {
    hz: 60,
    attractEnabled: false,
    rewindSeconds: 6 / 60,
    keyframeIntervalFrames: 2,
    idleFrames: 60_000,
    ...OPTIONS,
  });
  rewind.loadState(origin, 0);
  for (let frame = 0; frame < 6; frame++) rewind.step(0);
  const placed = canonicalJson(rewind.state);
  rewind.step(BTN_L);
  expect(rewind.length).toBe(0);
  for (let frame = 0; frame < 6; frame++) rewind.step(0);
  expect(canonicalJson(rewind.state)).toBe(placed);
});

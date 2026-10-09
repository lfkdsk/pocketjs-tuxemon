import { expect, test } from "bun:test";

import { TUXEMON_BATTLE_RULES, TUXEMON_EXTENSIONS, TUXEMON_SCENES } from "../battle/game.ts";
import { buildProject, G6_IMPORT_OPTIONS } from "../importer/project.ts";
import { applyTerrain, importTerrain } from "../importer/terrain.ts";
import { AttractController } from "../vendor/pocket-rpgkit/src/engine/attract.ts";
import { BTN_BITS } from "../vendor/pocket-rpgkit/src/engine/camera.ts";
import {
  canSave,
  canonicalJson,
  createAutosaveSessionSnapshot,
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

function assertExactTileCrossing(
  session: Session,
  initial: SessionState,
  actorId: string,
  rate: number,
  roundTrip: boolean,
): SessionState {
  let state = initial;
  const first = state.chars.chars[actorId]!;
  expect(first, `${actorId} must exist at ${rate} tiles/s`).toBeDefined();
  expect(first).toMatchObject({ phase: 1, moving: true, stepTilesPerSecond: rate });
  const originX = first.tx;
  const originY = first.ty;
  const dx = [0, -1, 0, 1][first.stepDir]!;
  const dy = [1, 0, -1, 0][first.stepDir]!;
  const frames = Math.ceil(60 / rate);
  const midpoint = Math.max(1, Math.floor(frames / 2));
  let replay: SessionState | null = null;

  for (let phase = 1; phase < frames; phase++) {
    const actor = state.chars.chars[actorId]!;
    expect(actor.phase, `${actorId} ${rate} tiles/s phase`).toBe(phase);
    expect(actor).toMatchObject({
      tx: originX,
      ty: originY,
      moving: true,
      stepTilesPerSecond: rate,
    });
    expect(actor.px).toBeCloseTo(originX * 16 + dx * phase * 16 * rate / 60, 10);
    expect(actor.py).toBeCloseTo(originY * 16 + dy * phase * 16 * rate / 60, 10);
    if (roundTrip && phase === midpoint) {
      const snapshot = createAutosaveSessionSnapshot(session, state, 0);
      expect(snapshot, `${actorId} phase ${phase} autosave`).not.toBeNull();
      replay = restoreSessionSnapshot(session, decodeEnvelopeText(encodeEnvelope(snapshot!)));
    }
    state = stepSession(session, state, { buttons: 0 });
    if (replay) replay = stepSession(session, replay, { buttons: 0 });
  }

  const landed = state.chars.chars[actorId]!;
  expect(landed, `${actorId} ${rate} tiles/s crossing tick`).toMatchObject({
    tx: originX + dx,
    ty: originY + dy,
    px: (originX + dx) * 16,
    py: (originY + dy) * 16,
    phase: 0,
    moving: false,
  });
  expect(landed.stepTilesPerSecond).toBeUndefined();
  if (replay) expect(movementProjection(replay)).toEqual(movementProjection(state));
  return state;
}

function driveToExactTile(
  project: Project,
  actorId: string,
  rate: number,
  prepare: (state: SessionState) => void,
  roundTrip = false,
): void {
  const session = createSession(project, 60, OPTIONS);
  let state = startSession(project, session);
  prepare(state);
  for (let guard = 0; guard < 20_000; guard++) {
    state = stepSession(session, state, { buttons: 0, confirmEdge: true });
    const actor = state.chars.chars[actorId];
    if (actor?.stepTilesPerSecond !== rate || actor.phase !== 1) continue;
    assertExactTileCrossing(session, state, actorId, rate, roundTrip);
    return;
  }
  throw new Error(`did not observe ${actorId} moving at ${rate} tiles/s on ${project.maps[0]!.id}`);
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
    const inFlight = foldReferenceTicks(session, state, session.ticksPerFrame, BTN_BITS.RIGHT);
    expect(inFlight.move.moving).toBeTrue();
    expect(inFlight.move.phase).toBeGreaterThan(0);
    expect(canSave(inFlight.move, inFlight.interp, inFlight.scene)).toBeFalse();
    const direct = foldReferenceTicks(
      session,
      inFlight,
      12 - session.ticksPerFrame,
      BTN_BITS.RIGHT,
    );
    const replay = foldReferenceTicks(session, restored, 12, BTN_BITS.RIGHT);
    expect(canonicalJson(replay)).toBe(canonicalJson(direct));
    expect(direct.move).toMatchObject({ tx: 24, ty: 30, moving: false });
    expect(direct.interp.moveControls?.player.routeStopped).toBeTrue();
    expect(direct.interp.modal?.kind).toBe("text");

    // A stop never snaps an already committed tile. Manual saving remains
    // refused while that tile, the warning, or its follow-up route owns the
    // player; the next resting tile is the first safe point.
    let settled = direct;
    for (let guard = 0; guard < 20 && !canSave(settled.move, settled.interp, settled.scene); guard++) {
      settled = stepSession(session, settled, {
        buttons: 0,
        confirmEdge: settled.interp.modal?.kind === "text",
      });
    }
    expect(settled.move).toMatchObject({ tx: 25, ty: 30, phase: 0, moving: false });
    expect(canSave(settled.move, settled.interp, settled.scene)).toBeTrue();
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

test("real Kay Wren char_speed keeps 7 tiles/s at every Hz and across save/rewind", () => {
  const keep = new Set(["e009_professor_pls2", "npc_kay_wren"]);
  const project = realProject("tuxe_mart_taba", (event) => keep.has(event.id));
  project.start = { map: "tuxe_mart_taba", x: 6, y: 7, dir: "down" };
  const cutscene = project.maps[0]!.events?.find((event) => event.id === "e009_professor_pls2")!;
  expect(JSON.stringify(cutscene)).toContain(
    '"kind":"routeSpeed","value":5,"tilesPerSecond":7',
  );

  // Trigger the real imported parallel event. Starting on its authored player
  // destination skips no event command; the variables only select this branch.
  const prepSession = createSession(project, 60, OPTIONS);
  let routeStart = startSession(project, prepSession);
  routeStart.sw.variables["local.npc.kay_wren"] = 1;
  routeStart.sw.variables["v.proftalk1"] = 2;
  for (let guard = 0; guard < 3_000; guard++) {
    const modal = routeStart.interp.modal;
    routeStart = stepSession(prepSession, routeStart, {
      buttons: 0,
      confirmEdge: modal?.kind === "text" && modal.complete,
    });
    const kay = routeStart.chars.chars.npc_kay_wren;
    if (kay?.route?.tilesPerSecond === 7 && kay.phase === 0) break;
  }
  expect(routeStart.chars.chars.npc_kay_wren?.route).toMatchObject({
    speed: 5,
    tilesPerSecond: 7,
  });
  const startAutosave = createAutosaveSessionSnapshot(prepSession, routeStart, 0);
  expect(startAutosave).not.toBeNull();
  const startSnapshot = decodeEnvelopeText(encodeEnvelope(startAutosave!));

  const projections = ([60, 30, 20] as const).map((hz) => {
    const session = createSession(project, hz, OPTIONS);
    let state = restoreSessionSnapshot(session, startSnapshot);
    let movingSamples = 0;
    for (let ticks = session.ticksPerFrame; ticks <= 12; ticks += session.ticksPerFrame) {
      state = stepSession(session, state, { buttons: 0 });
      const kay = state.chars.chars.npc_kay_wren!;
      if (!kay.moving) continue;
      movingSamples++;
      const dx = [0, -1, 0, 1][kay.stepDir]!;
      const dy = [1, 0, -1, 0][kay.stepDir]!;
      const distance = kay.phase * 16 * 7 / 60;
      expect(kay.px).toBeCloseTo(kay.tx * 16 + dx * distance, 10);
      expect(kay.py).toBeCloseTo(kay.ty * 16 + dy * distance, 10);
    }
    expect(movingSamples).toBeGreaterThan(0);
    expect(state.chars.chars.npc_kay_wren).toMatchObject({ phase: 3, moving: true });

    // Engine autosaves may retain an active waiting fiber and NPC mid-tile.
    // The fractional position and route rate must resume byte-identically.
    const midAutosave = createAutosaveSessionSnapshot(session, state, 0);
    expect(midAutosave).not.toBeNull();
    const midSnapshot = decodeEnvelopeText(encodeEnvelope(midAutosave!));
    const restored = restoreSessionSnapshot(session, midSnapshot);
    const direct = foldReferenceTicks(session, state, 60);
    const replay = foldReferenceTicks(session, restored, 60);
    expect(canonicalJson(replay)).toBe(canonicalJson(direct));
    expect(direct.chars.chars.npc_kay_wren).toMatchObject({
      tx: 6,
      ty: 10,
      px: 96,
      py: 160,
      phase: 0,
      moving: false,
      route: null,
    });
    return movementProjection(direct);
  });
  expect(projections[1]).toEqual(projections[0]);
  expect(projections[2]).toEqual(projections[0]);

  const rewindOptions = { hz: 60, attractEnabled: false, rewindSeconds: 0.5,
    keyframeIntervalFrames: 17, idleFrames: 60_000, ...OPTIONS } as const;
  const keyed = new AttractController(project, [], rewindOptions);
  const fromZero = new AttractController(project, [], { ...rewindOptions, keyframeMaxBytes: 0 });
  keyed.loadState(routeStart, 0);
  fromZero.loadState(routeStart, 0);
  for (let frame = 0; frame < 72; frame++) {
    keyed.step(0);
    fromZero.step(0);
  }
  const before = canonicalJson(keyed.state);
  expect(before).toBe(canonicalJson(fromZero.state));
  keyed.step(BTN_L);
  fromZero.step(BTN_L);
  expect(keyed.length).toBe(42);
  for (let frame = 0; frame < 30; frame++) {
    keyed.step(0);
    fromZero.step(0);
  }
  expect(canonicalJson(keyed.state)).toBe(before);
  expect(canonicalJson(fromZero.state)).toBe(before);
});

test("every imported char_speed rate with a following tile crosses on its exact reference tick", () => {
  const townMissingMale = realProject(
    "37707_town_missing",
    (event) => new Set(["e006_villager_male", "npc_37707_male_missing"]).has(event.id),
  );
  townMissingMale.start = { map: "37707_town_missing", x: 24, y: 6, dir: "down" };
  driveToExactTile(townMissingMale, "npc_37707_male_missing", 1, () => {}, true);

  const townMissingFemale = realProject(
    "37707_town_missing",
    (event) => new Set(["e007_villager_female", "npc_37707_female_missing"]).has(event.id),
  );
  townMissingFemale.start = { map: "37707_town_missing", x: 24, y: 6, dir: "down" };
  driveToExactTile(townMissingFemale, "npc_37707_female_missing", 5, () => {});

  const townMale = realProject(
    "37707_town",
    (event) => new Set(["e008_villager_male", "npc_37707_male"]).has(event.id),
  );
  townMale.start = { map: "37707_town", x: 24, y: 6, dir: "down" };
  driveToExactTile(townMale, "npc_37707_male", 3, () => {});

  const cotton = realProject("cotton_town", (event) => event.id === "npc_aeble");
  cotton.start = { map: "cotton_town", x: 13, y: 10, dir: "right" };
  expect(JSON.stringify(cotton.maps[0]!.events)).toContain('"tilesPerSecond":0.5');
  const cottonSession = createSession(cotton, 60, OPTIONS);
  let cottonState = startSession(cotton, cottonSession);
  cottonState.sw.variables["local.npc.aeble"] = 1;
  let sawHalfRateStep = false;
  for (let guard = 0; guard < 500 && cottonState.sw.variables["v.donewithyou"] !== 1; guard++) {
    cottonState = stepSession(cottonSession, cottonState, { buttons: 0, confirmEdge: true });
    if (cottonState.chars.chars.npc_aeble?.stepTilesPerSecond === 0.5) sawHalfRateStep = true;
  }
  // The real 0.5 use follows a ten-tile char_move that already ends at the
  // pathfind destination (22,10), so upstream and the import have no 0.5-tps
  // tile to time. The component rate table still exercises its 120-tick tile.
  expect(cottonState.sw.variables["v.donewithyou"]).toBe(1);
  expect(sawHalfRateStep).toBeFalse();

  const tabaBattleNine = realProject(
    "taba_ba_main",
    (event) => new Set([
      "e007_or_don_t_confront_it",
      "npc_christie",
      "npc_speck",
    ]).has(event.id),
  );
  tabaBattleNine.start = { map: "taba_ba_main", x: 5, y: 5, dir: "down" };
  driveToExactTile(tabaBattleNine, "npc_christie", 9, (state) => {
    state.sw.variables["local.npc.christie"] = 1;
    state.sw.variables["local.npc.speck"] = 1;
    state.sw.variables["v.fourthdialog"] = 1;
  });

  const tabaBattleSlow = realProject(
    "taba_ba_main",
    (event) => new Set([
      "e007_or_don_t_confront_it",
      "e008_oh_look_it_s_kyle",
      "npc_christie",
      "npc_speck",
    ]).has(event.id),
  );
  tabaBattleSlow.start = { map: "taba_ba_main", x: 5, y: 5, dir: "down" };
  driveToExactTile(tabaBattleSlow, "npc_speck", 3.75, (state) => {
    state.sw.variables["local.npc.christie"] = 1;
    state.sw.variables["local.npc.speck"] = 1;
    state.sw.variables["v.fourthdialog"] = 1;
  });

  const tabaTen = realProject(
    "taba_town",
    (event) => new Set([
      "e032_listentime2",
      "npc_allie",
      "npc_knight3",
      "npc_knight4",
    ]).has(event.id),
  );
  tabaTen.start = { map: "taba_town", x: 36, y: 47, dir: "up" };
  driveToExactTile(tabaTen, "npc_allie", 10, (state) => {
    state.sw.variables["local.npc.allie"] = 1;
    state.sw.variables["local.npc.knight4"] = 1;
    state.sw.variables["v.goodbyeoldknight"] = 9;
  }, true);

  const tabaEight = structuredClone(tabaTen);
  driveToExactTile(tabaEight, "npc_knight4", 8, (state) => {
    state.sw.variables["local.npc.allie"] = 1;
    state.sw.variables["local.npc.knight4"] = 1;
    state.sw.variables["v.goodbyeoldknight"] = 9;
  });

  const tabaSlow = realProject(
    "taba_town",
    (event) => new Set(["e034_listentime4", "npc_allie"]).has(event.id),
  );
  tabaSlow.start = { map: "taba_town", x: 36, y: 47, dir: "up" };
  driveToExactTile(tabaSlow, "npc_allie", 1.5, (state) => {
    state.sw.variables["local.npc.allie"] = 1;
    state.sw.variables["v.goodbyeoldknight"] = 5;
  });

  const mart = realProject(
    "tuxe_mart_taba",
    (event) => new Set(["e009_professor_pls2", "npc_kay_wren"]).has(event.id),
  );
  mart.start = { map: "tuxe_mart_taba", x: 6, y: 7, dir: "down" };
  driveToExactTile(mart, "npc_kay_wren", 7, (state) => {
    state.sw.variables["local.npc.kay_wren"] = 1;
    state.sw.variables["v.proftalk1"] = 2;
  });
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

  // Repeat the same rewind/refold check across Allie's imported exact-speed
  // segment, so another real cutscene covers the route-scoped lifetime.
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

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createJsonMapRepository,
  mapManifestHash,
} from "../vendor/pocket-rpgkit/src/engine/map-repository.ts";
import {
  createSession,
  releaseSessionMapsExcept,
  startSession,
  stepSession,
  type SessionInput,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import {
  canonicalJson,
  createSessionSnapshot,
  decodeEnvelopeText,
  encodeEnvelope,
} from "../vendor/pocket-rpgkit/src/engine/save.ts";
import {
  restoreSessionEnvelope,
  restoreSessionSnapshot,
} from "../vendor/pocket-rpgkit/src/engine/save-restore.ts";
import { AttractController } from "../vendor/pocket-rpgkit/src/engine/attract.ts";
import { followCamera } from "../vendor/pocket-rpgkit/src/engine/camera.ts";
import type { CameraState, ProjectShell } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { readInlineProject, readShardedProject } from "../tools/generated-project.ts";
import {
  createTuxemonSessionOptions,
  TUXEMON_BATTLE_RULES,
  TUXEMON_EXTENSIONS,
  TUXEMON_SCENES,
} from "../battle/game.ts";
import { journeyWorldTraversal } from "../tools/gb6-journey.ts";
import {
  restoreSave,
  saveBlockReason,
  takeSaveSnapshot,
} from "../ui/save-game.ts";
import {
  createGameWorldCacheDriver,
  GAME_WORLD_ENTRY_SETTLE_FRAMES,
} from "../ui/game-world-cache-driver.ts";

const ROOT = resolve(import.meta.dir, "..");
const journey = JSON.parse(readFileSync(join(ROOT, "data/g6-journey.json"), "utf8")) as {
  worldTraversal?: unknown;
  masks: number[];
  checkpoints: Array<{ name: string; frame: number }>;
  terminalStateSha256: string;
};
const worldTraversal = journeyWorldTraversal(journey, "G7 maintained journey");
const GAME_OPTIONS = { extensions: TUXEMON_EXTENSIONS, battle: TUXEMON_BATTLE_RULES, scenes: TUXEMON_SCENES } as const;
// Terminal state after the legacy timeline: the cathedral bill now carries
// its authored interest/late-fee/share metadata, so the state hash changed
// (the story terminal — spyder_route1@14,19 — is unchanged).
const LEGACY_TERMINAL_STATE_SHA256 = "5173f27c8f63e360cfce26f1fd865fb29ca2ae919857e864df934ee883478781";
const BEFORE_HANDOFF_FRAME = 3_964;
const MID_HANDOFF_FRAME = 3_978;
const AFTER_HANDOFF_FRAME = 3_982;
const BTN_LTRIGGER = 0x0100;
const VIEWPORT = { w: 480, h: 272 } as const;

function input(mask: number, previous: number): SessionInput {
  const pressed = mask & ~previous;
  return {
    buttons: mask,
    confirmEdge: !!(pressed & 0x2000),
    cancelEdge: !!(pressed & 0x4000),
    upEdge: !!(pressed & 0x0010),
    downEdge: !!(pressed & 0x0040),
    leftEdge: !!(pressed & 0x0080),
    rightEdge: !!(pressed & 0x0020),
  };
}

function createProductionCacheSync(
  session: ReturnType<typeof createSession>,
  project: ProjectShell,
): (state: Readonly<SessionState>) => void {
  const layout = project.worldLayout;
  if (!layout) throw new Error("G7 repository: generated project has no world layout");
  const driver = createGameWorldCacheDriver(session, layout, { now: () => 0 });
  return (state) => {
    let camera: CameraState = {
      x: 0,
      y: 0,
      facing: state.move.facing,
    };
    for (const component of layout.components) {
      const placement = component.placements.find((candidate) => candidate.mapId === state.mapId);
      if (!placement) continue;
      camera = followCamera(
        placement.originTileX * project.tileSize + state.move.px,
        placement.originTileY * project.tileSize + state.move.py,
        project.tileSize,
        state.move.facing,
        {
          worldX: component.bounds.minTileX * project.tileSize,
          worldY: component.bounds.minTileY * project.tileSize,
          worldW: (component.bounds.maxTileX - component.bounds.minTileX) * project.tileSize,
          worldH: (component.bounds.maxTileY - component.bounds.minTileY) * project.tileSize,
          viewportW: VIEWPORT.w,
          viewportH: VIEWPORT.h,
        },
      );
      break;
    }
    driver.sync(state, camera, VIEWPORT);
  };
}

describe("G6 production map repository", () => {
  test("the maintained journey is byte-identical to inline on every frame", () => {
    const inlineProject = readInlineProject(ROOT);
    const sharded = readShardedProject(ROOT);
    const inlineSession = createSession(inlineProject, 60,
      createTuxemonSessionOptions(inlineProject, worldTraversal, GAME_OPTIONS));
    const shardedSession = createSession(sharded.project, 60,
      createTuxemonSessionOptions(sharded.project, worldTraversal, { maps: sharded.repository, ...GAME_OPTIONS }));
    let inlineState = startSession(inlineProject, inlineSession);
    let shardedState = startSession(sharded.project, shardedSession);
    const syncCache = createProductionCacheSync(shardedSession, sharded.project);
    let previous = 0;

    syncCache(shardedState);
    expect(canonicalJson(shardedState)).toBe(canonicalJson(inlineState));
    for (let frame = 0; frame < journey.masks.length; frame++) {
      const mask = journey.masks[frame]!;
      const frameInput = input(mask, previous);
      inlineState = stepSession(inlineSession, inlineState, frameInput);
      shardedState = stepSession(shardedSession, shardedState, frameInput);
      syncCache(shardedState);
      expect(canonicalJson(shardedState), `frame ${frame}`).toBe(canonicalJson(inlineState));
      const resident = [...shardedSession.maps.keys()];
      expect(resident, `current map resident at frame ${frame}`).toContain(shardedState.mapId);
      // The component runtime defers seamless eviction to the layered cache
      // owner (the production WorldCacheDriver, exercised by verify:world-cache);
      // a headless session without one retains the journey's working set
      // (active + visible + one-hop + the just-left map). The GB6 mainline's
      // working set peaks at 5 maps.
      expect(resident.length, `bounded seam residents at frame ${frame}`).toBeLessThanOrEqual(5);
      previous = mask;
    }

    expect([shardedState.mapId, shardedState.move.tx, shardedState.move.ty])
      .toEqual(["spyder_route1", 14, 19]);
    expect(createHash("sha256").update(canonicalJson(shardedState)).digest("hex"))
      .toBe(journey.terminalStateSha256);
  }, 60_000);

  test("attract replay stays byte-identical at 60, 30, 20, and 4 Hz", () => {
    const inlineProject = readInlineProject(ROOT);
    const terminalHashes: string[] = [];
    for (const hz of [60, 30, 20, 4]) {
      const sharded = readShardedProject(ROOT);
      const inline = new AttractController(inlineProject, journey.masks,
        { hz, ...createTuxemonSessionOptions(inlineProject, worldTraversal, GAME_OPTIONS) });
      const lazy = new AttractController(sharded.project, journey.masks, {
        hz,
        ...createTuxemonSessionOptions(sharded.project, worldTraversal, {
          maps: sharded.repository,
          ...GAME_OPTIONS,
        }),
      });
      inline.startAttract();
      lazy.startAttract();
      let hostFrame = 0;
      let sawHandoff = false;
      for (; hostFrame < 20_000; hostFrame++) {
        const expected = inline.step(0);
        const actual = lazy.step(0);
        if (canonicalJson(actual.state) !== canonicalJson(expected.state)) {
          throw new Error(`attract SessionState mismatch at ${hz} Hz host frame ${hostFrame}`);
        }
        if (actual.state.handoff) {
          sawHandoff = true;
          expect(actual.state.fade, `${hz} Hz handoff must not fade`).toBeNull();
          expect(actual.state.handoff.sourceMapId).toBe("spyder_paper_town");
          expect(actual.state.handoff.targetMapId).toBe("spyder_route1");
        }
        if (actual.status.demoFrame === journey.masks.length) break;
      }
      expect(lazy.status().demoFrame, `${hz} Hz tape completion`).toBe(journey.masks.length);
      if (hz >= 20) expect(sawHandoff, `${hz} Hz did not expose the seamless crossing`).toBeTrue();
      expect([lazy.state.mapId, lazy.state.move.tx, lazy.state.move.ty])
        .toEqual(["spyder_route1", 14, 19]);
      terminalHashes.push(
        createHash("sha256").update(canonicalJson(lazy.state)).digest("hex"),
      );
    }
    expect(new Set(terminalHashes)).toEqual(new Set([journey.terminalStateSha256]));
  }, 60_000);

  test("saves immediately around the handoff restore and replay the same suffix", () => {
    const project = readInlineProject(ROOT);
    const makeSession = () => createSession(project, 60,
      createTuxemonSessionOptions(project, worldTraversal, GAME_OPTIONS));
    const baselineSession = makeSession();
    let state = startSession(project, baselineSession);
    let previous = 0;
    let before: ReturnType<typeof takeSaveSnapshot> | undefined;
    let after: ReturnType<typeof takeSaveSnapshot> | undefined;

    for (let frame = 0; frame < journey.masks.length; frame++) {
      const mask = journey.masks[frame]!;
      state = stepSession(baselineSession, state, input(mask, previous));
      previous = mask;
      const folded = frame + 1;
      if (folded === BEFORE_HANDOFF_FRAME) {
        expect([state.mapId, state.move.tx, state.move.ty]).toEqual(["spyder_paper_town", 14, 1]);
        expect(saveBlockReason(state)).toBeNull();
        before = takeSaveSnapshot(baselineSession, state, mask);
      } else if (folded === MID_HANDOFF_FRAME) {
        expect(state.handoff?.phase).toBe(4);
        expect(saveBlockReason(state)).toBe("Wait until the scene is over.");
        expect(() => takeSaveSnapshot(baselineSession, state, mask)).toThrow(/Wait until the scene is over/);
      } else if (folded === AFTER_HANDOFF_FRAME) {
        expect([state.mapId, state.move.tx, state.move.ty]).toEqual(["spyder_route1", 14, 19]);
        expect(state.handoff).toBeUndefined();
        expect(saveBlockReason(state)).toBeNull();
        after = takeSaveSnapshot(baselineSession, state, mask);
      }
    }

    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(createHash("sha256").update(canonicalJson(state)).digest("hex"))
      .toBe(journey.terminalStateSha256);

    const replaySuffix = (snapshot: NonNullable<typeof before>, from: number) => {
      const session = makeSession();
      let restored = restoreSave(session, snapshot);
      let held = snapshot.held;
      for (let frame = from; frame < journey.masks.length; frame++) {
        const mask = journey.masks[frame]!;
        restored = stepSession(session, restored, input(mask, held));
        held = mask;
      }
      return restored;
    };

    for (const [snapshot, from] of [
      [before!, BEFORE_HANDOFF_FRAME],
      [after!, AFTER_HANDOFF_FRAME],
    ] as const) {
      const resumed = replaySuffix(snapshot, from);
      // Save restore derives the host-only counter from interp.frame. The
      // reducer never reads it; fixing that one field must recover the exact
      // uninterrupted terminal state, including map-entry and handoff state.
      expect(canonicalJson({ ...resumed, frame: state.frame })).toBe(canonicalJson(state));
      expect(createHash("sha256").update(canonicalJson({ ...resumed, frame: state.frame })).digest("hex"))
        .toBe(journey.terminalStateSha256);
    }
  }, 60_000);

  test("rewinding from handoff phase 4 refolds the crossing byte-for-byte", () => {
    const project = readInlineProject(ROOT);
    const options = {
      hz: 60,
      rewindSeconds: 5 / 60,
      ...createTuxemonSessionOptions(project, worldTraversal, GAME_OPTIONS),
    };
    const reference = new AttractController(project, journey.masks, options);
    const states = new Map<number, string>([[0, canonicalJson(reference.state)]]);
    reference.startAttract();
    let phaseFourTimeline = -1;
    for (let guard = 0; guard < 20_000 && reference.status().demoFrame < journey.masks.length; guard++) {
      reference.step(0);
      states.set(reference.length, canonicalJson(reference.state));
      if (reference.state.handoff?.phase === 4) phaseFourTimeline = reference.length;
    }
    expect(phaseFourTimeline).toBeGreaterThan(5);
    expect(createHash("sha256").update(canonicalJson(reference.state)).digest("hex"))
      .toBe(journey.terminalStateSha256);

    const rewound = new AttractController(project, journey.masks, options);
    rewound.startAttract();
    for (let guard = 0; guard < 20_000 && rewound.state.handoff?.phase !== 4; guard++) rewound.step(0);
    expect(rewound.state.handoff?.phase).toBe(4);
    expect(rewound.length).toBe(phaseFourTimeline);
    const target = phaseFourTimeline - 5;
    const result = rewound.step(BTN_LTRIGGER);
    expect(result.status.rewound).toBeTrue();
    expect(rewound.length).toBe(target);
    const expected = states.get(target);
    expect(expected).toBeDefined();
    expect(canonicalJson(rewound.state)).toBe(expected!);
    expect(rewound.state.handoff).toBeUndefined();

    rewound.step(0); // release L, then continue the restored tape prefix
    for (let guard = 0; guard < 20_000 && rewound.status().demoFrame < journey.masks.length; guard++) {
      rewound.step(0);
    }
    expect(rewound.status().demoFrame).toBe(journey.masks.length);
    expect(createHash("sha256").update(canonicalJson(rewound.state)).digest("hex"))
      .toBe(journey.terminalStateSha256);
  }, 60_000);

  test("a cross-map save restores an evicted map and rejects another content build", () => {
    const inlineProject = readInlineProject(ROOT);
    const sharded = readShardedProject(ROOT);
    const inlineSession = createSession(inlineProject, 60,
      createTuxemonSessionOptions(inlineProject, worldTraversal, GAME_OPTIONS));
    const shardedSession = createSession(sharded.project, 60,
      createTuxemonSessionOptions(sharded.project, worldTraversal, { maps: sharded.repository, ...GAME_OPTIONS }));
    let inlineState: SessionState = startSession(inlineProject, inlineSession);
    let shardedState: SessionState = startSession(sharded.project, shardedSession);
    const syncCache = createProductionCacheSync(shardedSession, sharded.project);
    let previous = 0;
    let inlineEnvelope = "";
    let shardedEnvelope = "";
    let savedMap = "";
    let retainedDuringEntrySettle = false;
    let evictedAfterEntrySettle = false;
    const saveFrame = journey.checkpoints.find((mark) => mark.name === "bedroom")?.frame;
    const endFrame = journey.checkpoints.find((mark) => mark.name === "downstairs-mom")?.frame;
    if (saveFrame === undefined || endFrame === undefined) {
      throw new Error("G7 repository: maintained journey is missing save/eviction checkpoints");
    }

    syncCache(shardedState);
    for (let frame = 0; frame <= endFrame; frame++) {
      const mask = journey.masks[frame]!;
      const frameInput = input(mask, previous);
      inlineState = stepSession(inlineSession, inlineState, frameInput);
      shardedState = stepSession(shardedSession, shardedState, frameInput);
      syncCache(shardedState);
      previous = mask;
      if (frame === saveFrame) {
        savedMap = shardedState.mapId;
        const inlineSnapshot = createSessionSnapshot(inlineSession, inlineState, mask);
        const shardedSnapshot = createSessionSnapshot(shardedSession, shardedState, mask);
        inlineEnvelope = encodeEnvelope(inlineSnapshot);
        shardedEnvelope = encodeEnvelope(shardedSnapshot, shardedSession.content);
        expect(canonicalJson(shardedSnapshot)).toBe(canonicalJson(inlineSnapshot));
        expect(JSON.parse(shardedEnvelope).checksum).toBe(JSON.parse(inlineEnvelope).checksum);
      }
      if (savedMap !== "" && shardedState.mapId !== savedMap) {
        if (shardedState.interp.frame < GAME_WORLD_ENTRY_SETTLE_FRAMES) {
          retainedDuringEntrySettle ||= shardedSession.maps.has(savedMap);
        } else if (!shardedSession.maps.has(savedMap)) {
          evictedAfterEntrySettle = true;
        }
      }
    }

    // The component runtime defers seamless eviction to the layered cache
    // owner (the production WorldCacheDriver); a headless session retains
    // the working set. Explicitly evict to the current map so the restore
    // below exercises the evicted-map path, as the production driver would.
    releaseSessionMapsExcept(shardedSession, [shardedState.mapId]);

    expect(savedMap).toBe("spyder_bedroom");
    expect(shardedState.mapId).toBe("spyder_downstairs");
    expect(retainedDuringEntrySettle).toBeTrue();
    expect(evictedAfterEntrySettle).toBeTrue();
    expect(shardedSession.maps.has(savedMap)).toBeFalse();
    const restoredInline = restoreSessionSnapshot(
      inlineSession,
      decodeEnvelopeText(inlineEnvelope),
    );
    const restoredSharded = restoreSessionEnvelope(shardedSession, shardedEnvelope);
    expect(canonicalJson(restoredSharded)).toBe(canonicalJson(restoredInline));
    expect([...shardedSession.maps.keys()]).toEqual([savedMap]);

    let reads = 0;
    const changedIndex = sharded.project.mapIndex.map((entry) => entry.id === savedMap
      ? { ...entry, sha256: "0".repeat(64) }
      : entry);
    const unhashed: ProjectShell = {
      ...sharded.project,
      mapIndex: changedIndex,
      mapManifestHash: undefined,
    };
    const mismatched: ProjectShell = { ...unhashed, mapManifestHash: mapManifestHash(unhashed) };
    const repository = createJsonMapRepository(mismatched.mapIndex, {
      read(entry) {
        reads++;
        return new Uint8Array(readFileSync(join(ROOT, "dist", entry)));
      },
    });
    const mismatchedSession = createSession(mismatched, 60,
      createTuxemonSessionOptions(mismatched, worldTraversal, { maps: repository, ...GAME_OPTIONS }));
    expect(reads).toBe(1);
    expect(() => restoreSessionEnvelope(mismatchedSession, shardedEnvelope)).toThrow(/manifest hash/);
    expect(reads).toBe(1);
  });

  test("the preserved masks still replay on the explicit legacy timeline", () => {
    const project = readInlineProject(ROOT);
    const session = createSession(project, 60,
      createTuxemonSessionOptions(project, "legacy-transfer", GAME_OPTIONS));
    let state = startSession(project, session);
    let previous = 0;
    for (const mask of journey.masks) {
      state = stepSession(session, state, input(mask, previous));
      previous = mask;
    }
    // Seamless traversal completes atomically at the end of the recorded
    // crossing. The explicit legacy timeline needs its historical neutral
    // transfer tick before both modes can be compared at Route 1.
    state = stepSession(session, state, input(0, previous));
    expect([state.mapId, state.move.tx, state.move.ty]).toEqual(["spyder_route1", 14, 19]);
    expect(createHash("sha256").update(canonicalJson(state)).digest("hex"))
      .toBe(LEGACY_TERMINAL_STATE_SHA256);
  });
});

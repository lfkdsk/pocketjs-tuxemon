// Cross-map presentation parity through constructed Tuxemon source events.
// Every command below is emitted by buildProject from the committed TMX
// fixture; tests never manufacture reducer state or hand-write kit commands.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTuxemonExtensions } from "../battle/extension.ts";
import { createTuxemonSessionOptions } from "../battle/game.ts";
import { TUXEMON_COMPATIBLE_SAVE_CONTENT } from "../data/save-compat.ts";
import { BTN } from "../vendor/pocket-rpgkit/vendor/pocketjs/contracts/spec/spec.ts";
import { AttractController } from "../vendor/pocket-rpgkit/src/engine/attract.ts";
import { animFrameIndex } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";
import {
  canonicalJson,
  createSessionSnapshot,
  encodeEnvelope,
} from "../vendor/pocket-rpgkit/src/engine/save.ts";
import { restoreSessionEnvelope } from "../vendor/pocket-rpgkit/src/engine/save-restore.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { Command, Project, WorldTraversalMode } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { readShardedProject } from "../tools/generated-project.ts";
import { productionPaginator } from "../battle/paginator.ts";
import {
  browserSaveStore,
  loadSlot,
  restoreSave,
  saveSlot,
  takeSaveSnapshot,
  type SlotStore,
  type StorageLike,
} from "../ui/save-game.ts";
import {
  loadGPersistBuilds,
  type GPersistBuild,
  type GPersistFeature,
} from "./helpers/g-persist-import.ts";

const builds = await loadGPersistBuilds();
const SESSION_OPTIONS = { extensions: createTuxemonExtensions({} as never) } as const;
const FEATURES = ["animation", "camera", "balloon", "backdrop"] as const;
const TARGET = "persist_target";
const ROOT = resolve(import.meta.dir, "..");
const SAVE_FIXTURES = [
  "main-4019a9b8",
  "main-0fc1580c",
  "main-a19bc37b",
  "main-78493afa",
  "main-bbeef6b4",
  "main-3a9e95b2",
  "main-97dadd0b",
  "main-e799febb",
  "main-c38f8e72",
] as const;
const IMMEDIATE_PREDECESSOR_FIXTURE = "main-c38f8e72" as const;

interface PublishedSaveMetadata {
  content: { manifest: string; schema: string };
  tape: {
    path: string;
    /** Whole source-tape identity at the recorded predecessor commit. */
    sha256: string;
    /** Portable copy check for the prefix actually used after this save. */
    continuationPrefix?: { frames: number; sha256: string };
  };
  save: {
    frame: number;
    timelineFrame: number;
    held: number;
    map: string;
    position: [number, number];
    envelopeSha256: string;
  };
  continuation: {
    frames: number;
    targetFrame: number;
    map: string;
    position: [number, number];
    stateSha256: string;
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sessionInput(mask: number, previous: number) {
  const pressed = mask & ~previous;
  return {
    buttons: mask,
    confirmEdge: Boolean(pressed & 0x2000),
    cancelEdge: Boolean(pressed & 0x4000),
    upEdge: Boolean(pressed & 0x0010),
    downEdge: Boolean(pressed & 0x0040),
    leftEdge: Boolean(pressed & 0x0080),
    rightEdge: Boolean(pressed & 0x0020),
  };
}

function memorySlots(initial?: string): {
  slots: SlotStore;
  values: Map<string, string>;
} {
  const values = new Map<string, string>();
  const storage: StorageLike = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
  const slots: SlotStore = { channel: "browser", store: browserSaveStore(storage) };
  if (initial !== undefined) slots.store.write(1, initial);
  return { slots, values };
}

function loadPublishedSave(name: typeof SAVE_FIXTURES[number]): {
  envelope: string;
  metadata: PublishedSaveMetadata;
} {
  const fixture = resolve(ROOT, "tests/fixtures/save-compat", name);
  const envelope = readFileSync(resolve(fixture, "slot-1.json"), "utf8");
  const metadata = JSON.parse(
    readFileSync(resolve(fixture, "metadata.json"), "utf8"),
  ) as PublishedSaveMetadata;
  expect(sha256(envelope)).toBe(metadata.save.envelopeSha256);
  expect(TUXEMON_COMPATIBLE_SAVE_CONTENT.some((candidate) =>
    candidate.manifest === metadata.content.manifest
    && candidate.schema === metadata.content.schema
  )).toBe(true);
  return { envelope, metadata };
}

function commandTree(project: Project): Command[] {
  const flatten = (commands: readonly Command[]): Command[] => commands.flatMap((command) => {
    if (command.op === "if") return [command, ...flatten(command.then), ...flatten(command.else ?? [])];
    if (command.op === "loop") return [command, ...flatten(command.commands)];
    if (command.op === "choices") {
      return [command, ...command.options.flatMap((option) => flatten(option.commands))];
    }
    return [command];
  });
  return project.maps.flatMap((map) =>
    (map.events ?? []).flatMap((event) => event.pages.flatMap((page) => flatten(page.commands)))
  );
}

function inputMask(mapId: string, frame: number, hz: number): number {
  if (frame === 0) return BTN.CIRCLE;
  if (mapId === "persist_backdrop" && (frame === 2 || frame === Math.ceil(hz * 0.25))) {
    return BTN.CIRCLE;
  }
  return 0;
}

function runOneSecond(build: GPersistBuild, hz: 60 | 30 | 20): {
  session: Session;
  state: SessionState;
} {
  const session = createSession(build.project, hz, SESSION_OPTIONS);
  let state = startSession(build.project, session);
  let previous = 0;
  for (let frame = 0; frame < hz; frame++) {
    const buttons = inputMask(build.project.start.map, frame, hz);
    state = stepSession(session, state, {
      buttons,
      confirmEdge: (buttons & BTN.CIRCLE) !== 0 && (previous & BTN.CIRCLE) === 0,
    });
    previous = buttons;
  }
  expect(state.mapId).toBe(TARGET);
  return { session, state };
}

function roundTrip(session: Session, state: SessionState): SessionState {
  return restoreSessionEnvelope(
    session,
    encodeEnvelope(createSessionSnapshot(session, state, 0)),
  );
}

function rewindAcrossTransfer(project: Project): void {
  const controller = new AttractController(project, [], {
    ...SESSION_OPTIONS,
    hz: 60,
    idleFrames: 60_000,
    rewindSeconds: 12 / 60,
    attractEnabled: false,
  });
  controller.startPlay();
  const states = [structuredClone(controller.state)];
  const masks: number[] = [];
  let landed = -1;
  for (let frame = 0; frame < 90; frame++) {
    const mask = inputMask(project.start.map, frame, 60);
    masks.push(mask);
    controller.step(mask);
    states.push(structuredClone(controller.state));
    if (controller.state.mapId === TARGET) {
      landed = states.length - 1;
      break;
    }
  }
  expect(landed).toBeGreaterThan(12);
  for (let frame = 0; frame < 6; frame++) {
    masks.push(0);
    controller.step(0);
    states.push(structuredClone(controller.state));
  }
  const finalIndex = states.length - 1;
  const target = finalIndex - 12;
  expect(states[target]!.mapId).not.toBe(TARGET);
  expect(states[finalIndex]!.mapId).toBe(TARGET);
  const final = structuredClone(controller.state);
  controller.step(BTN.LTRIGGER);
  expect(controller.state).toEqual(states[target]);
  for (let frame = target; frame < finalIndex; frame++) controller.step(masks[frame]!);
  expect(controller.state).toEqual(final);
}

function expectNative(build: GPersistBuild, type: string, total: number): void {
  const row = build.coverage.actions.rows.find((candidate) => candidate.type === type);
  expect(row).toMatchObject({ total, native: total, degraded: 0, placeholder: 0, dropped: 0 });
}

describe("imported Tuxemon presentation state survives map transfer", () => {
  test("a looping map animation keeps its phase at 60/30/20 Hz, through save and rewind", () => {
    const build = builds.animation;
    expect(commandTree(build.project)).toContainEqual({
      op: "mapAnim",
      id: "tux_map_grass",
      anim: "tux_grass_100000us",
      target: "player",
      follow: false,
      layer: "above",
      loop: true,
    });
    expectNative(build, "play_map_animation", 1);

    const outcomes = ([60, 30, 20] as const).map((hz) => {
      const { session, state } = runOneSecond(build, hz);
      const instance = state.interp.anims?.[0];
      expect(instance).toMatchObject({ id: "tux_map_grass", loop: true, target: null });
      expect(instance!.start).toBeLessThan(0);
      const timing = session.worlds.get(TARGET)!.anims.get(instance!.anim)!;
      return {
        state,
        session,
        frame: animFrameIndex(timing, instance!, state.interp.frame),
        elapsed: state.interp.frame - instance!.start,
      };
    });
    expect(outcomes.map(({ frame, elapsed }) => ({ frame, elapsed })))
      .toEqual(Array.from({ length: 3 }, () => ({ frame: outcomes[0]!.frame, elapsed: outcomes[0]!.elapsed })));
    const restored = roundTrip(outcomes[0]!.session, outcomes[0]!.state);
    expect(restored.interp.anims).toEqual(outcomes[0]!.state.interp.anims);
    rewindAcrossTransfer(build.project);
  });

  test("a fixed camera survives at 60/30/20 Hz, through save and rewind", () => {
    const build = builds.camera;
    expect(commandTree(build.project)).toContainEqual({ op: "camera", target: { x: 7, y: 7 }, duration: 0 });
    expectNative(build, "camera_position", 1);
    const outcomes = ([60, 30, 20] as const).map((hz) => runOneSecond(build, hz));
    const cameras = outcomes.map(({ state }) => state.interp.screen?.camera);
    expect(cameras).toEqual([cameras[0], cameras[0], cameras[0]]);
    expect(cameras[0]).toMatchObject({ mode: "fixed", toX: 120, toY: 120, total: 0, left: 0 });
    expect(roundTrip(outcomes[0]!.session, outcomes[0]!.state).interp.screen?.camera).toEqual(cameras[0]);
    rewindAcrossTransfer(build.project);
  });

  test("a player balloon survives at 60/30/20 Hz, through save and rewind", () => {
    const build = builds.balloon;
    expect(commandTree(build.project)).toContainEqual({
      op: "balloon",
      target: "player",
      icon: "tux_bubble_exclamation",
    });
    expectNative(build, "set_bubble", 1);
    const outcomes = ([60, 30, 20] as const).map((hz) => runOneSecond(build, hz));
    const balloons = outcomes.map(({ state }) => state.interp.screen?.balloons?.player);
    expect(balloons).toEqual([balloons[0], balloons[0], balloons[0]]);
    expect(balloons[0]).toMatchObject({ target: "player", icon: "tux_bubble_exclamation", left: null });
    expect(roundTrip(outcomes[0]!.session, outcomes[0]!.state).interp.screen?.balloons?.player)
      .toEqual(balloons[0]);
    rewindAcrossTransfer(build.project);
  });

  test("an open backdrop ignores replacement and survives at 60/30/20 Hz, save and rewind", () => {
    const build = builds.backdrop;
    expect(commandTree(build.project).filter((command) => command.op === "screenBackdrop")).toEqual([
      {
        op: "screenBackdrop",
        layer: "tux_backdrop",
        variant: "bg_gradient_blue",
        whenModalOpen: "ignore",
      },
      {
        op: "screenBackdrop",
        layer: "tux_backdrop",
        variant: "bg_gradient_red",
        whenModalOpen: "ignore",
      },
    ]);
    const coverage = build.coverage.actions.rows.find((candidate) => candidate.type === "change_bg");
    expect(coverage).toMatchObject({ total: 2, native: 0, degraded: 2, placeholder: 0, dropped: 0 });
    const probeSession = createSession(build.project, 60, SESSION_OPTIONS);
    let probe = startSession(build.project, probeSession);
    let previous = 0;
    for (let frame = 0; frame < 20 && probe.sw.variables["v.g_persist_replaced"] !== 1; frame++) {
      const buttons = inputMask(build.project.start.map, frame, 60);
      probe = stepSession(probeSession, probe, {
        buttons,
        confirmEdge: (buttons & BTN.CIRCLE) !== 0 && (previous & BTN.CIRCLE) === 0,
      });
      previous = buttons;
    }
    expect(probe.sw.variables["v.g_persist_replaced"]).toBe(1);
    expect(probe.interp.modal?.kind).toBe("text");
    expect(probe.interp.screen?.backdrop).toEqual({ layer: "tux_backdrop", variant: "bg_gradient_blue" });
    const outcomes = ([60, 30, 20] as const).map((hz) => runOneSecond(build, hz));
    const backdrops = outcomes.map(({ state }) => state.interp.screen?.backdrop);
    expect(backdrops).toEqual([backdrops[0], backdrops[0], backdrops[0]]);
    expect(backdrops[0]).toEqual({ layer: "tux_backdrop", variant: "bg_gradient_blue" });
    expect(roundTrip(outcomes[0]!.session, outcomes[0]!.state).interp.screen?.backdrop)
      .toEqual(backdrops[0]);
    rewindAcrossTransfer(build.project);
  });

  test("all constructed feature projects remain schema-clean", () => {
    for (const feature of FEATURES satisfies readonly GPersistFeature[]) {
      expect(builds[feature].project.maps).toHaveLength(2);
    }
  });
});

test("published predecessor slots load exactly and only resave under the current identity", () => {
  const current = loadPublishedSave(IMMEDIATE_PREDECESSOR_FIXTURE);
  const tape = JSON.parse(readFileSync(resolve(ROOT, current.metadata.tape.path), "utf8")) as {
    worldTraversal: WorldTraversalMode;
  };
  const { project, repository } = readShardedProject(ROOT);
  const session = createSession(project, 60, createTuxemonSessionOptions(
    project,
    tape.worldTraversal,
    { maps: repository, paginateText: productionPaginator(ROOT) },
  ));
  expect(session.content?.compatible).toEqual(TUXEMON_COMPATIBLE_SAVE_CONTENT);

  for (const name of SAVE_FIXTURES) {
    const { envelope, metadata } = loadPublishedSave(name);
    const { slots } = memorySlots(envelope);
    const snapshot = loadSlot(slots, 1, session.content);
    const state = restoreSave(session, snapshot);
    expect([state.mapId, state.move.tx, state.move.ty]).toEqual([
      metadata.save.map,
      ...metadata.save.position,
    ]);

    const currentSnapshot = takeSaveSnapshot(session, state, metadata.save.held);
    saveSlot(slots, 2, currentSnapshot, session.content);
    const currentEnvelope = slots.store.read(2);
    if (currentEnvelope === null) throw new Error("current slot was not written");
    const rewritten = JSON.parse(currentEnvelope) as { content?: unknown };
    expect(rewritten.content).toEqual({
      manifest: session.content?.manifest,
      schema: session.content?.schema,
    });
    expect(loadSlot(slots, 2, session.content)).toEqual(currentSnapshot);

    const refuse = (content: { manifest: string; schema: string }) => {
      const foreign = JSON.parse(envelope) as { content: { manifest: string; schema: string } };
      foreign.content = content;
      slots.store.write(1, JSON.stringify(foreign));
      expect(() => loadSlot(slots, 1, session.content)).toThrow();
    };
    refuse({ ...metadata.content, manifest: "f".repeat(64) });
    refuse({ ...metadata.content, schema: "e".repeat(64) });
    const mismatchedSchema = TUXEMON_COMPATIBLE_SAVE_CONTENT.find((candidate) =>
      candidate.schema !== metadata.content.schema
      && !TUXEMON_COMPATIBLE_SAVE_CONTENT.some((accepted) =>
        accepted.manifest === metadata.content.manifest
        && accepted.schema === candidate.schema
      )
    )?.schema;
    expect(mismatchedSchema).toBeDefined();
    refuse({
      manifest: metadata.content.manifest,
      schema: mismatchedSchema!,
    });
  }
});

/** Slots recorded on the still-current mainline tape continue on it. */
const CONTINUING_FIXTURES = ["main-78493afa", "main-3a9e95b2", IMMEDIATE_PREDECESSOR_FIXTURE] as const;

for (const name of CONTINUING_FIXTURES) test(`the ${name} main slot continues on the current tape`, () => {
  const { envelope, metadata } = loadPublishedSave(name);
  const tapeBytes = readFileSync(resolve(ROOT, metadata.tape.path));
  const tape = JSON.parse(tapeBytes.toString("utf8")) as {
    worldTraversal: WorldTraversalMode;
    masks: number[];
  };
  expect(metadata.tape.continuationPrefix?.frames).toBe(metadata.continuation.targetFrame);
  expect(sha256(JSON.stringify(tape.masks.slice(0, metadata.continuation.targetFrame))))
    .toBe(metadata.tape.continuationPrefix!.sha256);
  expect(metadata.continuation.targetFrame - metadata.save.frame)
    .toBe(metadata.continuation.frames);

  const { project, repository } = readShardedProject(ROOT);
  const session = createSession(project, 60, createTuxemonSessionOptions(
    project,
    tape.worldTraversal,
    { maps: repository, paginateText: productionPaginator(ROOT) },
  ));
  const { slots } = memorySlots(envelope);
  const snapshot = loadSlot(slots, 1, session.content);
  let state = restoreSave(session, snapshot);
  const frameOffset = metadata.save.timelineFrame - state.frame;
  let previous = metadata.save.held;
  for (let frame = metadata.save.frame; frame < metadata.continuation.targetFrame; frame++) {
    const mask = tape.masks[frame]!;
    state = stepSession(session, state, sessionInput(mask, previous));
    previous = mask;
  }
  expect([state.mapId, state.move.tx, state.move.ty]).toEqual([
    metadata.continuation.map,
    ...metadata.continuation.position,
  ]);
  expect(sha256(canonicalJson({ ...state, frame: state.frame + frameOffset })))
    .toBe(metadata.continuation.stateSha256);
});

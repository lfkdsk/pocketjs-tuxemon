// Tests for the PSP boot-snapshot overlay (ui/boot-snapshot-overlay.tsx):
// a segment build bakes a chapter save envelope; the overlay restores it on
// the first frame and re-bases the global frame counter to the chapter's
// timeline frame before the tape replay starts. These tests drive the real
// overlay with a real kit session (no PSP SDK), so the frame re-base and the
// success/failure paths are covered end-to-end.

import { afterEach, describe, expect, test } from "bun:test";

import { canonicalJson } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { GameViewSessionHost } from "../vendor/pocket-rpgkit/src/ui/demo-contract.ts";
import { createBootSnapshotOverlay } from "../ui/boot-snapshot-overlay.tsx";
import { readInlineProject } from "../tools/generated-project.ts";
import { mainlineSessionOptions } from "../tools/mainline-session.ts";
import {
  loadChapters,
  loadMainlineTape,
  mainlineInput,
  resolveSegment,
  ROOT,
  sha256,
} from "../tools/psp-segment.ts";

const globals = globalThis as unknown as Record<string, unknown>;

function makeHost(): { host: GameViewSessionHost; session: Session; getState: () => SessionState } {
  const project = readInlineProject(ROOT);
  const { worldTraversal } = loadMainlineTape(ROOT);
  const session = createSession(
    project,
    60,
    mainlineSessionOptions(project, worldTraversal),
  );
  let state = startSession(project, session);
  const host: GameViewSessionHost = {
    project,
    session,
    getState: () => state,
    heldButtons: () => 0,
    replaceState: (next) => {
      state = next;
    },
  };
  return { host, session, getState: () => state };
}

function chapter(id: string) {
  const found = loadChapters(ROOT).chapters.find((c) => c.id === id);
  if (!found) throw new Error(`no chapter ${id}`);
  return found;
}

afterEach(() => {
  delete globals.__pocketTuxemonBootSnapshot;
  delete globals.__pocketTuxemonBootFrame;
  delete globals.__pocketTuxemonBootReady;
});

describe("boot-snapshot overlay", () => {
  test("restores a chapter envelope and re-bases the global frame", () => {
    const radio = chapter("radio-broadcast");
    const { host, getState } = makeHost();
    globals.__pocketTuxemonBootSnapshot = radio.snapshot;
    globals.__pocketTuxemonBootFrame = radio.timelineFrame;

    const runtime = createBootSnapshotOverlay().create(host);
    const result = runtime.step(0, 0);

    expect(result.consumed).toBe(true);
    expect(result.stateChanged).toBe(true);
    expect(globals.__pocketTuxemonBootReady).toBe(true);
    const state = getState();
    // The frame re-base: the envelope carries only the per-map interpreter
    // clock, so without the overlay's correction the restored frame would be
    // the radiotower map's small local clock, not the global timeline frame.
    expect(state.frame).toBe(radio.timelineFrame);
    expect(state.mapId).toBe("spyder_radiotower");
    expect(state.move.tx).toBe(9);
    expect(state.move.ty).toBe(5);
  });

  test("a second step is inert after a successful restore", () => {
    const radio = chapter("radio-broadcast");
    const { host } = makeHost();
    globals.__pocketTuxemonBootSnapshot = radio.snapshot;
    globals.__pocketTuxemonBootFrame = radio.timelineFrame;

    const runtime = createBootSnapshotOverlay().create(host);
    runtime.step(0, 0);
    const again = runtime.step(0, 0);
    expect(again.consumed).toBe(false);
    expect(again.stateChanged).toBeUndefined();
  });

  test("is inert when no snapshot global is set (production builds)", () => {
    const { host, getState } = makeHost();
    const before = getState();
    const runtime = createBootSnapshotOverlay().create(host);
    const result = runtime.step(0, 0);
    expect(result.consumed).toBe(false);
    expect(globals.__pocketTuxemonBootReady).toBe(true);
    // The running state is untouched.
    expect(getState()).toBe(before);
  });

  test("a snapshot that fails to restore throws and does not re-attempt", () => {
    const { host, getState } = makeHost();
    const before = getState();
    // Valid JSON, but not a save envelope: loadSession refuses it.
    globals.__pocketTuxemonBootSnapshot = "{}";

    const runtime = createBootSnapshotOverlay().create(host);
    expect(() => runtime.step(0, 0)).toThrow(/boot snapshot restore failed/);
    // The overlay does not re-attempt on later frames (no throw loop), and
    // the running state is left untouched by the failed restore.
    expect(runtime.step(0, 0)).toEqual({ consumed: false });
    expect(getState()).toBe(before);
    expect(globals.__pocketTuxemonBootReady).toBeUndefined();
  });

  test("the restored state suffix-replays to the full-mainline terminal", () => {
    // The success path proves the restore + frame re-base; this proves the
    // restored state is a viable suffix start: replay the radio-broadcast
    // suffix through the same session and reach the J3 terminal pin.
    const radio = chapter("radio-broadcast");
    const { host, session, getState } = makeHost();
    globals.__pocketTuxemonBootSnapshot = radio.snapshot;
    globals.__pocketTuxemonBootFrame = radio.timelineFrame;
    const runtime = createBootSnapshotOverlay().create(host);
    runtime.step(0, 0);

    const spec = resolveSegment(ROOT, "radio-broadcast", 193219);
    let state = getState();
    let previous = radio.held >>> 0;
    for (const mask of spec.suffix) {
      state = stepSession(session, state, mainlineInput(mask, previous));
      previous = mask;
    }
    // The terminal hash carries the deterministic player identity alongside
    // the cathedral bill metadata and live-movement encounter state.
    expect(sha256(canonicalJson(state)))
      .toBe("043a9ddffdb162e32bf01d50bb2fa89f8e4e91bce3f3391d5670d873e064169d");
    expect(state.frame).toBe(193219);
  });
});

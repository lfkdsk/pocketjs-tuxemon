// Unit tests for the PSP save e2e phase dispatcher (tools/lib/psp-save-verify.ts).
//
// The real phases need PPSSPPHeadless; here fake build/run deps prove that
// every documented phase really executes through the dispatcher. Every
// phase is driven via runPhase("<phase>") — the same call the CLI's
// --phase= flag lands in — never by calling the phase functions directly.
// Consequences:
//   - Deleting a dispatch branch makes runPhase throw "unknown phase", so
//     each phase's positive test (valid log -> no throw) goes red.
//   - Every negative test asserts the phase's OWN error message (not a bare
//     toThrow()), so a missing branch can no longer hide behind the
//     dispatcher's "unknown phase" error.
// An empty or wrong log must throw, not pass (the original --phase=load
// false green), and the dispatcher rejects unknown phases outright.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import {
  decodePspSaveRecord,
  PHASES,
  runPhase,
  type LogEntry,
  type MenuStateShape,
  type PspSaveVerifyDeps,
  type Tape,
} from "../tools/lib/psp-save-verify.ts";

function framedSave(text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const bytes = new Uint8Array(16 + payload.length);
  bytes.set(new TextEncoder().encode("PJSAVE1\n"));
  const view = new DataView(bytes.buffer);
  view.setUint32(8, payload.length, true);
  let hash = 0x811c9dc5;
  for (const byte of payload) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  view.setUint32(12, hash, true);
  bytes.set(payload, 16);
  return bytes;
}

function fakeState(overrides: Record<string, unknown> = {}): SessionState {
  return {
    mapId: "spyder_paper_town",
    move: { tx: 10, ty: 20 },
    interp: { frame: 2544, variables: { "v.spokenmom": 1 } },
    frame: 100,
    ...overrides,
  } as unknown as SessionState;
}

interface FakeDeps {
  deps: PspSaveVerifyDeps;
  builds: Tape[];
  runs: string[];
  /** Logs returned per phase label. */
  logs: Record<string, LogEntry[]>;
  files: Map<string, string>;
}

function makeFakeDeps(logs: Record<string, LogEntry[]>, opts: { writes?: boolean } = {}): FakeDeps {
  const work = mkdtempSync(join(tmpdir(), "psp-save-verify-"));
  dirs.push(work);
  const files = new Map<string, string>();
  const builds: Tape[] = [];
  const runs: string[] = [];
  const writes = opts.writes ?? true;
  const deps: PspSaveVerifyDeps = {
    build(tape) { builds.push(tape); },
    run(phase) {
      runs.push(phase);
      // Simulate the game writing its save file under PPSSPP.
      if (writes && phase === "save") files.set("save/slot-1.json", "{}");
      if (writes && phase === "autosave-trigger") files.set("save/autosave.json", JSON.stringify({ frame: 2544 }));
      return logs[phase] ?? [];
    },
    memstick: join(work, "memstick"),
    work,
    autosaveFrame: 3942,
    cleanMemstick() { files.clear(); },
    withReadOnlySaveDir(fn) { fn(); },
    readSaveFile(rel) { return files.get(rel) ?? null; },
    saveFileExists(rel) { return files.has(rel); },
  };
  return { deps, builds, runs, logs, files };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A marked+terminal log pair for one state. */
function logFor(state: SessionState, menu?: MenuStateShape | null): LogEntry[] {
  return [
    { kind: "marked", frame: 1, state, menu: menu ?? null },
    { kind: "terminal", frame: 2, state },
  ];
}

describe("phase dispatch", () => {
  test("the documented phases are exactly save/load/autosave/failure", () => {
    expect([...PHASES]).toEqual(["save", "load", "autosave", "failure"]);
  });

  test("an unknown phase throws instead of passing", () => {
    const { deps } = makeFakeDeps({});
    expect(() => runPhase("bogus", deps)).toThrow(/unknown phase/);
    expect(() => runPhase("", deps)).toThrow(/unknown phase/);
  });
});

describe("PSP physical save records", () => {
  test("decodes checksummed records and complete legacy JSON", () => {
    expect(decodePspSaveRecord(framedSave('{"frame":2544}'))).toBe('{"frame":2544}');
    expect(decodePspSaveRecord(new TextEncoder().encode('{"legacy":true}'))).toBe('{"legacy":true}');
  });

  test("rejects truncation, trailing bytes and checksum damage", () => {
    const valid = framedSave('{"frame":2544}');
    expect(() => decodePspSaveRecord(valid.subarray(0, valid.length - 1))).toThrow(/length/);
    const trailing = new Uint8Array(valid.length + 1);
    trailing.set(valid);
    expect(() => decodePspSaveRecord(trailing)).toThrow(/length/);
    const damaged = valid.slice();
    damaged[damaged.length - 1] ^= 1;
    expect(() => decodePspSaveRecord(damaged)).toThrow(/checksum/);
  });
});

describe("every phase passes through the dispatcher with a valid log", () => {
  // The positive path is the mutation killer: deleting a dispatch branch
  // makes runPhase throw "unknown phase", turning these red.

  test("save passes, builds the save tape and writes the slot file", () => {
    const state = fakeState();
    const fake = makeFakeDeps({ save: logFor(state) });
    expect(() => runPhase("save", fake.deps)).not.toThrow();
    expect(fake.builds).toHaveLength(1);
    expect(fake.builds[0]!.label).toBe("save");
    expect(fake.runs).toEqual(["save"]);
    expect(fake.files.has("save/slot-1.json")).toBe(true);
  });

  test("load passes after running the save half, and compares the states", () => {
    const state = fakeState();
    const fake = makeFakeDeps({
      save: logFor(state),
      load: logFor(state),
    });
    expect(() => runPhase("load", fake.deps)).not.toThrow();
    expect(fake.runs).toEqual(["save", "load"]);
  });

  test("autosave passes with a matching continue state", () => {
    // The live state at the autosave point carries the one-frame hostActions
    // queue; the restored state does not. The comparison strips it.
    const atPoint = fakeState({ interp: { frame: 2544, hostActions: ["autosave"] } });
    const continued = fakeState({ interp: { frame: 2544 } });
    const fake = makeFakeDeps({
      "autosave-trigger": logFor(atPoint),
      "autosave-continue": logFor(continued),
    });
    fake.files.set("save/autosave.json", JSON.stringify({ frame: 2544 }));
    expect(() => runPhase("autosave", fake.deps)).not.toThrow();
    expect(fake.runs).toEqual(["autosave-trigger", "autosave-continue"]);
  });

  test("failure passes with a SAVE FAILED menu, no file, no crash", () => {
    const state = fakeState();
    const fake = makeFakeDeps({
      failure: logFor(state, { kind: "message", title: "SAVE FAILED", body: "read-only" }),
    });
    expect(() => runPhase("failure", fake.deps)).not.toThrow();
    expect(fake.runs).toEqual(["failure"]);
  });
});

describe("an empty emulator log fails every phase through the dispatcher", () => {
  // If a phase passed here, it ran no assertions (the original
  // --phase=load false green). The message must be the phase's own
  // "no log entry" error — a deleted dispatch branch throws "unknown
  // phase" instead, which this regex rejects.
  for (const phase of PHASES) {
    test(`${phase} throws its own missing-log error, not "unknown phase"`, () => {
      const { deps } = makeFakeDeps({});
      expect(() => runPhase(phase, deps)).toThrow(/no (marked|terminal) log entry with a state/);
    });
  }
});

describe("injected inconsistencies fail the phase that owns them", () => {
  // Each assertion goes through runPhase and pins the phase's own error
  // message, so a missing dispatch branch (-> "unknown phase") goes red.

  test("save throws when the slot file was not written", () => {
    const state = fakeState();
    const fake = makeFakeDeps({ save: logFor(state) }, { writes: false });
    expect(() => runPhase("save", fake.deps)).toThrow(/slot-1\.json/);
  });

  test("load throws when the loaded state differs from the saved state", () => {
    const saved = fakeState();
    const loaded = fakeState({ mapId: "spyder_route1" });
    const fake = makeFakeDeps({
      save: logFor(saved),
      load: logFor(loaded),
    });
    expect(() => runPhase("load", fake.deps)).toThrow(/mismatch/);
  });

  test("autosave throws when the autosave file is missing", () => {
    const state = fakeState();
    const fake = makeFakeDeps({
      "autosave-trigger": logFor(state),
      "autosave-continue": logFor(state),
    }, { writes: false });
    expect(() => runPhase("autosave", fake.deps)).toThrow(/autosave\.json/);
  });

  test("autosave throws when the logged frame drifts from the autosave point", () => {
    const atPoint = fakeState({ interp: { frame: 2500 } }); // not the autosave frame
    const continued = fakeState({ interp: { frame: 2500 } });
    const fake = makeFakeDeps({
      "autosave-trigger": logFor(atPoint),
      "autosave-continue": logFor(continued),
    });
    fake.files.set("save/autosave.json", JSON.stringify({ frame: 2544 }));
    expect(() => runPhase("autosave", fake.deps)).toThrow(/drift/);
  });

  test("autosave throws when the continued state drops story state", () => {
    const atPoint = fakeState({ interp: { frame: 2544, hostActions: ["autosave"] } });
    const continued = fakeState({ interp: { frame: 2544 }, mapId: "spyder_bedroom" });
    const fake = makeFakeDeps({
      "autosave-trigger": logFor(atPoint),
      "autosave-continue": logFor(continued),
    });
    fake.files.set("save/autosave.json", JSON.stringify({ frame: 2544 }));
    expect(() => runPhase("autosave", fake.deps)).toThrow(/mismatch/);
  });

  test("failure throws when the menu shows a success instead", () => {
    const state = fakeState();
    const fake = makeFakeDeps({
      failure: logFor(state, { kind: "message", title: "SAVED TO SLOT 1", body: "" }),
    });
    expect(() => runPhase("failure", fake.deps)).toThrow(/did not fail visibly/);
  });

  test("failure throws when the game crashed", () => {
    const crashed = fakeState({ interp: { frame: 2544, error: "boom" } });
    const fake = makeFakeDeps({
      failure: logFor(crashed, { kind: "message", title: "SAVE FAILED", body: "" }),
    });
    expect(() => runPhase("failure", fake.deps)).toThrow(/crash/);
  });
});

describe("runPhase all", () => {
  test("all runs every phase in order and passes", () => {
    const state = fakeState();
    const atPoint = fakeState({ interp: { frame: 2544, hostActions: ["autosave"] } });
    const fake = makeFakeDeps({
      save: logFor(state),
      load: logFor(state),
      "autosave-trigger": logFor(atPoint),
      "autosave-continue": logFor(fakeState({ interp: { frame: 2544 } })),
      failure: logFor(state, { kind: "message", title: "SAVE FAILED", body: "" }),
    });
    expect(() => runPhase("all", fake.deps)).not.toThrow();
    // save runs once (phaseSave), then load reuses the artifact (no second
    // save run), then autosave (trigger+continue), then failure.
    expect(fake.runs).toEqual(["save", "load", "autosave-trigger", "autosave-continue", "failure"]);
  });
});

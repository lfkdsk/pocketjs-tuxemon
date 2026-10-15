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
  decodePocketPackage,
  encodePocketPackage,
  findSection,
  findVariant,
  POCKET_SECTION,
} from "../vendor/pocket-rpgkit/vendor/pocketjs/contracts/spec/pocket-package.ts";
import {
  decodePspSaveRecord,
  loadTape,
  makeSourceOnlyPspPackage,
  OPENING_PREFIX,
  PHASES,
  POST_LOAD_CONTINUE_FRAMES,
  pspPhysicalSavePath,
  runPhase,
  saveTape,
  autosaveContinueTape,
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
  legacyWrites: string[];
}

function makeFakeDeps(
  logs: Record<string, LogEntry[]>,
  opts: { writes?: boolean; language?: "en" | "zh" } = {},
): FakeDeps {
  const work = mkdtempSync(join(tmpdir(), "psp-save-verify-"));
  dirs.push(work);
  const files = new Map<string, string>();
  const builds: Tape[] = [];
  const runs: string[] = [];
  const legacyWrites: string[] = [];
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
    language: opts.language ?? "en",
    cleanMemstick() { files.clear(); },
    withReadOnlySaveDir(fn) { fn(); },
    readSaveFile(rel) { return files.get(rel) ?? null; },
    saveFileExists(rel) { return files.has(rel); },
    writeLegacySaveFile(rel, json) {
      legacyWrites.push(rel);
      files.set(rel, json);
    },
  };
  return { deps, builds, runs, logs, files, legacyWrites };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A marked+terminal log pair for one state. */
function logFor(state: SessionState, menu?: MenuStateShape | null): LogEntry[] {
  const terminal = { ...state, frame: state.frame + POST_LOAD_CONTINUE_FRAMES } as SessionState;
  return [
    { kind: "marked", frame: 1, state, menu: menu ?? null },
    { kind: "terminal", frame: 2, state: terminal },
  ];
}

describe("phase dispatch", () => {
  test("the documented phases include legacy compatibility", () => {
    expect([...PHASES]).toEqual(["save", "load", "legacy", "autosave", "failure"]);
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

describe("source-fallback PSP package", () => {
  test("removes only PSP bytecode while preserving source and other variants", () => {
    const source = new TextEncoder().encode("globalThis.frame=()=>0;\0");
    const pspBytecode = new Uint8Array([1, 2, 3]);
    const desktopBytecode = new Uint8Array([4, 5, 6]);
    const pkg = encodePocketPackage({
      manifest: new TextEncoder().encode("{}"),
      variants: [
        { target: "psp", hostAbi: 1, sections: [
          { kind: POCKET_SECTION.js, bytes: source },
          { kind: POCKET_SECTION.bytecode, bytes: pspBytecode },
        ] },
        { target: "linux-app", hostAbi: 1, sections: [
          { kind: POCKET_SECTION.js, bytes: source },
          { kind: POCKET_SECTION.bytecode, bytes: desktopBytecode },
        ] },
      ],
    });

    const transformed = decodePocketPackage(makeSourceOnlyPspPackage(pkg));
    const psp = findVariant(transformed, "psp")!;
    const desktop = findVariant(transformed, "linux-app")!;
    expect(findSection(psp, POCKET_SECTION.js)).toEqual(source);
    expect(findSection(psp, POCKET_SECTION.bytecode)).toBeNull();
    expect(findSection(desktop, POCKET_SECTION.bytecode)).toEqual(desktopBytecode);
  });

  test("rejects packages without one PSP source and bytecode pair", () => {
    const sourceOnly = encodePocketPackage({
      manifest: new TextEncoder().encode("{}"),
      variants: [{ target: "psp", hostAbi: 1, sections: [
        { kind: POCKET_SECTION.js, bytes: new TextEncoder().encode("source\0") },
      ] }],
    });
    expect(() => makeSourceOnlyPspPackage(sourceOnly)).toThrow(/expected one QJBC section/);
  });
});

describe("PSP memstick path projection", () => {
  test("appends the logical save path exactly once below the PocketJS app root", () => {
    expect(pspPhysicalSavePath("/memstick", "save/slot-1.json"))
      .toBe("/memstick/PSP/COMMON/pocketjs/save/slot-1.json");
    expect(pspPhysicalSavePath("/memstick", "save/autosave.json"))
      .toBe("/memstick/PSP/COMMON/pocketjs/save/autosave.json");
  });

  test("rejects paths outside the PSP save namespace", () => {
    expect(() => pspPhysicalSavePath("/memstick", "slot-1.json")).toThrow(/invalid PSP save path/);
    expect(() => pspPhysicalSavePath("/memstick", "save/nested/slot-1.json")).toThrow(/invalid PSP save path/);
    expect(() => pspPhysicalSavePath("/memstick", "save/../slot-1.json")).toThrow(/invalid PSP save path/);
  });
});

describe("START menu tape navigation", () => {
  const pressedEdges = (tape: Tape): number[] => tape.masks
    .slice(OPENING_PREFIX + 30)
    .filter((mask) => mask !== 0);

  test("manual save traverses START Save, save root and slot 1", () => {
    const tape = saveTape();
    expect(pressedEdges(tape)).toEqual([0x0008, 0x0040, 0x2000, 0x2000, 0x2000]);
    expect(tape.logAt).toBe(tape.masks.length);
  });

  test("manual and automatic load traverse START Load", () => {
    const expected = [0x0008, 0x0040, 0x0040, 0x2000, 0x2000];
    const manual = loadTape();
    const automatic = autosaveContinueTape();
    expect(pressedEdges(manual)).toEqual(expected);
    expect(pressedEdges(automatic)).toEqual(expected);
    expect(manual.logAt).toBe(manual.masks.length - POST_LOAD_CONTINUE_FRAMES);
    expect(automatic.logAt).toBe(automatic.masks.length - POST_LOAD_CONTINUE_FRAMES);
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

  test("legacy passes after replacing the framed slot with raw JSON", () => {
    const state = fakeState();
    const fake = makeFakeDeps({
      save: logFor(state),
      load: logFor(state),
    });
    expect(() => runPhase("legacy", fake.deps)).not.toThrow();
    expect(fake.runs).toEqual(["save", "load"]);
    expect(fake.legacyWrites).toEqual(["save/slot-1.json"]);
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

  test("failure recognises the localized Chinese failure title", () => {
    const state = fakeState();
    const fake = makeFakeDeps({
      failure: logFor(state, { kind: "message", title: "保存失败", body: "只读" }),
    }, { language: "zh" });
    expect(() => runPhase("failure", fake.deps)).not.toThrow();
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

describe("a partial emulator log fails every successful phase", () => {
  for (const phase of ["save", "load", "legacy", "autosave"] as const) {
    test(`${phase} rejects marked without terminal`, () => {
      const state = fakeState();
      const markedOnly = [{ kind: "marked", frame: 1, state }];
      const fake = makeFakeDeps({
        save: markedOnly,
        load: markedOnly,
        "autosave-trigger": markedOnly,
        "autosave-continue": markedOnly,
      });
      fake.files.set("save/autosave.json", JSON.stringify({ frame: 2544 }));
      expect(() => runPhase(phase, fake.deps)).toThrow(/no terminal log entry with a state/);
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

  test("load throws when it restores but does not continue the game loop", () => {
    const state = fakeState();
    const stalled = [
      { kind: "marked", frame: 1, state },
      { kind: "terminal", frame: 2, state },
    ];
    const fake = makeFakeDeps({ save: logFor(state), load: stalled });
    expect(() => runPhase("load", fake.deps)).toThrow(/did not continue/);
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
    // save runs once (phaseSave), load and legacy reuse its artifact, then
    // autosave (trigger+continue), then failure.
    expect(fake.runs).toEqual([
      "save",
      "load",
      "load",
      "autosave-trigger",
      "autosave-continue",
      "failure",
    ]);
    expect(fake.legacyWrites).toEqual(["save/slot-1.json"]);
  });
});

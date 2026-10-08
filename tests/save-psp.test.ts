// PSP memory-stick save bridge: the host __pspSave FFI wrapped as the kit's
// SaveStore and AutosaveBridge, plus its slot in detectSlotStore/
// detectAutosaveChannel. The real FFI runs under PPSSPP (verify:psp:save);
// here a fake host stands in for the Rust side, including its failure modes.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";

import { FIXED_INITIAL_CIVIL_TIME } from "../battle/time-weather.ts";
import { SaveError } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import { startSession, stepSession, type Session, type SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { UiTextOverrides } from "../vendor/pocket-rpgkit/src/engine/ui-text.ts";
import { createOsk } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/src/osk-controller.ts";
import {
  createGameSession,
  input,
  loadGb6Tape,
} from "../tools/save-resume.ts";
import {
  detectAutosaveChannel,
  detectSlotStore,
  inspectAutosaveSlot,
  listSlots,
  loadAutosaveSlot,
  loadSlot,
  persistAutosave,
  saveBlockReason,
  saveSlot,
  takeSaveSnapshot,
} from "../ui/save-game.ts";
import { pspAutosaveBridge, pspSaveHost, pspSaveStore, type PspSaveHost } from "../ui/save-psp.ts";
import { createSaveMenuRuntime, type SaveMenuRuntime } from "../ui/save-menu-runtime.ts";

const tape = loadGb6Tape();
const PREFIX = 6500;

/** A fake of the PSP host's __pspSave FFI: an in-memory file tree with the
 *  same contract (read null when absent, write/remove throw on failure). */
function fakePspSaveHost(fail: { read?: boolean; write?: boolean; remove?: boolean } = {}) {
  const files = new Map<string, string>();
  const host: PspSaveHost & { files: Map<string, string> } = {
    files,
    read(path) {
      if (fail.read) throw new Error("memstick read error");
      const v = files.get(path);
      return v === undefined ? null : v;
    },
    write(path, data) {
      if (fail.write) throw new Error("memstick is read-only");
      files.set(path, data);
      return true;
    },
    remove(path) {
      if (fail.remove) throw new Error("memstick remove error");
      files.delete(path);
      return true;
    },
  };
  return host;
}

const g = globalThis as { __pspSave?: unknown; __rpgkitAutosave?: unknown };
let savedSave: PropertyDescriptor | undefined;
let savedAutosave: PropertyDescriptor | undefined;
beforeEach(() => {
  savedSave = Object.getOwnPropertyDescriptor(globalThis, "__pspSave");
  savedAutosave = Object.getOwnPropertyDescriptor(globalThis, "__rpgkitAutosave");
  delete g.__pspSave;
  delete g.__rpgkitAutosave;
});
afterEach(() => {
  delete g.__pspSave;
  delete g.__rpgkitAutosave;
  if (savedSave) Object.defineProperty(globalThis, "__pspSave", savedSave);
  if (savedAutosave) Object.defineProperty(globalThis, "__rpgkitAutosave", savedAutosave);
});

/** Replay the GB6 prefix once and keep a safe state past the first map. */
const sampled = (() => {
  const { project, session } = createGameSession(FIXED_INITIAL_CIVIL_TIME);
  let state = startSession(project, session);
  let previous = 0;
  let safe: SessionState | null = null;
  for (let frame = 0; frame < PREFIX; frame++) {
    const mask = tape.masks[frame]!;
    state = stepSession(session, state, input(mask, previous));
    previous = mask;
    if (frame > 3300 && !safe && saveBlockReason(state) === null) safe = state;
  }
  return { project, session, safe: safe! };
})();

describe("PSP host detection", () => {
  test("no host bridge on other targets", () => {
    expect(pspSaveHost()).toBeNull();
    expect(pspSaveStore()).toBeNull();
    expect(pspAutosaveBridge()).toBeNull();
  });

  test("a complete bridge is detected; a malformed one is rejected", () => {
    g.__pspSave = fakePspSaveHost();
    expect(pspSaveHost()).not.toBeNull();
    expect(pspSaveStore()).not.toBeNull();
    expect(pspAutosaveBridge()).not.toBeNull();
    for (const malformed of [
      null,
      {},
      { read: "nope", write() {}, remove() {} },
      { read() {}, write() {} },
    ]) {
      g.__pspSave = malformed;
      expect(pspSaveHost()).toBeNull();
      expect(pspSaveStore()).toBeNull();
      expect(pspAutosaveBridge()).toBeNull();
    }
  });
});

describe("PSP slot store", () => {
  test("write, read, exists and remove round-trip through the host", () => {
    const host = fakePspSaveHost();
    g.__pspSave = host;
    const store = pspSaveStore()!;
    expect(store.exists(1)).toBe(false);
    expect(store.read(1)).toBeNull();
    const { session, safe } = sampled;
    const snapshot = takeSaveSnapshot(session, safe, 0);
    saveSlot({ channel: "psp", store }, 1, snapshot, session.content);
    expect(store.exists(1)).toBe(true);
    // The host sees the same relative path the desktop fs store uses.
    expect(host.files.has("save/slot-1.json")).toBe(true);
    const listed = listSlots({ channel: "psp", store }, session.content);
    expect(listed[0]).toMatchObject({ slot: 1, map: safe.mapId });
    const loaded = loadSlot({ channel: "psp", store }, 1, session.content);
    expect(loaded.map).toBe(safe.mapId);
    store.remove?.(1);
    expect(store.exists(1)).toBe(false);
    expect(store.read(1)).toBeNull();
  });

  test("a host write failure surfaces as a thrown error, not a silent drop", () => {
    g.__pspSave = fakePspSaveHost({ write: true });
    const store = pspSaveStore()!;
    const { session, safe } = sampled;
    const snapshot = takeSaveSnapshot(session, safe, 0);
    expect(() => saveSlot({ channel: "psp", store }, 2, snapshot, session.content)).toThrow("read-only");
    // Nothing was written.
    expect(store.read(2)).toBeNull();
  });

  test("a host read failure is an error for the store, a damaged row for the menu", () => {
    g.__pspSave = fakePspSaveHost({ read: true });
    const store = pspSaveStore()!;
    expect(() => store.read(1)).toThrow("memstick read error");
    const listed = listSlots({ channel: "psp", store }, sampled.session.content);
    expect(listed[0]).toMatchObject({ slot: 1, error: "memstick read error" });
  });

  test("ENOENT is an empty slot; a non-ENOENT read failure is a damaged row", () => {
    // The host contract: read returns null only for ENOENT (absent) and
    // throws for every other sceIoOpen failure. A host that throws the
    // PSP EACCES code (0x8001000D) on slot 1 and reports slot 2 absent
    // must show slot 1 as a damaged row, not an empty one.
    const host = fakePspSaveHost();
    host.read = (path: string) => {
      if (path === "save/slot-1.json") throw new Error("0x8001000D");
      return null; // ENOENT for every other path
    };
    g.__pspSave = host;
    const store = pspSaveStore()!;
    const listed = listSlots({ channel: "psp", store }, sampled.session.content);
    expect(listed[0]).toMatchObject({ slot: 1, error: "0x8001000D" });
    expect(listed[1]).toBeNull();
    expect(store.exists(1)).toBe(false);
    expect(store.read(2)).toBeNull();
  });
});

describe("PSP autosave bridge", () => {
  test("an absent autosave remains omitted", () => {
    g.__pspSave = fakePspSaveHost();
    g.__rpgkitAutosave = pspAutosaveBridge()!;
    expect(loadAutosaveSlot(sampled.session.content)).toBeNull();
    expect(inspectAutosaveSlot(sampled.session.content)).toBeNull();
  });

  test("persist, inspect and load the automatic slot", () => {
    g.__pspSave = fakePspSaveHost();
    g.__rpgkitAutosave = pspAutosaveBridge()!;
    expect(detectAutosaveChannel()).toBe("psp");
    const { session, safe } = sampled;
    const snapshot = takeSaveSnapshot(session, safe, 0);
    expect(persistAutosave(snapshot, session.content)).toBe(true);
    const status = inspectAutosaveSlot(session.content);
    expect(status).toMatchObject({ slot: 0, map: safe.mapId });
    const loaded = loadAutosaveSlot(session.content);
    expect(loaded?.map).toBe(safe.mapId);
  });

  test("a failed write reports false so the autosave stays a visible no-op", () => {
    g.__pspSave = fakePspSaveHost({ write: true });
    g.__rpgkitAutosave = pspAutosaveBridge()!;
    const { session, safe } = sampled;
    expect(persistAutosave(takeSaveSnapshot(session, safe, 0), session.content)).toBe(false);
    expect(loadAutosaveSlot(session.content)).toBeNull();
  });

  test("a failed read stays visible as a damaged autosave and throws on load", () => {
    g.__pspSave = fakePspSaveHost({ read: true });
    g.__rpgkitAutosave = pspAutosaveBridge()!;
    expect(() => loadAutosaveSlot(sampled.session.content)).toThrow("memstick read error");
    expect(inspectAutosaveSlot(sampled.session.content)).toMatchObject({
      slot: 0,
      error: "memstick read error",
    });
  });
});

describe("channel detection with a PSP host", () => {
  test("the PSP store wins over browser storage, loses to data.fs", () => {
    g.__pspSave = fakePspSaveHost();
    expect(detectSlotStore()?.channel).toBe("psp");
    expect(detectAutosaveChannel()).toBe("psp");
  });
});

describe("START menu runtime on PSP", () => {
  const BTN_START = 0x0008;
  const BTN_UP = 0x0010;
  const BTN_DOWN = 0x0040;
  const BTN_CIRCLE = 0x2000;

  const mount = (options: {
    host?: ReturnType<typeof fakePspSaveHost>;
    uiText?: UiTextOverrides;
    autosave?: boolean;
  } = {}): { live: { session: Session; state: SessionState; held: number; step(mask: number): void }; menu: SaveMenuRuntime; dispose: () => void; host: ReturnType<typeof fakePspSaveHost> } => {
    const { project, session } = createGameSession(FIXED_INITIAL_CIVIL_TIME);
    const live = {
      session,
      state: startSession(project, session),
      held: 0,
      step(mask: number) {
        this.state = stepSession(session, this.state, input(mask, this.held));
        this.held = mask;
      },
    };
    const host = options.host ?? fakePspSaveHost();
    g.__pspSave = host;
    if (options.autosave) g.__rpgkitAutosave = pspAutosaveBridge()!;
    let dispose = () => {};
    const menu = createRoot((d) => {
      dispose = d;
      return createSaveMenuRuntime(
        { slots: detectSlotStore() },
        {
          project,
          session,
          getState: () => live.state,
          heldButtons: () => live.held,
          replaceState(next, held = 0) {
            live.state = next;
            live.held = held;
          },
        },
        (oskOptions) => createOsk(oskOptions),
        () => options.uiText,
      );
    });
    return { live, menu, dispose, host };
  };

  test("the menu title names the memory stick and a save lands in a slot file", () => {
    const { live, menu, dispose, host } = mount();
    try {
      expect(menu.title).toBe("SAVE — memory stick");
      // Walk to a safe point, then START opens the menu.
      let previous = 0;
      for (let frame = 0; frame < PREFIX; frame++) {
        const mask = tape.masks[frame]!;
        live.step(mask);
        previous = mask;
      }
      live.held = 0;
      expect(menu.step(0, BTN_START).consumed).toBe(true);
      expect(menu.menu().kind).toBe("root");
      // Root row 0 is "Save to slot"; confirm, then confirm slot 1.
      expect(menu.step(0, BTN_CIRCLE).consumed).toBe(true);
      expect(menu.menu().kind).toBe("slots-save");
      expect(menu.step(0, BTN_CIRCLE).consumed).toBe(true);
      expect(menu.menu().kind).toBe("message");
      expect(host.files.has("save/slot-1.json")).toBe(true);
      // The slot listing now shows the save.
      expect(menu.slots()[0]).toMatchObject({ slot: 1, map: live.state.mapId });
    } finally {
      dispose();
    }
  });

  test("a load restores the saved state", () => {
    const { live, menu, dispose } = mount();
    try {
      let previous = 0;
      for (let frame = 0; frame < PREFIX; frame++) {
        const mask = tape.masks[frame]!;
        live.step(mask);
        previous = mask;
      }
      const savedMap = live.state.mapId;
      live.held = 0;
      menu.step(0, BTN_START);
      menu.step(0, BTN_CIRCLE); // root: Save to slot
      menu.step(0, BTN_CIRCLE); // slot 1
      expect(menu.menu().kind).toBe("message");
      // Close, walk on, then load slot 1 back.
      menu.step(0, BTN_START);
      for (let frame = PREFIX; frame < PREFIX + 400; frame++) {
        live.step(tape.masks[frame]!);
      }
      live.held = 0;
      menu.step(0, BTN_START);
      menu.step(0, BTN_DOWN); // root: Load from slot
      menu.step(0, BTN_CIRCLE);
      expect(menu.menu().kind).toBe("slots-load");
      menu.step(0, BTN_CIRCLE); // slot 1
      expect(live.state.mapId).toBe(savedMap);
    } finally {
      dispose();
    }
  });

  test("a PSP autosave read error remains selectable and shows the localized failure", () => {
    const host = fakePspSaveHost({ read: true });
    const { menu, dispose } = mount({
      host,
      autosave: true,
      uiText: {
        "save.loadAutosaveFailedTitle": "自动存档读取失败",
        "save.loadErrorRead": "记忆棒上的自动存档无法读取。",
      },
    });
    try {
      menu.step(0, BTN_START);
      expect(menu.autosave()).toMatchObject({ slot: 0, error: "memstick read error" });
      menu.step(0, BTN_DOWN); // root: Load from slot
      menu.step(0, BTN_CIRCLE);
      expect(menu.menu()).toMatchObject({ kind: "slots-load", index: 0 });
      menu.step(0, BTN_CIRCLE); // damaged Automatic Save row remains actionable
      expect(menu.menu()).toMatchObject({
        kind: "message",
        title: "自动存档读取失败",
        body: "记忆棒上的自动存档无法读取。",
      });
    } finally {
      dispose();
    }
  });
});

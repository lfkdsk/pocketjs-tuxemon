import { afterEach, describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";

import { createSessionSnapshot } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import {
  createSession,
  startSession,
  type Session,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { Project } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { createSimAutosaveBridge } from "../vendor/pocket-rpgkit/src/host/autosave.ts";
import { createOsk } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/src/osk-controller.ts";
import {
  browserSaveStore,
  persistAutosave,
  saveSlot,
  type SlotStore,
  type StorageLike,
} from "../ui/save-game.ts";
import {
  createSaveMenuRuntime,
  type PocketTuxemonSaveHook,
  type SaveMenuRuntime,
} from "../ui/save-menu-runtime.ts";

const PROJECT: Project = {
  format: "rpgkit-project/v1",
  title: "save-menu-runtime",
  tileSize: 16,
  start: { map: "test", x: 1, y: 1, dir: "down" },
  sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
  items: [],
  maps: [{
    id: "test",
    name: "test",
    width: 4,
    height: 4,
    ground: new Array(16).fill("plain.0"),
  }],
};

function memoryStorage(): StorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

interface MountedMenu {
  runtime: SaveMenuRuntime;
  hook: PocketTuxemonSaveHook;
  slots: SlotStore;
  content: Session["content"];
  state: () => SessionState;
  replacements: () => number;
  snapshot: () => ReturnType<typeof createSessionSnapshot>;
  dispose: () => void;
}

function mount(): MountedMenu {
  const session = createSession(PROJECT);
  let state = startSession(PROJECT, session);
  let replacements = 0;
  const slots: SlotStore = {
    channel: "browser",
    store: browserSaveStore(memoryStorage()),
  };
  let dispose = () => {};
  const runtime = createRoot((cleanup) => {
    dispose = cleanup;
    return createSaveMenuRuntime({ slots }, {
      project: PROJECT,
      session,
      getState: () => state,
      heldButtons: () => 0,
      replaceState(next) {
        state = next;
        replacements++;
      },
    }, createOsk);
  });
  const hook = globalThis.__pocketTuxemonSave;
  if (!hook) throw new Error("save menu did not publish its integration hook");
  return {
    runtime,
    hook,
    slots,
    content: session.content,
    state: () => state,
    replacements: () => replacements,
    snapshot: () => createSessionSnapshot(session, state, 0),
    dispose,
  };
}

afterEach(() => {
  delete globalThis.__pocketTuxemonSave;
});

describe("save menu public handoff", () => {
  test("opens the legacy root, load page, and code importer and signals dismissal", () => {
    const mounted = mount();
    try {
      mounted.hook.open();
      expect(mounted.runtime.menu()).toEqual({ kind: "root", index: 0 });
      expect(mounted.hook.completion()).toBeNull();

      mounted.hook.open("load");
      expect(mounted.runtime.menu()).toEqual({ kind: "slots-load", index: 0 });

      mounted.hook.close();
      expect(mounted.runtime.menu()).toEqual({ kind: "closed" });
      expect(mounted.hook.completion()).toEqual({ kind: "dismissed" });

      mounted.hook.open("code");
      expect(mounted.runtime.menu()).toEqual({ kind: "code-import" });
      expect(mounted.runtime.osk.isOpen()).toBe(true);
      expect(mounted.hook.completion()).toBeNull();
      mounted.hook.close();
      expect(mounted.runtime.osk.isOpen()).toBe(false);
    } finally {
      mounted.dispose();
    }
  });

  test("loads a numbered slot directly and publishes its completion target", () => {
    const mounted = mount();
    try {
      saveSlot(mounted.slots, 2, mounted.snapshot(), mounted.content);
      expect(mounted.hook.loadSlot(2)).toBe(true);
      expect(mounted.replacements()).toBe(1);
      expect(mounted.runtime.menu()).toEqual({ kind: "closed" });
      expect(mounted.runtime.toast()).toBe("Loaded slot 2");
      expect(mounted.hook.completion()).toEqual({
        kind: "loaded",
        target: { kind: "slot", slot: 2 },
      });
      expect(() => mounted.hook.loadSlot(0)).toThrow(RangeError);
    } finally {
      mounted.dispose();
    }
  });

  test("loads the automatic slot directly and reports autosave completion", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "__rpgkitAutosave");
    globalThis.__rpgkitAutosave = createSimAutosaveBridge();
    const mounted = mount();
    try {
      expect(persistAutosave(mounted.snapshot(), mounted.content)).toBe(true);
      expect(mounted.runtime.loadAutosave()).toBe(true);
      expect(mounted.replacements()).toBe(1);
      expect(mounted.runtime.toast()).toBe("Loaded autosave");
      expect(mounted.runtime.completion()).toEqual({
        kind: "loaded",
        target: { kind: "autosave" },
      });
    } finally {
      mounted.dispose();
      delete globalThis.__rpgkitAutosave;
      if (descriptor) Object.defineProperty(globalThis, "__rpgkitAutosave", descriptor);
    }
  });
});

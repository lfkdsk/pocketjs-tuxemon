// Save and load: save points, a short GB6 save/resume, damaged, foreign and
// empty saves, the three storage channels, and the START menu runtime.
// The whole-mainline resume check is `bun run verify:save`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";

import { FIXED_INITIAL_CIVIL_TIME } from "../battle/time-weather.ts";
import {
  decodeEnvelopeText,
  encodeEnvelope,
  SaveError,
} from "../vendor/pocket-rpgkit/src/engine/save.ts";
import { restoreSessionSnapshot } from "../vendor/pocket-rpgkit/src/engine/save-restore.ts";
import { startSession, stepSession, type Session, type SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { createOsk } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/src/osk-controller.ts";
import { createSimFsHost } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/fs.ts";
import { createSimAutosaveBridge } from "../vendor/pocket-rpgkit/src/host/autosave.ts";
import {
  afterBattle,
  afterMapChange,
  createGameSession,
  digest,
  input,
  loadGb6Tape,
  verifySaveResume,
} from "../tools/save-resume.ts";
import {
  BROWSER_SAVE_KEY_PREFIX,
  browserSaveStore,
  describeLoadError,
  detectAutosaveChannel,
  detectSlotStore,
  exportSaveCode,
  importSaveCode,
  inspectAutosaveSlot,
  isLegacySaveExt,
  LEGACY_SAVE_EXT_FORMAT,
  listSlots,
  loadAutosaveSlot,
  loadSlot,
  persistAutosave,
  restoreSave,
  saveBlockReason,
  SaveRefused,
  saveSlot,
  takeSaveSnapshot,
  type SlotStore,
  type StorageLike,
} from "../ui/save-game.ts";
import { createSaveMenuRuntime, type SaveMenuRuntime } from "../ui/save-menu-runtime.ts";

const BTN_START = 0x0008;
const BTN_UP = 0x0010;
const BTN_DOWN = 0x0040;
const BTN_CIRCLE = 0x2000;
const BTN_CROSS = 0x4000;

const tape = loadGb6Tape();
/** Frames of the GB6 tape the short resume checks replay. */
const PREFIX = 6500;

function memoryStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

interface Sampled {
  safe: SessionState;
  modal: SessionState;
  battle: SessionState;
  walking: SessionState;
  locked: SessionState;
}

/** Replay the GB6 prefix once and keep one state of each kind. */
const sampled = (() => {
  const { project, session } = createGameSession(FIXED_INITIAL_CIVIL_TIME);
  let state = startSession(project, session);
  let previous = 0;
  const found: Partial<Sampled> = {};
  for (let frame = 0; frame < 6500 && Object.keys(found).length < 5; frame++) {
    const mask = tape.masks[frame]!;
    state = stepSession(session, state, input(mask, previous));
    previous = mask;
    if (frame > 3300 && !found.safe && saveBlockReason(state) === null) found.safe = state;
    if (!found.modal && state.interp.modal !== null && state.scene === null) found.modal = state;
    if (!found.battle && state.scene !== null) found.battle = state;
    if (!found.walking && state.move.moving && state.interp.modal === null && !state.interp.inputLocked
      && state.interp.main === null && state.scene === null && state.fade === null) found.walking = state;
    if (!found.locked && state.interp.inputLocked && state.interp.modal === null && state.scene === null
      && state.fade === null && !state.move.moving) found.locked = state;
  }
  return { project, session, states: found as Sampled };
})();

describe("save points", () => {
  test("off a save point the reason is visible and no snapshot is made", () => {
    const { session, states } = sampled;
    expect(saveBlockReason(states.safe)).toBeNull();
    expect(saveBlockReason(states.modal)).toBe("Finish the conversation first.");
    expect(saveBlockReason(states.battle)).toBe("You can't save during a battle.");
    expect(saveBlockReason(states.walking)).toBe("Stop walking first.");
    expect(saveBlockReason(states.locked)).toBe("Wait until the scene is over.");
    for (const unsafe of [states.modal, states.battle, states.walking, states.locked]) {
      expect(() => takeSaveSnapshot(session, unsafe, 0)).toThrow(SaveRefused);
    }
  });

  test("a save carries the map's characters in the kit's map runtime", () => {
    const { session, states } = sampled;
    const snapshot = takeSaveSnapshot(session, states.safe, 0);
    expect(isLegacySaveExt(snapshot.ext)).toBe(false);
    expect(Object.keys(snapshot.mapRuntime!.chars.chars).length).toBeGreaterThan(0);
    const restored = restoreSave(session, decodeEnvelopeText(encodeEnvelope(snapshot, session.content), session.content));
    expect(digest({ ...restored, frame: states.safe.frame })).toBe(digest(states.safe));
    // The kit's own restore is the same path.
    const generic = restoreSessionSnapshot(session, snapshot);
    expect(digest({ ...generic, frame: states.safe.frame })).toBe(digest(states.safe));
  });

  test("an old save with the character table in the extension slot is migrated", () => {
    const { session, states } = sampled;
    const current = takeSaveSnapshot(session, states.safe, 0);
    // The format the save menu wrote before the kit stored map runtime.
    const { mapRuntime, ...rest } = current;
    const legacy = {
      ...rest,
      ext: { format: LEGACY_SAVE_EXT_FORMAT, ext: current.ext, chars: mapRuntime!.chars },
    } as unknown as typeof current;
    expect(LEGACY_SAVE_EXT_FORMAT).toBe("pocket-tuxemon/save-ext/v1");
    const code = exportSaveCode(session, legacy);
    const decoded = importSaveCode(session, code);
    expect(isLegacySaveExt(decoded.ext)).toBe(true);
    expect(decoded.mapRuntime).toBeUndefined();
    const restored = restoreSave(session, decoded);
    expect(digest({ ...restored, frame: states.safe.frame })).toBe(digest(states.safe));
    // A generic kit restore still loads it, rebuilding the table from the map.
    const generic = restoreSessionSnapshot(session, decoded);
    expect(generic.chars.chars).toEqual({});
    expect(digest(generic.ext)).toBe(digest(states.safe.ext));
  });
});

describe("save and resume on the GB6 mainline prefix", () => {
  test("after a battle, after a map change and after a later battle", () => {
    // Save points follow the recorded tape: Billie's battle, the first
    // arrival on route 1, and the last wild battle of the prefix.
    const billie = tape.battles.find((b) => b.opponent === "spyder_billie")!;
    const route1 = tape.maps.find((m) => m.map === "spyder_route1")!;
    const wild = tape.battles.filter((b) => b.kind === "wild" && b.endFrame < PREFIX - 700).at(-1)!;
    expect(billie.endFrame < route1.frame && route1.frame < wild.endFrame).toBe(true);
    const report = verifySaveResume(tape.masks.slice(0, PREFIX), [
      afterBattle("after-billie", billie.endFrame),
      afterMapChange("route-1", route1.frame),
      afterBattle("after-wild", wild.endFrame),
    ]);
    expect(report.points.map((p) => p.id)).toEqual(["after-billie", "route-1", "after-wild"]);
    expect(report.points.map((p) => p.channel)).toEqual(["slot", "code", "slot"]);
    for (const resume of report.resumes) {
      expect(resume.restoredDiff).toEqual([]);
      expect(resume.onlyFrameDiffers).toBe(true);
      expect(resume.terminalSha256).toBe(report.terminalSha256);
    }
  }, 60_000);
});

describe("bad, foreign and empty saves", () => {
  const { session, states } = sampled;
  const slots = (): { slots: SlotStore; storage: ReturnType<typeof memoryStorage> } => {
    const storage = memoryStorage();
    return { slots: { channel: "browser", store: browserSaveStore(storage) }, storage };
  };

  test("an empty slot lists as empty and refuses to load", () => {
    const { slots: store } = slots();
    expect(listSlots(store, session.content)).toEqual([null, null, null]);
    expect(() => loadSlot(store, 2, session.content)).toThrow(/slot 2 is empty/);
  });

  test("a damaged slot lists as damaged and loads with a visible reason", () => {
    const { slots: store, storage } = slots();
    saveSlot(store, 1, takeSaveSnapshot(session, states.safe, 0), session.content);
    const key = `${BROWSER_SAVE_KEY_PREFIX}1`;
    storage.map.set(key, storage.map.get(key)!.replace(/"gold":(\d+)/, (_, gold) => `"gold":${Number(gold) + 1}`));
    const listed = listSlots(store, session.content)[0];
    expect(listed && "error" in listed).toBe(true);
    let caught: unknown;
    try {
      loadSlot(store, 1, session.content);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SaveError);
    expect(describeLoadError(caught)).toBe("That save is damaged (checksum mismatch).");
    storage.map.set(key, "{not json");
    expect(() => loadSlot(store, 1, session.content)).toThrow(SaveError);
  });

  test("a save from another build is rejected", () => {
    const { slots: store } = slots();
    const snapshot = takeSaveSnapshot(session, states.safe, 0);
    saveSlot(store, 3, snapshot, { manifest: "another-build", schema: session.content!.schema });
    let caught: unknown;
    try {
      loadSlot(store, 3, session.content);
    } catch (error) {
      caught = error;
    }
    expect((caught as SaveError).code).toBe("content");
    expect(describeLoadError(caught)).toBe("That save is from another build of the game.");
    // The chapter snapshots are content-free kit envelopes: also refused.
    expect(() => importSaveCode(session, exportSaveCode({ ...session, content: null }, snapshot))).toThrow(SaveError);
  });

  test("a well-formed envelope with an impossible character table is refused", () => {
    const snapshot = takeSaveSnapshot(session, states.safe, 0);
    const first = Object.keys(snapshot.mapRuntime!.chars.chars)[0]!;
    const legacy = {
      ...snapshot,
      ext: { format: LEGACY_SAVE_EXT_FORMAT, ext: snapshot.ext, chars: structuredClone(snapshot.mapRuntime!.chars) },
      mapRuntime: undefined,
    } as unknown as typeof snapshot;
    delete (legacy as { mapRuntime?: unknown }).mapRuntime;
    snapshot.mapRuntime!.chars.chars[first]!.tx = 10_000;
    expect(() => restoreSave(session, importSaveCode(session, exportSaveCode(session, snapshot)))).toThrow(SaveError);
    // An old save goes through the same checks after migration.
    (legacy.ext as unknown as { chars: { chars: Record<string, { tx: number }> } }).chars.chars[first]!.tx = 10_000;
    const decoded = importSaveCode(session, exportSaveCode(session, legacy));
    expect(() => restoreSave(session, decoded)).toThrow(SaveError);
  });

  test("garbage save codes are refused with a visible reason", () => {
    for (const code of ["", "hello", "AAAA", "!!!"]) {
      let caught: unknown;
      try {
        importSaveCode(session, code);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SaveError);
      expect(describeLoadError(caught)).toBe("That is not a Pocket Tuxemon save.");
    }
  });
});

describe("storage channels", () => {
  const g = globalThis as { fs?: unknown; localStorage?: unknown; __rpgkitAutosave?: unknown };
  // Other suites boot worlds that mount these host globals and do not tear
  // them down, so start from a clean slate and put back what was there.
  const keys = ["fs", "localStorage", "__rpgkitAutosave"] as const;
  let saved: (PropertyDescriptor | undefined)[] = [];
  beforeEach(() => {
    saved = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
    for (const key of keys) delete g[key];
  });
  afterEach(() => {
    keys.forEach((key, i) => {
      delete g[key];
      const descriptor = saved[i];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    });
  });

  test("data.fs first, then browser storage, else save codes only", () => {
    expect(detectSlotStore()).toBeNull();
    g.localStorage = memoryStorage();
    expect(detectSlotStore()?.channel).toBe("browser");
    const host = createSimFsHost();
    g.fs = host.ns;
    const desktop = detectSlotStore()!;
    expect(desktop.channel).toBe("desktop");
    const { session, states } = sampled;
    saveSlot(desktop, 2, takeSaveSnapshot(session, states.safe, 0), session.content);
    expect(host.log.some((line) => line.startsWith("op write save/slot-2.json"))).toBe(true);
    const listed = listSlots(desktop, session.content);
    expect(listed[1]).toMatchObject({ slot: 2, map: states.safe.mapId });
    host.dispose();
  });

  test("storage that refuses writes falls back to save codes", () => {
    g.localStorage = { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => {} };
    expect(detectSlotStore()).toBeNull();
  });

  test("autosave chooses desktop data.fs, then the browser bridge, else a quiet no-op", () => {
    const snapshot = takeSaveSnapshot(sampled.session, sampled.states.safe, 0);
    expect(detectAutosaveChannel()).toBeNull();
    expect(persistAutosave(snapshot, sampled.session.content)).toBe(false);

    const bridge = createSimAutosaveBridge();
    g.__rpgkitAutosave = bridge;
    expect(detectAutosaveChannel()).toBe("browser");
    expect(persistAutosave(snapshot, sampled.session.content)).toBe(true);
    expect(inspectAutosaveSlot(sampled.session.content)).toMatchObject({
      slot: 0,
      map: sampled.states.safe.mapId,
    });
    expect(loadAutosaveSlot(sampled.session.content)?.map).toBe(sampled.states.safe.mapId);

    const host = createSimFsHost();
    g.fs = host.ns;
    expect(detectAutosaveChannel()).toBe("desktop");
    expect(persistAutosave(snapshot, sampled.session.content)).toBe(true);
    expect(host.log.some((line) => line.startsWith("op write save/autosave.json"))).toBe(true);
    expect(inspectAutosaveSlot(sampled.session.content)).toMatchObject({ slot: 0 });
    host.dispose();
  });
});

/** A live session behind the overlay host, folded like GameView without
 * an attract controller. */
interface LiveView {
  session: Session;
  state: SessionState;
  held: number;
  step(mask: number): void;
}

describe("START menu runtime", () => {
  const mount = (withSlots = true): { live: LiveView; menu: SaveMenuRuntime; dispose: () => void; storage: ReturnType<typeof memoryStorage> } => {
    const { project, session } = createGameSession(FIXED_INITIAL_CIVIL_TIME);
    const live: LiveView = {
      session,
      state: startSession(project, session),
      held: 0,
      step(mask) {
        this.state = stepSession(session, this.state, input(mask, this.held));
        this.held = mask;
      },
    };
    const storage = memoryStorage();
    let dispose = () => {};
    const menu = createRoot((d) => {
      dispose = d;
      return createSaveMenuRuntime(
        { slots: withSlots ? { channel: "browser", store: browserSaveStore(storage) } : null },
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
        createOsk,
      );
    });
    return { live, menu, dispose, storage };
  };
  let lastButtons = 0;
  const press = (menu: SaveMenuRuntime, buttons: number) => {
    const pressed = buttons & ~lastButtons;
    lastButtons = buttons;
    const result = menu.step(buttons, pressed);
    const released = menu.step(0, 0);
    lastButtons = 0;
    return { result, released };
  };
  const fold = (live: LiveView, from: number, to: number) => {
    for (let frame = from; frame < to; frame++) live.step(tape.masks[frame]!);
  };
  /** Fold to the first save point at or after frame 3400; returns the frame. */
  const foldToSavePoint = (live: LiveView): number => {
    let frame = 0;
    while (frame < 3400 || saveBlockReason(live.state) !== null) live.step(tape.masks[frame++]!);
    return frame;
  };

  test("START is ignored while another menu is open", () => {
    const { project, session } = sampled;
    let dispose = () => {};
    const runtime = createRoot((d) => {
      dispose = d;
      return createSaveMenuRuntime({ slots: null, suspended: () => true }, {
        project,
        session,
        getState: () => sampled.states.safe,
        heldButtons: () => 0,
        replaceState: () => {
          throw new Error("unexpected load");
        },
      }, createOsk);
    });
    expect(runtime.step(BTN_START, BTN_START)).toEqual({ consumed: false });
    expect(runtime.isOpen()).toBe(false);
    dispose();
  });

  test("save to a slot, refuse off a save point, then load it back", () => {
    const { live, menu, dispose, storage } = mount();
    const saveFrame = foldToSavePoint(live);
    const savedDigest = digest(live.state);

    // START opens; the world folds nothing while it is open.
    expect(press(menu, BTN_START).result).toEqual({ consumed: true });
    expect(menu.menu()).toEqual({ kind: "root", index: 0 });
    expect(menu.step(BTN_DOWN, 0).consumed).toBe(true); // a held button is not an edge
    press(menu, BTN_CIRCLE); // Save to slot
    expect(menu.menu()).toEqual({ kind: "slots-save", index: 0 });
    press(menu, BTN_CIRCLE); // slot 1
    expect(menu.menu()).toMatchObject({ kind: "message", title: "SAVED TO SLOT 1" });
    expect(storage.map.has(`${BROWSER_SAVE_KEY_PREFIX}1`)).toBe(true);
    expect(menu.slots()[0]).toMatchObject({ slot: 1, map: live.state.mapId });
    expect(digest(live.state)).toBe(savedDigest);
    press(menu, BTN_CIRCLE);
    press(menu, BTN_START); // close
    expect(menu.menu().kind).toBe("closed");
    expect(menu.isOpen()).toBe(false);

    // Walk on until a dialogue is open: saving is refused with the reason.
    let frame = saveFrame;
    while (live.state.interp.modal === null) live.step(tape.masks[frame++]!);
    press(menu, BTN_START);
    press(menu, BTN_CIRCLE);
    press(menu, BTN_CIRCLE);
    expect(menu.menu()).toMatchObject({ kind: "message", title: "CAN'T SAVE NOW", body: "Finish the conversation first." });
    press(menu, BTN_CROSS);
    expect(menu.menu()).toEqual({ kind: "slots-save", index: 0 });

    // Load slot 1 from the load page.
    press(menu, BTN_CROSS);
    press(menu, BTN_DOWN);
    press(menu, BTN_CIRCLE);
    expect(menu.menu()).toEqual({ kind: "slots-load", index: 0 });
    const { result } = press(menu, BTN_CIRCLE);
    expect(result).toEqual({ consumed: true, stateChanged: true });
    expect(menu.menu().kind).toBe("closed");
    expect(menu.toast()).toBe("Loaded slot 1");
    expect(digest({ ...live.state, frame: 0 })).toBe(digest({ ...sampledAt(saveFrame), frame: 0 }));
    dispose();
  }, 60_000);

  test("empty and damaged slots and a bad code show messages and keep the world", () => {
    const { live, menu, dispose, storage } = mount();
    foldToSavePoint(live);
    const before = digest(live.state);
    press(menu, BTN_START);
    press(menu, BTN_DOWN);
    press(menu, BTN_CIRCLE);
    press(menu, BTN_DOWN); // slot 2: empty
    press(menu, BTN_CIRCLE);
    expect(menu.menu()).toMatchObject({ kind: "message", title: "SLOT 2 IS EMPTY" });
    press(menu, BTN_CROSS);
    storage.map.set(`${BROWSER_SAVE_KEY_PREFIX}2`, "{oops");
    press(menu, BTN_CROSS);
    press(menu, BTN_START);
    press(menu, BTN_START);
    press(menu, BTN_DOWN);
    press(menu, BTN_CIRCLE);
    press(menu, BTN_DOWN);
    press(menu, BTN_CIRCLE);
    expect(menu.slots()[1]).toMatchObject({ slot: 2 });
    expect(menu.menu()).toMatchObject({ kind: "message", title: "CAN'T LOAD SLOT 2", body: "That is not a Pocket Tuxemon save." });
    press(menu, BTN_START);

    globalThis.__pocketTuxemonSave!.importCode("not-a-save-code");
    expect(menu.menu()).toMatchObject({ kind: "message", title: "CAN'T LOAD THAT CODE" });
    expect(digest(live.state)).toBe(before);
    dispose();
  }, 60_000);

  test("export a save code and import it back", () => {
    const { live, menu, dispose } = mount();
    const saveFrame = foldToSavePoint(live);
    const at = digest(live.state);
    press(menu, BTN_START);
    press(menu, BTN_DOWN);
    press(menu, BTN_DOWN);
    press(menu, BTN_CIRCLE);
    expect(menu.menu()).toEqual({ kind: "code-export", page: 0 });
    const code = menu.saveCode();
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    press(menu, BTN_CROSS);
    press(menu, BTN_START);
    fold(live, saveFrame, saveFrame + 200);
    expect(digest(live.state)).not.toBe(at);
    globalThis.__pocketTuxemonSave!.importCode(code);
    // The keyboard commits outside a step; the host presents the load.
    expect(menu.menu().kind).toBe("closed");
    expect(menu.toast()).toBe("Loaded save code");
    expect(digest({ ...live.state, frame: 0 })).toBe(digest({ ...sampledAt(saveFrame), frame: 0 }));
    dispose();
  }, 60_000);

  test("the read-only autosave row loads without becoming a manual save target", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "__rpgkitAutosave");
    const bridge = createSimAutosaveBridge();
    globalThis.__rpgkitAutosave = bridge;
    const { live, menu, dispose, storage } = mount();
    try {
      const saveFrame = foldToSavePoint(live);
      const at = digest(live.state);
      expect(persistAutosave(
        takeSaveSnapshot(live.session, live.state, live.held),
        live.session.content,
      )).toBe(true);
      fold(live, saveFrame, saveFrame + 200);
      expect(digest(live.state)).not.toBe(at);

      press(menu, BTN_START);
      expect(menu.autosave()).toMatchObject({ slot: 0 });
      press(menu, BTN_DOWN); // root: Load from slot
      press(menu, BTN_CIRCLE);
      expect(menu.menu()).toEqual({ kind: "slots-load", index: 0 });
      const { result } = press(menu, BTN_CIRCLE); // automatic row
      expect(result).toEqual({ consumed: true, stateChanged: true });
      expect(menu.toast()).toBe("Loaded autosave");
      expect(digest({ ...live.state, frame: 0 })).toBe(digest({ ...sampledAt(saveFrame), frame: 0 }));
      expect(storage.map.has(`${BROWSER_SAVE_KEY_PREFIX}0`)).toBe(false);
    } finally {
      dispose();
      delete globalThis.__rpgkitAutosave;
      if (descriptor) Object.defineProperty(globalThis, "__rpgkitAutosave", descriptor);
    }
  }, 60_000);

  test("an autosave-only browser keeps root navigation aligned and exposes no manual target", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "__rpgkitAutosave");
    globalThis.__rpgkitAutosave = createSimAutosaveBridge();
    const { live, menu, dispose, storage } = mount(false);
    try {
      const saveFrame = foldToSavePoint(live);
      expect(persistAutosave(
        takeSaveSnapshot(live.session, live.state, live.held),
        live.session.content,
      )).toBe(true);

      press(menu, BTN_START);
      expect(menu.hasSlots).toBe(false);
      expect(globalThis.__pocketTuxemonSave?.channel()).toBe("code");
      expect(menu.menu()).toEqual({ kind: "root", index: 0 });

      press(menu, BTN_CIRCLE); // the only load row is the automatic slot
      expect(menu.menu()).toEqual({ kind: "slots-load", index: 0 });
      press(menu, BTN_DOWN);
      expect(menu.menu()).toEqual({ kind: "slots-load", index: 0 });
      press(menu, BTN_CROSS);
      expect(menu.menu()).toEqual({ kind: "root", index: 0 });

      press(menu, BTN_DOWN); // code export
      press(menu, BTN_CIRCLE);
      expect(menu.menu()).toEqual({ kind: "code-export", page: 0 });
      press(menu, BTN_CROSS);
      expect(menu.menu()).toEqual({ kind: "root", index: 1 });

      press(menu, BTN_DOWN); // code import
      press(menu, BTN_CIRCLE);
      expect(menu.menu()).toEqual({ kind: "code-import" });
      globalThis.__pocketTuxemonSave!.importCode("not-a-save-code");
      expect(menu.menu()).toMatchObject({
        kind: "message",
        title: "CAN'T LOAD THAT CODE",
        back: { kind: "root", index: 2 },
      });
      press(menu, 0); // consume the keyboard-close fence
      press(menu, BTN_CROSS);
      expect(menu.menu()).toEqual({ kind: "root", index: 2 });

      press(menu, BTN_START);
      fold(live, saveFrame, saveFrame + 200);
      expect(digest({ ...live.state, frame: 0 })).not.toBe(digest({ ...sampledAt(saveFrame), frame: 0 }));

      press(menu, BTN_START);
      expect(menu.menu()).toEqual({ kind: "root", index: 0 });
      press(menu, BTN_CIRCLE);
      const { result } = press(menu, BTN_CIRCLE);
      expect(result).toEqual({ consumed: true, stateChanged: true });
      expect(menu.toast()).toBe("Loaded autosave");
      expect(digest({ ...live.state, frame: 0 })).toBe(digest({ ...sampledAt(saveFrame), frame: 0 }));
      expect(storage.map.size).toBe(0);
    } finally {
      dispose();
      delete globalThis.__rpgkitAutosave;
      if (descriptor) Object.defineProperty(globalThis, "__rpgkitAutosave", descriptor);
    }
  }, 60_000);
});

const sampledCache = new Map<number, SessionState>();
function sampledAt(frames: number): SessionState {
  const cached = sampledCache.get(frames);
  if (cached) return cached;
  const { project, session } = createGameSession(FIXED_INITIAL_CIVIL_TIME);
  let state = startSession(project, session);
  let previous = 0;
  for (let frame = 0; frame < frames; frame++) {
    const mask = tape.masks[frame]!;
    state = stepSession(session, state, input(mask, previous));
    previous = mask;
  }
  sampledCache.set(frames, state);
  return state;
}

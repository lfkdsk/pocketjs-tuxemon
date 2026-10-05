// Save/load menu logic: the kit's pure menu reducer (engine/save-menu.ts)
// plus the commands it returns, performed through ui/save-game.ts. JSX-free
// so tests drive it directly; ui/save-menu.tsx adds the presentation.
//
// The menu is a GameView overlay (src/ui/demo-contract.ts): while it is
// open every host frame is consumed (the world folds nothing), and a load
// replaces the live session through the overlay host. An overlay arms no
// attract controller, so the menu itself adds no per-frame work. The demo
// menu has its own slot; `suspended` keeps START from opening the save menu
// over it.

import { createSignal, onCleanup, type Accessor } from "solid-js";
import { BTN } from "@pocketjs/framework/input";
import type { CreateOskOptions, OskController } from "@pocketjs/framework/osk";
import { MapNotReadyError } from "../vendor/pocket-rpgkit/src/engine/map-repository.ts";
import {
  menuStep,
  saveMenuRootRows,
  type MenuAction,
  type MenuState,
} from "../vendor/pocket-rpgkit/src/engine/save-menu.ts";
import type { SaveSnapshot } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import type { UiTextOverrides } from "../vendor/pocket-rpgkit/src/engine/ui-text.ts";
import type {
  GameViewDemoRuntime,
  GameViewDemoStepResult,
  GameViewSessionHost,
} from "../vendor/pocket-rpgkit/src/ui/demo-contract.ts";
import { langSwitchMechanism, type Lang } from "./language.ts";
import {
  describeLoadError,
  detectSlotStore,
  exportSaveCode,
  importSaveCode,
  inspectAutosaveSlot,
  listSlots,
  loadAutosaveSlot,
  loadSlot,
  peekSaveCode,
  peekSlot,
  restoreSave,
  SaveRefused,
  saveSlot,
  snapshotLang,
  takeSaveSnapshot,
  type SlotListing,
  type SlotStore,
  type AutosaveListing,
} from "./save-game.ts";

/** Frames a "Saved" / "Loaded" notice stays on screen after the menu closes. */
export const SAVE_TOAST_FRAMES = 150;
const CODE_PAGE_CHARS = 24 * 10;

export interface SaveMenuOptions {
  /** One button bit that opens and closes the menu. Default START. */
  openButton?: number;
  /** Slot storage; undefined detects data.fs, then browser storage. Null
   * forces the save-code-only menu. */
  slots?: SlotStore | null;
  /** True while another menu (the demo menu) owns the screen; the open
   * button is ignored then. */
  suspended?: () => boolean;
  /** Active content language. A save written in the other language is
   * refused with a clear message instead of silently mixing content. */
  lang?: Lang;
}

/** Test and tooling handle: the live menu publishes itself here. */
export interface PocketTuxemonSaveHook {
  open(): void;
  menu(): MenuState;
  toast(): string | null;
  saveCode(): string;
  /** Type a save code as if entered on the keyboard and commit it. */
  importCode(code: string): void;
  channel(): SlotStore["channel"] | "code";
}

declare global {
  // eslint-disable-next-line no-var
  var __pocketTuxemonSave: PocketTuxemonSaveHook | undefined;
}

function message(title: string, body: string, back: MenuState): MenuState {
  return { kind: "message", title, body, back };
}

/** The prompt shown when a save was written in the other language build.
 *  Says which language the save is in and how to switch to it. */
function languageMismatchMessage(saveLang: Lang, back: MenuState): MenuState {
  const otherEn = saveLang === "zh_CN" ? "Chinese (中文)" : "English";
  const otherZh = saveLang === "zh_CN" ? "中文" : "英文";
  const otherLabel = saveLang === "zh_CN" ? "中文" : "English";
  const howEn = langSwitchMechanism() === "reload"
    ? `Press R, pick ${otherLabel}, then load it again.`
    : `Switch the language to ${otherLabel} and restart the game, then load it again.`;
  const howZh = langSwitchMechanism() === "reload"
    ? `按 R 选择${otherLabel}后重新读取。`
    : `切换到${otherLabel}并重启游戏后重新读取。`;
  return message(
    "LANGUAGE MISMATCH / 语言不匹配",
    `That save is from the ${otherEn} build. ${howEn} / 该存档来自${otherZh}版，${howZh}`,
    back,
  );
}

export function channelTitle(slots: SlotStore | null): string {
  if (!slots) return "SAVE — save code";
  return slots.channel === "desktop" ? "SAVE — desktop slots" : "SAVE — browser slots";
}

/** Everything the presentation reads, plus the GameView step contract. */
export interface SaveMenuRuntime {
  step: GameViewDemoRuntime["step"];
  isOpen: GameViewDemoRuntime["isOpen"];
  menu: Accessor<MenuState>;
  slots: Accessor<SlotListing>;
  /** Dedicated read-only automatic slot, or null before the first autosave. */
  autosave: Accessor<AutosaveListing>;
  saveCode: Accessor<string>;
  toast: Accessor<string | null>;
  legend: Accessor<string>;
  osk: OskController;
  hasSlots: boolean;
  title: string;
}

export function validateOpenButton(open: number): void {
  if (!Number.isInteger(open) || open <= 0 || open > 0xffff || (open & (open - 1)) !== 0) {
    throw new RangeError("save menu: openButton must be one u16 button bit");
  }
}

export function createSaveMenuRuntime(
  options: SaveMenuOptions,
  host: GameViewSessionHost,
  createOsk: (options: CreateOskOptions) => OskController,
  uiText: () => UiTextOverrides | undefined = () => undefined,
): SaveMenuRuntime {
  const openButton = options.openButton ?? BTN.START;
  const slots = options.slots === undefined ? detectSlotStore() : options.slots;
  const hasSlots = slots !== null;
  const content = host.session.content;
  const suspended = options.suspended ?? (() => false);

  const [menu, setMenu] = createSignal<MenuState>({ kind: "closed" });
  const [slotInfo, setSlotInfo] = createSignal<SlotListing>([null, null, null]);
  const [autosaveInfo, setAutosaveInfo] = createSignal<AutosaveListing>(null);
  const [saveCode, setSaveCode] = createSignal("");
  const [typed, setTyped] = createSignal("");
  const [toast, setToast] = createSignal<string | null>(null);
  const rootIndex = (id: string): number => Math.max(0,
    saveMenuRootRows(hasSlots, autosaveInfo() !== null).findIndex((row) => row.id === id));
  let toastFrames = 0;
  // After the menu closes, hold the world until every button is released so
  // the closing press never reaches the reducer as a fresh edge.
  let waitRelease = false;
  // A load whose map is not resident yet (sharded web/console builds).
  let pending: { snapshot: SaveSnapshot; label: string; ready: boolean; error?: unknown } | null = null;
  // The keyboard closes on its own START/x press, which may run before this
  // runtime's step in the same frame; that press must not also close the menu.
  let keyboardClosed = false;

  const refreshSlots = (): void => {
    setSlotInfo(listSlots(slots, content, options.lang ?? "en_US"));
    setAutosaveInfo(inspectAutosaveSlot(content));
  };
  const showToast = (text: string): void => {
    setToast(text);
    toastFrames = SAVE_TOAST_FRAMES;
  };
  const close = (): void => {
    setMenu({ kind: "closed" });
    waitRelease = true;
  };

  /** Restore and present a decoded save; false while its map is loading. */
  const load = (snapshot: SaveSnapshot, label: string, back: MenuState): boolean => {
    const saveLang = snapshotLang(snapshot);
    if (options.lang && saveLang !== options.lang) {
      setMenu(languageMismatchMessage(saveLang, back));
      return false;
    }
    try {
      const restored = restoreSave(host.session, snapshot);
      host.replaceState(restored, snapshot.held);
      pending = null;
      close();
      showToast(`Loaded ${label}`);
      return true;
    } catch (error) {
      const repository = host.session.repository;
      if (error instanceof MapNotReadyError && repository?.prepare) {
        const wait = { snapshot, label, ready: false as boolean, error: undefined as unknown };
        pending = wait;
        setMenu(message("LOADING", `Preparing ${error.mapId}...`, back));
        void repository.prepare(error.mapId).then(
          () => { wait.ready = true; },
          (reason) => { wait.error = reason ?? new Error("map failed to load"); },
        );
        return false;
      }
      pending = null;
      setMenu(message(`CAN'T LOAD ${label.toUpperCase()}`, describeLoadError(error), back));
      return false;
    }
  };

  const snapshotNow = (back: MenuState): SaveSnapshot | null => {
    try {
      return takeSaveSnapshot(host.session, host.getState(), host.heldButtons());
    } catch (error) {
      const body = error instanceof SaveRefused ? error.message : "The game state could not be saved.";
      setMenu(message("CAN'T SAVE NOW", body, back));
      return null;
    }
  };

  const osk = createOsk({
    value: typed,
    setValue: setTyped,
    onCommit(text) {
      keyboardClosed = true;
      const back: MenuState = { kind: "root", index: rootIndex("code-import") };
      // Same language pre-check as the slot path: a foreign-language save
      // code has a different map manifest and must show the mismatch prompt
      // instead of the "another build" refusal.
      try {
        const peeked = peekSaveCode(text);
        if (options.lang && snapshotLang(peeked) !== options.lang) {
          setMenu(languageMismatchMessage(snapshotLang(peeked), back));
          return;
        }
      } catch (error) {
        setMenu(message("CAN'T LOAD THAT CODE", describeLoadError(error), back));
        return;
      }
      try {
        const snapshot = importSaveCode(host.session, text);
        // replaceState outside a step: GameView presents it next frame.
        load(snapshot, "save code", back);
      } catch (error) {
        setMenu(message("CAN'T LOAD THAT CODE", describeLoadError(error), back));
      }
    },
    onClose() {
      keyboardClosed = true;
      if (menu().kind === "code-import") setMenu({ kind: "root", index: rootIndex("code-import") });
    },
  });

  const perform = (next: MenuState, command: NonNullable<ReturnType<typeof menuStep>["command"]>): boolean => {
    switch (command.op) {
      case "save-slot": {
        const back: MenuState = { kind: "slots-save", index: command.slot - 1 };
        const snapshot = snapshotNow(back);
        if (!snapshot) return false;
        try {
          saveSlot(slots!, command.slot, snapshot, content);
        } catch (error) {
          setMenu(message("SAVE FAILED", error instanceof Error ? error.message.slice(0, 48) : "write failed", back));
          return false;
        }
        refreshSlots();
        setMenu(message(`SAVED TO SLOT ${command.slot}`, `${snapshot.map}  (${snapshot.player.tx},${snapshot.player.ty})`, {
          kind: "root",
          index: 0,
        }));
        return false;
      }
      case "load-slot": {
        const back: MenuState = { kind: "slots-load", index: command.slot - 1 };
        // Peek at the save's language before the content check: a save from
        // the other language build has a different map manifest and would
        // otherwise be refused as "another build" before the prompt.
        try {
          const peeked = peekSlot(slots!, command.slot);
          if (options.lang && snapshotLang(peeked) !== options.lang) {
            setMenu(languageMismatchMessage(snapshotLang(peeked), back));
            return false;
          }
        } catch (error) {
          setMenu(message(`CAN'T LOAD SLOT ${command.slot}`, describeLoadError(error), back));
          return false;
        }
        let snapshot: SaveSnapshot;
        try {
          snapshot = loadSlot(slots!, command.slot, content);
        } catch (error) {
          setMenu(message(`CAN'T LOAD SLOT ${command.slot}`, describeLoadError(error), back));
          return false;
        }
        return load(snapshot, `slot ${command.slot}`, back);
      }
      case "load-autosave": {
        const back: MenuState = { kind: "slots-load", index: 0 };
        try {
          const peeked = loadAutosaveSlot(null);
          if (!peeked) throw new Error("automatic save is empty");
          if (options.lang && snapshotLang(peeked) !== options.lang) {
            setMenu(languageMismatchMessage(snapshotLang(peeked), back));
            return false;
          }
        } catch (error) {
          setMenu(message("CAN'T LOAD AUTOSAVE", describeLoadError(error), back));
          return false;
        }
        try {
          const snapshot = loadAutosaveSlot(content);
          if (!snapshot) throw new Error("automatic save is empty");
          return load(snapshot, "autosave", back);
        } catch (error) {
          setMenu(message("CAN'T LOAD AUTOSAVE", describeLoadError(error), back));
          return false;
        }
      }
      case "open-export": {
        const back: MenuState = { kind: "root", index: rootIndex("code-export") };
        const snapshot = snapshotNow(back);
        if (!snapshot) return false;
        setSaveCode(exportSaveCode(host.session, snapshot));
        setMenu(next);
        return false;
      }
      case "open-import":
        setTyped("");
        setMenu(next);
        osk.open();
        return false;
    }
  };

  const actionFor = (pressed: number): MenuAction | null => {
    if (pressed & BTN.UP) return "up";
    if (pressed & BTN.DOWN) return "down";
    if (pressed & BTN.CIRCLE) return "confirm";
    if (pressed & BTN.CROSS) return "back";
    return null;
  };

  const openMenu = (): void => {
    refreshSlots();
    setMenu({ kind: "root", index: 0 });
  };

  const runtime: SaveMenuRuntime = {
    step(buttons: number, pressed: number): GameViewDemoStepResult {
      if (toastFrames > 0 && --toastFrames === 0) setToast(null);
      if (pending) {
        if (pending.error !== undefined) {
          const failed = pending;
          pending = null;
          setMenu(message(`CAN'T LOAD ${failed.label.toUpperCase()}`, describeLoadError(failed.error), { kind: "root", index: 0 }));
          return { consumed: true };
        }
        if (!pending.ready) return { consumed: true };
        const ready = pending;
        return { consumed: true, stateChanged: load(ready.snapshot, ready.label, { kind: "root", index: 0 }) };
      }
      const current = menu();
      if (current.kind === "closed") {
        if (waitRelease) {
          if (buttons !== 0) return { consumed: true };
          waitRelease = false;
        }
        if (pressed & openButton && !suspended()) {
          openMenu();
          return { consumed: true };
        }
        return { consumed: false };
      }
      // The keyboard reads its own buttons while it is open.
      if (osk.isOpen()) return { consumed: true };
      if (keyboardClosed) {
        keyboardClosed = false;
        return { consumed: true };
      }
      if (pressed & openButton) {
        close();
        return { consumed: true };
      }
      const action = actionFor(pressed);
      if (action === null) return { consumed: true };
      const result = menuStep(current, action, {
        hasFs: hasSlots,
        autosaveAvailable: autosaveInfo() !== null,
        slotNonEmpty: slotInfo().map((slot) => slot !== null),
        codePages: Math.max(1, Math.ceil(saveCode().length / CODE_PAGE_CHARS)),
        text: uiText(),
      });
      if (result.state.kind === "closed") {
        close();
        return { consumed: true };
      }
      if (!result.command) {
        setMenu(result.state);
        return { consumed: true };
      }
      return { consumed: true, stateChanged: perform(result.state, result.command) };
    },
    isOpen: () => menu().kind !== "closed" || pending !== null,
    menu,
    slots: slotInfo,
    autosave: autosaveInfo,
    saveCode,
    toast,
    legend: () => {
      // Game-owned footer text (not in the kit's UiTextTable); match the
      // kit's button-hint wording (确定/返回) for the Chinese build.
      const zh = options.lang === "zh_CN";
      if (menu().kind === "message") {
        return zh ? "o: 确定   x: 返回" : "o: ok   x: back";
      }
      return zh ? "o: 选择   x: 返回   START: 关闭" : "o: select   x: back   START: close";
    },
    osk,
    hasSlots,
    title: channelTitle(slots),
  };

  const hook: PocketTuxemonSaveHook = {
    open: () => {
      if (menu().kind === "closed") openMenu();
    },
    menu,
    toast,
    saveCode,
    importCode(code: string) {
      if (menu().kind !== "code-import") {
        setTyped("");
        setMenu({ kind: "code-import" });
        osk.open();
      }
      setTyped(code);
      osk.commit();
    },
    channel: () => slots?.channel ?? "code",
  };
  globalThis.__pocketTuxemonSave = hook;
  onCleanup(() => {
    if (globalThis.__pocketTuxemonSave === hook) delete globalThis.__pocketTuxemonSave;
  });
  return runtime;
}

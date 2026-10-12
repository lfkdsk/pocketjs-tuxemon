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
  SAVE_MENU_UI_TEXT,
  saveMenuRootRows,
  type ExtraRootRow,
  type MenuAction,
  type MenuState,
} from "../vendor/pocket-rpgkit/src/engine/save-menu.ts";
import type { SaveSnapshot } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import {
  formatUiText,
  withUiText,
  type UiTextOverrides,
} from "../vendor/pocket-rpgkit/src/engine/ui-text.ts";
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
  /** Game-defined rows appended after the kit's own root rows. Their labels
   *  are already localized; CONFIRM on one calls `onExtra` with its id.
   *  A resolver may inspect the live session when the menu opens (for
   *  inventory-gated world-menu entries such as NuPhone). */
  extraRows?: readonly ExtraRootRow[] | ((state: ReturnType<GameViewSessionHost["getState"]>) => readonly ExtraRootRow[]);
  /** Called when the player confirms an `extraRows` row. */
  onExtra?: (id: string) => void;
}

/** Screens a game-owned START/title menu may hand off to directly. */
export type SaveMenuOpenTarget = "root" | "load" | "code";

/** The save menu's externally observable reason for returning control. */
export type SaveMenuCompletion =
  | { kind: "dismissed" }
  | { kind: "loaded"; target: LoadTarget };

/** Test and tooling handle: the live menu publishes itself here. */
export interface PocketTuxemonSaveHook {
  /** Re-read manual and automatic save summaries without opening a page. */
  refresh(): void;
  /** Open the traditional root, the load-slot page, or the code importer. */
  open(target?: SaveMenuOpenTarget): void;
  /** Close the menu and return control to its game-owned parent. */
  close(): void;
  /** Load without navigating the legacy menu. False means pending or refused. */
  loadSlot(slot: number): boolean;
  /** Load the dedicated automatic slot without navigating the legacy menu. */
  loadAutosave(): boolean;
  /** Null while active; set when the current handoff is dismissed or loads. */
  completion(): SaveMenuCompletion | null;
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

export type LoadTarget =
  | { kind: "slot"; slot: number }
  | { kind: "code" }
  | { kind: "autosave" };

function loadFailureTitle(
  target: LoadTarget,
  text: ReturnType<typeof saveMenuText>,
): string {
  if (target.kind === "slot") {
    return formatUiText(text["save.loadSlotFailedTitle"], { slot: target.slot });
  }
  return target.kind === "code"
    ? text["save.loadCodeFailedTitle"]
    : text["save.loadAutosaveFailedTitle"];
}

function loadedToast(target: LoadTarget, text: ReturnType<typeof saveMenuText>): string {
  if (target.kind === "slot") {
    return formatUiText(text["save.loadedSlotToast"], { slot: target.slot });
  }
  return target.kind === "code"
    ? text["save.loadedCodeToast"]
    : text["save.loadedAutosaveToast"];
}

function saveMenuText(overrides?: UiTextOverrides) {
  return withUiText(SAVE_MENU_UI_TEXT, overrides);
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
  if (slots.channel === "desktop") return "SAVE — desktop slots";
  if (slots.channel === "psp") return "SAVE — memory stick";
  return "SAVE — browser slots";
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
  /** Resolved game-owned rows for the current live session. */
  extraRows: Accessor<readonly ExtraRootRow[]>;
  /** Programmatic handoff used by a game-owned START/title root. */
  refresh(): void;
  open(target?: SaveMenuOpenTarget): void;
  close(): void;
  loadSlot(slot: number): boolean;
  loadAutosave(): boolean;
  completion: Accessor<SaveMenuCompletion | null>;
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
  const [completion, setCompletion] = createSignal<SaveMenuCompletion | null>(null);
  const extraRows = (): readonly ExtraRootRow[] => typeof options.extraRows === "function"
    ? options.extraRows(host.getState())
    : (options.extraRows ?? []);
  const rootIndex = (id: string): number => Math.max(0,
    saveMenuRootRows(hasSlots, autosaveInfo() !== null, extraRows()).findIndex((row) => row.id === id));
  let toastFrames = 0;
  // After the menu closes, hold the world until every button is released so
  // the closing press never reaches the reducer as a fresh edge.
  let waitRelease = false;
  // A load whose map is not resident yet (sharded web/console builds).
  let pending: { snapshot: SaveSnapshot; target: LoadTarget; ready: boolean; error?: unknown } | null = null;
  // The keyboard closes on its own START/x press, which may run before this
  // runtime's step in the same frame; that press must not also close the menu.
  let keyboardClosed = false;
  let osk: OskController;

  const refreshSlots = (): void => {
    setSlotInfo(listSlots(slots, content, options.lang ?? "en_US"));
    setAutosaveInfo(inspectAutosaveSlot(content));
  };
  const showToast = (text: string): void => {
    setToast(text);
    toastFrames = SAVE_TOAST_FRAMES;
  };
  const finish = (result: SaveMenuCompletion): void => {
    pending = null;
    osk?.close();
    setMenu({ kind: "closed" });
    setCompletion(result);
    waitRelease = true;
  };
  const close = (): void => finish({ kind: "dismissed" });

  /** Restore and present a decoded save; false while its map is loading. */
  const load = (snapshot: SaveSnapshot, target: LoadTarget, back: MenuState): boolean => {
    const text = saveMenuText(uiText());
    const saveLang = snapshotLang(snapshot);
    if (options.lang && saveLang !== options.lang) {
      setMenu(languageMismatchMessage(saveLang, back));
      return false;
    }
    try {
      const restored = restoreSave(host.session, snapshot);
      host.replaceState(restored, snapshot.held);
      pending = null;
      finish({ kind: "loaded", target });
      showToast(loadedToast(target, text));
      return true;
    } catch (error) {
      const repository = host.session.repository;
      if (error instanceof MapNotReadyError && repository?.prepare) {
        const wait = { snapshot, target, ready: false as boolean, error: undefined as unknown };
        pending = wait;
        setMenu(message(
          text["save.loadingTitle"],
          formatUiText(text["save.loadingBody"], { map: error.mapId }),
          back,
        ));
        void repository.prepare(error.mapId).then(
          () => { wait.ready = true; },
          (reason) => { wait.error = reason ?? new Error("map failed to load"); },
        );
        return false;
      }
      pending = null;
      setMenu(message(loadFailureTitle(target, text), describeLoadError(error, uiText()), back));
      return false;
    }
  };

  const snapshotNow = (back: MenuState): SaveSnapshot | null => {
    const text = saveMenuText(uiText());
    try {
      return takeSaveSnapshot(host.session, host.getState(), host.heldButtons(), uiText());
    } catch (error) {
      const body = error instanceof SaveRefused ? error.message : text["save.snapshotFailed"];
      setMenu(message(text["save.refusedTitle"], body, back));
      return null;
    }
  };

  osk = createOsk({
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
        const text = saveMenuText(uiText());
        setMenu(message(loadFailureTitle({ kind: "code" }, text), describeLoadError(error, uiText()), back));
        return;
      }
      try {
        const snapshot = importSaveCode(host.session, text);
        // replaceState outside a step: GameView presents it next frame.
        load(snapshot, { kind: "code" }, back);
      } catch (error) {
        const text = saveMenuText(uiText());
        setMenu(message(loadFailureTitle({ kind: "code" }, text), describeLoadError(error, uiText()), back));
      }
    },
    onClose() {
      keyboardClosed = true;
      if (menu().kind === "code-import") setMenu({ kind: "root", index: rootIndex("code-import") });
    },
  });

  const loadManualSlot = (slot: number): boolean => {
    if (!Number.isInteger(slot) || slot < 1 || slot > 3) {
      throw new RangeError("save menu: slot must be an integer from 1 to 3");
    }
    setCompletion(null);
    const back: MenuState = { kind: "slots-load", index: slot - 1 };
    if (!slots) {
      const text = saveMenuText(uiText());
      setMenu(message(
        loadFailureTitle({ kind: "slot", slot }, text),
        text["save.loadErrorRead"],
        { kind: "root", index: 0 },
      ));
      return false;
    }
    // Peek at the save's language before the content check: a save from the
    // other language build has a different map manifest and would otherwise
    // be refused as "another build" before the prompt.
    try {
      const peeked = peekSlot(slots, slot);
      if (options.lang && snapshotLang(peeked) !== options.lang) {
        setMenu(languageMismatchMessage(snapshotLang(peeked), back));
        return false;
      }
    } catch (error) {
      const text = saveMenuText(uiText());
      setMenu(message(
        loadFailureTitle({ kind: "slot", slot }, text),
        describeLoadError(error, uiText()),
        back,
      ));
      return false;
    }
    try {
      return load(loadSlot(slots, slot, content), { kind: "slot", slot }, back);
    } catch (error) {
      const text = saveMenuText(uiText());
      setMenu(message(
        loadFailureTitle({ kind: "slot", slot }, text),
        describeLoadError(error, uiText()),
        back,
      ));
      return false;
    }
  };

  const loadAutomaticSlot = (): boolean => {
    setCompletion(null);
    const back: MenuState = { kind: "slots-load", index: 0 };
    try {
      const peeked = loadAutosaveSlot(null);
      if (!peeked) throw new Error("automatic save is empty");
      if (options.lang && snapshotLang(peeked) !== options.lang) {
        setMenu(languageMismatchMessage(snapshotLang(peeked), back));
        return false;
      }
    } catch (error) {
      const text = saveMenuText(uiText());
      setMenu(message(
        loadFailureTitle({ kind: "autosave" }, text),
        describeLoadError(error, uiText()),
        back,
      ));
      return false;
    }
    try {
      const snapshot = loadAutosaveSlot(content);
      if (!snapshot) throw new Error("automatic save is empty");
      return load(snapshot, { kind: "autosave" }, back);
    } catch (error) {
      const text = saveMenuText(uiText());
      setMenu(message(
        loadFailureTitle({ kind: "autosave" }, text),
        describeLoadError(error, uiText()),
        back,
      ));
      return false;
    }
  };

  const perform = (next: MenuState, command: NonNullable<ReturnType<typeof menuStep>["command"]>): boolean => {
    switch (command.op) {
      case "save-slot": {
        const back: MenuState = { kind: "slots-save", index: command.slot - 1 };
        const snapshot = snapshotNow(back);
        if (!snapshot) return false;
        try {
          saveSlot(slots!, command.slot, snapshot, content);
        } catch (error) {
          globalThis.console?.debug?.("pocket-tuxemon: slot save write failed", error);
          const text = saveMenuText(uiText());
          setMenu(message(text["save.failedTitle"], text["save.failedBody"], back));
          return false;
        }
        refreshSlots();
        const text = saveMenuText(uiText());
        setMenu(message(
          formatUiText(text["save.savedTitle"], { slot: command.slot }),
          formatUiText(text["save.savedBody"], {
            map: snapshot.map,
            x: snapshot.player.tx,
            y: snapshot.player.ty,
          }), {
          kind: "root",
          index: 0,
        }));
        return false;
      }
      case "load-slot": {
        return loadManualSlot(command.slot);
      }
      case "load-autosave": {
        return loadAutomaticSlot();
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
      case "extra":
        // A game-defined root row: hand off to the game. The menu stays on
        // the root (the kit returned it unchanged); the game opens its own
        // screen, which the composite overlay routes input to while open.
        options.onExtra?.(command.id);
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

  const openMenu = (target: SaveMenuOpenTarget = "root"): void => {
    pending = null;
    osk.close();
    refreshSlots();
    setCompletion(null);
    if (target === "load" && (hasSlots || autosaveInfo() !== null)) {
      setMenu({ kind: "slots-load", index: 0 });
      return;
    }
    if (target === "code") {
      setTyped("");
      setMenu({ kind: "code-import" });
      osk.open();
      return;
    }
    setMenu({ kind: "root", index: 0 });
  };

  const publicOpen = (target: SaveMenuOpenTarget = "root"): void => {
    // Preserve open()'s original idempotence for existing callers. A named
    // handoff may deliberately switch pages while the menu is already open.
    if (target === "root" && menu().kind !== "closed") return;
    openMenu(target);
  };

  const runtime: SaveMenuRuntime = {
    step(buttons: number, pressed: number): GameViewDemoStepResult {
      if (toastFrames > 0 && --toastFrames === 0) setToast(null);
      if (pending) {
        if (pending.error !== undefined) {
          const failed = pending;
          pending = null;
          const text = saveMenuText(uiText());
          setMenu(message(
            loadFailureTitle(failed.target, text),
            describeLoadError(failed.error, uiText()),
            { kind: "root", index: 0 },
          ));
          return { consumed: true };
        }
        if (!pending.ready) return { consumed: true };
        const ready = pending;
        return { consumed: true, stateChanged: load(ready.snapshot, ready.target, { kind: "root", index: 0 }) };
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
        extra: extraRows(),
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
    extraRows,
    refresh: refreshSlots,
    open: publicOpen,
    close,
    loadSlot: loadManualSlot,
    loadAutosave: loadAutomaticSlot,
    completion,
    osk,
    hasSlots,
    title: channelTitle(slots),
  };

  const hook: PocketTuxemonSaveHook = {
    refresh: refreshSlots,
    open: publicOpen,
    close,
    loadSlot: loadManualSlot,
    loadAutosave: loadAutomaticSlot,
    completion,
    menu,
    toast,
    saveCode,
    importCode(code: string) {
      if (menu().kind !== "code-import") {
        openMenu("code");
      } else {
        setCompletion(null);
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

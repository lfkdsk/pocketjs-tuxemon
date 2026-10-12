// JSX-free Options controller shared by title and START. It reads only the
// generated PO-backed labels and the installation-scoped SettingsController;
// no preference enters reducer/session state.

import { createSignal, onCleanup, type Accessor } from "solid-js";
import { BTN } from "@pocketjs/framework/input";
import type { GameViewDemoRuntime } from "../vendor/pocket-rpgkit/src/ui/demo-contract.ts";
import type { OptionsData } from "./feature-modes-data.ts";
import type { Lang } from "./language.ts";
import {
  CONTROL_ACTIONS,
  bindControl,
  pressedPhysicalButton,
  swapControl,
  type ControlAction,
  type PhysicalButton,
  type SettingsController,
} from "./settings.ts";

export type OptionsOrigin = "title" | "start";
export type ControlRowId = `control:${ControlAction}`;
export type OptionsRowId = ControlRowId
  | "reset"
  | "language"
  | "screen"
  | "mute"
  | "music"
  | "sound"
  | "units"
  | "hemisphere";

export interface OptionsRow {
  readonly id: OptionsRowId;
  readonly section: "controls" | "general";
  readonly label: string;
  readonly value: string;
  readonly enabled: boolean;
}

export interface OptionsCapabilities {
  /** False on touch-only presentations: the seven remap rows are omitted. */
  readonly remap: boolean;
  readonly language: boolean;
  /** PSP is fixed 480x272 and omits this row; window/web show host-owned Auto. */
  readonly screenSize: "host" | "hidden";
}

export interface OptionsPhysicalInput {
  physicalPressed(): number;
}

export interface OptionsRuntimeOptions {
  readonly data: OptionsData;
  readonly lang: Lang;
  readonly settings: SettingsController;
  readonly input: OptionsPhysicalInput;
  readonly capabilities: OptionsCapabilities;
  readonly onLanguage?: (origin: OptionsOrigin) => void;
  readonly onClose?: (origin: OptionsOrigin) => void;
}

export interface OptionsConflict {
  readonly action: ControlAction;
  readonly button: PhysicalButton;
  readonly occupiedBy: ControlAction;
}

export interface OptionsRuntime {
  step: GameViewDemoRuntime["step"];
  isOpen: GameViewDemoRuntime["isOpen"];
  open(origin: OptionsOrigin): void;
  close(): void;
  openSignal: Accessor<boolean>;
  origin: Accessor<OptionsOrigin>;
  rows: Accessor<readonly OptionsRow[]>;
  cursor: Accessor<number>;
  capture: Accessor<ControlAction | null>;
  conflict: Accessor<OptionsConflict | null>;
  persistFailed: Accessor<boolean>;
  controlGlyph(action: ControlAction): string;
  activateIndex(index: number): void;
  adjustIndex(index: number, delta: -1 | 1): void;
  resolveConflict(accept: boolean): void;
}

export type PocketOptionsHook = Pick<OptionsRuntime,
  "isOpen" | "origin" | "rows" | "cursor" | "capture" | "conflict"
  | "activateIndex" | "adjustIndex" | "resolveConflict">;

declare global {
  // eslint-disable-next-line no-var
  var __pocketOptions: PocketOptionsHook | undefined;
}

const controlRowId = (action: ControlAction): ControlRowId => `control:${action}`;
const rowControl = (id: OptionsRowId): ControlAction | null =>
  id.startsWith("control:") ? id.slice("control:".length) as ControlAction : null;

const pick = (data: OptionsData, lang: Lang) => ({
  text: (value: { en_US: string; zh_CN: string }): string => value[lang],
  control: (action: ControlAction): string => data.controls[action][lang],
});

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value / 10) * 10));
}

const CONTROL_GLYPHS: Readonly<Record<PhysicalButton, string>> = Object.freeze({
  up: "↑",
  left: "←",
  right: "→",
  down: "↓",
  primary: "○",
  secondary: "△",
  back: "×",
});

function cyclePercent(value: number): number {
  if (value >= 100) return 0;
  return Math.min(100, Math.floor(value / 10) * 10 + 10);
}

export function createOptionsRuntime(options: OptionsRuntimeOptions): OptionsRuntime {
  const [openSignal, setOpen] = createSignal(false);
  const [origin, setOrigin] = createSignal<OptionsOrigin>("start");
  const [cursor, setCursor] = createSignal(0);
  const [capture, setCapture] = createSignal<ControlAction | null>(null);
  const [conflict, setConflict] = createSignal<OptionsConflict | null>(null);
  const [persistFailed, setPersistFailed] = createSignal(false);
  const [settingsRevision, setSettingsRevision] = createSignal(0);
  const labels = pick(options.data, options.lang);

  const rows = (): readonly OptionsRow[] => {
    settingsRevision();
    const settings = options.settings.get();
    const out: OptionsRow[] = [];
    if (options.capabilities.remap) {
      for (const action of CONTROL_ACTIONS) {
        out.push({
          id: controlRowId(action),
          section: "controls",
          label: labels.control(action),
          value: labels.control(settings.controls[action]),
          enabled: true,
        });
      }
      out.push({
        id: "reset",
        section: "controls",
        label: labels.text(options.data.resetDefault),
        value: "",
        enabled: true,
      });
    }
    if (options.capabilities.language) {
      out.push({
        id: "language",
        section: "general",
        label: labels.text(options.data.language),
        value: labels.text(options.lang === "zh_CN"
          ? options.data.languageChinese
          : options.data.languageEnglish),
        enabled: true,
      });
    }
    if (options.capabilities.screenSize === "host") {
      out.push({
        id: "screen",
        section: "general",
        label: labels.text(options.data.screenSize),
        value: "480×272",
        enabled: false,
      });
    }
    if (origin() === "start") {
      out.push({
        id: "mute",
        section: "general",
        label: labels.text(settings.musicMuted ? options.data.unmuteMusic : options.data.muteMusic),
        value: settings.musicMuted ? "●" : "○",
        enabled: true,
      }, {
        id: "music",
        section: "general",
        label: labels.text(options.data.musicVolume),
        value: `${settings.musicVolume}%`,
        enabled: true,
      }, {
        id: "sound",
        section: "general",
        label: labels.text(options.data.soundVolume),
        value: `${settings.soundVolume}%`,
        enabled: true,
      }, {
        id: "units",
        section: "general",
        label: labels.text(options.data.units),
        value: labels.text(settings.units === "metric" ? options.data.metric : options.data.imperial),
        enabled: true,
      }, {
        id: "hemisphere",
        section: "general",
        label: labels.text(options.data.hemisphere),
        value: labels.text(settings.hemisphere === "northern"
          ? options.data.northern
          : options.data.southern),
        enabled: true,
      });
    }
    return out;
  };

  const recordWrite = (persisted: boolean): void => {
    setSettingsRevision((revision) => revision + 1);
    setPersistFailed(!persisted);
  };

  const write = (change: Parameters<SettingsController["update"]>[0]): void => {
    recordWrite(options.settings.update(change));
  };

  const close = (): void => {
    if (!openSignal()) return;
    const from = origin();
    setCapture(null);
    setConflict(null);
    setOpen(false);
    options.onClose?.(from);
  };

  const adjust = (row: OptionsRow, delta: -1 | 1): void => {
    if (!row.enabled) return;
    switch (row.id) {
      case "mute":
        write((settings) => ({ ...settings, musicMuted: !settings.musicMuted }));
        break;
      case "music":
        write((settings) => ({
          ...settings,
          musicVolume: clampPercent(settings.musicVolume + delta * 10),
        }));
        break;
      case "sound":
        write((settings) => ({
          ...settings,
          soundVolume: clampPercent(settings.soundVolume + delta * 10),
        }));
        break;
      case "units":
        write((settings) => ({
          ...settings,
          units: settings.units === "metric" ? "imperial" : "metric",
        }));
        break;
      case "hemisphere":
        write((settings) => ({
          ...settings,
          hemisphere: settings.hemisphere === "northern" ? "southern" : "northern",
        }));
        break;
    }
  };

  const activate = (row: OptionsRow): void => {
    if (!row.enabled) return;
    const action = rowControl(row.id);
    if (action !== null) {
      setCapture(action);
      setConflict(null);
      return;
    }
    switch (row.id) {
      case "reset":
        recordWrite(options.settings.resetControls());
        break;
      case "language":
        options.onLanguage?.(origin());
        break;
      case "mute":
      case "units":
      case "hemisphere":
        adjust(row, 1);
        break;
      case "music":
      case "sound":
        // Touch/confirm cycles a range; left/right remain clamped sliders.
        write((settings) => ({
          ...settings,
          [row.id === "music" ? "musicVolume" : "soundVolume"]:
            cyclePercent(settings[row.id === "music" ? "musicVolume" : "soundVolume"]),
        }));
        break;
    }
  };

  const resolveConflict = (accept: boolean): void => {
    const pending = conflict();
    if (!pending) return;
    if (accept) {
      recordWrite(options.settings.replace(
        swapControl(options.settings.get(), pending.action, pending.button),
      ));
    }
    setConflict(null);
  };

  const activateIndex = (index: number): void => {
    const current = rows();
    if (index < 0 || index >= current.length) return;
    setCursor(index);
    activate(current[index]!);
  };

  const step: GameViewDemoRuntime["step"] = (_buttons, pressed) => {
    if (!openSignal()) return { consumed: false };
    if (conflict()) {
      if (pressed & BTN.CIRCLE) resolveConflict(true);
      else if (pressed & (BTN.CROSS | BTN.START)) resolveConflict(false);
      return { consumed: true };
    }
    const binding = capture();
    if (binding !== null) {
      if (pressed & BTN.START) {
        setCapture(null);
        return { consumed: true };
      }
      const button = pressedPhysicalButton(options.input.physicalPressed());
      if (button !== null) {
        const result = bindControl(options.settings.get(), binding, button);
        setCapture(null);
        if (result.conflict) {
          setConflict({ action: binding, button, occupiedBy: result.conflict });
        } else {
          recordWrite(options.settings.replace(result.settings));
        }
      }
      return { consumed: true };
    }
    const current = rows();
    if (pressed & BTN.CROSS) {
      close();
    } else if (pressed & (BTN.UP | BTN.DOWN)) {
      const delta = pressed & BTN.UP ? -1 : 1;
      setCursor((cursor() + delta + current.length) % current.length);
    } else if (pressed & (BTN.LEFT | BTN.RIGHT)) {
      adjust(current[cursor()]!, pressed & BTN.LEFT ? -1 : 1);
    } else if (pressed & BTN.CIRCLE) {
      activate(current[cursor()]!);
    }
    return { consumed: true };
  };

  const adjustIndex: OptionsRuntime["adjustIndex"] = (index, delta) => {
    const current = rows();
    if (current[index]) {
      setCursor(index);
      adjust(current[index]!, delta);
    }
  };
  const hook: PocketOptionsHook = {
    isOpen: openSignal,
    origin,
    rows,
    cursor,
    capture,
    conflict,
    activateIndex,
    adjustIndex,
    resolveConflict,
  };
  globalThis.__pocketOptions = hook;
  onCleanup(() => {
    if (globalThis.__pocketOptions === hook) delete globalThis.__pocketOptions;
  });

  return {
    step,
    isOpen: () => openSignal(),
    open(from) {
      setOrigin(from);
      setCursor(0);
      setCapture(null);
      setConflict(null);
      setPersistFailed(false);
      setOpen(true);
    },
    close,
    openSignal,
    origin,
    rows,
    cursor,
    capture,
    conflict,
    persistFailed,
    controlGlyph(action) {
      settingsRevision();
      return CONTROL_GLYPHS[options.settings.get().controls[action]];
    },
    activateIndex,
    adjustIndex,
    resolveConflict,
  };
}

// Scaled 480x272 Options presentation. The runtime is shared by title and
// START; this component owns only layout, focus paint and touch hit regions.

import { createMemo, createSignal, For, Show, type Component } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { getOps, hostViewport } from "@pocketjs/framework/host";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { modality, surfaceHasTouch } from "@pocketjs/framework/modality";
import { platform } from "@pocketjs/framework/platform";
import type { GameViewDemoRuntime, GameViewOverlayConfig } from "../vendor/pocket-rpgkit/src/ui/demo-contract.ts";
import { Panel } from "../vendor/pocket-rpgkit/src/ui/Panel.tsx";
import type { OptionsData } from "./feature-modes-data.ts";
import type { Lang } from "./language.ts";
import {
  createOptionsRuntime,
  type OptionsCapabilities,
  type OptionsOrigin,
  type OptionsRow,
  type OptionsRuntime,
} from "./options-runtime.ts";
import type { ButtonRemapper, SettingsController } from "./settings.ts";
import { TUXEMON_UI_THEME } from "./tuxemon-theme.ts";

export const OPTIONS_BASE_W = 480;
export const OPTIONS_BASE_H = 272;

export interface OptionsCanvas {
  readonly scale: number;
  readonly left: number;
  readonly top: number;
}

export interface OptionsRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface OptionsRowLayout {
  readonly row: OptionsRow;
  readonly index: number;
  readonly rect: OptionsRect;
}

const PANEL: OptionsRect = { x: 10, y: 9, w: 460, h: 254 };
const BACK: OptionsRect = { x: 390, y: 237, w: 66, h: 19 };
const ROW_TOP = 49;
const ROW_H = 21;
const ROW_GAP = 2;
const CONTROL_COLUMN: OptionsRect = { x: 22, y: ROW_TOP, w: 211, h: 184 };
const GENERAL_COLUMN: OptionsRect = { x: 247, y: ROW_TOP, w: 211, h: 184 };
const SINGLE_COLUMN: OptionsRect = { x: 67, y: ROW_TOP, w: 346, h: 184 };
const SELECTED = "#145064";

export function optionsCanvas(viewport: { w: number; h: number }): OptionsCanvas {
  const scale = Math.min(viewport.w / OPTIONS_BASE_W, viewport.h / OPTIONS_BASE_H);
  return {
    scale,
    left: Math.floor((viewport.w - OPTIONS_BASE_W * scale) / 2),
    top: Math.floor((viewport.h - OPTIONS_BASE_H * scale) / 2),
  };
}

export function optionsViewRect(canvas: OptionsCanvas, rect: OptionsRect): OptionsRect {
  return {
    x: canvas.left + rect.x * canvas.scale,
    y: canvas.top + rect.y * canvas.scale,
    w: rect.w * canvas.scale,
    h: rect.h * canvas.scale,
  };
}

export function optionsBasePoint(canvas: OptionsCanvas, x: number, y: number): { x: number; y: number } {
  return { x: (x - canvas.left) / canvas.scale, y: (y - canvas.top) / canvas.scale };
}

export function optionsRowLayout(rows: readonly OptionsRow[]): OptionsRowLayout[] {
  const controls = rows.filter((row) => row.section === "controls");
  const general = rows.filter((row) => row.section === "general");
  const split = controls.length > 0;
  const out: OptionsRowLayout[] = [];
  const add = (section: readonly OptionsRow[], column: OptionsRect): void => {
    section.forEach((row, localIndex) => out.push({
      row,
      index: rows.indexOf(row),
      rect: {
        x: column.x,
        y: column.y + localIndex * (ROW_H + ROW_GAP),
        w: column.w,
        h: ROW_H,
      },
    }));
  };
  if (split) add(controls, CONTROL_COLUMN);
  add(general, split ? GENERAL_COLUMN : SINGLE_COLUMN);
  return out.sort((left, right) => left.index - right.index);
}

export interface OptionsOverlayOptions {
  readonly data: OptionsData;
  readonly lang: Lang;
  readonly settings: SettingsController;
  readonly input: ButtonRemapper;
  readonly canSwitchLanguage: boolean;
  readonly capabilities?: OptionsCapabilities;
  readonly onLanguage?: (origin: OptionsOrigin) => void;
  readonly onClose?: (origin: OptionsOrigin) => void;
}

export function defaultOptionsCapabilities(canSwitchLanguage: boolean): OptionsCapabilities {
  return {
    remap: modality.buttons && !surfaceHasTouch(),
    language: canSwitchLanguage,
    screenSize: platform.target === "psp" ? "hidden" : "host",
  };
}

export function createOptionsOverlay(options: OptionsOverlayOptions): GameViewOverlayConfig & {
  runtimeRef: { current: OptionsRuntime | null };
} {
  const runtimeRef: { current: OptionsRuntime | null } = { current: null };
  return {
    runtimeRef,
    create() {
      const runtime = createOptionsRuntime({
        data: options.data,
        lang: options.lang,
        settings: options.settings,
        input: options.input,
        capabilities: options.capabilities ?? defaultOptionsCapabilities(options.canSwitchLanguage),
        onLanguage: options.onLanguage,
        onClose: options.onClose,
      });
      runtimeRef.current = runtime;
      return {
        step: runtime.step,
        isOpen: runtime.isOpen,
        render() {
          return <OptionsView runtime={runtime} data={options.data} lang={options.lang} />;
        },
      };
    },
  };
}

const OptionsView: Component<{ runtime: OptionsRuntime; data: OptionsData; lang: Lang }> = (props) => {
  const [viewport, setViewport] = createSignal({ w: OPTIONS_BASE_W, h: OPTIONS_BASE_H });
  const canvas = createMemo(() => optionsCanvas(viewport()));
  const rows = () => props.runtime.rows();
  const layout = createMemo(() => optionsRowLayout(rows()));
  const open = () => props.runtime.openSignal();
  const disabled: OptionsRect = { x: -1, y: -1, w: 0, h: 0 };
  const t = (text: { en_US: string; zh_CN: string }): string => text[props.lang];

  onFrame(() => {
    if (!open()) return;
    const next = hostViewport(getOps());
    if (next && (next.w !== viewport().w || next.h !== viewport().h)) {
      setViewport({ w: next.w, h: next.h });
    }
  });

  createGesture({
    region: { rect: () => open() && !props.runtime.capture() && !props.runtime.conflict()
      ? optionsViewRect(canvas(), { x: 18, y: ROW_TOP - 3, w: 444, h: 188 })
      : disabled },
    onTap: (contact) => {
      const point = optionsBasePoint(canvas(), contact.x, contact.y);
      const hit = layout().find(({ rect }) =>
        point.x >= rect.x && point.x < rect.x + rect.w
        && point.y >= rect.y && point.y < rect.y + rect.h);
      if (hit) props.runtime.activateIndex(hit.index);
    },
  });
  createGesture({
    region: { rect: () => open() && !props.runtime.capture() && !props.runtime.conflict()
      ? optionsViewRect(canvas(), BACK)
      : disabled },
    onTap: () => props.runtime.close(),
  });
  createGesture({
    region: { rect: () => props.runtime.conflict()
      ? optionsViewRect(canvas(), { x: 114, y: 164, w: 116, h: 27 })
      : disabled },
    onTap: () => props.runtime.resolveConflict(true),
  });
  createGesture({
    region: { rect: () => props.runtime.conflict()
      ? optionsViewRect(canvas(), { x: 250, y: 164, w: 116, h: 27 })
      : disabled },
    onTap: () => props.runtime.resolveConflict(false),
  });

  return (
    <Show when={open()}>
      <View class="absolute inset-0" style={{ posType: 1, bgColor: TUXEMON_UI_THEME.backdrop }} debugName="options-overlay">
        <View
          class="absolute overflow-hidden"
          style={{
            posType: 1,
            insetL: canvas().left,
            insetT: canvas().top,
            width: OPTIONS_BASE_W,
            height: OPTIONS_BASE_H,
            scaleX: canvas().scale,
            scaleY: canvas().scale,
            originX: -0.5,
            originY: -0.5,
          }}
          debugName="options-canvas"
        >
          <Panel
            theme={TUXEMON_UI_THEME}
            style={{ posType: 1, insetL: PANEL.x, insetT: PANEL.y, width: PANEL.w, height: PANEL.h }}
            debugName="options-panel"
          >
            <Text
              class="text-lg"
              style={{ posType: 1, insetL: 15, insetT: 7, width: 260, height: 27, lineHeight: 23, textColor: TUXEMON_UI_THEME.accent }}
              debugName="options-title"
            >
              {t(props.data.title)}
            </Text>
            <Text
              class="text-xs"
              style={{ posType: 1, insetR: 15, insetT: 12, width: 150, height: 16, lineHeight: 14, textAlign: 2, textColor: TUXEMON_UI_THEME.dim }}
              debugName="options-origin"
            >
              {props.runtime.origin() === "title" ? "TITLE" : "START"}
            </Text>
            <For each={layout()}>{({ row, index, rect }) => {
              const selected = () => props.runtime.cursor() === index;
              return (
                <View
                  class="absolute flex-row items-center"
                  style={{
                    posType: 1,
                    insetL: rect.x - PANEL.x,
                    insetT: rect.y - PANEL.y,
                    width: rect.w,
                    height: rect.h,
                    bgColor: selected() ? SELECTED : TUXEMON_UI_THEME.paper,
                    opacity: row.enabled ? 1 : 0.58,
                    borderWidth: 1,
                    borderColor: selected() ? TUXEMON_UI_THEME.accent : TUXEMON_UI_THEME.border,
                  }}
                  debugName={`options-row-${row.id}`}
                >
                  <Text
                    class="text-xs"
                    style={{ marginL: 6, width: rect.w - 82, height: 16, lineHeight: 14, textColor: selected() ? "#ffffff" : TUXEMON_UI_THEME.ink }}
                    debugName={`options-label-${row.id}`}
                  >
                    {row.label}
                  </Text>
                  <Text
                    class="text-xs"
                    style={{ width: 70, height: 16, lineHeight: 14, textAlign: 2, textColor: selected() ? "#ffffff" : TUXEMON_UI_THEME.accent }}
                    debugName={`options-value-${row.id}`}
                  >
                    {row.value}
                  </Text>
                </View>
              );
            }}</For>
            <Text
              class="text-xs"
              style={{ posType: 1, insetL: 15, insetB: 9, width: 270, height: 16, lineHeight: 14, textColor: props.runtime.persistFailed() ? "#e2574c" : TUXEMON_UI_THEME.dim }}
              debugName="options-legend"
            >
              {props.runtime.persistFailed() ? "⚠ settings.json" : "↑↓  ←→ CHANGE   ○ SELECT"}
            </Text>
            <View
              class="absolute flex-row justify-center items-center"
              style={{ posType: 1, insetL: BACK.x - PANEL.x, insetT: BACK.y - PANEL.y, width: BACK.w, height: BACK.h, bgColor: SELECTED, borderWidth: 1, borderColor: TUXEMON_UI_THEME.accent }}
              debugName="options-back"
            >
              <Text class="text-xs" style={{ width: 58, height: 15, lineHeight: 13, textAlign: 1, textColor: "#ffffff" }}>× BACK</Text>
            </View>
          </Panel>

          <Show when={props.runtime.capture()}>{(action) => (
            <View
              class="absolute"
              style={{ posType: 1, insetL: 60, insetT: 73, width: 360, height: 126, bgColor: "#071923f5", borderWidth: 2, borderColor: TUXEMON_UI_THEME.rim }}
              debugName="options-capture-dialog"
            >
              <Text class="text-sm" style={{ posType: 1, insetL: 18, insetT: 17, width: 324, height: 42, lineHeight: 18, textAlign: 1, textColor: TUXEMON_UI_THEME.ink }} debugName="options-capture-prompt">
                {t(props.data.capturePrompt)}
              </Text>
              <Text class="text-sm" style={{ posType: 1, insetL: 18, insetT: 64, width: 324, height: 22, lineHeight: 18, textAlign: 1, textColor: TUXEMON_UI_THEME.accent }} debugName="options-capture-action">
                {t(props.data.controls[action()])}
              </Text>
              <Text class="text-xs" style={{ posType: 1, insetL: 18, insetT: 98, width: 324, height: 16, lineHeight: 14, textAlign: 1, textColor: TUXEMON_UI_THEME.dim }}>START · CANCEL</Text>
            </View>
          )}</Show>

          <Show when={props.runtime.conflict()}>{(pending) => (
            <View
              class="absolute"
              style={{ posType: 1, insetL: 70, insetT: 78, width: 340, height: 124, bgColor: "#071923f5", borderWidth: 2, borderColor: TUXEMON_UI_THEME.rim }}
              debugName="options-conflict-dialog"
            >
              <Text class="text-sm" style={{ posType: 1, insetL: 15, insetT: 17, width: 310, height: 42, lineHeight: 18, textAlign: 1, textColor: TUXEMON_UI_THEME.ink }} debugName="options-conflict-prompt">
                {`${t(props.data.controls[pending().action])}  ↔  ${t(props.data.controls[pending().occupiedBy])}`}
              </Text>
              <View class="absolute flex-row justify-center items-center" style={{ posType: 1, insetL: 44, insetT: 86, width: 116, height: 27, bgColor: SELECTED, borderWidth: 1, borderColor: TUXEMON_UI_THEME.accent }}>
                <Text class="text-xs" style={{ width: 102, height: 15, lineHeight: 13, textAlign: 1, textColor: "#ffffff" }}>○ SWAP</Text>
              </View>
              <View class="absolute flex-row justify-center items-center" style={{ posType: 1, insetL: 180, insetT: 86, width: 116, height: 27, bgColor: TUXEMON_UI_THEME.paper, borderWidth: 1, borderColor: TUXEMON_UI_THEME.border }}>
                <Text class="text-xs" style={{ width: 102, height: 15, lineHeight: 13, textAlign: 1, textColor: TUXEMON_UI_THEME.ink }}>× CANCEL</Text>
              </View>
            </View>
          )}</Show>
        </View>
      </View>
    </Show>
  );
};

// NuPhone and GPS map presentation. The imported 256x144 coordinates are
// projected into one fixed 480x272 composition, then letterboxed to the live
// viewport; touch hit-testing uses the exact inverse transform.

import { For, Show, createMemo, createSignal, type Component } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { getOps, hostViewport } from "@pocketjs/framework/host";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { featureText, type NuPhoneMapPoint } from "./feature-modes-data.ts";
import type { GameViewOverlayConfig } from "../vendor/pocket-rpgkit/src/ui/demo-contract.ts";
import { TUXEMON_UI_THEME } from "./tuxemon-theme.ts";
import {
  createNuPhoneRuntime,
  nuPhonePointSelectable,
  type NuPhoneOptions,
  type NuPhoneRuntime,
} from "./nuphone-runtime.ts";

const THEME = TUXEMON_UI_THEME;
export const NUPHONE_BASE_W = 480;
export const NUPHONE_BASE_H = 272;
const PHONE_APP_RECT = { x: 28, y: 53, w: 116, h: 106 };
const BACK_RECT = { x: 430, y: 7, w: 34, h: 24 };
const MESSAGE_OK_RECT = { x: 190, y: 160, w: 100, h: 30 };
const NOMINAL_X = 16;
const NOMINAL_Y = 10;
const NOMINAL_SCALE = 1.75;
const TITLE_OFFSET_Y = 7;

export interface NuPhoneCanvas {
  scale: number;
  left: number;
  top: number;
}

export function nuPhoneCanvas(viewport: { w: number; h: number }): NuPhoneCanvas {
  const scale = Math.min(viewport.w / NUPHONE_BASE_W, viewport.h / NUPHONE_BASE_H);
  return {
    scale,
    left: Math.floor((viewport.w - NUPHONE_BASE_W * scale) / 2),
    top: Math.floor((viewport.h - NUPHONE_BASE_H * scale) / 2),
  };
}

export function nuPhoneViewRect(
  canvas: NuPhoneCanvas,
  rect: { x: number; y: number; w: number; h: number },
): { x: number; y: number; w: number; h: number } {
  return {
    x: canvas.left + rect.x * canvas.scale,
    y: canvas.top + rect.y * canvas.scale,
    w: rect.w * canvas.scale,
    h: rect.h * canvas.scale,
  };
}

export function nuPhoneBasePoint(canvas: NuPhoneCanvas, x: number, y: number): { x: number; y: number } {
  return { x: (x - canvas.left) / canvas.scale, y: (y - canvas.top) / canvas.scale };
}

export function nuPhonePointPosition(point: Pick<NuPhoneMapPoint, "x" | "y">): { x: number; y: number } {
  return {
    x: NOMINAL_X + point.x * NOMINAL_SCALE,
    y: NOMINAL_Y + (point.y - TITLE_OFFSET_Y) * NOMINAL_SCALE,
  };
}

const STRINGS = {
  en_US: {
    installed: "INSTALLED APPS",
    noApps: "No map application installed.",
    known: "KNOWN",
    here: "YOU ARE HERE",
    mapLegend: "d-pad: move   x: back",
    phoneLegend: "o: open   x: close",
    back: "x",
    ok: "OK",
  },
  zh_CN: {
    installed: "已安装应用",
    noApps: "尚未安装地图应用。",
    known: "已发现",
    here: "当前位置",
    mapLegend: "方向键：移动  ×：返回",
    phoneLegend: "○：打开  ×：关闭",
    back: "×",
    ok: "确定",
  },
} as const;

export function createNuPhoneOverlay(options: NuPhoneOptions): GameViewOverlayConfig & {
  runtimeRef: { current: NuPhoneRuntime | null };
} {
  const runtimeRef: { current: NuPhoneRuntime | null } = { current: null };
  return {
    runtimeRef,
    create(host) {
      const runtime = createNuPhoneRuntime(options, host);
      runtimeRef.current = runtime;
      return {
        step: runtime.step,
        isOpen: runtime.isOpen,
        render() {
          // Keep the runtime/hook alive, but do not register this view's
          // frame observer and touch regions until the phone is visible.
          return <Show when={runtime.isOpen()}><NuPhoneView runtime={runtime} /></Show>;
        },
      };
    },
  };
}

const NuPhoneView: Component<{ runtime: NuPhoneRuntime }> = (props) => {
  const runtime = props.runtime;
  const data = runtime.data;
  const t = () => runtime.lang === "zh_CN" ? STRINGS.zh_CN : STRINGS.en_US;
  const open = () => runtime.openSignal();
  const state = () => runtime.state();
  const [viewport, setViewport] = createSignal({ w: NUPHONE_BASE_W, h: NUPHONE_BASE_H });
  onFrame(() => {
    if (!open()) return;
    const live = hostViewport(getOps());
    if (live && (live.w !== viewport().w || live.h !== viewport().h)) setViewport({ w: live.w, h: live.h });
  });
  const canvas = createMemo(() => nuPhoneCanvas(viewport()));
  const disabledRect = { x: -1, y: -1, w: 0, h: 0 } as const;
  const selected = createMemo(() => data.points.find((point) => point.key === state().cursor) ?? data.points[0]!);
  const selectedKnown = () => state().known.includes(selected().key);
  const selectedLabel = () => selectedKnown() ? featureText(selected().label, runtime.lang) : "???";
  const currentPoint = createMemo(() => data.points.find((point) => point.key === state().currentLocation));
  const knownCount = () => state().known.length;

  const actBack = (): void => runtime.applyAction("back");
  createGesture({
    region: { rect: () => open() ? nuPhoneViewRect(canvas(), BACK_RECT) : disabledRect },
    onTap: () => { if (open()) actBack(); },
  });
  createGesture({
    region: { rect: () => open() && state().screen === "phone"
      ? nuPhoneViewRect(canvas(), PHONE_APP_RECT)
      : disabledRect },
    onTap: () => {
      if (open() && state().screen === "phone" && state().hasMapApp) runtime.applyAction("confirm");
    },
  });
  createGesture({
    region: { rect: () => open() && state().screen === "message"
      ? nuPhoneViewRect(canvas(), MESSAGE_OK_RECT)
      : disabledRect },
    onTap: () => {
      if (open() && state().screen === "message") runtime.applyAction("confirm");
    },
  });
  // One map-wide gesture resolves the nearest authored pin. This keeps touch
  // registration constant while still preserving the 20-point source graph.
  createGesture({
    // Disable the hit region outside the map screen. Otherwise this broad
    // region sits above the Map App card in the host's down-edge hit facts
    // and eats the very tap that should open it.
    region: { rect: () => open() && state().screen === "map"
      ? nuPhoneViewRect(canvas(), { x: 12, y: 30, w: 456, h: 218 })
      : disabledRect },
    onTap: (contact) => {
      if (!open() || state().screen !== "map") return;
      const point = nuPhoneBasePoint(canvas(), contact.x, contact.y);
      let nearest: { key: string; distance: number } | null = null;
      for (const candidate of data.points) {
        if (!nuPhonePointSelectable(data, state(), candidate.key)) continue;
        const position = nuPhonePointPosition(candidate);
        const distance = (position.x - point.x) ** 2 + (position.y - point.y) ** 2;
        if (distance <= 14 ** 2 && (!nearest || distance < nearest.distance)) {
          nearest = { key: candidate.key, distance };
        }
      }
      if (nearest) runtime.selectPoint(nearest.key);
    },
  });

  const backgroundLeft = NOMINAL_X + (data.nominalWidth - data.art.map.width) * NOMINAL_SCALE / 2;
  const backgroundTop = NOMINAL_Y + (data.nominalHeight - data.art.map.height) * NOMINAL_SCALE / 2;

  return (
    <Show when={open()}>
      <View class="absolute inset-0" style={{ posType: 1, bgColor: THEME.backdrop }} debugName="tux-nuphone-overlay">
        <View
          class="absolute overflow-hidden"
          style={{
            posType: 1,
            insetL: canvas().left,
            insetT: canvas().top,
            width: NUPHONE_BASE_W,
            height: NUPHONE_BASE_H,
            scaleX: canvas().scale,
            scaleY: canvas().scale,
            originX: -0.5,
            originY: -0.5,
            bgColor: "#071923",
          }}
          debugName="tux-nuphone-canvas"
        >
          <Show when={state().screen === "phone"}>
            <View
              class="absolute"
              style={{ posType: 1, insetL: 10, insetT: 8, width: 460, height: 256, borderWidth: 2, borderColor: THEME.rim, bgColor: THEME.paper }}
              debugName="tux-nuphone-shell"
            />
            <View class="absolute" style={{ posType: 1, insetL: 20, insetT: 18, width: 4, height: 28, bgColor: THEME.accent }} />
            <Text class="text-lg" style={{ posType: 1, insetL: 32, insetT: 16, width: 230, height: 26, lineHeight: 22, textColor: THEME.ink }} debugName="tux-nuphone-title">
              {featureText(data.entry.phoneLabel, runtime.lang)}
            </Text>
            <Text class="text-xs" style={{ posType: 1, insetL: 30, insetT: 178, width: 200, height: 18, lineHeight: 14, textColor: THEME.dim }}>
              {t().installed}
            </Text>
            <Show
              when={state().hasMapApp}
              fallback={
                <Text class="text-sm" style={{ posType: 1, insetL: 30, insetT: 72, width: 300, height: 22, lineHeight: 18, textColor: THEME.dim }} debugName="tux-nuphone-no-apps">
                  {t().noApps}
                </Text>
              }
            >
              <View
                class="absolute flex-col items-center"
                style={{ posType: 1, insetL: PHONE_APP_RECT.x, insetT: PHONE_APP_RECT.y, width: PHONE_APP_RECT.w, height: PHONE_APP_RECT.h, borderWidth: 2, borderColor: THEME.accent, bgColor: "#0d3845" }}
                debugName="tux-nuphone-map-app"
              >
                <Image src={data.art.appIcon.texture} style={{ width: 56, height: 56, marginT: 10 }} />
                <Text class="text-sm" style={{ width: 108, height: 22, lineHeight: 18, textColor: THEME.ink, textAlign: 1 }}>
                  {featureText(data.entry.appLabel, runtime.lang)}
                </Text>
              </View>
              <Text class="text-xs" style={{ posType: 1, insetL: 164, insetT: 62, width: 270, height: 48, lineHeight: 16, textColor: THEME.dim }} debugName="tux-nuphone-app-help">
                {runtime.lang === "zh_CN" ? "查看已发现地点与当前位置。" : "View discovered locations and your current position."}
              </Text>
            </Show>
            <Text class="text-xs" style={{ posType: 1, insetL: 30, insetT: 232, width: 360, height: 18, lineHeight: 14, textColor: THEME.dim }} debugName="tux-nuphone-phone-legend">
              {t().phoneLegend}
            </Text>
          </Show>

          <Show when={state().screen === "map"}>
            <View class="absolute" style={{ posType: 1, insetL: 8, insetT: 7, width: 464, height: 258, borderWidth: 1, borderColor: THEME.rim, bgColor: "#102b3a" }} />
            <Image
              class="absolute"
              src={data.art.map.texture}
              style={{
                posType: 1,
                insetL: backgroundLeft,
                insetT: backgroundTop,
                width: data.art.map.width * NOMINAL_SCALE,
                height: data.art.map.height * NOMINAL_SCALE,
              }}
              debugName="tux-nuphone-map-image"
            />
            <For each={data.points}>{(point) => {
              const position = nuPhonePointPosition(point);
              const selectable = () => nuPhonePointSelectable(data, state(), point.key);
              const known = () => state().known.includes(point.key);
              return (
                <Show when={selectable()}>
                  <View
                    class="absolute"
                    style={{
                      posType: 1,
                      insetL: position.x - 3,
                      insetT: position.y - 3,
                      width: 6,
                      height: 6,
                      bgColor: known() ? "#7cf29a" : "#7c93a2",
                      borderWidth: 1,
                      borderColor: "#071923",
                    }}
                    debugName={`tux-nuphone-pin-${point.key}`}
                  />
                </Show>
              );
            }}</For>
            <Show when={currentPoint()}>{(point) => {
              const position = nuPhonePointPosition(point());
              return (
                <Image
                  class="absolute"
                  src={data.art.player.texture}
                  style={{ posType: 1, insetL: position.x - 7, insetT: position.y - 12, width: 12, height: 12 }}
                  debugName="tux-nuphone-player-marker"
                />
              );
            }}</Show>
            <Image
              class="absolute"
              src={data.art.cursor.texture}
              style={{
                posType: 1,
                insetL: nuPhonePointPosition(selected()).x - 10,
                insetT: nuPhonePointPosition(selected()).y - 10,
                width: 20,
                height: 20,
              }}
              debugName="tux-nuphone-cursor"
            />
            <Text class="text-lg" style={{ posType: 1, insetL: 18, insetT: 10, width: 170, height: 24, lineHeight: 21, textColor: THEME.accent }} debugName="tux-nuphone-map-title">
              {featureText(data.entry.appLabel, runtime.lang)}
            </Text>
            <View class="absolute" style={{ posType: 1, insetL: 340, insetT: 190, width: 122, height: 48, borderWidth: 1, borderColor: THEME.border, bgColor: "#071923" }} />
            <Text class="text-xs" style={{ posType: 1, insetL: 348, insetT: 196, width: 106, height: 16, lineHeight: 14, textColor: THEME.dim }}>
              {`${t().known} ${knownCount()}/${data.points.length}`}
            </Text>
            <Text class="text-sm" style={{ posType: 1, insetL: 348, insetT: 214, width: 106, height: 20, lineHeight: 17, textColor: selectedKnown() ? THEME.accent : THEME.ink }} debugName="tux-nuphone-location-label">
              {selectedLabel()}
            </Text>
            <Show when={state().currentLocation === state().cursor}>
              <Text class="text-xs" style={{ posType: 1, insetL: 350, insetT: 171, width: 100, height: 16, lineHeight: 14, textColor: "#7cf29a" }} debugName="tux-nuphone-here-label">
                {t().here}
              </Text>
            </Show>
            <Text class="text-xs" style={{ posType: 1, insetL: 18, insetT: 244, width: 310, height: 18, lineHeight: 14, textColor: THEME.dim }} debugName="tux-nuphone-map-legend">
              {t().mapLegend}
            </Text>
          </Show>

          <Show when={state().screen === "message"}>
            <View class="absolute" style={{ posType: 1, insetL: 70, insetT: 70, width: 340, height: 132, borderWidth: 2, borderColor: THEME.rim, bgColor: THEME.paper }} debugName="tux-nuphone-message">
              <Text class="text-sm" style={{ posType: 1, insetL: 22, insetT: 30, width: 296, height: 42, lineHeight: 18, textColor: THEME.ink, textAlign: 1 }} debugName="tux-nuphone-message-text">
                {featureText(data.entry.noTrackers, runtime.lang)}
              </Text>
              <View class="absolute flex-row justify-center items-center" style={{ posType: 1, insetL: 120, insetT: 90, width: 100, height: 28, borderWidth: 1, borderColor: THEME.accent }}>
                <Text class="text-sm" style={{ height: 18, lineHeight: 17, textColor: THEME.accent }}>{t().ok}</Text>
              </View>
            </View>
          </Show>

          <View class="absolute flex-row justify-center items-center" style={{ posType: 1, insetL: BACK_RECT.x, insetT: BACK_RECT.y, width: BACK_RECT.w, height: BACK_RECT.h, borderWidth: 1, borderColor: THEME.border }} debugName="tux-nuphone-back">
            <Text class="text-sm" style={{ height: 18, lineHeight: 17, textColor: THEME.ink }}>{t().back}</Text>
          </View>
        </View>
      </View>
    </Show>
  );
};

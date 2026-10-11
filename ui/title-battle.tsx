// Opaque title menu and five-level Battle picker. The composition is authored
// once at 480x272 and uniformly scaled/letterboxed for desktop, web and PSP.

import { For, Show, createMemo, createSignal, type Component } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { getOps, hostViewport } from "@pocketjs/framework/host";
import { onFrame } from "@pocketjs/framework/lifecycle";
import type { SessionOwningOverlayConfig } from "./game-overlay.tsx";
import { TUXEMON_UI_THEME } from "./tuxemon-theme.ts";
import {
  createTitleBattleRuntime,
  type TitleBattleOptions,
  type TitleBattleRuntime,
} from "./title-battle-runtime.ts";

export const TITLE_BATTLE_BASE_W = 480;
export const TITLE_BATTLE_BASE_H = 272;
const TITLE_ROWS = [
  { x: 278, y: 151, w: 170, h: 36 },
  { x: 278, y: 194, w: 170, h: 36 },
] as const;
const DIFFICULTY_ROWS = [0, 1, 2, 3, 4].map((index) => ({
  x: 130,
  y: 88 + index * 31,
  w: 220,
  h: 27,
}));
const BACK_RECT = { x: 20, y: 229, w: 92, h: 28 };
const RESULT_RECT = { x: 145, y: 184, w: 190, h: 34 };
const TITLE_BACKGROUND = "assets/battle/gfx/ui/combat/grass_background.png";

const STRINGS = {
  en_US: {
    subtitle: "SPYDER ADVENTURES",
    adventure: "Adventure",
    back: "Back",
    legend: "d-pad: choose   o: confirm   x: back",
    win: "Victory!",
    lose: "Defeat",
    escape: "Battle ended",
    draw: "Draw",
    resultHelp: "Return to title",
  },
  zh_CN: {
    subtitle: "斯派德冒险",
    adventure: "冒险模式",
    back: "返回",
    legend: "方向键：选择  ○：确认  ×：返回",
    win: "胜利！",
    lose: "战败",
    escape: "对战结束",
    draw: "平局",
    resultHelp: "返回标题菜单",
  },
} as const;

interface Canvas {
  scale: number;
  left: number;
  top: number;
}

export function titleBattleCanvas(viewport: { w: number; h: number }): Canvas {
  const scale = Math.min(viewport.w / TITLE_BATTLE_BASE_W, viewport.h / TITLE_BATTLE_BASE_H);
  return {
    scale,
    left: Math.floor((viewport.w - TITLE_BATTLE_BASE_W * scale) / 2),
    top: Math.floor((viewport.h - TITLE_BATTLE_BASE_H * scale) / 2),
  };
}

function viewRect(canvas: Canvas, rect: { x: number; y: number; w: number; h: number }) {
  return {
    x: canvas.left + rect.x * canvas.scale,
    y: canvas.top + rect.y * canvas.scale,
    w: rect.w * canvas.scale,
    h: rect.h * canvas.scale,
  };
}

export function createTitleBattleOverlay(options: TitleBattleOptions): SessionOwningOverlayConfig & {
  runtimeRef: { current: TitleBattleRuntime | null };
} {
  const runtimeRef: { current: TitleBattleRuntime | null } = { current: null };
  return {
    runtimeRef,
    ownsSession: () => runtimeRef.current?.ownsSession() ?? false,
    create(host) {
      const runtime = createTitleBattleRuntime(options, host);
      runtimeRef.current = runtime;
      return {
        step: runtime.step,
        isOpen: runtime.isOpen,
        render() {
          // Automation and campaign play keep the title runtime available
          // without paying for its frame observer or gesture regions.
          return <Show when={runtime.isOpen()}><TitleBattleView runtime={runtime} /></Show>;
        },
      };
    },
  };
}

const TitleBattleView: Component<{ runtime: TitleBattleRuntime }> = (props) => {
  const runtime = props.runtime;
  const t = () => STRINGS[runtime.lang];
  const state = () => runtime.state();
  const open = () => runtime.isOpen();
  const [viewport, setViewport] = createSignal({ w: TITLE_BATTLE_BASE_W, h: TITLE_BATTLE_BASE_H });
  onFrame(() => {
    if (!open()) return;
    const next = hostViewport(getOps());
    if (next && (next.w !== viewport().w || next.h !== viewport().h)) setViewport({ w: next.w, h: next.h });
  });
  const canvas = createMemo(() => titleBattleCanvas(viewport()));
  const disabledRect = { x: -1, y: -1, w: 0, h: 0 } as const;

  TITLE_ROWS.forEach((rect, index) => createGesture({
    region: { rect: () => state().screen === "title"
      ? viewRect(canvas(), rect)
      : disabledRect },
    onTap: () => {
      if (state().screen === "title") runtime.selectTitle(index);
    },
  }));
  DIFFICULTY_ROWS.forEach((rect, index) => createGesture({
    region: { rect: () => state().screen === "difficulty"
      ? viewRect(canvas(), rect)
      : disabledRect },
    onTap: () => {
      if (state().screen === "difficulty") runtime.selectDifficulty(index);
    },
  }));
  createGesture({
    region: { rect: () => state().screen === "difficulty"
      ? viewRect(canvas(), BACK_RECT)
      : disabledRect },
    onTap: () => {
      if (state().screen === "difficulty") runtime.applyAction("back");
    },
  });
  createGesture({
    region: { rect: () => state().screen === "result"
      ? viewRect(canvas(), RESULT_RECT)
      : disabledRect },
    onTap: () => {
      if (state().screen === "result") runtime.applyAction("confirm");
    },
  });

  const resultText = () => {
    const result = state().result;
    return result === "win" ? t().win
      : result === "lose" ? t().lose
        : result === "draw" ? t().draw
          : t().escape;
  };

  return (
    <Show when={open()}>
      <View class="absolute inset-0" style={{ posType: 1, bgColor: "#030c12" }} debugName="tux-title-overlay">
        <View
          class="absolute overflow-hidden"
          style={{
            posType: 1,
            insetL: canvas().left,
            insetT: canvas().top,
            width: TITLE_BATTLE_BASE_W,
            height: TITLE_BATTLE_BASE_H,
            scaleX: canvas().scale,
            scaleY: canvas().scale,
            originX: -0.5,
            originY: -0.5,
            bgColor: "#071923",
          }}
          debugName="tux-title-canvas"
        >
          <Image
            class="absolute"
            src={TITLE_BACKGROUND}
            style={{ posType: 1, insetL: 0, insetT: 0, width: 480, height: 240, opacity: 0.68 }}
            debugName="tux-title-background"
          />
          <View class="absolute" style={{ posType: 1, insetL: 0, insetT: 0, width: 480, height: 272, bgColor: "#061722aa" }} />
          <Show when={state().screen === "title"}>
            <View class="absolute" style={{ posType: 1, insetL: 18, insetT: 17, width: 6, height: 91, bgColor: TUXEMON_UI_THEME.accent }} />
            <Text class="text-lg" style={{ posType: 1, insetL: 34, insetT: 21, width: 300, height: 32, lineHeight: 25, textColor: "#f3fbff" }} debugName="tux-title-name">
              POCKET TUXEMON
            </Text>
            <Text class="text-sm" style={{ posType: 1, insetL: 36, insetT: 58, width: 240, height: 23, lineHeight: 18, textColor: TUXEMON_UI_THEME.accent }} debugName="tux-title-subtitle">
              {t().subtitle}
            </Text>
            <View class="absolute" style={{ posType: 1, insetL: 261, insetT: 130, width: 204, height: 116, borderWidth: 2, borderColor: TUXEMON_UI_THEME.rim, bgColor: "#071923e8" }} />
            <For each={[t().adventure, runtime.data.title[runtime.lang]]}>{(label, index) => {
              const rect = TITLE_ROWS[index()]!;
              const selected = () => state().titleIndex === index();
              return (
                <View
                  class="absolute flex-row items-center"
                  style={{
                    posType: 1,
                    insetL: rect.x,
                    insetT: rect.y,
                    width: rect.w,
                    height: rect.h,
                    borderWidth: selected() ? 2 : 1,
                    borderColor: selected() ? TUXEMON_UI_THEME.accent : TUXEMON_UI_THEME.border,
                    bgColor: selected() ? "#145064" : "#0a2633",
                  }}
                  debugName={`tux-title-row-${index()}`}
                >
                  <Text class="text-sm" style={{ marginL: 15, width: 138, height: 20, lineHeight: 18, textColor: selected() ? "#ffffff" : TUXEMON_UI_THEME.ink }}>
                    {label}
                  </Text>
                </View>
              );
            }}</For>
          </Show>

          <Show when={state().screen === "difficulty"}>
            <View class="absolute" style={{ posType: 1, insetL: 111, insetT: 31, width: 258, height: 222, borderWidth: 2, borderColor: TUXEMON_UI_THEME.rim, bgColor: "#071923" }} />
            <Text class="text-sm" style={{ posType: 1, insetL: 125, insetT: 48, width: 230, height: 24, lineHeight: 19, textAlign: 1, textColor: TUXEMON_UI_THEME.accent }} debugName="tux-title-difficulty-prompt">
              {runtime.data.difficultyPrompt[runtime.lang]}
            </Text>
            <For each={runtime.data.difficulties}>{(difficulty, index) => {
              const rect = DIFFICULTY_ROWS[index()]!;
              const selected = () => state().difficultyIndex === index();
              return (
                <View
                  class="absolute flex-row items-center"
                  style={{
                    posType: 1,
                    insetL: rect.x,
                    insetT: rect.y,
                    width: rect.w,
                    height: rect.h,
                    borderWidth: selected() ? 2 : 1,
                    borderColor: selected() ? TUXEMON_UI_THEME.accent : TUXEMON_UI_THEME.border,
                    bgColor: selected() ? "#145064" : "#0a2633",
                  }}
                  debugName={`tux-title-difficulty-${difficulty.id}`}
                >
                  <Text class="text-sm" style={{ marginL: 12, width: 124, height: 19, lineHeight: 17, textColor: TUXEMON_UI_THEME.ink }}>
                    {difficulty.label[runtime.lang]}
                  </Text>
                  <Text class="text-xs" style={{ width: 72, height: 17, lineHeight: 14, textAlign: 2, textColor: TUXEMON_UI_THEME.dim }}>
                    {`${difficulty.partySize}v${difficulty.partySize}  Lv.${difficulty.level}`}
                  </Text>
                </View>
              );
            }}</For>
            <View class="absolute flex-row items-center" style={{ posType: 1, insetL: BACK_RECT.x, insetT: BACK_RECT.y, width: BACK_RECT.w, height: BACK_RECT.h, borderWidth: 1, borderColor: TUXEMON_UI_THEME.border, bgColor: "#0a2633" }}>
              <Text class="text-xs" style={{ marginL: 14, width: 65, height: 17, lineHeight: 14, textColor: TUXEMON_UI_THEME.dim }}>{`×  ${t().back}`}</Text>
            </View>
          </Show>

          <Show when={state().screen === "result"}>
            <View class="absolute" style={{ posType: 1, insetL: 105, insetT: 76, width: 270, height: 151, borderWidth: 2, borderColor: TUXEMON_UI_THEME.rim, bgColor: "#071923f2" }} debugName="tux-title-result-panel">
              <Text class="text-lg" style={{ posType: 1, insetL: 20, insetT: 25, width: 230, height: 31, lineHeight: 24, textAlign: 1, textColor: TUXEMON_UI_THEME.accent }} debugName="tux-title-result">
                {resultText()}
              </Text>
              <View class="absolute flex-row justify-center items-center" style={{ posType: 1, insetL: 40, insetT: 108, width: 190, height: 34, borderWidth: 1, borderColor: TUXEMON_UI_THEME.accent, bgColor: "#145064" }}>
                <Text class="text-sm" style={{ width: 160, height: 20, lineHeight: 18, textAlign: 1, textColor: "#ffffff" }}>{t().resultHelp}</Text>
              </View>
            </View>
          </Show>

          <Show when={state().screen === "title"}>
            <Text class="text-xs" style={{ posType: 1, insetL: 20, insetT: 249, width: 430, height: 16, lineHeight: 14, textColor: TUXEMON_UI_THEME.dim }} debugName="tux-title-legend">
              {t().legend}
            </Text>
          </Show>
        </View>
      </View>
    </Show>
  );
};

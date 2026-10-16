// Title-menu/Battle/Minigame overlay. The composition is authored
// once at 480x272 and uniformly scaled/letterboxed for desktop, web and PSP.

import { For, Show, createMemo, createSignal, type Component } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { getOps, hostViewport } from "@pocketjs/framework/host";
import { onFrame } from "@pocketjs/framework/lifecycle";
import type { BattleImageRef } from "../importer/battle-schema.ts";
import { featureText } from "./feature-modes-data.ts";
import {
  createBattleImageCache,
  LazyImage,
  type TileImageSource,
} from "../vendor/pocket-rpgkit/src/ui/battle/index.ts";
import type { SessionOwningOverlayConfig } from "./game-overlay.tsx";
import { TUXEMON_UI_THEME } from "./tuxemon-theme.ts";
import {
  createTitleBattleRuntime,
  type TitleBattleOptions,
  type TitleBattleRuntime,
  type TitleBattleScreen,
  type TitleMenuRowId,
} from "./title-battle-runtime.ts";

export const TITLE_BATTLE_BASE_W = 480;
export const TITLE_BATTLE_BASE_H = 272;
const TITLE_MENU_MAX_ROWS = 7;
const TITLE_MENU_AREA = { x: 267, y: 38, w: 188, h: 200 } as const;
const TITLE_MENU_ROW_H = 25;
const TITLE_MENU_ROW_GAP = 4;
export function titleMenuRowRects(count: number): readonly { x: number; y: number; w: number; h: number }[] {
  if (!Number.isInteger(count) || count < 1 || count > TITLE_MENU_MAX_ROWS) {
    throw new RangeError(`title menu: row count must be 1..${TITLE_MENU_MAX_ROWS}`);
  }
  const height = count * TITLE_MENU_ROW_H + (count - 1) * TITLE_MENU_ROW_GAP;
  const top = TITLE_MENU_AREA.y + Math.floor((TITLE_MENU_AREA.h - height) / 2);
  return Array.from({ length: count }, (_, index) => ({
    x: TITLE_MENU_AREA.x,
    y: top + index * (TITLE_MENU_ROW_H + TITLE_MENU_ROW_GAP),
    w: TITLE_MENU_AREA.w,
    h: TITLE_MENU_ROW_H,
  }));
}
const DIFFICULTY_ROWS = [0, 1, 2, 3, 4].map((index) => ({
  x: 130,
  y: 88 + index * 31,
  w: 220,
  h: 27,
}));
const MINIGAME_DIFFICULTY_ROWS = [0, 1, 2].map((index) => ({
  x: 130,
  y: 101 + index * 39,
  w: 220,
  h: 31,
}));
const MINIGAME_OPTION_ROWS = [
  { x: 25, y: 146, w: 138, h: 28 },
  { x: 171, y: 146, w: 138, h: 28 },
  { x: 317, y: 146, w: 138, h: 28 },
  { x: 98, y: 180, w: 138, h: 28 },
  { x: 244, y: 180, w: 138, h: 28 },
] as const;
const BACK_RECT = { x: 20, y: 229, w: 92, h: 28 };
const RESULT_RECT = { x: 145, y: 184, w: 190, h: 34 };
const MINIGAME_EXIT_RECT = { x: 378, y: 235, w: 84, h: 25 };
const MINIGAME_PREV_RECT = { x: 43, y: 77, w: 32, h: 31 };
const MINIGAME_NEXT_RECT = { x: 405, y: 77, w: 32, h: 31 };
const MINIGAME_WRONG_RECT = { x: 145, y: 164, w: 190, h: 36 };
const TITLE_BACKGROUND = "assets/battle/gfx/ui/combat/grass_background.png";

const STRINGS = {
  en_US: {
    subtitle: "SPYDER ADVENTURES",
    back: "Back",
    legend: "d-pad: choose   o: confirm   x: back",
    win: "Victory!",
    lose: "Defeat",
    escape: "Battle ended",
    draw: "Draw",
    resultHelp: "Return to title",
    quitMessage: "You can close this tab.",
  },
  zh_CN: {
    subtitle: "斯派德冒险",
    back: "返回",
    legend: "方向键：选择  ○：确认  ×：返回",
    win: "胜利！",
    lose: "战败",
    escape: "对战结束",
    draw: "平局",
    resultHelp: "返回标题菜单",
    quitMessage: "现在可以关闭此标签页。",
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

function imageSource(ref: BattleImageRef): TileImageSource {
  return {
    kind: "tile",
    ref: ref.key,
    sourceWidth: ref.width,
    sourceHeight: ref.height,
  };
}

function isMinigameQuestion(screen: TitleBattleScreen): boolean {
  return screen === "minigameQuestion" || screen === "minigameWrong";
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
          // without paying for its frame observer, gestures or image cache.
          return <Show when={runtime.isOpen()}><TitleBattleView runtime={runtime} /></Show>;
        },
      };
    },
  };
}

const TitleBattleView: Component<{ runtime: TitleBattleRuntime }> = (props) => {
  const runtime = props.runtime;
  const t = () => runtime.lang === "zh_CN" ? STRINGS.zh_CN : STRINGS.en_US;
  const state = () => runtime.state();
  const titleRows = () => runtime.titleRows();
  const titleRects = createMemo(() => titleMenuRowRects(titleRows().length));
  const titleRowLabel = (id: TitleMenuRowId): string => featureText(runtime.menuText[id], runtime.lang);
  const minigame = () => state().minigame;
  const minigameDifficulty = () => {
    const current = minigame();
    return current ? runtime.minigameData.difficulties[current.difficultyIndex] : undefined;
  };
  const currentMonster = () => {
    const slug = minigame()?.question.target;
    return slug ? runtime.catalog.monster(slug) : undefined;
  };
  const optionName = (slug: string): string => runtime.catalog.monster(slug)?.name ?? slug;
  const imageActive = () => isMinigameQuestion(state().screen)
    && minigameDifficulty()?.clue === "image";
  const imageCache = createBattleImageCache(imageActive, { maxEntries: 1 });
  const activeImageSource = (ref: BattleImageRef): TileImageSource => {
    // The title view stays mounted while its image clue is closed. Re-open
    // the cache scope before LazyImage acquires so a later quiz round cannot
    // race the reactive active() effect after an earlier endScope().
    if (imageActive()) imageCache.beginScope();
    return imageSource(ref);
  };
  const open = () => runtime.isOpen();
  const [viewport, setViewport] = createSignal({ w: TITLE_BATTLE_BASE_W, h: TITLE_BATTLE_BASE_H });
  onFrame(() => {
    if (!open()) return;
    const next = hostViewport(getOps());
    if (next && (next.w !== viewport().w || next.h !== viewport().h)) {
      setViewport({ w: next.w, h: next.h });
    }
  });
  const canvas = createMemo(() => titleBattleCanvas(viewport()));
  const disabledRect = { x: -1, y: -1, w: 0, h: 0 } as const;

  Array.from({ length: TITLE_MENU_MAX_ROWS }).forEach((_, index) => createGesture({
    region: { rect: () => state().screen === "title" && titleRows()[index] !== undefined
      ? viewRect(canvas(), titleRects()[index]!)
      : disabledRect },
    onTap: () => {
      if (state().screen === "title") runtime.selectTitle(index);
    },
  }));
  DIFFICULTY_ROWS.forEach((rect, index) => createGesture({
    region: { rect: () => state().screen === "difficulty" ? viewRect(canvas(), rect) : disabledRect },
    onTap: () => {
      if (state().screen === "difficulty") runtime.selectDifficulty(index);
    },
  }));
  MINIGAME_DIFFICULTY_ROWS.forEach((rect, index) => createGesture({
    region: { rect: () => state().screen === "minigameDifficulty" ? viewRect(canvas(), rect) : disabledRect },
    onTap: () => {
      if (state().screen === "minigameDifficulty") runtime.selectMinigameDifficulty(index);
    },
  }));
  MINIGAME_OPTION_ROWS.forEach((rect, index) => createGesture({
    region: { rect: () => state().screen === "minigameQuestion"
      && minigame()?.question.options[index] !== undefined
      ? viewRect(canvas(), rect)
      : disabledRect },
    onTap: () => {
      if (state().screen === "minigameQuestion") runtime.selectMinigameAnswer(index);
    },
  }));
  createGesture({
    region: { rect: () => state().screen === "difficulty" || state().screen === "minigameDifficulty"
      ? viewRect(canvas(), BACK_RECT)
      : disabledRect },
    onTap: () => runtime.applyAction("back"),
  });
  createGesture({
    region: { rect: () => state().screen === "result" ? viewRect(canvas(), RESULT_RECT) : disabledRect },
    onTap: () => runtime.applyAction("confirm"),
  });
  createGesture({
    region: { rect: () => isMinigameQuestion(state().screen)
      ? viewRect(canvas(), MINIGAME_EXIT_RECT)
      : disabledRect },
    onTap: () => runtime.applyAction("back"),
  });
  createGesture({
    region: { rect: () => state().screen === "minigameQuestion"
      && minigameDifficulty()?.clue === "description"
      ? viewRect(canvas(), MINIGAME_PREV_RECT)
      : disabledRect },
    onTap: () => runtime.applyAction("left"),
  });
  createGesture({
    region: { rect: () => state().screen === "minigameQuestion"
      && minigameDifficulty()?.clue === "description"
      ? viewRect(canvas(), MINIGAME_NEXT_RECT)
      : disabledRect },
    onTap: () => runtime.applyAction("right"),
  });
  createGesture({
    region: { rect: () => state().screen === "minigameWrong"
      ? viewRect(canvas(), MINIGAME_WRONG_RECT)
      : disabledRect },
    onTap: () => runtime.applyAction("confirm"),
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
            <Text class="text-lg" style={{ posType: 1, insetL: 34, insetT: 21, width: 210, height: 32, lineHeight: 25, textColor: "#f3fbff" }} debugName="tux-title-name">
              POCKET TUXEMON
            </Text>
            <Text class="text-sm" style={{ posType: 1, insetL: 36, insetT: 58, width: 205, height: 23, lineHeight: 18, textColor: TUXEMON_UI_THEME.accent }} debugName="tux-title-subtitle">
              {t().subtitle}
            </Text>
            <View class="absolute" style={{ posType: 1, insetL: 253, insetT: 28, width: 215, height: 220, borderWidth: 2, borderColor: TUXEMON_UI_THEME.rim, bgColor: "#071923e8" }} />
            <For each={titleRows()}>{(row, index) => {
              const rect = () => titleRects()[index()]!;
              const selected = () => state().titleIndex === index();
              return (
                <View
                  class="absolute flex-row items-center"
                  style={{
                    posType: 1,
                    insetL: rect().x,
                    insetT: rect().y,
                    width: rect().w,
                    height: rect().h,
                    borderWidth: selected() ? 2 : 1,
                    borderColor: selected() ? TUXEMON_UI_THEME.accent : TUXEMON_UI_THEME.border,
                    bgColor: selected() ? "#145064" : "#0a2633",
                  }}
                  debugName={`tux-title-row-${row}`}
                >
                  <Text class="text-sm" style={{ marginL: 13, width: 160, height: 19, lineHeight: 17, textColor: selected() ? "#ffffff" : TUXEMON_UI_THEME.ink }}>
                    {titleRowLabel(row)}
                  </Text>
                </View>
              );
            }}</For>
          </Show>

          <Show when={state().screen === "quit"}>
            <View class="absolute" style={{ posType: 1, insetL: 87, insetT: 73, width: 306, height: 126, borderWidth: 2, borderColor: TUXEMON_UI_THEME.rim, bgColor: "#071923ed" }} />
            <Text class="text-lg" style={{ posType: 1, insetL: 105, insetT: 95, width: 270, height: 31, lineHeight: 25, textAlign: 1, textColor: TUXEMON_UI_THEME.accent }} debugName="tux-title-quit-heading">
              {featureText(runtime.menuText.exit, runtime.lang)}
            </Text>
            <Text class="text-sm" style={{ posType: 1, insetL: 105, insetT: 143, width: 270, height: 25, lineHeight: 18, textAlign: 1, textColor: TUXEMON_UI_THEME.ink }} debugName="tux-title-quit-message">
              {t().quitMessage}
            </Text>
          </Show>

          <Show when={state().screen === "difficulty"}>
            <View class="absolute" style={{ posType: 1, insetL: 111, insetT: 31, width: 258, height: 222, borderWidth: 2, borderColor: TUXEMON_UI_THEME.rim, bgColor: "#071923" }} />
            <Text class="text-sm" style={{ posType: 1, insetL: 125, insetT: 48, width: 230, height: 24, lineHeight: 19, textAlign: 1, textColor: TUXEMON_UI_THEME.accent }} debugName="tux-title-difficulty-prompt">
              {featureText(runtime.data.difficultyPrompt, runtime.lang)}
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
                    {featureText(difficulty.label, runtime.lang)}
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

          <Show when={state().screen === "minigameDifficulty"}>
            <View class="absolute" style={{ posType: 1, insetL: 111, insetT: 46, width: 258, height: 194, borderWidth: 2, borderColor: TUXEMON_UI_THEME.rim, bgColor: "#071923" }} />
            <Text class="text-sm" style={{ posType: 1, insetL: 125, insetT: 62, width: 230, height: 24, lineHeight: 19, textAlign: 1, textColor: TUXEMON_UI_THEME.accent }} debugName="tux-minigame-difficulty-prompt">
              {featureText(runtime.minigameData.difficultyPrompt, runtime.lang)}
            </Text>
            <For each={runtime.minigameData.difficulties}>{(difficulty, index) => {
              const rect = MINIGAME_DIFFICULTY_ROWS[index()]!;
              const selected = () => state().minigameDifficultyIndex === index();
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
                  debugName={`tux-minigame-difficulty-${difficulty.id}`}
                >
                  <Text class="text-sm" style={{ marginL: 12, width: 125, height: 19, lineHeight: 17, textColor: TUXEMON_UI_THEME.ink }}>
                    {featureText(difficulty.label, runtime.lang)}
                  </Text>
                  <Text class="text-xs" style={{ width: 66, height: 17, lineHeight: 14, textAlign: 2, textColor: TUXEMON_UI_THEME.dim }}>
                    {`+${difficulty.points}`}
                  </Text>
                </View>
              );
            }}</For>
            <View class="absolute flex-row items-center" style={{ posType: 1, insetL: BACK_RECT.x, insetT: BACK_RECT.y, width: BACK_RECT.w, height: BACK_RECT.h, borderWidth: 1, borderColor: TUXEMON_UI_THEME.border, bgColor: "#0a2633" }}>
              <Text class="text-xs" style={{ marginL: 14, width: 65, height: 17, lineHeight: 14, textColor: TUXEMON_UI_THEME.dim }}>{`×  ${t().back}`}</Text>
            </View>
          </Show>

          <Show when={isMinigameQuestion(state().screen) && minigame() !== null}>
            <Text class="text-lg" style={{ posType: 1, insetL: 20, insetT: 8, width: 440, height: 25, lineHeight: 22, textAlign: 1, textColor: TUXEMON_UI_THEME.accent }} debugName="tux-minigame-question">
              {featureText(runtime.minigameData.question, runtime.lang)}
            </Text>
            <Show
              when={minigameDifficulty()?.clue === "image" ? currentMonster() : undefined}
              fallback={
                <View class="absolute" style={{ posType: 1, insetL: 38, insetT: 38, width: 404, height: 88, borderWidth: 1, borderColor: TUXEMON_UI_THEME.rim, bgColor: "#071923ee" }} debugName="tux-minigame-description-panel">
                  <For each={minigame()!.question.descriptionPages[minigame()!.question.descriptionPage]!}>
                    {(line, index) => (
                      <Text
                        class="text-xs"
                        style={{ posType: 1, insetL: 22, insetT: 9 + index() * 14, width: 360, height: 14, lineHeight: 14, textAlign: 1, textColor: TUXEMON_UI_THEME.ink }}
                        debugName={`tux-minigame-description-row-${index()}`}
                      >
                        {line}
                      </Text>
                    )}
                  </For>
                  <Text class="text-xs" style={{ posType: 1, insetL: 4, insetT: 34, width: 28, height: 18, lineHeight: 15, textAlign: 1, textColor: TUXEMON_UI_THEME.accent }}>‹</Text>
                  <Text class="text-xs" style={{ posType: 1, insetR: 4, insetT: 34, width: 28, height: 18, lineHeight: 15, textAlign: 1, textColor: TUXEMON_UI_THEME.accent }}>›</Text>
                  <Text class="text-xs" style={{ posType: 1, insetR: 8, insetB: 3, width: 46, height: 15, lineHeight: 13, textAlign: 2, textColor: TUXEMON_UI_THEME.dim }} debugName="tux-minigame-page">
                    {`${minigame()!.question.descriptionPage + 1}/${minigame()!.question.descriptionPages.length}`}
                  </Text>
                </View>
              }
            >
              {(monster) => (
                <View class="absolute overflow-hidden" style={{ posType: 1, insetL: 192, insetT: 38, width: 96, height: 96 }} debugName="tux-minigame-monster-clip">
                  <LazyImage
                    src={activeImageSource(monster().art.sheet)}
                    cache={imageCache}
                    active={imageActive()}
                    class="absolute"
                    style={{
                      posType: 1,
                      insetL: -monster().art.front[0] * 1.5,
                      insetT: -monster().art.front[1] * 1.5,
                      width: monster().art.sheet.width * 1.5,
                      height: monster().art.sheet.height * 1.5,
                    }}
                    debugName="tux-minigame-monster-art"
                  />
                </View>
              )}
            </Show>

            <For each={minigame()!.question.options}>{(slug, index) => {
              const rect = MINIGAME_OPTION_ROWS[index()]!;
              const selected = () => minigame()!.selectedIndex === index();
              return (
                <View
                  class="absolute flex-row justify-center items-center"
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
                  debugName={`tux-minigame-option-${index()}`}
                >
                  <Text class="text-xs" style={{ width: 128, height: 24, lineHeight: 12, textAlign: 1, textColor: selected() ? "#ffffff" : TUXEMON_UI_THEME.ink }} debugName={`tux-minigame-option-label-${index()}`}>
                    {optionName(slug)}
                  </Text>
                </View>
              );
            }}</For>

            <Text class="text-sm" style={{ posType: 1, insetL: 20, insetT: 217, width: 145, height: 20, lineHeight: 17, textColor: TUXEMON_UI_THEME.ink }} debugName="tux-minigame-score">
              {`${featureText(runtime.minigameData.scoreLabel, runtime.lang)}: ${minigame()!.score}`}
            </Text>
            <Text class="text-sm" style={{ posType: 1, insetL: 171, insetT: 217, width: 145, height: 20, lineHeight: 17, textColor: TUXEMON_UI_THEME.ink }} debugName="tux-minigame-streak">
              {`${featureText(runtime.minigameData.streakLabel, runtime.lang)}: ${minigame()!.streak}`}
            </Text>
            <Show when={minigame()!.streak >= 10}>
              <Text class="text-xs" style={{ posType: 1, insetL: 20, insetT: 242, width: 340, height: 17, lineHeight: 14, textColor: "#ffd75a" }} debugName="tux-minigame-streak-bonus">
                {featureText(runtime.minigameData.streakBonus, runtime.lang)}
              </Text>
            </Show>
            <View class="absolute flex-row justify-center items-center" style={{ posType: 1, insetL: MINIGAME_EXIT_RECT.x, insetT: MINIGAME_EXIT_RECT.y, width: MINIGAME_EXIT_RECT.w, height: MINIGAME_EXIT_RECT.h, borderWidth: 1, borderColor: TUXEMON_UI_THEME.border, bgColor: "#0a2633" }} debugName="tux-minigame-exit">
              <Text class="text-xs" style={{ width: 74, height: 16, lineHeight: 14, textAlign: 1, textColor: TUXEMON_UI_THEME.dim }}>{`× ${featureText(runtime.minigameData.exit, runtime.lang)}`}</Text>
            </View>

            <Show when={state().screen === "minigameWrong"}>
              <View class="absolute" style={{ posType: 1, insetL: 117, insetT: 83, width: 246, height: 119, borderWidth: 2, borderColor: TUXEMON_UI_THEME.rim, bgColor: "#071923f7" }} debugName="tux-minigame-wrong-panel">
                <Text class="text-lg" style={{ posType: 1, insetL: 18, insetT: 20, width: 210, height: 30, lineHeight: 24, textAlign: 1, textColor: "#ffb17a" }} debugName="tux-minigame-wrong">
                  {featureText(runtime.minigameData.wrong, runtime.lang)}
                </Text>
                <View class="absolute flex-row justify-center items-center" style={{ posType: 1, insetL: 28, insetT: 81, width: 190, height: 28, borderWidth: 1, borderColor: TUXEMON_UI_THEME.accent, bgColor: "#145064" }}>
                  <Text class="text-xs" style={{ width: 170, height: 16, lineHeight: 14, textAlign: 1, textColor: "#ffffff" }}>○</Text>
                </View>
              </View>
            </Show>
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
            <Text class="text-xs" style={{ posType: 1, insetL: 20, insetT: 251, width: 430, height: 16, lineHeight: 14, textColor: TUXEMON_UI_THEME.dim }} debugName="tux-title-legend">
              {t().legend}
            </Text>
          </Show>
        </View>
      </View>
    </Show>
  );
};

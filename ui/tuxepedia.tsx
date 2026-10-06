// Tuxepedia overlay presentation: the menu-opened encyclopedia. The runtime
// (ui/tuxepedia-runtime.ts) owns the navigation state; this file renders the
// list, the detail panel, the counts and the filter, and wires touch through
// the framework gesture layer (tap a row to select it, swipe the list to
// page, tap the filter button to toggle). Text uses the kit's bounded cells
// so a long name, fact line or description wraps or scrolls instead of being
// cut. The 14 authored `open_journal` previews keep using the tux.journal
// scene; this view is the browse mode the START menu opens.

import { createMemo, createSignal, onCleanup, Show, type Component } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { getOps, hostViewport } from "@pocketjs/framework/host";
import type { GameViewOverlayConfig } from "../vendor/pocket-rpgkit/src/ui/demo-contract.ts";
import { Panel } from "../vendor/pocket-rpgkit/src/ui/Panel.tsx";
import { BoundedLine } from "../vendor/pocket-rpgkit/src/ui/BoundedLine.tsx";
import { fitBounded, marqueeOffset, type BoundedCell } from "../vendor/pocket-rpgkit/src/ui/list-window.ts";
import { slotMeasure, TEXT_XS_SLOT } from "../vendor/pocket-rpgkit/src/ui/text-measure.ts";
import { useMarqueeTick } from "../vendor/pocket-rpgkit/src/ui/use-marquee-tick.ts";
import {
  createBattleImageCache,
  LazyImage,
  type TileImageSource,
} from "../vendor/pocket-rpgkit/src/ui/battle/index.ts";
import type { BattleImageRef } from "../importer/battle-schema.ts";
import { TUXEMON_UI_THEME } from "./tuxemon-theme.ts";
import { imageSource, title } from "./journal-scene.tsx";
import {
  createTuxepediaRuntime,
  TUXEPEDIA_PAGE_SIZE,
  type TuxepediaOptions,
  type TuxepediaRuntime,
} from "./tuxepedia-runtime.ts";
import type { Lang } from "./language.ts";

const THEME = TUXEMON_UI_THEME;
/** Font slot of `text-sm` (14 px regular): index 1 of the core's FONT_PX table. */
const TEXT_SM_SLOT = 1;
const LIST_PANEL = { x: 8, y: 32, w: 190, h: 218 };
const DETAIL_PANEL = { x: 204, y: 32, w: 268, h: 218 };
const ROW_H = 26;
const ROW_TOP = 6;
const FILTER_RECT = { x: 322, y: 5, w: 100, h: 20 };
const CLOSE_RECT = { x: 428, y: 5, w: 22, h: 20 };
/** A vertical swipe past this many px turns a list page. */
const SWIPE_PX = 24;

/** The fixed 480x272 composition, letterboxed and scaled to the live
 *  viewport. Drawing and touch hit-testing share this one transform so a tap
 *  lands on the row the player sees at every viewport scale (480x272 and
 *  960x544 both tap the drawn position). */
export const TUXEPEDIA_BASE_W = 480;
export const TUXEPEDIA_BASE_H = 272;

export interface TuxepediaCanvas {
  scale: number;
  left: number;
  top: number;
}

/** The letterbox transform from the base 480x272 composition to `viewport`. */
export function tuxepediaCanvas(viewport: { w: number; h: number }): TuxepediaCanvas {
  const scale = Math.min(viewport.w / TUXEPEDIA_BASE_W, viewport.h / TUXEPEDIA_BASE_H);
  return {
    scale,
    left: Math.floor((viewport.w - TUXEPEDIA_BASE_W * scale) / 2),
    top: Math.floor((viewport.h - TUXEPEDIA_BASE_H * scale) / 2),
  };
}

/** Map a base (480x272) rect to the live viewport (for gesture regions). */
export function tuxepediaViewRect(
  canvas: TuxepediaCanvas,
  rect: { x: number; y: number; w: number; h: number },
): { x: number; y: number; w: number; h: number } {
  return {
    x: canvas.left + rect.x * canvas.scale,
    y: canvas.top + rect.y * canvas.scale,
    w: rect.w * canvas.scale,
    h: rect.h * canvas.scale,
  };
}

/** Map a live viewport point back to base (480x272) coordinates (for taps). */
export function tuxepediaBasePoint(
  canvas: TuxepediaCanvas,
  x: number,
  y: number,
): { x: number; y: number } {
  return { x: (x - canvas.left) / canvas.scale, y: (y - canvas.top) / canvas.scale };
}

const STRINGS = {
  en_US: {
    title: "TUXEPEDIA",
    seen: "SEEN",
    caught: "CAUGHT",
    all: "ALL",
    caughtOnly: "CAUGHT",
    unknown: "Unknown Tuxemon",
    unknownStatus: "UNKNOWN",
    seenStatus: "SEEN",
    caughtStatus: "CAUGHT",
    legend: "up/down: browse  left/right: page  square: filter  x: close",
    close: "x",
  },
  zh_CN: {
    title: "图鉴",
    seen: "已见",
    caught: "已捕获",
    all: "全部",
    caughtOnly: "已捕获",
    unknown: "未知怪兽",
    unknownStatus: "未知",
    seenStatus: "已见",
    caughtStatus: "已捕获",
    // Button glyphs (□/×) match the kit's zh hints ("按 × 返回") and the
    // framework's BUTTON_GLYPHS, not the English key names.
    legend: "上下: 浏览  左右: 翻页  □: 筛选  ×: 关闭",
    close: "×",
  },
} as const;

/** Chinese monster-type names. The game has no runtime type table; these
 *  come from the project's zh glossary (l10n/zh_CN/glossary.tsv, element
 *  rows), which sources the 7 upstream types from Tuxemon's zh_CN catalog
 *  (mods/tuxemon/l18n/zh_CN/LC_MESSAGES/base.po: metal→金属, fire→火, …) and
 *  supplements the 6 the upstream catalog lacks. English keeps the
 *  title-cased slug. */
const ZH_TYPE_NAMES: Readonly<Record<string, string>> = {
  normal: "正常",
  fire: "火",
  water: "水",
  earth: "土",
  metal: "金属",
  wood: "木头",
  venom: "毒液",
  lightning: "闪电",
  frost: "冰",
  sky: "天空",
  shadow: "暗影",
  cosmic: "宇宙",
  heroic: "英勇",
};

function typeName(slug: string, lang: Lang): string {
  if (lang === "zh_CN") {
    const zh = ZH_TYPE_NAMES[slug];
    if (zh) return zh;
  }
  return title(slug);
}

function strings(lang: Lang) {
  return STRINGS[lang] ?? STRINGS.en_US;
}

function statusMarker(caught: boolean, seen: boolean, preview: boolean): string {
  if (caught) return "C";
  if (seen) return "S";
  if (preview) return "P";
  return "?";
}

/** GameView overlay config for the Tuxepedia. `create(host)` builds the
 *  runtime (captured by the caller for the save menu's onExtra hook). */
export function createTuxepediaOverlay(options: TuxepediaOptions): GameViewOverlayConfig & {
  /** Captured on create(host); null until GameView mounts the overlay. */
  runtimeRef: { current: TuxepediaRuntime | null };
} {
  const runtimeRef: { current: TuxepediaRuntime | null } = { current: null };
  return {
    runtimeRef,
    create(host) {
      const runtime = createTuxepediaRuntime(options, host);
      runtimeRef.current = runtime;
      return {
        step: runtime.step,
        isOpen: runtime.isOpen,
        render() {
          return <TuxepediaView runtime={runtime} catalog={options.catalog} />;
        },
      };
    },
  };
}

const TuxepediaView: Component<{
  runtime: TuxepediaRuntime;
  catalog: TuxepediaOptions["catalog"];
}> = (props) => {
  const runtime = props.runtime;
  const catalog = props.catalog;
  const t = () => strings(runtime.lang);
  const open = () => runtime.openSignal();
  const state = () => runtime.state();
  const rows = () => runtime.rows();
  const counts = () => runtime.counts();

  // The overlay renders a fixed 480x272 composition scaled to the live
  // viewport (the same letterbox the journal scene uses), so it fills the
  // screen at 960x544 like the world. Drawing and touch hit-testing share
  // tuxepediaCanvas/tuxepediaViewRect/tuxepediaBasePoint so a tap lands on
  // the row the player sees at every scale.
  const BASE_W = TUXEPEDIA_BASE_W;
  const BASE_H = TUXEPEDIA_BASE_H;
  const [viewport, setViewport] = createSignal({ w: BASE_W, h: BASE_H });
  onFrame(() => {
    if (!open()) return;
    const live = hostViewport(getOps());
    if (live && (live.w !== viewport().w || live.h !== viewport().h)) {
      setViewport({ w: live.w, h: live.h });
    }
  });
  const canvas = createMemo(() => tuxepediaCanvas(viewport()));

  const imageCache = createBattleImageCache(() => open());
  const activeImageSource = (ref: BattleImageRef): TileImageSource => {
    if (open()) imageCache.beginScope();
    return imageSource(ref);
  };

  const measureXs = slotMeasure(TEXT_XS_SLOT);
  const measureSm = slotMeasure(TEXT_SM_SLOT);
  const boundXs = (value: string, width: number, maxRows: number): BoundedCell =>
    fitBounded(value, width, maxRows, measureXs);
  const boundSm = (value: string, width: number, maxRows: number): BoundedCell =>
    fitBounded(value, width, maxRows, measureSm);

  const rowStart = () => Math.max(0, Math.min(
    Math.max(0, rows().length - TUXEPEDIA_PAGE_SIZE),
    state().cursor - Math.floor(TUXEPEDIA_PAGE_SIZE / 2),
  ));
  const visible = () => rows().slice(rowStart(), rowStart() + TUXEPEDIA_PAGE_SIZE);

  const selectedSlug = () => rows()[state().cursor] ?? undefined;
  const selectedEntry = () => {
    const slug = selectedSlug();
    return slug ? catalog.index.find((entry) => entry.id === slug) : undefined;
  };
  const isCaught = (slug: string) => state().caught.includes(slug);
  const isSeen = (slug: string) => state().seen.includes(slug);
  const known = (slug: string | undefined) =>
    slug !== undefined && (isCaught(slug) || isSeen(slug));
  const detail = () => {
    const slug = selectedSlug();
    return known(slug) && slug ? catalog.monster(slug) : undefined;
  };
  const statusLabel = () => {
    const slug = selectedSlug();
    if (slug === undefined) return t().unknownStatus;
    if (isCaught(slug)) return t().caughtStatus;
    if (isSeen(slug)) return t().seenStatus;
    return t().unknownStatus;
  };

  // Bounded cells for the detail panel (no truncation). Unknown monsters hide
  // their name and details behind a placeholder.
  const detailName = createMemo(() => {
    const monster = detail();
    if (!monster) return boundSm(t().unknown, 180, 2);
    return boundSm(monster.name ?? selectedEntry()?.name ?? "", 180, 2);
  });
  const facts = createMemo(() => {
    const monster = detail();
    if (!monster) return { kind: "wrap", rows: [], overflow: 0 } as BoundedCell;
    return boundXs(`${monster.types.map((type) => typeName(type, runtime.lang)).join(" / ")}   ${monster.height} cm   ${monster.weight} kg`, 248, 1);
  });
  const description = createMemo(() => {
    const monster = detail();
    if (!monster) return { kind: "wrap", rows: [], overflow: 0 } as BoundedCell;
    return boundXs(monster.description, 248, 3);
  });
  const rowLabels = createMemo(
    () => visible().map((slug) => {
      const entry = catalog.index.find((e) => e.id === slug);
      const label = known(slug) ? (entry?.name ?? slug) : "???";
      return boundXs(label, 108, 1);
    }),
  );
  const anyMarquee = createMemo(() =>
    detailName().kind === "marquee" ||
    facts().kind === "marquee" ||
    description().kind === "marquee" ||
    rowLabels().some((cell) => cell.kind === "marquee"),
  );
  const marqueeTick = useMarqueeTick(createMemo(() => open() && anyMarquee()));

  const selectVisible = (visibleIndex: number): void => {
    const start = rowStart();
    const target = Math.min(rows().length - 1, start + visibleIndex);
    if (target >= 0) runtime.setCursor(target);
  };
  const page = (dir: 1 | -1): void => {
    runtime.applyAction(dir === 1 ? "pageDown" : "pageUp");
  };
  const toggleFilter = (): void => runtime.applyAction("toggleFilter");

  // Touch: tap a row to select it, swipe the list to page. The gesture
  // region is the list panel mapped through the same canvas transform the
  // drawing uses, and the tap point is mapped back to base coordinates
  // before the row index is computed, so both viewport scales hit the
  // drawn row.
  createGesture({
    region: { rect: () => tuxepediaViewRect(canvas(), LIST_PANEL) },
    tapSlop: 10,
    panSlop: 14,
    axis: "y",
    onTap: (c) => {
      if (!open()) return;
      const p = tuxepediaBasePoint(canvas(), c.x, c.y);
      const index = Math.floor((p.y - (LIST_PANEL.y + ROW_TOP)) / ROW_H);
      selectVisible(Math.max(0, Math.min(TUXEPEDIA_PAGE_SIZE - 1, index)));
    },
    onPanEnd: (c) => {
      if (!open()) return;
      const dy = c.dy / canvas().scale;
      if (dy < -SWIPE_PX) page(1);
      else if (dy > SWIPE_PX) page(-1);
    },
  });
  // Touch: the filter button.
  createGesture({
    region: { rect: () => tuxepediaViewRect(canvas(), FILTER_RECT) },
    onTap: () => { if (open()) toggleFilter(); },
  });
  // Touch: the close button.
  createGesture({
    region: { rect: () => tuxepediaViewRect(canvas(), CLOSE_RECT) },
    onTap: () => { if (open()) runtime.close(); },
  });

  const filterLabel = () => (state().filter === "caught" ? t().caughtOnly : t().all);

  return (
    <Show when={open()}>
      <View
        class="absolute inset-0"
        style={{ posType: 1, bgColor: THEME.backdrop }}
        debugName="tux-tuxepedia-overlay"
      >
        <View
          class="absolute overflow-hidden"
          style={{
            posType: 1,
            insetL: canvas().left,
            insetT: canvas().top,
            width: BASE_W,
            height: BASE_H,
            scaleX: canvas().scale,
            scaleY: canvas().scale,
            originX: -0.5,
            originY: -0.5,
            bgColor: THEME.backdrop,
          }}
          debugName="tux-tuxepedia-canvas"
        >
        {/* Header */}
        <Text
          class="text-lg"
          style={{ posType: 1, insetL: 12, insetT: 6, width: 110, height: 22, lineHeight: 20, textColor: THEME.accent }}
          debugName="tux-tuxepedia-title"
        >
          {t().title}
        </Text>
        <Text
          class="text-xs"
          style={{ posType: 1, insetL: 128, insetT: 9, width: 190, height: 16, lineHeight: 14, textColor: THEME.dim }}
          debugName="tux-tuxepedia-counts"
        >
          {`${t().seen} ${counts().seen}  ${t().caught} ${counts().caught}/${counts().total}`}
        </Text>
        <View
          class="flex-row justify-center items-center"
          style={{
            posType: 1,
            insetL: FILTER_RECT.x,
            insetT: FILTER_RECT.y,
            width: FILTER_RECT.w,
            height: FILTER_RECT.h,
            borderWidth: 1,
            borderColor: state().filter === "caught" ? THEME.accent : THEME.border,
          }}
          debugName="tux-tuxepedia-filter"
        >
          <Text
            class="text-xs"
            style={{ textColor: state().filter === "caught" ? THEME.accent : THEME.ink, lineHeight: 14, height: 14 }}
          >
            {filterLabel()}
          </Text>
        </View>
        <View
          class="flex-row justify-center items-center"
          style={{
            posType: 1,
            insetL: CLOSE_RECT.x,
            insetT: CLOSE_RECT.y,
            width: CLOSE_RECT.w,
            height: CLOSE_RECT.h,
            borderWidth: 1,
            borderColor: THEME.border,
          }}
          debugName="tux-tuxepedia-close"
        >
          <Text class="text-xs" style={{ textColor: THEME.ink, lineHeight: 14, height: 14 }}>
            {t().close}
          </Text>
        </View>

        {/* List */}
        <Panel
          theme={THEME}
          style={{ posType: 1, insetL: LIST_PANEL.x, insetT: LIST_PANEL.y, width: LIST_PANEL.w, height: LIST_PANEL.h }}
          debugName="tux-tuxepedia-list"
        >
          {visible().map((slug, offset) => {
            const index = rowStart() + offset;
            const entry = catalog.index.find((e) => e.id === slug);
            const selectedRow = () => index === state().cursor;
            const caught = isCaught(slug);
            const seen = isSeen(slug);
            const cell = () => rowLabels()[offset]!;
            return (
              <View
                class="absolute"
                style={{
                  posType: 1,
                  insetL: 5,
                  insetT: ROW_TOP + offset * ROW_H,
                  width: 176,
                  height: ROW_H - 2,
                  ...(selectedRow() ? { bgColor: THEME.accent } : {}),
                }}
                debugName={`tux-tuxepedia-row-${index}`}
              >
                <Text
                  class="text-xs"
                  style={{ posType: 1, insetL: 4, insetT: 4, width: 38, height: 16, lineHeight: 14, textColor: selectedRow() ? THEME.paper : THEME.dim }}
                >
                  {`#${String(entry?.txmnId ?? 0).padStart(3, "0")}`}
                </Text>
                <View
                  style={{ posType: 1, insetL: 47, insetT: 4, width: 108, height: 16, overflow: 1 }}
                >
                  <Text
                    class="text-xs"
                    style={{
                      textColor: selectedRow() ? THEME.paper : THEME.ink,
                      lineHeight: 14,
                      height: 14,
                      shrink: 0,
                      translateX: -marqueeOffset(cell().overflow, marqueeTick()),
                    }}
                  >
                    {cell().rows[0] ?? ""}
                  </Text>
                </View>
                <Text
                  class="text-xs"
                  style={{ posType: 1, insetR: 4, insetT: 4, width: 10, height: 16, lineHeight: 14, textColor: selectedRow() ? THEME.paper : THEME.accent }}
                >
                  {statusMarker(caught, seen, false)}
                </Text>
              </View>
            );
          })}
        </Panel>

        {/* Detail */}
        <Panel
          theme={THEME}
          style={{ posType: 1, insetL: DETAIL_PANEL.x, insetT: DETAIL_PANEL.y, width: DETAIL_PANEL.w, height: DETAIL_PANEL.h }}
          debugName="tux-tuxepedia-detail"
        >
          <View style={{ posType: 1, insetL: 10, insetT: 6, width: 180, height: detailName().rows.length > 1 ? 36 : 18 }}>
            <BoundedLine
              cell={detailName()}
              tick={marqueeTick}
              textColor={THEME.accent}
              rowH={18}
              width={180}
              sizeClass="text-sm"
              debugName="tux-tuxepedia-name"
            />
          </View>
          <Text
            class="text-xs"
            style={{ posType: 1, insetR: 8, insetT: 8, width: 70, height: 16, lineHeight: 14, textColor: THEME.dim }}
            debugName="tux-tuxepedia-status"
          >
            {statusLabel()}
          </Text>
          <Show
            when={detail()}
            fallback={
              <Text
                class="text-lg"
                style={{ posType: 1, insetL: 104, insetT: 78, width: 64, height: 30, lineHeight: 26, textColor: THEME.dim }}
                debugName="tux-tuxepedia-unknown"
              >
                ???
              </Text>
            }
          >
            {(monster) => (
              <>
                <View
                  class="absolute overflow-hidden"
                  style={{ posType: 1, insetL: 70, insetT: 28, width: 120, height: 120 }}
                  debugName="tux-tuxepedia-art-clip"
                >
                  <LazyImage
                    src={activeImageSource(monster().art.sheet)}
                    cache={imageCache}
                    active={open()}
                    class="absolute"
                    style={{
                      posType: 1,
                      insetL: -monster().art.front[0] * 2,
                      insetT: -monster().art.front[1] * 2,
                      width: monster().art.sheet.width * 2,
                      height: monster().art.sheet.height * 2,
                    }}
                    debugName="tux-tuxepedia-art"
                  />
                </View>
                <View style={{ posType: 1, insetL: 10, insetT: 152, width: 248, height: facts().rows.length > 0 ? 16 : 0 }}>
                  <BoundedLine
                    cell={facts()}
                    tick={marqueeTick}
                    textColor={THEME.dim}
                    rowH={15}
                    width={248}
                    debugName="tux-tuxepedia-facts"
                  />
                </View>
                <View style={{ posType: 1, insetL: 10, insetT: 170, width: 248, height: 42 }}>
                  <BoundedLine
                    cell={description()}
                    tick={marqueeTick}
                    textColor={THEME.ink}
                    rowH={14}
                    width={248}
                    debugName="tux-tuxepedia-description"
                  />
                </View>
              </>
            )}
          </Show>
        </Panel>

        {/* Legend */}
        <Text
          class="text-xs"
          style={{ posType: 1, insetL: 12, insetT: 254, width: 456, height: 14, lineHeight: 14, textColor: THEME.dim }}
          debugName="tux-tuxepedia-legend"
        >
          {t().legend}
        </Text>
        </View>
      </View>
    </Show>
  );
};

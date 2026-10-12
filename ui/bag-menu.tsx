// Fixed-resolution Bag presentation. Runtime state and persistence stay in
// bag-menu-runtime.ts so keyboard/gamepad and touch share one controller.

import { createMemo, createSignal, Show, type Component } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { getOps, hostViewport } from "@pocketjs/framework/host";
import { onFrame } from "@pocketjs/framework/lifecycle";
import type { GameViewOverlayConfig } from "../vendor/pocket-rpgkit/src/ui/demo-contract.ts";
import { Panel } from "../vendor/pocket-rpgkit/src/ui/Panel.tsx";
import { resolveUiTheme, type UiTheme } from "../vendor/pocket-rpgkit/src/ui/theme.ts";
import { TUXEMON_UI_THEME } from "./tuxemon-theme.ts";
import {
  createBagMenuRuntime,
  type BagMenuOptions,
  type BagMenuRuntime,
  type BagMenuScreen,
  type BagSwipeDirection,
} from "./bag-menu-runtime.ts";

export const BAG_BASE_WIDTH = 480;
export const BAG_BASE_HEIGHT = 272;
export const BAG_LIST_RECT = { x: 8, y: 34, w: 280, h: 202 } as const;
export const BAG_DETAIL_RECT = { x: 294, y: 34, w: 178, h: 202 } as const;
export const BAG_ROW_HEIGHT = 17;
export const BAG_ROW_TOP = 7;
export const BAG_SWIPE_PX = 24;

const CLOSE_RECT = { x: 440, y: 5, w: 28, h: 22 } as const;
const CONFIRM_RECT = { x: 285, y: 142, w: 170, h: 68 } as const;
const CONFIRM_ROW_TOP = 9;
const CONFIRM_ROW_HEIGHT = 24;
const PARTY_RECT = { x: 52, y: 42, w: 376, h: 190 } as const;
const PARTY_ROW_TOP = 8;
const PARTY_ROW_HEIGHT = 28;
const MOVE_RECT = { x: 106, y: 58, w: 268, h: 150 } as const;
const MOVE_ROW_TOP = 10;
const MOVE_ROW_HEIGHT = 28;
const MESSAGE_RECT = { x: 54, y: 76, w: 372, h: 120 } as const;

export interface BagCanvas {
  scale: number;
  left: number;
  top: number;
}

export function bagCanvas(viewport: { w: number; h: number }): BagCanvas {
  const scale = Math.min(viewport.w / BAG_BASE_WIDTH, viewport.h / BAG_BASE_HEIGHT);
  return {
    scale,
    left: Math.floor((viewport.w - BAG_BASE_WIDTH * scale) / 2),
    top: Math.floor((viewport.h - BAG_BASE_HEIGHT * scale) / 2),
  };
}

export function bagViewRect(
  canvas: BagCanvas,
  rect: { x: number; y: number; w: number; h: number },
): { x: number; y: number; w: number; h: number } {
  return {
    x: canvas.left + rect.x * canvas.scale,
    y: canvas.top + rect.y * canvas.scale,
    w: rect.w * canvas.scale,
    h: rect.h * canvas.scale,
  };
}

export function bagBasePoint(canvas: BagCanvas, x: number, y: number): { x: number; y: number } {
  return { x: (x - canvas.left) / canvas.scale, y: (y - canvas.top) / canvas.scale };
}

function rowIndex(y: number, top: number, height: number, count: number): number {
  return Math.max(0, Math.min(count - 1, Math.floor((y - top) / height)));
}

function swipeDirection(dx: number, dy: number): BagSwipeDirection {
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? "left" : "right";
  return dy < 0 ? "up" : "down";
}

/** Overlay factory consumed by the START menu's child-overlay slot. */
export function createBagMenu(options: BagMenuOptions): GameViewOverlayConfig & {
  runtimeRef: { current: BagMenuRuntime | null };
} {
  const runtimeRef: { current: BagMenuRuntime | null } = { current: null };
  return {
    runtimeRef,
    create(host) {
      const runtime = createBagMenuRuntime(options, host);
      runtimeRef.current = runtime;
      return {
        step: runtime.step,
        isOpen: runtime.isOpen,
        render(theme?: Partial<UiTheme>) {
          return <BagMenuView runtime={runtime} theme={theme} />;
        },
      };
    },
  };
}

export const createBagMenuOverlay = createBagMenu;

const BagMenuView: Component<{ runtime: BagMenuRuntime; theme?: Partial<UiTheme> }> = (props) => {
  const runtime = props.runtime;
  const theme = createMemo(() => resolveUiTheme({ ...TUXEMON_UI_THEME, ...props.theme }));
  const open = () => runtime.openSignal();
  const state = () => runtime.state();
  const page = () => runtime.page();
  const [viewport, setViewport] = createSignal({ w: BAG_BASE_WIDTH, h: BAG_BASE_HEIGHT });
  onFrame(() => {
    if (!open()) return;
    const live = hostViewport(getOps());
    if (live && (live.w !== viewport().w || live.h !== viewport().h)) setViewport({ w: live.w, h: live.h });
  });
  const canvas = createMemo(() => bagCanvas(viewport()));
  const disabledRect = { x: -1, y: -1, w: 0, h: 0 } as const;

  createGesture({
    region: { rect: () => open() && state().screen === "items"
      ? bagViewRect(canvas(), BAG_LIST_RECT)
      : disabledRect },
    tapSlop: 10,
    panSlop: 14,
    axis: "any",
    onTap: (contact) => {
      const point = bagBasePoint(canvas(), contact.x, contact.y);
      runtime.activateIndex(rowIndex(
        point.y,
        BAG_LIST_RECT.y + BAG_ROW_TOP,
        BAG_ROW_HEIGHT,
        page().items.length,
      ));
    },
    onPanEnd: (contact) => {
      const dx = contact.dx / canvas().scale;
      const dy = contact.dy / canvas().scale;
      if (Math.max(Math.abs(dx), Math.abs(dy)) >= BAG_SWIPE_PX) runtime.swipe(swipeDirection(dx, dy));
    },
  });
  createGesture({
    region: { rect: () => open() && state().screen === "confirm"
      ? bagViewRect(canvas(), CONFIRM_RECT)
      : disabledRect },
    onTap: (contact) => {
      const point = bagBasePoint(canvas(), contact.x, contact.y);
      runtime.activateIndex(rowIndex(point.y, CONFIRM_RECT.y + CONFIRM_ROW_TOP, CONFIRM_ROW_HEIGHT, 2));
    },
  });
  createGesture({
    region: { rect: () => open() && state().screen === "party"
      ? bagViewRect(canvas(), PARTY_RECT)
      : disabledRect },
    onTap: (contact) => {
      const point = bagBasePoint(canvas(), contact.x, contact.y);
      runtime.activateIndex(rowIndex(point.y, PARTY_RECT.y + PARTY_ROW_TOP, PARTY_ROW_HEIGHT, runtime.partyRows().length));
    },
  });
  createGesture({
    region: { rect: () => open() && state().screen === "moves"
      ? bagViewRect(canvas(), MOVE_RECT)
      : disabledRect },
    onTap: (contact) => {
      const point = bagBasePoint(canvas(), contact.x, contact.y);
      runtime.activateIndex(rowIndex(point.y, MOVE_RECT.y + MOVE_ROW_TOP, MOVE_ROW_HEIGHT, runtime.moveRows().length));
    },
  });
  createGesture({
    region: { rect: () => open() && state().screen === "message"
      ? bagViewRect(canvas(), MESSAGE_RECT)
      : disabledRect },
    onTap: () => runtime.applyAction("confirm"),
  });
  createGesture({
    region: { rect: () => open() ? bagViewRect(canvas(), CLOSE_RECT) : disabledRect },
    onTap: () => runtime.applyAction("back"),
  });

  const modalTitle = (screen: BagMenuScreen): string => {
    if (screen === "party") return runtime.labels.party;
    if (screen === "moves") return runtime.labels.techniques;
    return runtime.selectedItem()?.name ?? runtime.labels.title;
  };

  return (
    <Show when={open()}>
      <View
        class="absolute inset-0"
        style={{ posType: 1, bgColor: theme().backdrop }}
        debugName="tux-bag-overlay"
      >
        <View
          class="absolute overflow-hidden"
          style={{
            posType: 1,
            insetL: canvas().left,
            insetT: canvas().top,
            width: BAG_BASE_WIDTH,
            height: BAG_BASE_HEIGHT,
            scaleX: canvas().scale,
            scaleY: canvas().scale,
            originX: -0.5,
            originY: -0.5,
            bgColor: theme().backdrop,
          }}
          debugName="tux-bag-canvas"
        >
          <Text
            class="text-lg"
            style={{ posType: 1, insetL: 12, insetT: 6, width: 250, height: 24, lineHeight: 21, textColor: theme().accent }}
            debugName="tux-bag-title"
          >
            {runtime.labels.title}
          </Text>
          <Text
            class="text-sm"
            style={{ posType: 1, insetL: 440, insetT: 7, width: 28, height: 20, lineHeight: 18, textColor: theme().accent }}
            debugName="tux-bag-close"
          >
            {"×"}
          </Text>

          <Show when={state().screen === "items"}>
            <Panel theme={theme()} style={{ posType: 1, insetL: BAG_LIST_RECT.x, insetT: BAG_LIST_RECT.y, width: BAG_LIST_RECT.w, height: BAG_LIST_RECT.h }}>
              <Show when={page().items.length > 0} fallback={
                <Text class="text-sm" style={{ posType: 1, insetL: 10, insetT: 10, width: 248, height: 20, lineHeight: 18, textColor: theme().dim }} debugName="tux-bag-empty">
                  {runtime.labels.empty}
                </Text>
              }>
                {page().items.map((row, index) => (
                  <View
                    class="absolute flex-row items-center"
                    style={{
                      posType: 1,
                      insetL: 5,
                      insetT: BAG_ROW_TOP + index * BAG_ROW_HEIGHT,
                      width: 266,
                      height: BAG_ROW_HEIGHT - 1,
                      bgColor: state().cursor === index ? theme().accent : theme().paper,
                    }}
                    debugName={`tux-bag-item-${index}`}
                  >
                    <Text class="text-xs" style={{ width: 220, height: 15, lineHeight: 14, textColor: state().cursor === index ? theme().paper : row.usable ? theme().ink : theme().dim }}>
                      {row.name}
                    </Text>
                    <Text class="text-xs" style={{ width: 40, height: 15, lineHeight: 14, textAlign: "right", textColor: state().cursor === index ? theme().paper : theme().ink }} debugName={`tux-bag-quantity-${index}`}>
                      {`x${row.quantity}`}
                    </Text>
                  </View>
                ))}
              </Show>
            </Panel>
            <Panel theme={theme()} style={{ posType: 1, insetL: BAG_DETAIL_RECT.x, insetT: BAG_DETAIL_RECT.y, width: BAG_DETAIL_RECT.w, height: BAG_DETAIL_RECT.h }}>
              <Show when={runtime.selectedItem()} keyed>
                {(item) => (
                  <>
                    <Text class="text-sm" style={{ posType: 1, insetL: 8, insetT: 8, width: 154, height: 38, lineHeight: 18, textColor: theme().accent }} debugName="tux-bag-item-name">
                      {item.name}
                    </Text>
                    <Text class="text-xs" style={{ posType: 1, insetL: 8, insetT: 48, width: 154, height: 16, lineHeight: 14, textColor: theme().dim }} debugName="tux-bag-item-category">
                      {item.category}
                    </Text>
                    <Text class="text-xs" style={{ posType: 1, insetL: 8, insetT: 70, width: 154, height: 104, lineHeight: 14, textColor: theme().ink }} debugName="tux-bag-item-description">
                      {item.description}
                    </Text>
                  </>
                )}
              </Show>
            </Panel>
            <Text class="text-xs" style={{ posType: 1, insetL: 12, insetT: 244, width: 280, height: 16, lineHeight: 14, textColor: theme().dim }} debugName="tux-bag-legend">
              {"↑↓  ○  ×    ←→ / swipe"}
            </Text>
            <Text class="text-xs" style={{ posType: 1, insetL: 382, insetT: 244, width: 86, height: 16, lineHeight: 14, textAlign: "right", textColor: theme().dim }} debugName="tux-bag-page">
              {`${page().page + 1}/${page().pageCount}`}
            </Text>
          </Show>

          <Show when={state().screen === "confirm"}>
            <Panel theme={theme()} style={{ posType: 1, insetL: CONFIRM_RECT.x, insetT: CONFIRM_RECT.y, width: CONFIRM_RECT.w, height: CONFIRM_RECT.h }}>
              {[runtime.labels.use, runtime.labels.cancel].map((label, index) => (
                <Text
                  class="text-sm"
                  style={{
                    posType: 1,
                    insetL: 8,
                    insetT: CONFIRM_ROW_TOP + index * CONFIRM_ROW_HEIGHT,
                    width: 150,
                    height: 20,
                    lineHeight: 18,
                    textColor: state().actionCursor === index ? theme().accent : theme().ink,
                  }}
                  debugName={`tux-bag-action-${index}`}
                >
                  {`${state().actionCursor === index ? ">" : " "} ${label}`}
                </Text>
              ))}
            </Panel>
          </Show>

          <Show when={state().screen === "party" || state().screen === "moves"}>
            <Text class="text-sm" style={{ posType: 1, insetL: 55, insetT: 17, width: 370, height: 20, lineHeight: 18, textColor: theme().ink }} debugName="tux-bag-modal-title">
              {modalTitle(state().screen)}
            </Text>
          </Show>
          <Show when={state().screen === "party"}>
            <Panel theme={theme()} style={{ posType: 1, insetL: PARTY_RECT.x, insetT: PARTY_RECT.y, width: PARTY_RECT.w, height: PARTY_RECT.h }}>
              {runtime.partyRows().map((row, index) => (
                <View
                  class="absolute flex-row items-center"
                  style={{
                    posType: 1,
                    insetL: 7,
                    insetT: PARTY_ROW_TOP + index * PARTY_ROW_HEIGHT,
                    width: 358,
                    height: PARTY_ROW_HEIGHT - 2,
                    bgColor: state().partyCursor === index ? theme().accent : theme().paper,
                  }}
                  debugName={`tux-bag-party-${index}`}
                >
                  <Text class="text-sm" style={{ width: 170, height: 20, lineHeight: 18, textColor: state().partyCursor === index ? theme().paper : row.eligible ? theme().ink : theme().dim }}>
                    {row.name}
                  </Text>
                  <Text class="text-xs" style={{ width: 58, height: 16, lineHeight: 14, textColor: state().partyCursor === index ? theme().paper : theme().dim }}>
                    {`Lv.${row.level}`}
                  </Text>
                  <Text class="text-xs" style={{ width: 120, height: 16, lineHeight: 14, textAlign: "right", textColor: state().partyCursor === index ? theme().paper : theme().dim }}>
                    {`${runtime.labels.hp} ${row.hp}/${row.maxHp}`}
                  </Text>
                </View>
              ))}
            </Panel>
          </Show>

          <Show when={state().screen === "moves"}>
            <Panel theme={theme()} style={{ posType: 1, insetL: MOVE_RECT.x, insetT: MOVE_RECT.y, width: MOVE_RECT.w, height: MOVE_RECT.h }}>
              {runtime.moveRows().map((row, index) => (
                <Text
                  class="text-sm"
                  style={{
                    posType: 1,
                    insetL: 8,
                    insetT: MOVE_ROW_TOP + index * MOVE_ROW_HEIGHT,
                    width: 246,
                    height: 22,
                    lineHeight: 18,
                    textColor: state().moveCursor === index ? theme().accent : theme().ink,
                  }}
                  debugName={`tux-bag-move-${index}`}
                >
                  {`${state().moveCursor === index ? ">" : " "} ${row.name}`}
                </Text>
              ))}
            </Panel>
          </Show>

          <Show when={state().screen === "message"}>
            <Panel theme={theme()} style={{ posType: 1, insetL: MESSAGE_RECT.x, insetT: MESSAGE_RECT.y, width: MESSAGE_RECT.w, height: MESSAGE_RECT.h }}>
              <Text class="text-sm" style={{ posType: 1, insetL: 10, insetT: 12, width: 348, height: 62, lineHeight: 18, textColor: theme().ink }} debugName="tux-bag-message">
                {state().message?.text ?? ""}
              </Text>
              <Text class="text-xs" style={{ posType: 1, insetL: 10, insetT: 88, width: 348, height: 16, lineHeight: 14, textAlign: "right", textColor: theme().accent }} debugName="tux-bag-message-back">
                {`○ ${runtime.labels.back}`}
              </Text>
            </Panel>
          </Show>
        </View>
      </View>
    </Show>
  );
};

// Production-bundle fixture for the Simplified Chinese kit UI words.
// Every frame comes from dist/main.{js,pak}; the small amount of direct state
// injection selects otherwise distant UI surfaces without maintaining seven
// separate journey tapes. The demo menu is the shipped zh_CN one, listing
// the Chinese chapters.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { FIXED_TIME_HOST_GLOBALS } from "../battle/time-weather.ts";
import type { RuntimeBattleState } from "../battle/runtime.ts";
import {
  NAME_INPUT_SCENE_ID,
  nameInputRules,
} from "../vendor/pocket-rpgkit/src/engine/name-input.ts";
import type { SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { JsonValue } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { BTN } from "../vendor/pocket-rpgkit/vendor/pocketjs/contracts/spec/spec.ts";
import {
  bootWorld,
  type SimWorld,
} from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";

export const UI_TEXT_ZH_VIEWPORTS = [
  { width: 480, height: 272 },
  { width: 960, height: 544 },
] as const;

export const UI_TEXT_ZH_CASES = [
  "save-menu",
  "name-input",
  "demo-menu",
  "shop",
  "button-hints",
  "event-error",
  "battle-status",
] as const;

export type UiTextZhVisualCase = typeof UI_TEXT_ZH_CASES[number];

export interface UiTextZhFrame {
  rgba: Uint8Array;
  tree: unknown;
}

export interface UiTextZhCapture {
  width: number;
  height: number;
  cases: Record<UiTextZhVisualCase, UiTextZhFrame>;
}

interface ZhJourney {
  masks: number[];
}

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");
const JOURNEY = join(ROOT, "data/zh-smoke-journey.json");

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

function globals(): Record<string, unknown> {
  return {
    ...FIXED_TIME_HOST_GLOBALS,
    __pocketTuxemonLang: "zh_CN",
    __pocketTuxemonWorldDiagnostics: undefined,
    __rpgkitBoot: undefined,
    localStorage: memoryStorage(),
  };
}

function step(world: SimWorld, buttons = 0): void {
  world.frame(buttons, 0x8080);
  for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
}

function tap(world: SimWorld, button: number): void {
  step(world, button);
  step(world);
}

function state(): SessionState {
  const live = globalThis.__rpgSessionState;
  if (!live) throw new Error("uiText zh fixture: GameView did not publish SessionState");
  return live;
}

function ownerFiber(live: SessionState): string {
  return live.interp.modal?.fiber
    ?? live.interp.main?.key
    ?? Object.keys(live.interp.parallels)[0]
    ?? "ui-text-zh-fixture";
}

function frame(world: SimWorld): UiTextZhFrame {
  return {
    rgba: world.render().slice(),
    tree: structuredClone(world.getTree()),
  };
}

function treeHasNode(node: unknown, name: string): boolean {
  if (!node || typeof node !== "object") return false;
  const current = node as { n?: unknown; k?: unknown };
  if (current.n === name) return true;
  return Array.isArray(current.k) && current.k.some((child) => treeHasNode(child, name));
}

async function boot(
  viewport: { width: number; height: number },
): Promise<SimWorld> {
  const world = await bootWorld(BUNDLE, 60, globals(), undefined, viewport);
  step(world);
  return world;
}

async function captureSave(viewport: { width: number; height: number }): Promise<UiTextZhFrame> {
  const world = await boot(viewport);
  const hook = globalThis.__pocketTuxemonSave;
  if (!hook) throw new Error("uiText zh fixture: save-menu hook is unavailable");
  if (hook.channel() !== "browser") throw new Error(`uiText zh fixture: expected browser slots, got ${hook.channel()}`);
  hook.open();
  step(world);
  if (hook.menu().kind !== "root") throw new Error("uiText zh fixture: save root did not open");
  return frame(world);
}

async function captureNameInput(viewport: { width: number; height: number }): Promise<UiTextZhFrame> {
  const world = await boot(viewport);
  const live = state();
  const fiber = ownerFiber(live);
  const started = nameInputRules.start(live.ext, { maxLength: 8, default: "小岚" }, 0x5eed, {
    ext: live.ext,
    switches: live.sw.switches,
    variables: live.sw.variables,
    items: live.sw.items,
    gold: live.sw.gold,
    playerName: live.sw.playerName,
  });
  if (!started) throw new Error("uiText zh fixture: name-input rules refused the fixture");
  live.interp.modal = null;
  live.scene = {
    kind: "scene",
    id: NAME_INPUT_SCENE_ID,
    fiber,
    state: started.state,
    pausedTicks: 0,
  };
  step(world);
  const mounted = state().scene;
  if (mounted?.kind !== "scene" || mounted.id !== NAME_INPUT_SCENE_ID) {
    throw new Error("uiText zh fixture: name-input scene did not mount");
  }
  return frame(world);
}

async function captureDemo(viewport: { width: number; height: number }): Promise<UiTextZhFrame> {
  const world = await boot(viewport);
  tap(world, BTN.SELECT);
  if (!treeHasNode(world.getTree(), "rpgkit-demo-menu-title")) {
    throw new Error("uiText zh fixture: demo menu did not open");
  }
  return frame(world);
}

async function captureShop(viewport: { width: number; height: number }): Promise<UiTextZhFrame> {
  const world = await boot(viewport);
  const live = state();
  live.sw.gold = 8_888;
  live.interp.modal = {
    kind: "shop",
    // A non-running owner keeps this presentation-only modal parked; using
    // the opening event's real key would let that event replace it.
    fiber: "ui-text-zh-fixture",
    gold: 8_888,
    sell: true,
    stage: "buy",
    index: 0,
    rows: [
      {
        kind: "item",
        item: "ancient_tea",
        price: 3_150,
        owned: 1,
        canAfford: true,
        atCap: false,
        stock: 3,
        sellable: true,
      },
      { kind: "sell" },
      { kind: "leave" },
    ],
  };
  step(world);
  if (state().interp.modal?.kind !== "shop") throw new Error("uiText zh fixture: shop did not stay open");
  return frame(world);
}

async function captureButtonHints(viewport: { width: number; height: number }): Promise<UiTextZhFrame> {
  const world = await boot(viewport);
  const live = state();
  live.interp.modal = {
    kind: "choices",
    fiber: "ui-text-zh-fixture",
    prompt: "要继续吗？",
    options: ["继续", "返回城镇"],
    index: 0,
    cancellable: true,
  };
  step(world);
  if (state().interp.modal?.kind !== "choices") throw new Error("uiText zh fixture: choices did not stay open");
  return frame(world);
}

async function captureEventError(viewport: { width: number; height: number }): Promise<UiTextZhFrame> {
  const world = await boot(viewport);
  const live = state();
  live.interp.modal = null;
  live.interp.error = { kind: "content", message: "测试事件无法继续。" };
  step(world);
  if (!state().interp.error) throw new Error("uiText zh fixture: event error did not stay visible");
  return frame(world);
}

function readyBattle(state: SessionState): RuntimeBattleState | null {
  if (state.scene?.kind !== "battle") return null;
  const battle = state.scene.state as unknown as RuntimeBattleState;
  return battle.menuMode === "root"
      && battle.battle.awaiting !== null
      && battle.eventCursor >= battle.battle.events.length
    ? battle
    : null;
}

async function captureBattle(viewport: { width: number; height: number }): Promise<UiTextZhFrame> {
  const journey = JSON.parse(readFileSync(JOURNEY, "utf8")) as ZhJourney;
  const world = await boot(viewport);
  for (const mask of journey.masks) {
    step(world, mask);
    if (readyBattle(state())) return frame(world);
  }
  throw new Error("uiText zh fixture: zh smoke journey did not reach the battle command menu");
}

export function uiTextZhGoldenFile(
  visualCase: UiTextZhVisualCase,
  viewport: { width: number; height: number },
): string {
  return `ui-text-zh-${visualCase}.${viewport.width}x${viewport.height}.png`;
}

export async function captureUiTextZh(
  viewport: { width: number; height: number },
): Promise<UiTextZhCapture> {
  if (!existsSync(BUNDLE + ".js") || !existsSync(BUNDLE + ".pak")) {
    throw new Error("uiText zh fixture: run `bun run build` first");
  }
  const cases: Record<UiTextZhVisualCase, UiTextZhFrame> = {
    "save-menu": await captureSave(viewport),
    "name-input": await captureNameInput(viewport),
    "demo-menu": await captureDemo(viewport),
    shop: await captureShop(viewport),
    "button-hints": await captureButtonHints(viewport),
    "event-error": await captureEventError(viewport),
    "battle-status": await captureBattle(viewport),
  };
  return { ...viewport, cases };
}

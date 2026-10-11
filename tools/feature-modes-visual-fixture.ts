// Production-bundle visual fixture for the two out-of-map feature programs.
// One boot captures the title, difficulty picker and a real imported title
// battle; a second automation-compatible boot captures NuPhone and its GPS
// map. Both paths use the public touch regions at the requested viewport.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import featureModesJson from "../data/feature-modes.json";
import { BTN } from "@pocketjs/framework/input";
import { FIXED_TIME_HOST_GLOBALS } from "../battle/time-weather.ts";
import type { FeatureModesRuntimeData } from "../ui/feature-modes-data.ts";
import type { PocketNuPhoneHook } from "../ui/nuphone-runtime.ts";
import type { PocketTitleBattleHook } from "../ui/title-battle-runtime.ts";
import type { SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import {
  __packTouch,
  __packTouchWide,
} from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/src/touch.ts";
import {
  bootWorld,
  type SimWorld,
} from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");
const DATA = (featureModesJson as unknown as FeatureModesRuntimeData);

export const FEATURE_MODES_VIEWPORTS = [
  { width: 480, height: 272 },
  { width: 960, height: 544 },
] as const;

export const FEATURE_MODES_CASES = ["title", "difficulty", "battle", "phone", "map"] as const;
export type FeatureModesCase = typeof FEATURE_MODES_CASES[number];

interface CanvasPoint {
  x: number;
  y: number;
}

export interface FeatureModesFrame {
  rgba: Uint8Array;
  tree: unknown;
}

export interface FeatureModesTouchProbe {
  titleBattle: boolean;
  difficultyBattle: boolean;
  titleBattleDemoBlocked: boolean;
  phoneMap: boolean;
  mapPoint: boolean;
}

export interface FeatureModesCapture {
  width: number;
  height: number;
  lang: "en_US" | "zh_CN";
  cases: Record<FeatureModesCase, FeatureModesFrame>;
  touch: FeatureModesTouchProbe;
}

function pump(world: SimWorld, frames: number): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(0, 0x8080);
    world.tick();
  }
}

function capture(world: SimWorld): FeatureModesFrame {
  return {
    rgba: world.render().slice(),
    tree: structuredClone(world.getTree()),
  };
}

function treeHasNode(node: unknown, name: string): boolean {
  if (node === null || typeof node !== "object") return false;
  const current = node as { n?: unknown; k?: unknown };
  if (current.n === name) return true;
  return Array.isArray(current.k) && current.k.some((child) => treeHasNode(child, name));
}

function press(world: SimWorld, button: number): void {
  world.frame(button, 0x8080);
  world.tick();
  world.frame(0, 0x8080);
  world.tick();
}

function drawnPoint(
  viewport: { width: number; height: number },
  point: CanvasPoint,
): CanvasPoint {
  const scale = Math.min(viewport.width / 480, viewport.height / 272);
  const left = Math.floor((viewport.width - 480 * scale) / 2);
  const top = Math.floor((viewport.height - 272 * scale) / 2);
  return { x: left + point.x * scale, y: top + point.y * scale };
}

function tap(
  world: SimWorld,
  viewport: { width: number; height: number },
  point: CanvasPoint,
): void {
  const drawn = drawnPoint(viewport, point);
  const packed = viewport.width > 511 || viewport.height > 511
    ? __packTouchWide(1, drawn.x, drawn.y)
    : __packTouch(1, drawn.x, drawn.y);
  world.frame(0, 0x8080, [packed]);
  world.tick();
  world.frame(0, 0x8080, []);
  world.tick();
  pump(world, 2);
}

function titleHook(): PocketTitleBattleHook {
  const hook = globalThis.__pocketTitleBattle;
  if (!hook) throw new Error("feature modes fixture: title hook is unavailable");
  return hook;
}

function phoneHook(): PocketNuPhoneHook {
  const hook = globalThis.__pocketNuPhone;
  if (!hook) throw new Error("feature modes fixture: NuPhone hook is unavailable");
  return hook;
}

function live(): SessionState {
  return globalThis.__rpgSessionState as SessionState;
}

async function titleCases(
  viewport: { width: number; height: number },
  lang: "en_US" | "zh_CN",
): Promise<{
  frames: Pick<Record<FeatureModesCase, FeatureModesFrame>, "title" | "difficulty" | "battle">;
  titleBattle: boolean;
  difficultyBattle: boolean;
  titleBattleDemoBlocked: boolean;
}> {
  const world = await bootWorld(BUNDLE, 60, {
    ...FIXED_TIME_HOST_GLOBALS,
    __pocketTuxemonLang: lang,
    // Fixed time normally identifies automation and bypasses the title. This
    // explicit override proves the release title on the same deterministic
    // host used by the rest of the visual suite.
    __pocketTuxemonShowTitle: true,
  }, undefined, viewport);
  pump(world, 12);
  const title = capture(world);

  // Tap the Battle row where it is drawn (base rect 278,194,170,36).
  tap(world, viewport, { x: 363, y: 212 });
  const titleBattle = titleHook().state().screen === "difficulty";
  const difficulty = capture(world);

  // Tap Beginner (base rect 130,88,220,27). This must install the real
  // production battle scene using imported candidates and assets.
  tap(world, viewport, { x: 240, y: 101.5 });
  pump(world, 24);
  const difficultyBattle = titleHook().state().screen === "battle"
    && live().scene?.kind === "battle";
  const battle = capture(world);

  // SELECT normally opens the shipped chapter transport. A title battle owns
  // a disposable session, so replacing it would orphan that owner and crash
  // on the following frame. The production bundle must consume SELECT before
  // the demo runtime sees it, while leaving the real battle alive.
  press(world, BTN.SELECT);
  const titleBattleDemoBlocked = titleHook().state().screen === "battle"
    && live().scene?.kind === "battle"
    && !treeHasNode(world.getTree(), "rpgkit-demo-menu-title");
  return {
    frames: { title, difficulty, battle },
    titleBattle,
    difficultyBattle,
    titleBattleDemoBlocked,
  };
}

async function phoneCases(
  viewport: { width: number; height: number },
  lang: "en_US" | "zh_CN",
): Promise<{
  frames: Pick<Record<FeatureModesCase, FeatureModesFrame>, "phone" | "map">;
  phoneMap: boolean;
  mapPoint: boolean;
}> {
  const world = await bootWorld(BUNDLE, 60, {
    ...FIXED_TIME_HOST_GLOBALS,
    __pocketTuxemonLang: lang,
    __pocketTuxemonShowTitle: false,
    __pocketTuxemonSkipTitle: true,
  }, undefined, viewport);
  pump(world, 3);
  const session = live();
  session.sw.items[DATA.nuPhoneMap.entry.phoneItem] = 1;
  session.sw.items[DATA.nuPhoneMap.entry.appItem] = 1;
  session.sw.switches["tracker.paper_town"] = true;
  session.sw.switches["tracker.route1"] = true;

  const phoneRuntime = phoneHook();
  phoneRuntime.open();
  pump(world, 8);
  const phone = capture(world);

  // Tap the imported Map App card (base rect 28,53,116,106).
  tap(world, viewport, { x: 86, y: 106 });
  const phoneMap = phoneRuntime.state().screen === "map";
  pump(world, 8);
  const map = capture(world);

  // Tap Cotton Town using its authored nominal coordinate projected by the
  // fixed map composition, independently of the overlay hit-test helper.
  const point = DATA.nuPhoneMap.points.find((candidate) => candidate.key === "cotton_town");
  if (!point) throw new Error("feature modes fixture: imported cotton_town point is absent");
  tap(world, viewport, {
    x: 16 + point.x * 1.75,
    y: 10 + (point.y - 7) * 1.75,
  });
  const mapPoint = phoneRuntime.state().cursor === "cotton_town";
  return { frames: { phone, map }, phoneMap, mapPoint };
}

export async function captureFeatureModes(
  viewport: { width: number; height: number },
  lang: "en_US" | "zh_CN",
): Promise<FeatureModesCapture> {
  if (!existsSync(BUNDLE + ".js") || !existsSync(BUNDLE + ".pak")) {
    throw new Error("feature modes fixture: run `bun run build` first");
  }
  const globals = globalThis as Record<string, unknown>;
  const previousLang = globals.__pocketTuxemonLang;
  try {
    const title = await titleCases(viewport, lang);
    const phone = await phoneCases(viewport, lang);
    return {
      width: viewport.width,
      height: viewport.height,
      lang,
      cases: { ...title.frames, ...phone.frames },
      touch: {
        titleBattle: title.titleBattle,
        difficultyBattle: title.difficultyBattle,
        titleBattleDemoBlocked: title.titleBattleDemoBlocked,
        phoneMap: phone.phoneMap,
        mapPoint: phone.mapPoint,
      },
    };
  } finally {
    if (previousLang === undefined) delete globals.__pocketTuxemonLang;
    else globals.__pocketTuxemonLang = previousLang;
  }
}

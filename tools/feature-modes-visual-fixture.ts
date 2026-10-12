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

export const FEATURE_MODES_CASES = [
  "title",
  "difficulty",
  "battle",
  "minigame-easy",
  "minigame-normal",
  "minigame-hard",
  "phone",
  "map",
] as const;
export type FeatureModesCase = typeof FEATURE_MODES_CASES[number];
export type FeatureModesMinigameCase = Extract<FeatureModesCase, `minigame-${string}`>;

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
  titleMinigame: boolean;
  minigameDifficulty: boolean;
  minigameAnswers: boolean;
  minigameExit: boolean;
  phoneMap: boolean;
  mapPoint: boolean;
}

export interface FeatureModesMinigameProbe {
  target: string;
  options: string[];
  description: string;
  descriptionPage: string[];
  descriptionPages: number;
}

export interface FeatureModesCapture {
  width: number;
  height: number;
  lang: "en_US" | "zh_CN";
  cases: Record<FeatureModesCase, FeatureModesFrame>;
  touch: FeatureModesTouchProbe;
  minigame: Record<FeatureModesMinigameCase, FeatureModesMinigameProbe>;
  minigameArtUploads: {
    difficulty: number;
    easy: number;
    normal: number;
    hard: number;
  };
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

  // Tap the Battle row where it is drawn (base rect 278,164,170,31).
  tap(world, viewport, { x: 363, y: 179.5 });
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

const MINIGAME_DIFFICULTY_POINTS = [
  { x: 240, y: 116.5 },
  { x: 240, y: 155.5 },
  { x: 240, y: 194.5 },
] as const;
const MINIGAME_OPTION_POINTS = [
  { x: 94, y: 160 },
  { x: 240, y: 160 },
  { x: 386, y: 160 },
  { x: 167, y: 194 },
  { x: 313, y: 194 },
] as const;

async function minigameCases(
  viewport: { width: number; height: number },
  lang: "en_US" | "zh_CN",
): Promise<{
  frames: Pick<Record<FeatureModesCase, FeatureModesFrame>, FeatureModesMinigameCase>;
  probes: Record<FeatureModesMinigameCase, FeatureModesMinigameProbe>;
  artUploads: FeatureModesCapture["minigameArtUploads"];
  titleMinigame: boolean;
  minigameDifficulty: boolean;
  minigameAnswers: boolean;
  minigameExit: boolean;
}> {
  let uploads = 0;
  const world = await bootWorld(BUNDLE, 60, {
    ...FIXED_TIME_HOST_GLOBALS,
    __pocketTuxemonLang: lang,
    __pocketTuxemonShowTitle: true,
  }, (ops) => {
    const original = ops.uploadImgEntry as ((blob: Uint8Array) => number) | undefined;
    if (!original) throw new Error("feature modes fixture: host has no IMG upload operation");
    ops.uploadImgEntry = (blob: Uint8Array): number => {
      uploads++;
      return original.call(ops, blob);
    };
  }, viewport);
  pump(world, 12);

  const frames = {} as Record<FeatureModesMinigameCase, FeatureModesFrame>;
  const probes = {} as Record<FeatureModesMinigameCase, FeatureModesMinigameProbe>;
  const artUploads = { difficulty: 0, easy: 0, normal: 0, hard: 0 };
  let titleMinigame = true;
  let minigameDifficulty = true;
  let minigameAnswers = true;
  let minigameExit = true;

  for (const [difficultyIndex, difficulty] of DATA.titleMinigame.difficulties.entries()) {
    const beforeDifficulty = uploads;
    // Tap the third title row: the imported Minigame entry.
    tap(world, viewport, { x: 363, y: 217 });
    titleMinigame &&= titleHook().state().screen === "minigameDifficulty";
    artUploads.difficulty += uploads - beforeDifficulty;

    const beforeQuestion = uploads;
    tap(world, viewport, MINIGAME_DIFFICULTY_POINTS[difficultyIndex]!);
    pump(world, 6);
    const screen = titleHook().state();
    minigameDifficulty &&= screen.screen === "minigameQuestion"
      && screen.minigame?.difficultyIndex === difficultyIndex;
    const state = screen.minigame;
    if (!state) throw new Error(`feature modes fixture: ${difficulty.id} question is absent`);
    const visualCase = `minigame-${difficulty.id}` as FeatureModesMinigameCase;
    frames[visualCase] = capture(world);
    probes[visualCase] = {
      target: state.question.target,
      options: [...state.question.options],
      description: state.question.description,
      descriptionPage: [...state.question.descriptionPages[state.question.descriptionPage]!],
      descriptionPages: state.question.descriptionPages.length,
    };
    artUploads[difficulty.id] = uploads - beforeQuestion;

    const correctIndex = state.question.options.indexOf(state.question.target);
    if (correctIndex < 0) throw new Error(`feature modes fixture: ${difficulty.id} omitted its answer`);
    tap(world, viewport, MINIGAME_OPTION_POINTS[correctIndex]!);
    const answered = titleHook().state();
    minigameAnswers &&= answered.screen === "minigameQuestion"
      && answered.minigame?.score === difficulty.points
      && answered.minigame.streak === 1;

    // The always-visible Exit button must return directly to the title and
    // clear score/streak state before the next difficulty starts.
    tap(world, viewport, { x: 420, y: 247 });
    const exited = titleHook().state();
    minigameExit &&= exited.screen === "title" && exited.minigame === null;
  }

  return {
    frames,
    probes,
    artUploads,
    titleMinigame,
    minigameDifficulty,
    minigameAnswers,
    minigameExit,
  };
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
    const minigame = await minigameCases(viewport, lang);
    const phone = await phoneCases(viewport, lang);
    return {
      width: viewport.width,
      height: viewport.height,
      lang,
      cases: { ...title.frames, ...minigame.frames, ...phone.frames },
      touch: {
        titleBattle: title.titleBattle,
        difficultyBattle: title.difficultyBattle,
        titleBattleDemoBlocked: title.titleBattleDemoBlocked,
        titleMinigame: minigame.titleMinigame,
        minigameDifficulty: minigame.minigameDifficulty,
        minigameAnswers: minigame.minigameAnswers,
        minigameExit: minigame.minigameExit,
        phoneMap: phone.phoneMap,
        mapPoint: phone.mapPoint,
      },
      minigame: minigame.probes,
      minigameArtUploads: minigame.artUploads,
    };
  } finally {
    if (previousLang === undefined) delete globals.__pocketTuxemonLang;
    else globals.__pocketTuxemonLang = previousLang;
  }
}

// Production-bundle visual fixture for the menu-opened Tuxepedia overlay.
// Boots the built game, injects seen/caught into the live extension, opens
// the overlay through its test hook, and captures the populated, unknown and
// caught-filter states at both viewports, plus a touch interaction probe
// (tap a row to select it, swipe the list to page).

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { FIXED_TIME_HOST_GLOBALS } from "../battle/time-weather.ts";
import { packTuxemonExtensionState, tuxemonExtensionState } from "../battle/extension.ts";
import {
  bootWorld,
  type SimWorld,
} from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { __packTouch } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/src/touch.ts";
import type { SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { PocketTuxepediaHook } from "../ui/tuxepedia-runtime.ts";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");

export const TUXEPEDIA_VIEWPORTS = [
  { width: 480, height: 272 },
  { width: 960, height: 544 },
] as const;

export const TUXEPEDIA_CASES = ["populated", "unknown", "caughtFilter"] as const;
export type TuxepediaCase = typeof TUXEPEDIA_CASES[number];

/** Monsters injected for the populated/caught-filter cases. */
export const TUXEPEDIA_SEEN = ["bolt", "tweesher"];
export const TUXEPEDIA_CAUGHT = ["rockitten", "nut"];
/** The caught monster the populated case selects. */
export const TUXEPEDIA_POPULATED_SLUG = "nut";

function pump(world: SimWorld, frames: number): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(0, 0x8080);
    world.tick();
  }
}

function live(): SessionState {
  return globalThis.__rpgSessionState as SessionState;
}

function hook(): PocketTuxepediaHook {
  const value = globalThis.__pocketTuxepedia;
  if (!value) throw new Error("tuxepedia fixture: the overlay did not publish its hook");
  return value;
}

function injectDiscovery(seen: string[], caught: string[]): void {
  const state = tuxemonExtensionState(live().ext);
  state.seen = [...seen];
  state.caught = [...caught];
  live().ext = packTuxemonExtensionState(state);
}

export interface TuxepediaCaseCapture {
  rgba: Uint8Array;
  tree: unknown;
  cursor: number;
  filter: string;
  counts: { seen: number; caught: number; total: number };
}

export interface TuxepediaTouchProbe {
  tapFrom: number;
  tapTo: number;
  tapWorked: boolean;
  swipeFrom: number;
  swipeTo: number;
  swipeWorked: boolean;
}

export interface TuxepediaCapture {
  width: number;
  height: number;
  lang: string;
  cases: Record<TuxepediaCase, TuxepediaCaseCapture>;
  touch: TuxepediaTouchProbe;
}

function captureCase(world: SimWorld): TuxepediaCaseCapture {
  const h = hook();
  const state = h.state();
  return {
    rgba: world.render().slice(),
    tree: structuredClone(world.getTree()),
    cursor: state.cursor,
    filter: state.filter,
    // The displayed counts (seen = seen ∪ caught; total excludes txmnId 0).
    counts: h.counts(),
  };
}

/**
 * Boot the bundle at `viewport` in `lang`, open the Tuxepedia with injected
 * discovery, and capture the three visual cases plus a touch probe. The
 * overlay reads the live session on open, so the injection happens first.
 */
export async function captureTuxepedia(
  viewport: { width: number; height: number },
  lang: "en_US" | "zh_CN",
): Promise<TuxepediaCapture> {
  if (!existsSync(BUNDLE + ".js") || !existsSync(BUNDLE + ".pak")) {
    throw new Error("tuxepedia fixture: run `bun run build` first");
  }
  const globals = {
    ...FIXED_TIME_HOST_GLOBALS,
    // Force both languages: an English capture must not inherit a Chinese
    // override or stored preference from an earlier test in the process.
    __pocketTuxemonLang: lang,
  };
  // The sim host keeps host globals past boot; restore the language override so
  // a later zh capture cannot leak into another test's detectLang() call.
  const g = globalThis as Record<string, unknown>;
  const previousLang = g.__pocketTuxemonLang;
  try {
    const world = await bootWorld(BUNDLE, 60, globals, undefined, viewport);
    return await captureOnWorld(world, lang, viewport);
  } finally {
    if (previousLang === undefined) delete g.__pocketTuxemonLang;
    else g.__pocketTuxemonLang = previousLang;
  }
}

async function captureOnWorld(
  world: SimWorld,
  lang: "en_US" | "zh_CN",
  viewport: { width: number; height: number },
): Promise<TuxepediaCapture> {
  pump(world, 2);

  // --- populated: seen/caught injected, cursor on a caught monster ---
  injectDiscovery(TUXEPEDIA_SEEN, TUXEPEDIA_CAUGHT);
  const h = hook();
  h.open();
  pump(world, 8);
  const populatedIndex = h.rows().indexOf(TUXEPEDIA_POPULATED_SLUG);
  if (populatedIndex < 0) throw new Error(`tuxepedia fixture: ${TUXEPEDIA_POPULATED_SLUG} is not in the catalog`);
  for (let i = 0; i < populatedIndex; i++) h.act("down");
  pump(world, 40); // let the lazy front art load
  const populated = captureCase(world);

  // --- caught filter: toggle to caught-only ---
  h.act("toggleFilter");
  pump(world, 8);
  const caughtFilter = captureCase(world);

  // --- touch probe on the populated list (back in all-filter) ---
  h.act("toggleFilter"); // back to all
  pump(world, 4);
  const touch = probeTouch(world, h, viewport);

  // --- unknown: no discovery, first monster ---
  h.close();
  pump(world, 2);
  injectDiscovery([], []);
  h.open();
  pump(world, 8);
  const unknown = captureCase(world);

  return {
    width: viewport.width,
    height: viewport.height,
    lang,
    cases: { populated, unknown, caughtFilter },
    touch,
  };
}

/** The overlay's base composition (ui/tuxepedia.tsx): a fixed 480x272 canvas
 *  letterboxed and scaled to the live viewport. The probe re-derives the
 *  drawn position from the viewport and this base geometry (it does NOT call
 *  the overlay's own canvas transform), so a regression that draws at the
 *  wrong scale still taps where the row is actually painted and fails. */
const BASE_W = 480;
const BASE_H = 272;
const LIST_TOP = 32 + 6; // LIST_PANEL.y + ROW_TOP
const ROW_H = 26;
const ROW_X = 100; // inside the list panel

function drawnPoint(
  viewport: { width: number; height: number },
  baseX: number,
  baseY: number,
): { x: number; y: number } {
  const scale = Math.min(viewport.width / BASE_W, viewport.height / BASE_H);
  const left = Math.floor((viewport.width - BASE_W * scale) / 2);
  const top = Math.floor((viewport.height - BASE_H * scale) / 2);
  return { x: left + baseX * scale, y: top + baseY * scale };
}

/** Tap a list row and swipe the list, verifying the cursor follows. Runs in
 *  the all-filter on the populated list. The tap lands on the row as DRAWN
 *  at the live viewport scale, so it exercises the overlay's scaled hit
 *  regions at both 480x272 and 960x544. */
function probeTouch(
  world: SimWorld,
  h: PocketTuxepediaHook,
  viewport: { width: number; height: number },
): TuxepediaTouchProbe {
  const before = h.state().cursor;
  const total = h.rows().length;

  // Tap visible row 2 where it is drawn: the cursor lands on rowStart + 2.
  const rowStart = Math.max(0, Math.min(Math.max(0, total - 8), before - 4));
  const tap = drawnPoint(viewport, ROW_X, LIST_TOP + 2 * ROW_H + ROW_H / 2);
  world.frame(0, 0x8080, [__packTouch(1, tap.x, tap.y)]);
  world.tick();
  world.frame(0, 0x8080, []); // release → onTap
  world.tick();
  pump(world, 2);
  const afterTap = h.state().cursor;
  const expectedTap = Math.min(total - 1, rowStart + 2);

  // Swipe up (dy < -SWIPE) on the drawn list to page down.
  const swipe = drawnPoint(viewport, ROW_X, LIST_TOP + 4 * ROW_H);
  world.frame(0, 0x8080, [__packTouch(2, swipe.x, swipe.y)]);
  world.tick();
  world.frame(0, 0x8080, [__packTouch(2, swipe.x, swipe.y - 80)]);
  world.tick();
  world.frame(0, 0x8080, []); // release → onPanEnd
  world.tick();
  pump(world, 2);
  const afterSwipe = h.state().cursor;
  const expectedSwipe = Math.min(Math.max(0, total - 1), afterTap + 8);

  return {
    tapFrom: before,
    tapTo: afterTap,
    tapWorked: afterTap === expectedTap,
    swipeFrom: afterTap,
    swipeTo: afterSwipe,
    swipeWorked: afterSwipe === expectedSwipe,
  };
}

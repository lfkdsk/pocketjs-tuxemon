// Tuxepedia production-entry test: the real START-menu path. Boots the built
// game from a real chapter that owns app_tuxepedia, opens START, moves the
// cursor to the dynamically gated row and confirms, then asserts the
// Tuxepedia overlay opened. No menu ordering is hardcoded.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { FIXED_TIME_HOST_GLOBALS } from "../battle/time-weather.ts";
import {
  bootWorld,
  type SimWorld,
} from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { BTN } from "@pocketjs/framework/input";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");
const WASM = join(ROOT, "vendor/pocket-rpgkit/vendor/pocketjs/hosts/web/pocketjs.wasm");
const canBoot = existsSync(BUNDLE + ".js") && existsSync(BUNDLE + ".pak") && existsSync(WASM);
if (!canBoot) {
  console.warn("Tuxepedia entry test skipped; run `bun run build && bun run build:wasm`");
}
const simTest = canBoot ? test : test.skip;

function pump(world: SimWorld, frames: number): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(0, 0x8080);
    world.tick();
  }
}

/** Press and release one button, letting the overlay fold the edge. */
function press(world: SimWorld, button: number): void {
  world.frame(button, button);
  world.tick();
  world.frame(0, 0);
  world.tick();
  pump(world, 2);
}

describe("Tuxepedia production entry", () => {
  simTest("START exposes an owned Tuxepedia app and opens its overlay", async () => {
    const chapterFile = JSON.parse(readFileSync(join(ROOT, "data/chapters.json"), "utf8")) as {
      chapters: { id: string; timelineFrame: number; snapshot: string }[];
    };
    const chapter = chapterFile.chapters.find((row) => row.id === "city-park");
    expect(chapter).toBeDefined();
    const world = await bootWorld(BUNDLE, 60, {
      ...FIXED_TIME_HOST_GLOBALS,
      __pocketTuxemonBootSnapshot: chapter!.snapshot,
      __pocketTuxemonBootFrame: chapter!.timelineFrame,
    }, undefined, {
      width: 480,
      height: 272,
    });
    for (let frame = 0; frame < 120; frame++) {
      pump(world, 1);
      if ((globalThis as { __pocketTuxemonBootReady?: boolean }).__pocketTuxemonBootReady) break;
      await Promise.resolve();
    }
    expect((globalThis as { __pocketTuxemonBootReady?: boolean }).__pocketTuxemonBootReady).toBe(true);

    // START opens its root and resolves the app row from the restored live
    // inventory. Move from the live cursor rather than assuming a position.
    press(world, BTN.START);
    const startHook = globalThis.__pocketStartMenu;
    expect(startHook).toBeDefined();
    expect(startHook!.isOpen()).toBe(true);
    expect(startHook!.state().screen).toBe("root");
    const tuxepediaIndex = startHook!.rows().findIndex((row) => row.id === "tuxepedia");
    expect(tuxepediaIndex).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < startHook!.rows().length && startHook!.state().rootCursor !== tuxepediaIndex; i++) {
      press(world, BTN.DOWN);
    }
    expect(startHook!.state().rootCursor).toBe(tuxepediaIndex);
    press(world, BTN.CIRCLE);

    // The production handoff (main.tsx onExtra) opened the Tuxepedia.
    const tuxepediaHook = (globalThis as {
      __pocketTuxepedia?: { isOpen(): boolean };
    }).__pocketTuxepedia;
    expect(tuxepediaHook).toBeDefined();
    expect(tuxepediaHook!.isOpen()).toBe(true);
    // The START root stays mounted under its child overlay.
    expect(startHook!.isOpen()).toBe(true);
    expect(startHook!.state().rootCursor).toBe(tuxepediaIndex);
  }, 60_000);
});

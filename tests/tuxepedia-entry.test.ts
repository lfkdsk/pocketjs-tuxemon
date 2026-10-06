// Tuxepedia production-entry test: the real START-menu path. Boots the built
// game, opens the save menu with START, moves the cursor to the Tuxepedia row
// and confirms, then asserts the Tuxepedia overlay opened. The key sequence
// is derived from the kit's root row order (saveMenuRootRows), not hardcoded,
// so a kit change that reorders the rows moves the cursor with it.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { FIXED_TIME_HOST_GLOBALS } from "../battle/time-weather.ts";
import {
  bootWorld,
  type SimWorld,
} from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { BTN } from "@pocketjs/framework/input";
import { saveMenuRootRows, type MenuState } from "../vendor/pocket-rpgkit/src/engine/save-menu.ts";

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
  simTest("START opens the save menu and the Tuxepedia row opens the overlay", async () => {
    const world = await bootWorld(BUNDLE, 60, FIXED_TIME_HOST_GLOBALS, undefined, {
      width: 480,
      height: 272,
    });
    pump(world, 8);

    // The sim host has no data.fs and no browser storage, so the save menu
    // is the code-only root; a fresh boot has no autosave row either. Derive
    // the Tuxepedia row's position from the kit's root row order.
    const rows = saveMenuRootRows(false, false, [{ id: "tuxepedia", label: "Tuxepedia" }]);
    const tuxepediaIndex = rows.findIndex((row) => row.id === "tuxepedia");
    expect(tuxepediaIndex).toBeGreaterThan(0);

    // START opens the save menu on the root.
    press(world, BTN.START);
    const saveHook = (globalThis as { __pocketTuxemonSave?: { menu(): MenuState } })
      .__pocketTuxemonSave;
    expect(saveHook).toBeDefined();
    expect(saveHook!.menu().kind).toBe("root");

    // Move to the Tuxepedia row (derived above) and confirm.
    for (let i = 0; i < tuxepediaIndex; i++) press(world, BTN.DOWN);
    expect(saveHook!.menu()).toEqual({ kind: "root", index: tuxepediaIndex });
    press(world, BTN.CIRCLE);

    // The production handoff (main.tsx onExtra) opened the Tuxepedia.
    const tuxepediaHook = (globalThis as {
      __pocketTuxepedia?: { isOpen(): boolean };
    }).__pocketTuxepedia;
    expect(tuxepediaHook).toBeDefined();
    expect(tuxepediaHook!.isOpen()).toBe(true);
    // The save menu stays open on the root underneath the overlay.
    expect(saveHook!.menu()).toEqual({ kind: "root", index: tuxepediaIndex });
  }, 60_000);
});

// Real imported Spyder intro proof for the full-screen backdrop path. The
// exact golden comparison catches layout drift; semantic pixels make a
// self-consistent but blank/wrong golden fail for an understandable reason.

import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { FIXED_TIME_HOST_GLOBALS } from "../battle/time-weather.ts";
import { bundleIsBuilt, ROOT } from "../tools/dialog-token-drive.ts";
import type { SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { bootWorld } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";

const testIfBuilt = bundleIsBuilt() ? test : test.skip;
const BUNDLE = join(ROOT, "dist/main");
const BTN_CONFIRM = 0x2000;
const VIEWPORTS = [{ width: 480, height: 272 }, { width: 960, height: 544 }] as const;

type World = Awaited<ReturnType<typeof bootWorld>>;

function live(): SessionState {
  return globalThis.__rpgSessionState as SessionState;
}

function pump(world: World, frames: number, buttons = 0): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(buttons, 0x8080);
    world.tick();
  }
}

function press(world: World): void {
  pump(world, 1, BTN_CONFIRM);
  pump(world, 2);
}

function waitFor(world: World, label: string, done: () => boolean, limit = 6_000): void {
  for (let frame = 0; frame < limit; frame++) {
    if (done()) return;
    pump(world, 1);
  }
  throw new Error(`backdrop visual: timed out waiting for ${label}`);
}

function rgbaAt(frame: Uint8Array, width: number, x: number, y: number): number[] {
  const offset = (y * width + x) * 4;
  return [...frame.subarray(offset, offset + 4)];
}

testIfBuilt("the imported Dollfin backdrop and dialog render at both target viewports", async () => {
  for (const { width, height } of VIEWPORTS) {
    const world = await bootWorld(BUNDLE, 60, FIXED_TIME_HOST_GLOBALS, undefined, { width, height });
    waitFor(world, `${width}x${height} boot`, () => !!globalThis.__rpgkitDemo && !!globalThis.__rpgSessionState);
    pump(world, 30);

    globalThis.__rpgkitDemo!.warp("spyder_bedroom");
    waitFor(world, `${width}x${height} bedroom`, () => live().mapId === "spyder_bedroom");
    const state = live();
    state.interp.sw = {
      ...state.interp.sw,
      variables: { ...state.interp.sw.variables, "v.question_intro": 1 },
    };
    state.sw = state.interp.sw;
    waitFor(world, `${width}x${height} first intro dialog`, () => live().interp.modal?.kind === "text");

    const variant = "bg_gradient_blue_dollfin_monster";
    let attempts = 0;
    waitFor(world, `${width}x${height} Dollfin portrait`, () => {
      const screen = live().interp.screen;
      if (screen?.backdrop?.variant === variant && live().interp.modal?.kind === "text") return true;
      if (++attempts % 24 === 0) press(world);
      return false;
    });
    pump(world, 20);

    expect(live().interp.screen?.backdrop).toEqual({ layer: "tux_backdrop", variant });
    expect(live().interp.screen?.backdropStack).toBeUndefined();
    expect(live().interp.modal).toMatchObject({ kind: "text", lines: ["Dollfin"] });

    const frame = world.render().slice();
    const scale = width / 480;
    // The authored cyan-striped image fills the screen, Dollfin's blue body
    // remains centered, and the opaque Tuxemon dialog covers the lower band.
    expect(rgbaAt(frame, width, 20, 2 * scale), `${width} backdrop stripe`)
      .toEqual([200, 233, 235, 255]);
    expect(rgbaAt(frame, width, width / 2, height / 2 - 6 * scale), `${width} Dollfin body`)
      .toEqual([81, 155, 204, 255]);
    expect(rgbaAt(frame, width, 20, height - 52), `${width} dialog interior`)
      .toEqual([16, 43, 58, 255]);

    const golden = join(ROOT, `docs/screenshots/portraits/portrait-dollfin.${width}x${height}.png`);
    expect(existsSync(golden), `${width} golden exists`).toBeTrue();
    expect(
      Buffer.from(encodePNG(frame, width, height)).equals(readFileSync(golden)),
      `${width} real imported frame matches golden`,
    ).toBeTrue();
  }
}, 60_000);

// Render the G-PORTRAIT scenes in the built game (dist/main) at 480x272 and
// 960x544: the five Spyder starter portraits (change_bg_monster) with their
// dialog, and the paper-scoop choice_monster menu with its menu-face icons.
//
//   bun run build && bun tools/render-portraits.ts
//
// Screens land in docs/screenshots/portraits/.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { FIXED_TIME_HOST_GLOBALS } from "../battle/time-weather.ts";
import type { ChoiceModal } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";
import type { SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { bootWorld } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");
const OUT = join(ROOT, "docs/screenshots/portraits");
const VIEWPORTS = [{ width: 480, height: 272 }, { width: 960, height: 544 }] as const;
const BTN_CONFIRM = 0x2000;
const STARTERS = ["dollfin", "ignibus", "memnomnom", "budaye", "grintot"] as const;

type World = Awaited<ReturnType<typeof bootWorld>>;

function expect(label: string, condition: boolean): asserts condition {
  if (!condition) throw new Error(`portraits: ${label}`);
}

function live(): SessionState {
  return globalThis.__rpgSessionState as SessionState;
}

function pump(world: World, frames: number, buttons = 0): void {
  for (let i = 0; i < frames; i++) {
    world.frame(buttons, 0x8080);
    world.tick();
  }
}

function press(world: World, button: number): void {
  pump(world, 1, button);
  pump(world, 2);
}

function waitFor(world: World, label: string, done: () => boolean, limit = 600): void {
  for (let i = 0; i < limit; i++) {
    if (done()) return;
    pump(world, 1);
  }
  throw new Error(`portraits: timed out waiting for ${label}`);
}

function backdropVariant(): string | undefined {
  const screen = live().interp.screen as { backdrop?: { variant?: string } } | undefined;
  return screen?.backdrop?.variant;
}

function modal(): ChoiceModal | null {
  const m = live().interp.modal;
  return m && m.kind === "choices" ? m : null;
}

mkdirSync(OUT, { recursive: true });
for (const { width, height } of VIEWPORTS) {
  const world = await bootWorld(BUNDLE, 60, FIXED_TIME_HOST_GLOBALS, undefined, { width, height });
  waitFor(world, "boot", () => !!globalThis.__rpgkitDemo && !!globalThis.__rpgSessionState);
  pump(world, 30);

  // --- The Spyder starter intro (spyder_bedroom "Spyder Intro") ----------
  // question_intro:no makes the intro page run; it walks the five starter
  // portraits, each followed by a centered dialog naming the monster.
  globalThis.__rpgkitDemo!.warp("spyder_bedroom");
  waitFor(world, "spyder_bedroom", () => live().mapId === "spyder_bedroom");
  const state = live();
  state.interp.sw = {
    ...state.interp.sw,
    variables: { ...state.interp.sw.variables, "v.question_intro": 1 },
  };
  state.sw = state.interp.sw;
  // First blocking dialog is spyder_intro00 (over the beaverbrook backdrop).
  waitFor(world, "intro dialog 1", () => live().interp.modal?.kind === "text");
  // The intro's dialogs are multi-page; pulse confirm until each starter
  // portrait backdrop is up with its naming dialog, then capture.
  for (const starter of STARTERS) {
    const target = `bg_gradient_blue_${starter}_monster`;
    let pressed = 0;
    waitFor(
      world,
      `${starter} portrait`,
      () => {
        if (backdropVariant() === target && live().interp.modal?.kind === "text") return true;
        pressed++;
        if (pressed % 24 === 0) press(world, BTN_CONFIRM);
        return false;
      },
      6_000,
    );
    pump(world, 20);
    const shot = world.render().slice();
    writeFileSync(join(OUT, `portrait-${starter}.${width}x${height}.png`), encodePNG(shot, width, height));
  }

  // --- The starter choice (spyder_paper_scoop "Choice") ------------------
  // choice_phase:yes opens the choice_monster menu over the live party.
  globalThis.__rpgkitDemo!.warp("spyder_paper_scoop");
  waitFor(world, "spyder_paper_scoop", () => live().mapId === "spyder_paper_scoop");
  const scoop = live();
  scoop.interp.sw = {
    ...scoop.interp.sw,
    variables: { ...scoop.interp.sw.variables, "v.choice_phase": 3 },
  };
  scoop.sw = scoop.interp.sw;
  waitFor(world, "choice_monster menu", () => modal()?.icons !== undefined);
  pump(world, 20);
  const picker = modal()!;
  expect("five starter options", picker.options.length === 5);
  // Options are sorted (budaye, dollfin, grintot, ignibus, memnomnom).
  expect(
    "icons are the five starter menu faces",
    JSON.stringify(picker.icons!.map((icon) => icon?.sprite)) ===
      JSON.stringify([...STARTERS].sort().map((s) => `tux_monster_menu_${s}`)),
  );
  const top = world.render().slice();
  writeFileSync(join(OUT, `choice-monster.${width}x${height}.png`), encodePNG(top, width, height));
  console.log(`${width}x${height}: 5 portraits + choice menu captured`);
}

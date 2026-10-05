// Runtime proof that the eight choice_monster menu icons take the lazy path:
// none of their IMG entries are uploaded at boot, and only the five visible
// icons upload when the starter choice first opens. The choice menu frame is
// pixel-identical to the committed portrait-shot screenshot (the icons render
// exactly as before, only the load timing changed).
//
// Skips when the production bundle has not been built (local dev); CI builds
// it before running tests.

import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { bootWorld } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { FIXED_TIME_HOST_GLOBALS } from "../battle/time-weather.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import { bundleIsBuilt, ROOT } from "../tools/dialog-token-drive.ts";
import type { ChoiceModal, SessionState } from "../vendor/pocket-rpgkit/src/engine/index.ts";

const testIfBuilt = bundleIsBuilt() ? test : test.skip;

const BUNDLE = join(ROOT, "dist/main");
const VP = { width: 480, height: 272 };
const BTN_CONFIRM = 0x2000;
const STARTERS = ["dollfin", "ignibus", "memnomnom", "budaye", "grintot"] as const;
const ALL_ICONS = ["budaye", "dollfin", "fruitera", "grintot", "hydrone", "ignibus", "memnomnom", "rockitten"]
  .map((s) => `tux_monster_menu_${s}`)
  .sort();

type World = Awaited<ReturnType<typeof bootWorld>>;

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
  throw new Error(`choice-icons: timed out waiting for ${label}`);
}
function backdropVariant(): string | undefined {
  const screen = live().interp.screen as { backdrop?: { variant?: string } } | undefined;
  return screen?.backdrop?.variant;
}
function choiceModal(): ChoiceModal | null {
  const m = live().interp.modal;
  return m && m.kind === "choices" ? m : null;
}

/** FNV-1a over an IMG entry's bytes — the wrapper records every upload so the
 *  test can tell which entries the boot path and the choice menu touched. */
function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `0x${h.toString(16)}`;
}

interface PngImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** Decode an 8-bit RGBA PNG (the kit's encodePNG output). */
function decodePNG(buf: Uint8Array): PngImage {
  let pos = 8,
    width = 0,
    height = 0;
  const idat: number[] = [];
  while (pos < buf.length) {
    const len = (buf[pos]! << 24) | (buf[pos + 1]! << 16) | (buf[pos + 2]! << 8) | buf[pos + 3]!;
    const type = String.fromCharCode(buf[pos + 4]!, buf[pos + 5]!, buf[pos + 6]!, buf[pos + 7]!);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = (data[0]! << 24) | (data[1]! << 16) | (data[2]! << 8) | data[3]!;
      height = (data[4]! << 24) | (data[5]! << 16) | (data[6]! << 8) | data[7]!;
    } else if (type === "IDAT") {
      for (const b of data) idat.push(b);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  const raw = inflateSync(Uint8Array.from(idat));
  const stride = width * 4;
  const rgba = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++]!;
    const line = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? line[x - 4]! : 0;
      const b = prev[x]!;
      const c = x >= 4 ? prev[x - 4]! : 0;
      const v = raw[p++]!;
      line[x] = filter === 0 ? v : filter === 1 ? v + a : filter === 2 ? v + b : filter === 3 ? v + ((a + b) >> 1) : v + (a + b - c > 0 ? Math.max(a, b) : Math.min(a, b));
    }
    line.forEach((v, x) => (rgba[y * stride + x] = v));
    prev = line;
  }
  return { width, height, rgba };
}

testIfBuilt("choice_monster icons upload on first menu open, not at boot", async () => {
  // The eight on-demand IMG entries and their content hashes.
  const iconHashes = new Map<string, string>();
  for (const sprite of ALL_ICONS) {
    const path = resolve(ROOT, "dist/choice-icons", `${sprite}.img`);
    expect(existsSync(path), `${sprite}: IMG entry missing (run bun run import)`).toBe(true);
    iconHashes.set(sprite, fnv1a(readFileSync(path)));
  }

  const uploaded = new Set<string>();
  const world = await bootWorld(
    BUNDLE,
    60,
    FIXED_TIME_HOST_GLOBALS,
    (ops) => {
      const orig = ops.uploadImgEntry as ((buf: Uint8Array) => number) | undefined;
      expect(typeof orig, "host has uploadImgEntry").toBe("function");
      ops.uploadImgEntry = (buf: Uint8Array) => {
        uploaded.add(fnv1a(buf));
        return orig!(buf);
      };
    },
    VP,
  );
  waitFor(world, "boot", () => !!globalThis.__rpgkitDemo && !!globalThis.__rpgSessionState);
  pump(world, 30);

  // Boot is done and no choice menu has opened: no icon IMG entry was uploaded.
  const bootIcons = ALL_ICONS.filter((s) => uploaded.has(iconHashes.get(s)!));
  expect(bootIcons, "no choice icon uploaded at boot").toEqual([]);

  // The Spyder starter intro walks the five portraits (lazy IMG entries too,
  // but a different registry), then the starter choice opens over paper_scoop.
  globalThis.__rpgkitDemo!.warp("spyder_bedroom");
  waitFor(world, "spyder_bedroom", () => live().mapId === "spyder_bedroom");
  const intro = live();
  intro.interp.sw = {
    ...intro.interp.sw,
    variables: { ...intro.interp.sw.variables, "v.question_intro": 1 },
  };
  intro.sw = intro.interp.sw;
  waitFor(world, "intro dialog 1", () => live().interp.modal?.kind === "text");
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
  }
  // Still no choice menu, so still no icon upload.
  expect(ALL_ICONS.filter((s) => uploaded.has(iconHashes.get(s)!)), "no icon after intro").toEqual([]);

  // Open the starter choice.
  globalThis.__rpgkitDemo!.warp("spyder_paper_scoop");
  waitFor(world, "spyder_paper_scoop", () => live().mapId === "spyder_paper_scoop");
  const scoop = live();
  scoop.interp.sw = {
    ...scoop.interp.sw,
    variables: { ...scoop.interp.sw.variables, "v.choice_phase": 3 },
  };
  scoop.sw = scoop.interp.sw;
  waitFor(world, "choice_monster menu", () => choiceModal()?.icons !== undefined);
  pump(world, 20);
  const picker = choiceModal()!;
  expect(picker.options.length, "five starter options").toBe(5);
  const visibleSprites = picker.icons!.map((icon) => icon?.sprite).sort() as string[];
  expect(visibleSprites, "icons are the five starter menu faces").toEqual(
    [...STARTERS].sort().map((s) => `tux_monster_menu_${s}`),
  );

  // Exactly the five visible icons uploaded; the three off-menu icons did not.
  const afterIcons = ALL_ICONS.filter((s) => uploaded.has(iconHashes.get(s)!)).sort();
  expect(afterIcons, "only the five visible icons upload on first open").toEqual(visibleSprites);

  // The choice menu frame is pixel-identical to the committed portrait shot
  // (the icons render exactly as before; only the load timing changed).
  const frame = world.render().slice();
  const shotPath = resolve(ROOT, "docs/screenshots/portraits/choice-monster.480x272.png");
  expect(existsSync(shotPath), "committed choice screenshot exists").toBe(true);
  const shot = decodePNG(readFileSync(shotPath));
  expect(shot.width, "screenshot width").toBe(VP.width);
  expect(shot.height, "screenshot height").toBe(VP.height);
  let diffs = 0;
  for (let i = 0; i < frame.length; i += 4) {
    if (frame[i] !== shot.rgba[i] || frame[i + 1] !== shot.rgba[i + 1] || frame[i + 2] !== shot.rgba[i + 2]) diffs++;
  }
  expect(diffs, "choice menu frame matches the committed screenshot").toBe(0);
}, 60_000);

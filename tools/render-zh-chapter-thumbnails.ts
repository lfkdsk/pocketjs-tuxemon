// Chapter thumbnails for the Chinese build. Each chapter is restored in the
// built game booted in Chinese (dist/main.{js,pak}), exactly as
// bake-chapters.ts renders the English thumbnails. A chapter whose Chinese
// frame is pixel-identical to its English thumbnail (an idle map with no
// words on screen) keeps the English file; one that shows words (the
// bedroom's opening question) gets its own image under
// docs/screenshots/chapters-zh_CN/ (verify:chapters owns chapters/).
//
//   bun run build && bun run build:wasm
//   bun tools/render-zh-chapter-thumbnails.ts          write the images
//   bun tools/render-zh-chapter-thumbnails.ts --check  fail on any difference

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { FIXED_TIME_HOST_GLOBALS } from "../battle/time-weather.ts";
import type { SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { bootWorld } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import { ROOT, THUMB_DIR, THUMB_H, THUMB_W, THUMBNAIL_IDLE } from "./bake-chapters.ts";
import type { ZhChaptersFile } from "./transcribe-zh-tape.ts";
import { ZH_CHAPTERS_REL } from "./zh-tape.ts";

export const ZH_THUMB_DIR = join(THUMB_DIR, "..", "chapters-zh_CN");
const BUNDLE = join(ROOT, "dist/main");

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

/** The Chinese thumbnails that differ from the English ones, by file name. */
export async function renderZhThumbnails(): Promise<{ own: Map<string, Uint8Array>; shared: string[] }> {
  if (!existsSync(BUNDLE + ".js") || !existsSync(BUNDLE + ".pak")) {
    throw new Error("render-zh-chapter-thumbnails: missing dist/main.{js,pak}; run `bun run build && bun run build:wasm`");
  }
  const chapters = (JSON.parse(readFileSync(join(ROOT, ZH_CHAPTERS_REL), "utf8")) as ZhChaptersFile).chapters;
  const own = new Map<string, Uint8Array>();
  const shared: string[] = [];
  for (const chapter of chapters) {
    const world = await bootWorld(BUNDLE, 60, {
      ...FIXED_TIME_HOST_GLOBALS,
      __pocketTuxemonLang: "zh_CN",
      __rpgkitBoot: undefined,
      localStorage: memoryStorage(),
    }, undefined, { width: THUMB_W, height: THUMB_H });
    const demo = globalThis.__rpgkitDemo;
    if (!demo) throw new Error("render-zh-chapter-thumbnails: the Chinese build did not install the demo hook");
    demo.jump(chapter.id);
    let live: SessionState | undefined;
    for (let attempt = 0; attempt < 64; attempt++) {
      world.frame(0);
      world.tick();
      live = globalThis.__rpgSessionState as SessionState | undefined;
      if (live?.frame === chapter.timelineFrame && live.mapId === chapter.map
        && live.move.tx === chapter.position[0] && live.move.ty === chapter.position[1]) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (live?.frame !== chapter.timelineFrame || live.mapId !== chapter.map) {
      throw new Error(`render-zh-chapter-thumbnails: ${chapter.id} did not restore`);
    }
    for (let i = 0; i < (THUMBNAIL_IDLE[chapter.id] ?? 0); i++) {
      world.frame(0);
      world.tick();
    }
    const name = `${chapter.id}-${THUMB_W}x${THUMB_H}.png`;
    const png = encodePNG(world.render().slice(), THUMB_W, THUMB_H);
    const english = readFileSync(join(THUMB_DIR, name));
    if (Buffer.compare(Buffer.from(png), english) === 0) shared.push(name);
    else own.set(name, png);
  }
  return { own, shared };
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const { own, shared } = await renderZhThumbnails();
  const committed = existsSync(ZH_THUMB_DIR) ? readdirSync(ZH_THUMB_DIR).filter((f) => f.endsWith(".png")).sort() : [];
  if (check) {
    let ok = committed.join(",") === [...own.keys()].sort().join(",");
    for (const [name, png] of own) {
      if (!existsSync(join(ZH_THUMB_DIR, name)) || Buffer.compare(Buffer.from(png), readFileSync(join(ZH_THUMB_DIR, name))) !== 0) {
        console.error(`ZH THUMBNAIL DIFFERS: ${name}`);
        ok = false;
      }
    }
    console.log(ok ? `ZH THUMBNAILS OK (${own.size} own, ${shared.length} same as English)` : "ZH THUMBNAILS FAIL");
    process.exit(ok ? 0 : 1);
  }
  rmSync(ZH_THUMB_DIR, { recursive: true, force: true });
  mkdirSync(ZH_THUMB_DIR, { recursive: true });
  for (const [name, png] of own) writeFileSync(join(ZH_THUMB_DIR, name), png);
  console.log(`ZH THUMBNAILS: ${own.size} own (${[...own.keys()].join(", ")}), ${shared.length} same as English`);
}

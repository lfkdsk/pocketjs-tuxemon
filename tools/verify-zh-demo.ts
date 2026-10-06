// The zh_CN demo in the built game (dist/main.{js,pak}, sim host, Chinese
// boot): every chapter jump restores the Chinese save, and Autoplay from a
// chapter folds the transcribed tape to exactly the state the reducer
// reaches (tools/zh-demo-reference.ts), which is also the English chapter's
// state once the words are set aside. This is what proves the headless
// paginator the transcriber used cuts the same pages as the running core.
// It also re-renders the Chinese chapter thumbnails and requires the
// committed ones (tools/render-zh-chapter-thumbnails.ts).
//
//   bun run build && bun run build:wasm
//   bun tools/verify-zh-demo.ts                 all jumps, 600-frame Autoplay
//                                               from three chapters
//   bun tools/verify-zh-demo.ts --autoplay=all  Autoplay from every chapter
//   bun tools/verify-zh-demo.ts --full          plus the whole tape from the
//                                               bedroom (about 200k frames)

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { FIXED_TIME_HOST_GLOBALS } from "../battle/time-weather.ts";
import type { SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { bootWorld, type SimWorld } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { ROOT } from "./bake-chapters.ts";
import { chapterReference, liveStateDigests } from "./zh-demo-reference.ts";
import { renderZhThumbnails, ZH_THUMB_DIR } from "./render-zh-chapter-thumbnails.ts";
import type { ZhChaptersFile } from "./transcribe-zh-tape.ts";
import { ZH_CHAPTERS_REL } from "./zh-tape.ts";

const BUNDLE = join(ROOT, "dist/main");
if (!existsSync(BUNDLE + ".js") || !existsSync(BUNDLE + ".pak")) {
  throw new Error("verify-zh-demo: missing dist/main.{js,pak}; run `bun run build && bun run build:wasm`");
}
const AUTOPLAY_FRAMES = 600;
const DEFAULT_AUTOPLAY = ["paper-town", "captain-returns", "kernel-briefing"];
const args = new Set(process.argv.slice(2));
const chapters = (JSON.parse(await Bun.file(join(ROOT, ZH_CHAPTERS_REL)).text()) as ZhChaptersFile).chapters;
const autoplayIds = args.has("--autoplay=all") ? chapters.map((c) => c.id) : DEFAULT_AUTOPLAY;

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

async function boot(): Promise<SimWorld> {
  const world = await bootWorld(BUNDLE, 60, {
    ...FIXED_TIME_HOST_GLOBALS,
    __pocketTuxemonLang: "zh_CN",
    __rpgkitBoot: undefined,
    localStorage: memoryStorage(),
  }, undefined, { width: 480, height: 272 });
  step(world);
  return world;
}

function step(world: SimWorld): void {
  world.frame(0);
  for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
}

function live(): SessionState {
  const state = globalThis.__rpgSessionState as SessionState | undefined;
  if (!state) throw new Error("verify-zh-demo: GameView did not publish SessionState");
  return state;
}

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const world = await boot();
const hook = globalThis.__rpgkitDemo;
check("the Chinese boot installs the demo hook", hook !== undefined);
if (!hook) process.exit(1);

{
  // The selection the SELECT menu was built from: a Chinese boot must read
  // the Chinese tape and chapter saves, not the English entries.
  const selection = (globalThis as typeof globalThis & {
    __rpgkitDemoSelection?: {
      tapeEntry?: unknown;
      snapshotsEntry?: unknown;
      chapters?: { id: string; title: string }[];
    };
  }).__rpgkitDemoSelection;
  const entriesOk = selection?.tapeEntry === "demo/tape.zh_CN.bin"
    && selection?.snapshotsEntry === "demo/chapters.zh_CN.json";
  check("the Chinese boot selected the Chinese demo resources", entriesOk,
    `tape ${String(selection?.tapeEntry)}, snapshots ${String(selection?.snapshotsEntry)}`);
  const listed = selection?.chapters ?? [];
  const titlesOk = listed.length === chapters.length
    && listed.every((entry, i) => entry.id === chapters[i]!.id && entry.title === chapters[i]!.title)
    && listed.every((entry) => /[一-鿿]/.test(entry.title));
  check("the SELECT menu lists the Chinese chapter titles", titlesOk,
    `${listed.length} chapters, first "${listed[0]?.title ?? "none"}"`);
}

{
  // Actually open the SELECT menu and close it again: the menu must exist
  // in the Chinese build, and opening it must not disturb the live state.
  const menuOpen = (globalThis as typeof globalThis & { __rpgkitDemoMenuOpen?: () => boolean }).__rpgkitDemoMenuOpen;
  const before = live().frame;
  world.frame(0x0001); // BTN.SELECT tap
  world.frame(0);
  step(world);
  check("SELECT opens the demo menu in the Chinese build", menuOpen?.() === true);
  world.frame(0x0001); // toggle closed
  world.frame(0);
  step(world);
  check("SELECT closes the demo menu again", menuOpen?.() === false, `frame ${live().frame} (was ${before})`);
}

for (const chapter of chapters) {
  const reference = chapterReference(chapter.id, 0);
  hook.jump(chapter.id);
  for (let i = 0; i < 64 && live().frame !== reference.frame; i++) {
    step(world);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  const digests = liveStateDigests(live());
  check(`jump ${chapter.id} restores the Chinese save`,
    digests.stateSha256 === reference.zhStateSha256 && digests.neutralSha256 === reference.englishNeutralSha256,
    `${digests.summary.map}@${digests.summary.position} frame ${digests.summary.frame}`);
}

{
  // The selection checked above is computed before any I/O, so it cannot
  // prove the built game loaded the entries it declares. Every chapter
  // jump restores through the demo options' lazy providers (the tape
  // provider and the snapshot getter), so both reads have happened by now;
  // the read log is the I/O evidence. A Chinese boot must have read exactly
  // the Chinese entries, never the English ones.
  const selection = (globalThis as typeof globalThis & {
    __rpgkitDemoSelection?: { tapeEntry?: unknown; snapshotsEntry?: unknown };
  }).__rpgkitDemoSelection;
  const reads = (globalThis as typeof globalThis & {
    __rpgkitDemoReads?: () => string[];
  }).__rpgkitDemoReads?.() ?? [];
  const tapeReads = reads.filter((entry) => entry.startsWith("demo/tape"));
  const snapshotReads = reads.filter((entry) => entry.startsWith("demo/chapters"));
  check("the Chinese boot actually read the Chinese demo tape",
    tapeReads.length === 1 && tapeReads[0] === selection?.tapeEntry,
    `read ${tapeReads.join(", ") || "nothing"}, declared ${String(selection?.tapeEntry)}`);
  check("the Chinese boot actually read the Chinese demo saves",
    snapshotReads.length === 1 && snapshotReads[0] === selection?.snapshotsEntry,
    `read ${snapshotReads.join(", ") || "nothing"}, declared ${String(selection?.snapshotsEntry)}`);
}

async function autoplay(id: string, frames: number): Promise<void> {
  const reference = chapterReference(id, frames);
  const start = chapters.find((c) => c.id === id)!.timelineFrame;
  hook!.autoplay(id, 1);
  // The request applies on a following host frame.
  for (let i = 0; i < 64 && live().frame !== start; i++) {
    step(world);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  const started = performance.now();
  // Pacing holds show text for longer than the tape takes, so the host may
  // need more frames than the tape has.
  for (let i = 0; i < frames * 20 && live().frame < reference.frame; i++) {
    step(world);
    if (i % 4096 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  const digests = liveStateDigests(live());
  check(`autoplay ${id} +${frames}: same state as the Chinese reducer replay`,
    digests.stateSha256 === reference.zhStateSha256,
    `${digests.summary.map}@${digests.summary.position} frame ${digests.summary.frame} (want ${reference.frame}), `
      + `${((performance.now() - started) / 1000).toFixed(1)}s`);
  check(`autoplay ${id} +${frames}: same language-neutral state as English`,
    digests.neutralSha256 === reference.englishNeutralSha256,
    `party ${digests.summary.party.join(" ")}, gold ${digests.summary.gold}`);
}

for (const id of autoplayIds) await autoplay(id, AUTOPLAY_FRAMES);
if (args.has("--full")) {
  const bedroom = chapters[0]!;
  await autoplay(bedroom.id, bedroom.suffixFrames);
}

{
  const { own, shared } = await renderZhThumbnails();
  const committed = existsSync(ZH_THUMB_DIR) ? readdirSync(ZH_THUMB_DIR).filter((f) => f.endsWith(".png")).sort() : [];
  const same = committed.join(",") === [...own.keys()].sort().join(",")
    && [...own].every(([name, png]) => Buffer.compare(Buffer.from(png), readFileSync(join(ZH_THUMB_DIR, name))) === 0);
  check("Chinese chapter thumbnails match the committed ones", same,
    `${own.size} own (${[...own.keys()].join(", ")}), ${shared.length} same as English`);
}

console.log(failures === 0 ? "ZH DEMO PASS" : `ZH DEMO FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);

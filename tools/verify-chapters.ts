// Re-bake the chapter snapshots and thumbnails in memory and compare them
// byte-for-byte with the committed data/chapters.json and
// docs/screenshots/chapters/*.png. A component-kit, tape or importer change
// that moves a checkpoint fails here with the rebake command.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  bakeChapters,
  chapterWorldTraversal,
  chaptersJson,
  CHAPTERS_PATH,
  ROOT,
  THUMB_DIR,
  THUMB_W,
  THUMB_H,
  verifyChapterSuffixes,
} from "./bake-chapters.ts";

const REBAKE = "bun tools/bake-chapters.ts";

function fail(message: string): never {
  console.error(`CHAPTERS STALE: ${message}`);
  console.error(`Rebake with: ${REBAKE}`);
  process.exit(1);
}

if (!existsSync(CHAPTERS_PATH)) fail(`data/chapters.json is missing`);
const committedJson = readFileSync(CHAPTERS_PATH, "utf8");
try {
  const committed = JSON.parse(committedJson) as Parameters<typeof chapterWorldTraversal>[0];
  const worldTraversal = chapterWorldTraversal(committed, "committed chapters file");
  if (worldTraversal !== "seamless-v1") {
    fail(`committed chapters use ${worldTraversal}; new chapter artifacts must use seamless-v1`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const baked = await bakeChapters(ROOT);
const bakedJson = chaptersJson(baked.chapters);

if (committedJson !== bakedJson) {
  // Locate the first differing chapter for a shorter error message.
  const committed = JSON.parse(committedJson) as { chapters?: { id: string }[] };
  const bakedIds = baked.chapters.chapters.map((chapter) => chapter.id).join(", ");
  const committedIds = (committed.chapters ?? []).map((chapter) => chapter.id).join(", ");
  fail(committedIds === bakedIds
    ? `a chapter snapshot or thumbnail hash in data/chapters.json changed`
    : `chapter list changed (committed: ${committedIds || "-"}; baked: ${bakedIds})`);
}

const bakedFiles = new Set<string>();
for (const chapter of baked.chapters.chapters) {
  const png = baked.thumbnails.get(chapter.id);
  if (!png) fail(`bake produced no thumbnail for ${chapter.id}`);
  const path = resolve(ROOT, chapter.thumbnail);
  if (!existsSync(path)) fail(`${chapter.thumbnail} is missing`);
  const committed = readFileSync(path);
  const committedSha = createHash("sha256").update(committed).digest("hex");
  const bakedSha = createHash("sha256").update(png).digest("hex");
  if (committedSha !== bakedSha) {
    fail(`${chapter.thumbnail} bytes changed (committed ${committedSha.slice(0, 12)}, baked ${bakedSha.slice(0, 12)})`);
  }
  if (committedSha !== chapter.thumbnailSha256) {
    fail(`${chapter.thumbnail}: committed PNG does not match thumbnailSha256 in data/chapters.json`);
  }
  bakedFiles.add(join(THUMB_DIR, `${chapter.id}-${THUMB_W}x${THUMB_H}.png`));
}

const onDisk = new Set(readdirSync(THUMB_DIR).map((name) => join(THUMB_DIR, name)));
for (const extra of onDisk) {
  if (!bakedFiles.has(extra)) fail(`unexpected file ${extra.replace(ROOT + "/", "")} in ${THUMB_DIR.replace(ROOT + "/", "")}`);
}
for (const missing of bakedFiles) {
  if (!onDisk.has(missing)) fail(`${missing.replace(ROOT + "/", "")} is missing`);
}

// Every committed envelope must resume through the documented chapter
// contract (restore snapshot, set state.frame = timelineFrame, replay the
// suffix) and reach the same terminal state as one full tape replay.
const suffixes = verifyChapterSuffixes(ROOT);
const terminal = suffixes[0]?.terminalSha256 ?? "";
for (const result of suffixes) {
  if (!result.matches) {
    fail(`chapter ${result.id}: snapshot + suffix reached ${result.terminalSha256.slice(0, 12)}, `
      + `not the full-replay terminal ${terminal.slice(0, 12)}`);
  }
  if (!result.audioMatches) {
    fail(`chapter ${result.id}: snapshot + suffix changed battle/map audio transitions`);
  }
}

console.log(`CHAPTERS PASS ${baked.chapters.chapters.length} chapters, `
  + `${baked.chapters.tape.frames} combined tape frames, snapshots and thumbnails byte-identical; `
  + `${suffixes.length} chapter suffix replays preserve battle/map audio transitions and reach terminal ${terminal.slice(0, 12)}`);

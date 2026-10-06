// Records (or, with --check, re-derives and compares) the zh_CN demo data:
//
//   data/zh-mainline-journey.json  the English mainline tape transcribed for
//                                  the Chinese build (tools/zh-tape.ts):
//                                  source hashes, the confirm edits, the
//                                  dialog statistics and the terminal state
//   data/chapters.zh_CN.json       the chapter snapshots taken from the
//                                  Chinese session on the same frames as
//                                  data/chapters.json, with Chinese titles
//
//   TUXEMON_SRC=... bun run import          (dist/ must be current)
//   bun tools/transcribe-zh-tape.ts         write both files
//   bun tools/transcribe-zh-tape.ts --check fail unless both files are
//                                           byte-identical to a fresh run
//
// Both runs fold the whole mainline (about 200k frames) in an English and a
// Chinese session. The check fails fast, before folding, when the English
// tapes or chapters no longer match the hashes the Chinese files were made
// from.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { TUXEMON_SESSION_OPTIONS_ZH } from "../battle/game-zh.ts";
import { createTuxemonSessionOptions } from "../battle/game.ts";
import {
  canonicalJson,
  createSessionSnapshot,
  decodeEnvelopeText,
  encodeEnvelope,
  type SaveSnapshot,
} from "../vendor/pocket-rpgkit/src/engine/save.ts";
import { restoreSessionSnapshot } from "../vendor/pocket-rpgkit/src/engine/save-restore.ts";
import { createSession, startSession } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { CHAPTERS_PATH, chapterWorldTraversal, loadTape, ROOT, type ChaptersFile } from "./bake-chapters.ts";
import { readInlineProject, readShardedProject } from "./generated-project.ts";
import {
  applyTapeEdits,
  neutralDigest,
  neutralSummary,
  productionPaginator,
  productionPaginatorIdentity,
  sha256,
  transcribeTape,
  withoutWords,
  ZH_CHAPTER_TITLES_REL,
  ZH_CHAPTERS_FORMAT,
  ZH_CHAPTERS_REL,
  ZH_TAPE_FORMAT,
  ZH_TAPE_REL,
  type NeutralSummary,
  type PaginatorIdentity,
  type TapeEdit,
  type TranscribeStats,
} from "./zh-tape.ts";

export interface ZhTapeSource {
  /** sha256 of data/chapters.json, which names the English tape segments. */
  chaptersSha256: string;
  /** The English segments, as data/chapters.json records them. */
  tape: ChaptersFile["tape"];
}

export interface ZhTapeFile {
  format: typeof ZH_TAPE_FORMAT;
  lang: "zh_CN";
  hz: 60;
  worldTraversal: ChaptersFile["worldTraversal"];
  source: ZhTapeSource;
  paginator: PaginatorIdentity;
  frames: number;
  /** sha256(JSON.stringify(masks)) of the transcribed tape. */
  tapeSha256: string;
  /** The tape is the English tape with these masks replaced (frame count
   *  unchanged, so chapters start on the same frame in both languages). */
  edits: TapeEdit[];
  dialogs: TranscribeStats;
  terminal: { summary: NeutralSummary; neutralSha256: string };
}

export interface ZhChapterRecord {
  id: string;
  title: string;
  map: string;
  position: [number, number];
  frame: number;
  timelineFrame: number;
  held: number;
  suffixFrames: number;
  /** rpgkit-save/v1 envelope of the Chinese session at this frame. */
  snapshot: string;
  /** Language-neutral digest shared with the English chapter state. */
  neutralSha256: string;
}

export interface ZhChaptersFile {
  format: typeof ZH_CHAPTERS_FORMAT;
  lang: "zh_CN";
  worldTraversal: ChaptersFile["worldTraversal"];
  hz: 60;
  source: { chaptersSha256: string; tapeSha256: string };
  chapters: ZhChapterRecord[];
}

function expect(message: string, condition: boolean): asserts condition {
  if (!condition) throw new Error(`transcribe-zh-tape: ${message}`);
}

/** The English inputs the Chinese files are derived from, cheap to hash. */
export function currentZhTapeSource(root: string = ROOT): ZhTapeSource {
  const text = readFileSync(join(root, "data/chapters.json"), "utf8");
  const chapters = JSON.parse(text) as ChaptersFile;
  return { chaptersSha256: sha256(text), tape: chapters.tape };
}

/** Why the committed Chinese files no longer belong to the English tape,
 *  or null when their source hashes still match. Reads hashes only. */
export function zhTapeStaleness(root: string = ROOT): string | null {
  const zhPath = join(root, ZH_TAPE_REL);
  const chaptersPath = join(root, ZH_CHAPTERS_REL);
  if (!existsSync(zhPath) || !existsSync(chaptersPath)) return `${ZH_TAPE_REL} or ${ZH_CHAPTERS_REL} is missing`;
  const zh = JSON.parse(readFileSync(zhPath, "utf8")) as ZhTapeFile;
  const zhChapters = JSON.parse(readFileSync(chaptersPath, "utf8")) as ZhChaptersFile;
  const current = currentZhTapeSource(root);
  const segments = ["gb6", "j1", "j2", "j3", "j4"] as const;
  for (const segment of segments) {
    const want = current.tape[segment];
    const got = zh.source.tape[segment];
    // Hash the journey's masks themselves, so an edited frame shows up even
    // before data/chapters.json is baked again.
    const journey = JSON.parse(readFileSync(join(root, want.file), "utf8")) as { masks: number[] };
    const actual = sha256(JSON.stringify(journey.masks));
    if (!got || got.tapeSha256 !== actual || got.frames !== journey.masks.length || got.tapeSha256 !== want.tapeSha256) {
      return `English ${segment} tape ${want.file} changed since the Chinese tape was transcribed`;
    }
  }
  if (zh.source.tape.sha256 !== current.tape.sha256) return "the combined English tape changed";
  if (zh.source.chaptersSha256 !== current.chaptersSha256) return "data/chapters.json changed";
  if (zhChapters.source.chaptersSha256 !== current.chaptersSha256) return `${ZH_CHAPTERS_REL} was made from another data/chapters.json`;
  if (zhChapters.source.tapeSha256 !== zh.tapeSha256) return `${ZH_CHAPTERS_REL} was made from another Chinese tape`;
  const paginator = productionPaginatorIdentity(root);
  if (canonicalJson(paginator as never) !== canonicalJson(zh.paginator as never)) {
    return "the dialog font or charset changed since the Chinese tape was transcribed";
  }
  return null;
}

/** The transcribed Chinese masks: the English tape with the edits applied. */
export function zhMainlineMasks(root: string = ROOT): number[] {
  const zh = JSON.parse(readFileSync(join(root, ZH_TAPE_REL), "utf8")) as ZhTapeFile;
  const { combined } = loadTape();
  const masks = applyTapeEdits(combined, zh.edits);
  expect("transcribed tape hash mismatch", sha256(JSON.stringify(masks)) === zh.tapeSha256);
  return masks;
}

/** A snapshot without its words (compiled programs, the save's language
 *  marker), for comparing an English and a Chinese chapter save. */
function neutralSnapshot(snapshot: SaveSnapshot): string {
  const copy = withoutWords(snapshot) as { ext?: { lang?: unknown } | null };
  if (copy.ext && typeof copy.ext === "object") delete copy.ext.lang;
  return canonicalJson(copy as never);
}

export function transcribeZhDemo(root: string = ROOT): { tape: string; chapters: string; log: string[] } {
  const chaptersText = readFileSync(CHAPTERS_PATH, "utf8");
  const english = JSON.parse(chaptersText) as ChaptersFile;
  const worldTraversal = chapterWorldTraversal(english);
  const { combined } = loadTape();
  expect("data/chapters.json does not describe the current English tape",
    english.tape.sha256 === sha256(JSON.stringify(combined)) && english.tape.frames === combined.length);
  const titles = JSON.parse(readFileSync(join(root, ZH_CHAPTER_TITLES_REL), "utf8")) as Record<string, string>;
  for (const chapter of english.chapters) {
    expect(`${ZH_CHAPTER_TITLES_REL} has no title for chapter ${chapter.id}`, typeof titles[chapter.id] === "string");
  }

  const enProject = readInlineProject(root);
  const enSession = createSession(enProject, 60, createTuxemonSessionOptions(enProject, worldTraversal));
  const zh = readShardedProject(root, "zh_CN");
  const zhSession = createSession(zh.project, 60, createTuxemonSessionOptions(zh.project, worldTraversal, {
    ...TUXEMON_SESSION_OPTIONS_ZH,
    maps: zh.repository,
    paginateText: productionPaginator(root),
  }));
  const result = transcribeTape({
    source: combined,
    sourceSession: enSession,
    sourceStart: startSession(enProject, enSession),
    targetSession: zhSession,
    targetStart: startSession(zh.project, zhSession),
    captureAt: english.chapters.map((chapter) => chapter.frame),
  });
  const tapeSha256 = sha256(JSON.stringify(result.masks));
  const log: string[] = [];

  const chapters: ZhChapterRecord[] = [];
  for (const chapter of english.chapters) {
    const capture = result.captures.get(chapter.frame);
    expect(`chapter ${chapter.id}: frame ${chapter.frame} was not captured`, capture !== undefined);
    const state = capture!.target;
    expect(`chapter ${chapter.id}: Chinese state is not on ${chapter.map}@${chapter.position}`,
      state.mapId === chapter.map && state.move.tx === chapter.position[0] && state.move.ty === chapter.position[1]
      && state.frame === chapter.timelineFrame);
    const held = chapter.frame === 0 ? 0 : result.masks[chapter.frame - 1]!;
    const snapshot = createSessionSnapshot(zhSession, state, held);
    const envelope = encodeEnvelope(snapshot);
    const decoded = decodeEnvelopeText(envelope);
    const restored = restoreSessionSnapshot(zhSession, decoded);
    const again = createSessionSnapshot(zhSession, restored, decoded.held);
    expect(`chapter ${chapter.id}: save/restore round-trip changed the Chinese snapshot`,
      canonicalJson(again) === canonicalJson(snapshot));
    // The Chinese save must be the English chapter save in other words:
    // the same everything once programs and the language marker are set
    // aside.
    expect(`chapter ${chapter.id}: Chinese and English chapter saves differ beyond their words`,
      neutralSnapshot(snapshot) === neutralSnapshot(decodeEnvelopeText(chapter.snapshot)));
    chapters.push({
      id: chapter.id,
      title: titles[chapter.id]!,
      map: chapter.map,
      position: chapter.position,
      frame: chapter.frame,
      timelineFrame: chapter.timelineFrame,
      held: held >>> 0,
      suffixFrames: chapter.suffixFrames,
      snapshot: envelope,
      neutralSha256: neutralDigest(state),
    });
    log.push(`${chapter.id} f${chapter.frame} ${chapter.map}@${chapter.position.join(",")} ${titles[chapter.id]}`);
  }

  const tapeFile: ZhTapeFile = {
    format: ZH_TAPE_FORMAT,
    lang: "zh_CN",
    hz: 60,
    worldTraversal,
    source: { chaptersSha256: sha256(chaptersText), tape: english.tape },
    paginator: productionPaginatorIdentity(root),
    frames: result.masks.length,
    tapeSha256,
    edits: result.edits,
    dialogs: result.stats,
    terminal: {
      summary: neutralSummary(result.terminal.target),
      neutralSha256: neutralDigest(result.terminal.target),
    },
  };
  const chaptersFile: ZhChaptersFile = {
    format: ZH_CHAPTERS_FORMAT,
    lang: "zh_CN",
    worldTraversal,
    hz: 60,
    source: { chaptersSha256: sha256(chaptersText), tapeSha256 },
    chapters,
  };
  log.unshift(`frames=${result.masks.length} edits=${result.edits.length} `
    + `dialogs=${JSON.stringify(result.stats)} terminal=${tapeFile.terminal.neutralSha256.slice(0, 12)}`);
  return {
    tape: JSON.stringify(tapeFile, null, 2) + "\n",
    chapters: JSON.stringify(chaptersFile, null, 2) + "\n",
    log,
  };
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  if (check) {
    const stale = zhTapeStaleness(ROOT);
    if (stale) {
      console.error(`ZH TAPE STALE: ${stale}. Re-run \`bun run record:zh:tape\`.`);
      process.exit(1);
    }
  }
  const started = performance.now();
  const out = transcribeZhDemo(ROOT);
  for (const line of out.log) console.log(`  ${line}`);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  if (check) {
    const tapeOk = readFileSync(join(ROOT, ZH_TAPE_REL), "utf8") === out.tape;
    const chaptersOk = readFileSync(join(ROOT, ZH_CHAPTERS_REL), "utf8") === out.chapters;
    if (!tapeOk || !chaptersOk) {
      console.error(`ZH TAPE DIFFERS: ${!tapeOk ? ZH_TAPE_REL : ""} ${!chaptersOk ? ZH_CHAPTERS_REL : ""}`.trim()
        + ". Re-run `bun run record:zh:tape`.");
      process.exit(1);
    }
    console.log(`ZH TAPE OK (${seconds}s)`);
  } else {
    writeFileSync(join(ROOT, ZH_TAPE_REL), out.tape);
    writeFileSync(join(ROOT, ZH_CHAPTERS_REL), out.chapters);
    console.log(`ZH TAPE RECORDED (${seconds}s)`);
  }
}

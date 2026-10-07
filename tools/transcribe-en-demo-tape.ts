// Records (or, with --check, re-derives and compares) the English demo data:
//
//   data/en-demo-journey.json  the English mainline tape transcribed for the
//                              built game's dialog paginator (tools/en-demo-tape.ts):
//                              source hashes, the inserted frames, the dialog
//                              statistics and the terminal story summary
//
// The demo tape is the canonical English tape with a few frames inserted at
// the two Nimrod-room corner windows that take two pages under the production
// paginator. The canonical tape, data/chapters.json and its saves are never
// modified: the importer interleaves the recorded insertions at pack time
// (importer/demo-data.ts), and the demo controller windows the result.
//
//   TUXEMON_SRC=... bun run import          (dist/ must be current)
//   bun tools/transcribe-en-demo-tape.ts         write data/en-demo-journey.json
//   bun tools/transcribe-en-demo-tape.ts --check fail unless the file is
//                                                byte-identical to a fresh run
//
// Both runs fold the whole mainline (about 200k frames) in a canonical English
// session and a paged English session. The check fails fast, before folding,
// when the English tapes, chapters or the dialog font no longer match the
// hashes the demo tape was made from.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createTuxemonSessionOptions } from "../battle/game.ts";
import {
  canonicalJson,
  decodeEnvelopeText,
} from "../vendor/pocket-rpgkit/src/engine/save.ts";
import { restoreSessionSnapshot } from "../vendor/pocket-rpgkit/src/engine/save-restore.ts";
import { createSession, startSession, stepSession, type SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { TextPaginator } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";
import { CHAPTERS_PATH, chapterWorldTraversal, loadTape, ROOT, type ChaptersFile } from "./bake-chapters.ts";
import { readInlineProject } from "./generated-project.ts";
import {
  applyInsertions,
  demoFrameFor,
  demoNeutralSummary,
  enDemoTapeSha256,
  neutralStateDemo,
  sha256,
  transcribeEnDemo,
  EN_DEMO_TAPE_FORMAT,
  EN_DEMO_TAPE_REL,
  type EnDemoInsertion,
  type EnDemoStats,
} from "./en-demo-tape.ts";
import { productionPaginator, productionPaginatorIdentity, tapeInput, type PaginatorIdentity } from "./zh-tape.ts";

export interface EnDemoTapeFile {
  format: typeof EN_DEMO_TAPE_FORMAT;
  lang: "en_US";
  hz: 60;
  worldTraversal: ChaptersFile["worldTraversal"];
  source: {
    /** sha256 of data/chapters.json, which names the English tape segments. */
    chaptersSha256: string;
    /** The English segments, as data/chapters.json records them. */
    tape: ChaptersFile["tape"];
  };
  paginator: PaginatorIdentity;
  frames: number;
  /** sha256(JSON.stringify(masks)) of the demo tape (canonical + insertions). */
  tapeSha256: string;
  /** Frames inserted into the canonical tape, in canonical-frame order. */
  insertions: EnDemoInsertion[];
  dialogs: EnDemoStats;
  terminal: { summary: ReturnType<typeof demoNeutralSummary>; neutralSha256: string };
}

function expect(message: string, condition: boolean): asserts condition {
  if (!condition) throw new Error(`transcribe-en-demo-tape: ${message}`);
}

/** The English inputs the demo tape is derived from, cheap to hash. */
export function currentEnDemoSource(root: string = ROOT): {
  chaptersSha256: string;
  tape: ChaptersFile["tape"];
} {
  const text = readFileSync(join(root, "data/chapters.json"), "utf8");
  const chapters = JSON.parse(text) as ChaptersFile;
  return { chaptersSha256: sha256(text), tape: chapters.tape };
}

/** Why the committed demo tape no longer belongs to the English tape, or null
 *  when its source hashes still match. Reads hashes only. */
export function enDemoTapeStaleness(root: string = ROOT): string | null {
  const path = join(root, EN_DEMO_TAPE_REL);
  if (!existsSync(path)) return `${EN_DEMO_TAPE_REL} is missing`;
  const file = JSON.parse(readFileSync(path, "utf8")) as EnDemoTapeFile;
  const current = currentEnDemoSource(root);
  const segments = ["gb6", "j1", "j2", "j3", "j4"] as const;
  for (const segment of segments) {
    const want = current.tape[segment];
    const got = file.source.tape[segment];
    const journey = JSON.parse(readFileSync(join(root, want.file), "utf8")) as { masks: number[] };
    const actual = sha256(JSON.stringify(journey.masks));
    if (!got || got.tapeSha256 !== actual || got.frames !== journey.masks.length || got.tapeSha256 !== want.tapeSha256) {
      return `English ${segment} tape ${want.file} changed since the demo tape was transcribed`;
    }
  }
  if (file.source.tape.sha256 !== current.tape.sha256) return "the combined English tape changed";
  if (file.source.chaptersSha256 !== current.chaptersSha256) return "data/chapters.json changed";
  const paginator = productionPaginatorIdentity(root);
  if (canonicalJson(paginator as never) !== canonicalJson(file.paginator as never)) {
    return "the dialog font or charset changed since the demo tape was transcribed";
  }
  return null;
}

/** The demo masks: the canonical tape with the recorded insertions applied. */
export function enDemoMasks(insertions: readonly EnDemoInsertion[], root: string = ROOT): number[] {
  const { combined } = loadTape();
  return applyInsertions(combined, insertions);
}

export function transcribeEnDemoTape(root: string = ROOT): { file: string; log: string[] } {
  const chaptersText = readFileSync(CHAPTERS_PATH, "utf8");
  const english = JSON.parse(chaptersText) as ChaptersFile;
  const worldTraversal = chapterWorldTraversal(english);
  const { combined } = loadTape();
  expect("data/chapters.json does not describe the current English tape",
    english.tape.sha256 === sha256(JSON.stringify(combined)) && english.tape.frames === combined.length);

  const enProject = readInlineProject(root);
  const enSession = createSession(enProject, 60, createTuxemonSessionOptions(enProject, worldTraversal, {
    paginateText: productionPaginator(root),
  }));
  const pagedSession = createSession(enProject, 60, createTuxemonSessionOptions(enProject, worldTraversal, {
    paginateText: productionPaginator(root),
  }));
  const result = transcribeEnDemo({
    source: combined,
    sourceSession: enSession,
    sourceStart: startSession(enProject, enSession),
    targetSession: pagedSession,
    targetStart: startSession(enProject, pagedSession),
    captureAt: english.chapters.map((chapter) => chapter.frame),
  });
  const tapeSha256 = enDemoTapeSha256(result.masks);
  const log: string[] = [];

  // The chapter-to-chapter autoplay check: restore each canonical chapter
  // save, replay the demo tape to the next chapter through the production
  // paginator (the same session shape GameView gives the demo controller),
  // and require the same story state as the canonical chapter (the timeline
  // aside). This is the demo controller's exact path and covers every
  // chapter pair, not just the two Nimrod insertions.
  const chapterCheck = verifyEnDemoChapters(english, result.insertions, result.masks, enProject, worldTraversal, productionPaginator(root));
  for (const line of chapterCheck.log) log.push(`  ${line}`);

  const file: EnDemoTapeFile = {
    format: EN_DEMO_TAPE_FORMAT,
    lang: "en_US",
    hz: 60,
    worldTraversal,
    source: { chaptersSha256: sha256(chaptersText), tape: english.tape },
    paginator: productionPaginatorIdentity(root),
    frames: result.masks.length,
    tapeSha256,
    insertions: result.insertions,
    dialogs: result.stats,
    terminal: {
      summary: demoNeutralSummary(result.terminal.target),
      neutralSha256: sha256(canonicalJson(neutralStateDemo(result.terminal.target) as never)),
    },
  };
  log.unshift(`frames=${result.masks.length} insertions=${result.insertions.length} `
    + `dialogs=${JSON.stringify(result.stats)} terminal=${file.terminal.neutralSha256.slice(0, 12)}`);
  return { file: JSON.stringify(file, null, 2) + "\n", log };
}

/** Restore each chapter's canonical save and replay the demo tape to the next
 *  chapter node through the production paginator, requiring the same
 *  language-neutral story state. This is the path the built game's chapter
 *  Autoplay actually takes (GameView creates the demo session with the same
 *  paginator), so a text box that pages differently under the production
 *  font or charset fails here, not just in the browser. Returns the
 *  per-segment results for the report. */
export function verifyEnDemoChapters(
  english: ChaptersFile,
  insertions: readonly EnDemoInsertion[],
  demoMasks: readonly number[],
  project: ReturnType<typeof readInlineProject>,
  worldTraversal: ChaptersFile["worldTraversal"],
  paginator: TextPaginator,
): { log: string[] } {
  const session = createSession(project, 60, createTuxemonSessionOptions(project, worldTraversal, { paginateText: paginator }));
  const byFrame = new Map(english.chapters.map((chapter) => [chapter.frame, chapter]));
  const log: string[] = [];
  for (let i = 0; i < english.chapters.length - 1; i++) {
    const from = english.chapters[i]!;
    const to = english.chapters[i + 1]!;
    const demoFrom = demoFrameFor(from.frame, insertions);
    const demoTo = demoFrameFor(to.frame, insertions);
    let state: SessionState = restoreSessionSnapshot(session, decodeEnvelopeText(from.snapshot));
    state = { ...state, frame: from.timelineFrame };
    let prev = from.held >>> 0;
    for (let f = demoFrom; f < demoTo; f++) {
      const mask = demoMasks[f]!;
      state = stepSession(session, state, tapeInput(mask, prev));
      prev = mask;
    }
    const want = restoreSessionSnapshot(session, decodeEnvelopeText(byFrame.get(to.frame)!.snapshot));
    const got = demoNeutralSummary(state);
    const wantSummary = demoNeutralSummary(want);
    const ok = canonicalJson(got as never) === canonicalJson(wantSummary as never);
    if (!ok) {
      throw new Error(`en-demo chapter autoplay ${from.id} -> ${to.id}: story state differs `
        + `(got ${got.map}@${got.position}, want ${wantSummary.map}@${wantSummary.position})`);
    }
    log.push(`${from.id} -> ${to.id} ok (demo f${demoFrom}..${demoTo})`);
  }
  return { log };
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  if (check) {
    const stale = enDemoTapeStaleness(ROOT);
    if (stale) {
      console.error(`EN DEMO TAPE STALE: ${stale}. Re-run \`bun run record:en:demo\`.`);
      process.exit(1);
    }
  }
  const started = performance.now();
  const out = transcribeEnDemoTape(ROOT);
  for (const line of out.log) console.log(`  ${line}`);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  if (check) {
    const ok = readFileSync(join(ROOT, EN_DEMO_TAPE_REL), "utf8") === out.file;
    if (!ok) {
      console.error(`EN DEMO TAPE DIFFERS: ${EN_DEMO_TAPE_REL}. Re-run \`bun run record:en:demo\`.`);
      process.exit(1);
    }
    console.log(`EN DEMO TAPE OK (${seconds}s)`);
  } else {
    writeFileSync(join(ROOT, EN_DEMO_TAPE_REL), out.file);
    console.log(`EN DEMO TAPE RECORDED (${seconds}s)`);
  }
}

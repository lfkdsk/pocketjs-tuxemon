// The English demo tape: the transcriber's frame insertion at the two Nimrod
// paged windows, the chapter frame remap, and the committed demo tape staying
// tied to the English canonical tape it was made from.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createTuxemonSessionOptions } from "../battle/game.ts";
import { decodeEnvelopeText, canonicalJson } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import { restoreSessionSnapshot } from "../vendor/pocket-rpgkit/src/engine/save-restore.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { buildDemoData, buildEnDemoData, type DemoDataBuild } from "../importer/demo-data.ts";
import { buildWarpIndex } from "../importer/warp.ts";
import { CHAPTERS_PATH, chapterWorldTraversal, loadTape, ROOT, type ChaptersFile } from "../tools/bake-chapters.ts";
import { readInlineProject } from "../tools/generated-project.ts";
import {
  applyInsertions,
  demoFrameFor,
  demoNeutralSummary,
  neutralStateDemo,
  sha256,
  transcribeEnDemo,
  type EnDemoInsertion,
} from "../tools/en-demo-tape.ts";
import { enDemoTapeStaleness, type EnDemoTapeFile } from "../tools/transcribe-en-demo-tape.ts";
import { productionPaginator, tapeInput } from "../tools/zh-tape.ts";

const CONFIRM = 0x2000;

const chaptersFile = JSON.parse(readFileSync(CHAPTERS_PATH, "utf8")) as ChaptersFile;
const worldTraversal = chapterWorldTraversal(chaptersFile);
const { combined } = loadTape();
const project = readInlineProject(ROOT);
const plain: Session = createSession(project, 60, createTuxemonSessionOptions(project, worldTraversal));
const paged: Session = createSession(project, 60, createTuxemonSessionOptions(project, worldTraversal, {
  paginateText: productionPaginator(ROOT),
}));

const chapter = (id: string) => chaptersFile.chapters.find((c) => c.id === id)!;

/** Restore a chapter save into a session and fold a mask range. */
function foldSegment(
  session: Session,
  fromId: string,
  toId: string,
  masks: readonly number[],
  insertions: readonly EnDemoInsertion[],
): SessionState {
  const from = chapter(fromId);
  const to = chapter(toId);
  let state = restoreSessionSnapshot(session, decodeEnvelopeText(from.snapshot));
  state = { ...state, frame: from.timelineFrame };
  let prev = from.held >>> 0;
  for (let f = demoFrameFor(from.frame, insertions); f < demoFrameFor(to.frame, insertions); f++) {
    const mask = masks[f]!;
    state = stepSession(session, state, tapeInput(mask, prev));
    prev = mask;
  }
  return state;
}

describe("en demo tape transcription", () => {
  test("inserts frames at the Nimrod paged box and the demo tape reaches the next chapter", () => {
    // The segment from route-3-north to flower-city crosses the first Nimrod
    // corner window (canonical frame 110,418), which takes two pages under
    // the production paginator.
    const from = chapter("route-3-north");
    const to = chapter("flower-city");
    const segment = combined.slice(from.frame, to.frame);
    const sourceStart = restoreSessionSnapshot(plain, decodeEnvelopeText(from.snapshot));
    const targetStart = restoreSessionSnapshot(paged, decodeEnvelopeText(from.snapshot));

    const result = transcribeEnDemo({
      source: segment,
      sourceSession: plain,
      sourceStart,
      targetSession: paged,
      targetStart,
    });

    // Exactly one box in this segment pages, needing four inserted frames.
    expect(result.insertions).toHaveLength(1);
    expect(result.insertions[0]!.afterFrame).toBe(110418 - from.frame);
    expect(result.insertions[0]!.masks).toEqual([0, CONFIRM, 0, CONFIRM]);
    expect(result.stats.insertedFrames).toBe(4);
    expect(result.stats.pagedBoxes).toBe(1);

    // The demo tape (canonical + insertions) replayed from the chapter save
    // reaches the next chapter's story state.
    const demoMasks = applyInsertions(segment, result.insertions);
    let reached = restoreSessionSnapshot(paged, decodeEnvelopeText(from.snapshot));
    reached = { ...reached, frame: from.timelineFrame };
    let prev = from.held >>> 0;
    for (const mask of demoMasks) {
      reached = stepSession(paged, reached, tapeInput(mask, prev));
      prev = mask;
    }
    const want = restoreSessionSnapshot(paged, decodeEnvelopeText(to.snapshot));
    expect(canonicalJson(demoNeutralSummary(reached) as never))
      .toBe(canonicalJson(demoNeutralSummary(want) as never));

    // The canonical tape alone drifts: replaying it through the paginator
    // does not reach the next chapter's story state.
    let drifted = restoreSessionSnapshot(paged, decodeEnvelopeText(from.snapshot));
    drifted = { ...drifted, frame: from.timelineFrame };
    prev = from.held >>> 0;
    for (const mask of segment) {
      drifted = stepSession(paged, drifted, tapeInput(mask, prev));
      prev = mask;
    }
    expect(canonicalJson(demoNeutralSummary(drifted) as never))
      .not.toBe(canonicalJson(demoNeutralSummary(want) as never));
  });

  test("the demo tape reaches the next chapter through the paginator at the two Nimrod segments", () => {
    // The committed transcription, replayed through the paginator from each
    // segment's chapter save to the next, must reach the canonical chapter
    // state. Scoped to the two Nimrod-bearing segments so the test stays
    // fast; verify:en:demo runs the same check for all 19 chapter pairs
    // through the production paginator.
    const enDemo = JSON.parse(readFileSync(join(ROOT, "data/en-demo-journey.json"), "utf8")) as EnDemoTapeFile;
    expect(enDemoTapeStaleness(ROOT)).toBeNull();
    const demoMasks = applyInsertions(combined, enDemo.insertions);
    for (const [fromId, toId] of [["route-3-north", "flower-city"], ["captain-returns", "candy-town"]] as const) {
      const reached = foldSegment(paged, fromId, toId, demoMasks, enDemo.insertions);
      const want = restoreSessionSnapshot(paged, decodeEnvelopeText(chapter(toId).snapshot));
      expect(canonicalJson(demoNeutralSummary(reached) as never))
        .toBe(canonicalJson(demoNeutralSummary(want) as never));
    }
  });
});

describe("en demo frame remap", () => {
  const insertions: EnDemoInsertion[] = [
    { afterFrame: 110418, masks: [0, 1, 2, 3], fiber: "a", map: "m" },
    { afterFrame: 147755, masks: [0, 1, 2, 3], fiber: "b", map: "m" },
  ];
  test("frames before the first insertion are unchanged", () => {
    expect(demoFrameFor(0, insertions)).toBe(0);
    expect(demoFrameFor(110244, insertions)).toBe(110244);
    expect(demoFrameFor(110418, insertions)).toBe(110418);
  });
  test("frames after an insertion shift by its size", () => {
    expect(demoFrameFor(110419, insertions)).toBe(110423);
    expect(demoFrameFor(147755, insertions)).toBe(147759);
    expect(demoFrameFor(164415, insertions)).toBe(164423);
  });
});

describe("en demo importer gate", () => {
  test("applies the insertions and remaps the chapter index", () => {
    const canonical = buildDemoData(ROOT, buildWarpIndex(project));
    const { data, reason } = buildEnDemoData(ROOT, canonical);
    expect(reason).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.masks.length).toBe(combined.length + 8);
    expect(sha256(JSON.stringify(data!.masks))).toBe(
      (JSON.parse(readFileSync(join(ROOT, "data/en-demo-journey.json"), "utf8")) as EnDemoTapeFile).tapeSha256,
    );
    const byId = new Map(data!.index.map((e) => [e.id, e]));
    // route-3-north is before the first insertion: unchanged.
    expect(byId.get("route-3-north")!.frame).toBe(110244);
    // flower-city is after the first insertion: +4.
    expect(byId.get("flower-city")!.frame).toBe(115006);
    // candy-town is after both: +8.
    expect(byId.get("candy-town")!.frame).toBe(164423);
  });

  test("a changed English tape disables the demo tape", () => {
    const canonical = buildDemoData(ROOT, buildWarpIndex(project));
    const { data, reason } = buildEnDemoData(ROOT, {
      ...canonical,
      masks: [...canonical.masks, 0],
    } as DemoDataBuild);
    expect(data).toBeNull();
    expect(reason).toContain("changed since the demo tape was transcribed");
  });
});

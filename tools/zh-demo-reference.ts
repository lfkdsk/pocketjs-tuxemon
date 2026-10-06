// Reducer-side references for the zh_CN demo checks (tools/verify-zh-demo.ts
// through the sim host, tools/verify-web-demo.ts through Chrome): where a
// Chinese chapter jump or Autoplay window must land, computed headlessly
// from the committed saves and tapes in both languages.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TUXEMON_SESSION_OPTIONS_ZH } from "../battle/game-zh.ts";
import { createTuxemonSessionOptions } from "../battle/game.ts";
import { canonicalJson, decodeEnvelopeText } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import { restoreSessionSnapshot } from "../vendor/pocket-rpgkit/src/engine/save-restore.ts";
import { createSession, stepSession, type Session, type SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { CHAPTERS_PATH, loadTape, ROOT, type ChaptersFile } from "./bake-chapters.ts";
import { readInlineProject, readShardedProject } from "./generated-project.ts";
import { zhMainlineMasks, type ZhChaptersFile } from "./transcribe-zh-tape.ts";
import { neutralDigest, neutralSummary, productionPaginator, sha256, tapeInput, ZH_CHAPTERS_REL, type NeutralSummary } from "./zh-tape.ts";

export interface ChapterReference {
  id: string;
  /** Source frames folded after the chapter save. */
  frames: number;
  /** state.frame once those frames are folded. */
  frame: number;
  map: string;
  /** sha256(canonicalJson(state)) of the Chinese session: the built game
   *  must reach exactly this state. */
  zhStateSha256: string;
  /** Language-neutral digest; equal in both languages. */
  neutralSha256: string;
  englishNeutralSha256: string;
  summary: NeutralSummary;
  englishSummary: NeutralSummary;
}

interface Side {
  session: Session;
  masks: readonly number[];
  chapters: Map<string, { snapshot: string; frame: number; timelineFrame: number; held: number }>;
}

let sides: { en: Side; zh: Side } | null = null;

function load(): { en: Side; zh: Side } {
  if (sides) return sides;
  const english = JSON.parse(readFileSync(CHAPTERS_PATH, "utf8")) as ChaptersFile;
  const chinese = JSON.parse(readFileSync(join(ROOT, ZH_CHAPTERS_REL), "utf8")) as ZhChaptersFile;
  const enProject = readInlineProject(ROOT);
  const zh = readShardedProject(ROOT, "zh_CN");
  sides = {
    en: {
      session: createSession(enProject, 60, createTuxemonSessionOptions(enProject, english.worldTraversal)),
      masks: loadTape().combined,
      chapters: new Map(english.chapters.map((c) => [c.id, c])),
    },
    zh: {
      session: createSession(zh.project, 60, createTuxemonSessionOptions(zh.project, chinese.worldTraversal, {
        ...TUXEMON_SESSION_OPTIONS_ZH,
        maps: zh.repository,
        paginateText: productionPaginator(ROOT),
      })),
      masks: zhMainlineMasks(ROOT),
      chapters: new Map(chinese.chapters.map((c) => [c.id, c])),
    },
  };
  return sides;
}

function replay(side: Side, id: string, frames: number): SessionState {
  const chapter = side.chapters.get(id);
  if (!chapter) throw new Error(`zh-demo-reference: unknown chapter ${id}`);
  const decoded = decodeEnvelopeText(chapter.snapshot);
  let state = restoreSessionSnapshot(side.session, decoded);
  state = { ...state, frame: chapter.timelineFrame };
  let previous = decoded.held >>> 0;
  for (let f = chapter.frame; f < chapter.frame + frames && f < side.masks.length; f++) {
    const mask = side.masks[f]!;
    state = stepSession(side.session, state, tapeInput(mask, previous));
    previous = mask;
  }
  return state;
}

/** Restore chapter `id` in both languages and fold `frames` of each
 *  language's tape. Throws if the two disagree beyond their words. */
export function chapterReference(id: string, frames: number): ChapterReference {
  const { en, zh } = load();
  const english = replay(en, id, frames);
  const chinese = replay(zh, id, frames);
  const reference: ChapterReference = {
    id,
    frames,
    frame: chinese.frame,
    map: chinese.mapId,
    zhStateSha256: sha256(canonicalJson(chinese)),
    neutralSha256: neutralDigest(chinese),
    englishNeutralSha256: neutralDigest(english),
    summary: neutralSummary(chinese),
    englishSummary: neutralSummary(english),
  };
  if (reference.neutralSha256 !== reference.englishNeutralSha256) {
    throw new Error(`zh-demo-reference: ${id} +${frames}: Chinese and English replays differ beyond their words`);
  }
  return reference;
}

/** A state digest as the references compute it, for a state read back from
 *  a running game. */
export function liveStateDigests(state: SessionState): { stateSha256: string; neutralSha256: string; summary: NeutralSummary } {
  return { stateSha256: sha256(canonicalJson(state)), neutralSha256: neutralDigest(state), summary: neutralSummary(state) };
}

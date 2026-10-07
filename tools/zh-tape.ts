// Transcribing the English mainline tape for the zh_CN build.
//
// The maintained journeys (GB6 + J1..J4) were recorded against the English
// reducer, which has no dialog paginator. A Chinese session in the built
// game is created with the production paginator (GameView: pages cut at
// the 480 px design width with the baked font), and its messages have other
// lengths, so the confirms a message needs can differ: an extra page takes
// one more confirm, a message that fits one Chinese box takes fewer, and a
// longer page needs its typewriter finished before the closing confirm.
//
// The transcriber folds both sessions in lockstep, one mask per 60 Hz
// frame. Outside text boxes the Chinese mask is the English mask. While a
// text box is open, only the confirm bit is rewritten: the Chinese box must
// close on exactly the frame the English one closes (so every later frame,
// clock and NPC step stay aligned), and must stay open on every other
// frame. Within that window the transcriber turns extra pages, drops
// confirms that would close the Chinese box early, and finishes a long
// page's typewriter two frames before the close. Choice boxes keep their
// rows and cursor (the cursor moves by index, never by label width), so
// their masks pass through unchanged.
//
// After each closed box, on a fixed cadence, at every chapter point and at
// the end, the two sessions must hold the same language-neutral state:
// the full SessionState minus the words themselves (compiled event
// programs, the open box, a scene's title). The tape keeps the English
// frame count, so a chapter starts on the same frame in both languages.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { tuxemonExtensionState } from "../battle/extension.ts";
import { TUXEMON_BATTLE_DB } from "../battle/game.ts";
import { applyTapeEdits, type TapeEdit as TapeEditBase } from "../importer/tape-edits.ts";
import { canonicalJson } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import {
  stepSession,
  type Session,
  type SessionInput,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { TextModal, TextPaginator } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";
import { productionPaginator } from "../battle/paginator.ts";
import { TUXEMON_UI_THEME } from "../ui/tuxemon-theme.ts";

export { productionPaginator };

export const ZH_TAPE_REL = "data/zh-mainline-journey.json";
export const ZH_CHAPTERS_REL = "data/chapters.zh_CN.json";
export const ZH_CHAPTER_TITLES_REL = "l10n/zh_CN/chapter-titles.json";
export const ZH_TAPE_FORMAT = "pocket-tuxemon/zh-mainline-journey/v1";
export const ZH_CHAPTERS_FORMAT = "pocket-tuxemon/chapters-zh/v1";

const CONFIRM = 0x2000;

export function sha256(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

export function tapeInput(mask: number, previous: number): SessionInput {
  const pressed = mask & ~previous;
  return {
    buttons: mask,
    confirmEdge: Boolean(pressed & 0x2000),
    cancelEdge: Boolean(pressed & 0x4000),
    upEdge: Boolean(pressed & 0x0010),
    downEdge: Boolean(pressed & 0x0040),
    leftEdge: Boolean(pressed & 0x0080),
    rightEdge: Boolean(pressed & 0x0020),
  };
}

// --- the production paginator --------------------------------------------

/** The dialog font and box the built game paginates with: the 12 px text
 *  slot (Inter, then the app's CJK subset as the fallback face), the
 *  480 px design width, the Tuxemon theme's rim and no speaker portraits
 *  (main.tsx passes none). */
export interface PaginatorIdentity {
  viewportWidth: 480;
  px: 12;
  rim: boolean;
  fallbacks: string[];
  fontSha256: string;
  charsetSha256: string;
}

/** The primary face of the 12 px slot (font-measure.ts), relative to the
 *  game root. */
const INTER_REGULAR = "vendor/pocket-rpgkit/vendor/pocketjs/assets/fonts/Inter-Regular.ttf";

export function productionPaginatorIdentity(root: string): PaginatorIdentity {
  const fonts = JSON.parse(readFileSync(join(root, "fonts.json"), "utf8")) as {
    fallback?: string[];
    characterFiles?: string[];
  };
  const fallbacks = fonts.fallback ?? [];
  const charsetFiles = fonts.characterFiles ?? [];
  return {
    viewportWidth: 480,
    px: 12,
    rim: !!TUXEMON_UI_THEME.rim,
    fallbacks,
    fontSha256: sha256([
      sha256(readFileSync(join(root, INTER_REGULAR))),
      ...fallbacks.map((file) => sha256(readFileSync(join(root, file)))),
    ].join("\n")),
    charsetSha256: sha256(charsetFiles.map((file) => readFileSync(join(root, file), "utf8")).join("")),
  };
}

// --- language-neutral state ----------------------------------------------

/** The localized payload of compiled event programs, stripped field by
 *  field. Everything else in a program is behavior and is compared: the op,
 *  the instruction order, control flow (`if`/`jmp`/`repeat`/`break`/labels),
 *  transfer targets, variable and switch writes, branch structure, waits,
 *  battle and scene setup. Stripped fields, by op:
 *    text.lines                     the message text
 *    choices.prompt                 the option prompt
 *    choices.texts                 the option labels (branches stay programs)
 *    extChoice.prompt               the option prompt
 *    extChoice.args.options[].label enum option labels (tux.enum_choice)
 *    scene.args.title               name-input / monster-picker titles
 *    scene.args.labels              scene UI label maps (pc, daycare, shop)
 *    scene.args.boxNames            storage box names (tux.pc)
 *    scene.args.message             the trade-completed message (tux.trade)
 *  `choices.icons` is render-only option art, identical across languages.
 *  The list is exhaustive over the importer's translated-string sinks
 *  (po.get/poText in importer/project.ts): a new localized program field
 *  fails the transcriber's neutral checks loudly and is added here. */
const LANGUAGE_OP_FIELDS: Readonly<Record<string, readonly string[]>> = {
  text: ["lines"],
  choices: ["prompt", "texts"],
  extChoice: ["prompt"],
};

/** Localized args fields of `scene` instructions (importer/project.ts:
 *  pcScene, daycareScene, monsterShopScene and the nameInput/monsterPicker/
 *  trade cases). */
const SCENE_LANGUAGE_ARGS = new Set(["title", "labels", "boxNames", "message"]);

/** A scene's args without its localized fields. */
function neutralSceneArgs(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return withoutWords(args);
  const record = args as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (SCENE_LANGUAGE_ARGS.has(key)) continue;
    out[key] = withoutWords(record[key]);
  }
  return out;
}

/** An extChoice's args without the enum options' localized labels: the
 *  option key and the enum code it writes are behavior. */
function neutralExtChoiceArgs(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return withoutWords(args);
  const record = args as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key === "options" && Array.isArray(record[key])) {
      out[key] = (record[key] as unknown[]).map((option) => {
        if (option && typeof option === "object" && !Array.isArray(option)) {
          const rest = { ...(option as Record<string, unknown>) };
          delete rest.label;
          return withoutWords(rest);
        }
        return withoutWords(option);
      });
      continue;
    }
    out[key] = withoutWords(record[key]);
  }
  return out;
}

/** The open modal without its words and pagination/render state. A choice or
 *  shop box carries behavior the next input acts on — the cursor, the cancel
 *  permission, an extChoice's logical keys and enabled rows, a shop's stage,
 *  cursor, rows and gold — so those fields are kept; only text, pagination
 *  and pure-render fields are normalized. A text box keeps just its fiber:
 *  its words, typewriter position, page cuts and layout differ between
 *  languages mid-box and are render state, while the fiber identifies the
 *  open program. Deleting the whole modal (the previous projection) also
 *  hid a choice cursor or shop stage the next confirm was about to act on. */
function neutralModal(modal: unknown): unknown {
  if (modal === null || modal === undefined) return undefined;
  if (typeof modal !== "object") return modal;
  const record = modal as Record<string, unknown>;
  switch (record.kind) {
    case "text":
      return { kind: "text", fiber: record.fiber };
    case "choices": {
      const out: Record<string, unknown> = {
        kind: "choices",
        fiber: record.fiber,
        index: record.index,
        cancellable: record.cancellable,
      };
      if (record.keys !== undefined) out.keys = record.keys;
      if (record.enabled !== undefined) out.enabled = record.enabled;
      return out;
    }
    case "shop":
      return {
        kind: "shop",
        fiber: record.fiber,
        gold: record.gold,
        sell: record.sell,
        stage: record.stage,
        index: record.index,
        rows: record.rows,
      };
    default:
      return withoutWords(record);
  }
}

/** The SessionState without its words. Compiled event programs (`prog`) are
 *  kept whole except their localized payload (see LANGUAGE_OP_FIELDS and the
 *  scene/extChoice args helpers); the open modal keeps its behavior fields
 *  (see neutralModal); a scene may hold a localized title; the save's
 *  language marker is not story state. Every other field (map, position,
 *  characters, switches, variables, items, gold, the player's name, fibers
 *  and their program counters, the game extension with the party and its
 *  RNG, the clock) is compared as is, except a fiber clock its mode never
 *  reads (see withoutWords). */
export function neutralState(state: SessionState): unknown {
  const neutral = withoutWords(state) as {
    interp: Record<string, unknown>;
    scene: { state?: Record<string, unknown> } | null;
    ext?: { lang?: unknown } | null;
  };
  const modal = neutralModal(neutral.interp.modal);
  if (modal === undefined) delete neutral.interp.modal;
  else neutral.interp.modal = modal;
  if (neutral.scene?.state && typeof neutral.scene.state === "object") delete neutral.scene.state.title;
  if (neutral.ext && typeof neutral.ext === "object") delete neutral.ext.lang;
  return neutral;
}

/** Fiber modes that read their `since` clock; each sets it on entry. */
const TIMED_FIBER_MODES = new Set(["wait", "screenWait", "animWait", "text"]);

/** A deep copy with the programs' localized payload cleared (see
 *  LANGUAGE_OP_FIELDS), and without a fiber's `since` clock while its mode
 *  never reads it (a page turned on another frame leaves a different, dead
 *  value behind once the box closes). Instruction payloads are emptied in
 *  place (`lines`/`texts` to [], `prompt` to "") so the compared shape stays
 *  the compiled one: a program that only changed words then matches, while a
 *  different op, jump target or transfer still differs. */
export function withoutWords(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutWords);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const deadClock = typeof record.mode === "string" && "since" in record && !TIMED_FIBER_MODES.has(record.mode);
    const languageFields = typeof record.op === "string" ? LANGUAGE_OP_FIELDS[record.op] : undefined;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      if (deadClock && key === "since") continue;
      if (languageFields?.includes(key)) {
        out[key] = key === "prompt" ? "" : [];
        continue;
      }
      if (key === "args" && record.op === "scene") {
        out[key] = neutralSceneArgs(record[key]);
        continue;
      }
      if (key === "args" && record.op === "extChoice") {
        out[key] = neutralExtChoiceArgs(record[key]);
        continue;
      }
      out[key] = withoutWords(record[key]);
    }
    return out;
  }
  return value;
}

export function neutralDigest(state: SessionState): string {
  return sha256(canonicalJson(neutralState(state) as never));
}

/** A readable language-neutral summary for reports and the web check. */
export interface NeutralSummary {
  map: string;
  position: [number, number];
  facing: number;
  frame: number;
  gold: number;
  items: Record<string, number>;
  party: string[];
  storySha256: string;
}

export function neutralSummary(state: SessionState): NeutralSummary {
  const ext = tuxemonExtensionState(state.ext, TUXEMON_BATTLE_DB);
  return {
    map: state.mapId,
    position: [state.move.tx, state.move.ty],
    facing: state.move.facing,
    frame: state.frame,
    gold: state.sw.gold,
    items: state.sw.items,
    party: ext.party.map((monster) => `${monster.slug}:${monster.level}`),
    storySha256: sha256(canonicalJson({
      switches: state.sw.switches,
      self: state.sw.self,
      variables: state.sw.variables,
    } as never)),
  };
}

/** The first differing paths of two neutral states (diagnostics only). */
export function neutralDiff(a: SessionState, b: SessionState, limit = 12): string[] {
  const out: string[] = [];
  const walk = (x: unknown, y: unknown, path: string): void => {
    if (out.length >= limit) return;
    if (typeof x !== "object" || x === null || typeof y !== "object" || y === null) {
      const left = JSON.stringify(x);
      const right = JSON.stringify(y);
      if (left !== right) out.push(`${path}: ${left?.slice(0, 100)} | ${right?.slice(0, 100)}`);
      return;
    }
    for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
      walk((x as Record<string, unknown>)[key], (y as Record<string, unknown>)[key], `${path}.${key}`);
    }
  };
  walk(neutralState(a), neutralState(b), "");
  return out;
}

// --- the transcriber -----------------------------------------------------

export interface TapeEdit extends TapeEditBase {
  /** insert: a confirm press the source does not have; remove: a source
   *  press the target must not see; hold: only the held bit changed. */
  reason: "insert" | "remove" | "hold";
}

export interface TranscribeStats {
  /** Text boxes the source session closed. */
  textBoxes: number;
  /** Text boxes whose confirms had to change. */
  rewrittenBoxes: number;
  /** Boxes with more pages in the target than one. */
  pagedBoxes: number;
  choiceBoxes: number;
  confirmsInserted: number;
  confirmsRemoved: number;
  neutralChecks: number;
}

export interface TranscribeOptions {
  source: readonly number[];
  sourceSession: Session;
  sourceStart: SessionState;
  targetSession: Session;
  targetStart: SessionState;
  /** Tape indices at which both states are captured (the state after
   *  folding that many masks) and must be neutral-equal. */
  captureAt?: readonly number[];
  /** Also compare the neutral states this often (frames). */
  checkEvery?: number;
}

export interface TranscribeResult {
  masks: number[];
  edits: TapeEdit[];
  stats: TranscribeStats;
  captures: Map<number, { source: SessionState; target: SessionState }>;
  terminal: { source: SessionState; target: SessionState };
}

export class TranscribeError extends Error {}

function textModal(state: SessionState): TextModal | null {
  const modal = state.interp.modal;
  return modal && modal.kind === "text" ? modal : null;
}

/** Exported for the English demo transcriber (tools/en-demo-tape.ts). */
export { textModal };

/** Did the text box open in `before` close on this fold? A box that stays
 *  up keeps its fiber and lines and, under a confirm, completes its page or
 *  turns to the next. A box that closed and reopened (the same fiber's next
 *  message) starts typing again. */
export function boxClosed(before: SessionState, after: SessionState): boolean {
  const open = textModal(before);
  if (!open) return false;
  const next = textModal(after);
  if (!next || next.fiber !== open.fiber) return true;
  if (next.lines !== open.lines && canonicalJson(next.lines as never) !== canonicalJson(open.lines as never)) return true;
  // A page turn moves forward; a page index going back is the same
  // message reopened after the last page closed.
  if ((next.page ?? 0) < (open.page ?? 0)) return true;
  if ((next.page ?? 0) !== (open.page ?? 0)) return false;
  return next.revealed < open.revealed || (open.complete && !next.complete);
}

export function lastPage(modal: TextModal): boolean {
  return !modal.pageStarts || (modal.page ?? 0) + 1 >= modal.pageStarts.length;
}

export function transcribeTape(options: TranscribeOptions): TranscribeResult {
  const { source, sourceSession, targetSession } = options;
  const n = source.length;
  const checkEvery = options.checkEvery ?? 3600;
  const captureAt = new Set(options.captureAt ?? []);
  const captures = new Map<number, { source: SessionState; target: SessionState }>();
  const masks: number[] = new Array(n);
  const edits: TapeEdit[] = [];
  const stats: TranscribeStats = {
    textBoxes: 0,
    rewrittenBoxes: 0,
    pagedBoxes: 0,
    choiceBoxes: 0,
    confirmsInserted: 0,
    confirmsRemoved: 0,
    neutralChecks: 0,
  };

  // The source runs three folds ahead: the window rules look at whether
  // the English box closes on this fold, the next one or the one after.
  const ahead: SessionState[] = [options.sourceStart];
  let sourcePrev = 0;
  let folded = 0;
  const sourceAt = (k: number): SessionState => {
    while (folded < k && folded < n) {
      const last = ahead[ahead.length - 1]!;
      const mask = source[folded]!;
      ahead.push(stepSession(sourceSession, last, tapeInput(mask, sourcePrev)));
      sourcePrev = mask;
      folded++;
    }
    return ahead[k - (folded - (ahead.length - 1))]!;
  };
  const closesAt = (k: number): boolean => k < n && boxClosed(sourceAt(k), sourceAt(k + 1));

  let target = options.targetStart;
  let targetPrev = 0;
  let boxRewritten = false;
  let boxPaged = false;
  let boxClosedAt = -1;

  const check = (k: number, why: string): void => {
    stats.neutralChecks++;
    const a = sourceAt(k);
    if (neutralDigest(a) !== neutralDigest(target)) {
      throw new TranscribeError(`frame ${k} (${why}): language-neutral states differ on ${a.mapId}\n  `
        + neutralDiff(a, target).join("\n  "));
    }
  };

  if (captureAt.has(0)) {
    check(0, "capture");
    captures.set(0, { source: options.sourceStart, target });
  }
  for (let f = 0; f < n; f++) {
    const a0 = sourceAt(f);
    const a1 = sourceAt(f + 1);
    const srcMask = source[f]!;
    const aText = textModal(a0);
    const bText = textModal(target);
    if (a0.interp.modal?.kind !== "choices" && a1.interp.modal?.kind === "choices") stats.choiceBoxes++;

    let out = srcMask;
    if (aText || bText) {
      if (!aText || !bText || aText.fiber !== bText.fiber) {
        throw new TranscribeError(`frame ${f}: text boxes out of step on ${a0.mapId} `
          + `(source ${aText?.fiber ?? "none"}, target ${bText?.fiber ?? "none"})`);
      }
      if (bText.pageStarts) boxPaged = true;
      const closeNow = closesAt(f);
      if (closeNow) stats.textBoxes++;
      const edgeFree = (targetPrev & CONFIRM) === 0;
      const sourceEdge = (srcMask & CONFIRM) !== 0 && (sourcePrevMask(source, f) & CONFIRM) === 0;
      const base = srcMask & ~CONFIRM;
      if (closeNow && sourceEdge) {
        if (!edgeFree) {
          throw new TranscribeError(`frame ${f}: the source closes ${aText.fiber} but the target still holds confirm`);
        }
        out = base | CONFIRM;
      } else if (closeNow) {
        // Closed by something other than a confirm: nothing to rewrite.
        out = srcMask;
      } else if (!edgeFree || closesAt(f + 1)) {
        // Release, so the next frame's confirm is an edge.
        out = base;
      } else if (!lastPage(bText)) {
        // A page the source never had: complete it, then turn it.
        out = base | CONFIRM;
      } else if (!bText.complete && (boxPaged || closesAt(f + 2))) {
        // Finish typing a page that is still typing when the source is
        // about to close (a longer page, or a page just turned to).
        out = base | CONFIRM;
      } else {
        out = srcMask;
      }
      let next = stepSession(targetSession, target, tapeInput(out, targetPrev));
      if (!closeNow && (out & CONFIRM) && boxClosed(target, next)) {
        // The target's last page was already full: this confirm would close
        // it before the source does.
        out = base;
        next = stepSession(targetSession, target, tapeInput(out, targetPrev));
      }
      const closedNow = boxClosed(target, next);
      if (closeNow !== closedNow) {
        throw new TranscribeError(`frame ${f}: ${aText.fiber} on ${a0.mapId} `
          + (closeNow ? "closes in the source but the target needs more frames" : "would close early in the target")
          + ` (target page ${(bText.page ?? 0) + 1}/${bText.pageStarts?.length ?? 1}, complete=${bText.complete})`);
      }
      // Count presses as the reducer sees them (edges), on every frame of
      // the box: a released hold can turn an unchanged mask into a press.
      const targetEdge = (out & CONFIRM) !== 0 && (targetPrev & CONFIRM) === 0;
      if (targetEdge && !sourceEdge) stats.confirmsInserted++;
      if (sourceEdge && !targetEdge) stats.confirmsRemoved++;
      if (out !== srcMask) {
        boxRewritten = true;
        edits.push({
          frame: f,
          source: srcMask,
          target: out,
          reason: targetEdge && !sourceEdge ? "insert" : sourceEdge && !targetEdge ? "remove" : "hold",
        });
      }
      target = next;
      if (closedNow) {
        boxClosedAt = f + 1;
        if (boxRewritten) stats.rewrittenBoxes++;
        if (boxPaged) stats.pagedBoxes++;
        boxRewritten = false;
        boxPaged = false;
      }
    } else {
      const ac = a0.interp.modal;
      const bc = target.interp.modal;
      if ((ac?.kind ?? null) !== (bc?.kind ?? null)) {
        throw new TranscribeError(`frame ${f}: modal kinds differ (${ac?.kind ?? "none"} / ${bc?.kind ?? "none"})`);
      }
      if (ac?.kind === "choices" && bc?.kind === "choices") {
        if (ac.options.length !== bc.options.length || ac.index !== bc.index) {
          throw new TranscribeError(`frame ${f}: choice boxes differ (${ac.options.length}/${bc.options.length} rows, `
            + `cursor ${ac.index}/${bc.index})`);
        }
      }
      target = stepSession(targetSession, target, tapeInput(out, targetPrev));
    }
    masks[f] = out;
    targetPrev = out;
    // Free the source lookahead behind the cursor.
    while (ahead.length > 5 && folded - (ahead.length - 1) < f + 1) ahead.shift();
    const k = f + 1;
    if (captureAt.has(k)) {
      check(k, "capture");
      captures.set(k, { source: sourceAt(k), target });
    } else if (k === n) {
      check(k, "terminal");
    } else if (k === boxClosedAt) {
      check(k, "box closed");
    } else if (k % checkEvery === 0 && !textModal(target)) {
      check(k, "cadence");
    }
  }
  return { masks, edits, stats, captures, terminal: { source: sourceAt(n), target } };
}

function sourcePrevMask(source: readonly number[], f: number): number {
  return f === 0 ? 0 : source[f - 1]!;
}

/** Apply a transcription's edits to the source tape. Re-exported from the
 *  shared module so the importer's production packaging applies edits
 *  through the same loop (importer/tape-edits.ts). */
export { applyTapeEdits };

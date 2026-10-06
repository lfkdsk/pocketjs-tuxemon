// The zh_CN demo data: the transcriber's confirm rewriting on a real
// stretch of the mainline, and the committed Chinese tape and chapters
// staying tied to the English tape they were made from.

import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createTuxemonSessionOptions } from "../battle/game.ts";
import { decodeEnvelopeText } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import {
  createSession,
  startSession,
  stepSession,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { createDialogPaginator } from "../vendor/pocket-rpgkit/src/ui/dialog-pages.ts";
import { createFontMeasure } from "../vendor/pocket-rpgkit/tools/lib/font-measure.ts";
import { buildZhDemoData, encodeTape, type DemoDataBuild } from "../importer/demo-data.ts";
import { decodeDemoTape } from "../ui/demo-tape.ts";
import { loadTape, ROOT } from "../tools/bake-chapters.ts";
import { readInlineProject } from "../tools/generated-project.ts";
import { zhMainlineMasks, zhTapeStaleness, type ZhChaptersFile, type ZhTapeFile } from "../tools/transcribe-zh-tape.ts";
import {
  applyTapeEdits,
  neutralDiff,
  neutralDigest,
  sha256,
  tapeInput,
  transcribeTape,
  TranscribeError,
  ZH_CHAPTER_TITLES_REL,
  ZH_CHAPTERS_REL,
  ZH_TAPE_REL,
  type TapeEdit,
} from "../tools/zh-tape.ts";

const CONFIRM = 0x2000;

describe("tape transcription", () => {
  const { combined } = loadTape();
  const project = readInlineProject(ROOT);
  const plain = createSession(project, 60, createTuxemonSessionOptions(project, "seamless-v1"));
  // An 80 px box splits the opening's messages into several pages.
  const narrow = createDialogPaginator({ viewportWidth: 80, rim: true }, createFontMeasure({ px: 12 }));
  const paged = createSession(project, 60, createTuxemonSessionOptions(project, "seamless-v1", { paginateText: narrow }));

  // The recorded tape closes a box a few frames after it opens, too soon for
  // extra pages. A patient source waits 40 frames before every confirm that
  // lands on an open box, over the opening (bedroom to Paper Town).
  const patient: number[] = [];
  {
    let state: SessionState = startSession(project, plain);
    let previous = 0;
    for (let f = 0; f < 3000; f++) {
      const mask = combined[f]!;
      if (state.interp.modal?.kind === "text" && (mask & CONFIRM) && !(previous & CONFIRM)) {
        for (let i = 0; i < 40; i++) {
          const idle = mask & ~CONFIRM;
          state = stepSession(plain, state, tapeInput(idle, previous));
          patient.push(idle);
          previous = idle;
        }
      }
      state = stepSession(plain, state, tapeInput(mask, previous));
      patient.push(mask);
      previous = mask;
    }
  }

  const fold = (session: typeof plain, masks: readonly number[]): SessionState => {
    let state = startSession(project, session);
    let previous = 0;
    for (const mask of masks) {
      state = stepSession(session, state, tapeInput(mask, previous));
      previous = mask;
    }
    return state;
  };

  test("an unchanged layout needs no edits", () => {
    const result = transcribeTape({
      source: patient,
      sourceSession: plain,
      sourceStart: startSession(project, plain),
      targetSession: plain,
      targetStart: startSession(project, plain),
    });
    expect(result.edits).toEqual([]);
    expect(result.masks).toEqual(patient);
  });

  test("extra pages get extra confirms and the same story", () => {
    const result = transcribeTape({
      source: patient,
      sourceSession: plain,
      sourceStart: startSession(project, plain),
      targetSession: paged,
      targetStart: startSession(project, paged),
      checkEvery: 120,
    });
    expect(result.stats.pagedBoxes).toBeGreaterThan(0);
    expect(result.stats.confirmsInserted).toBeGreaterThan(0);
    expect(result.masks.length).toBe(patient.length);
    // Replaying the produced tape alone reaches the source's end state.
    const source = fold(plain, patient);
    const target = fold(paged, result.masks);
    expect(neutralDigest(target)).toBe(neutralDigest(source));
    // Without the edits the paged session falls out of step.
    expect(neutralDigest(fold(paged, patient))).not.toBe(neutralDigest(source));
  });

  test("fewer pages drop the confirms that would close a box early", () => {
    const result = transcribeTape({
      source: patient,
      sourceSession: paged,
      sourceStart: startSession(project, paged),
      targetSession: plain,
      targetStart: startSession(project, plain),
      checkEvery: 120,
    });
    expect(result.stats.confirmsRemoved).toBeGreaterThan(0);
    expect(result.stats.confirmsInserted).toBe(0);
    expect(neutralDigest(fold(plain, result.masks))).toBe(neutralDigest(fold(paged, patient)));
  });

  test("a box the source closes too soon for the target's pages is an error, not a drift", () => {
    expect(() => transcribeTape({
      source: combined.slice(0, 3000),
      sourceSession: plain,
      sourceStart: startSession(project, plain),
      targetSession: paged,
      targetStart: startSession(project, paged),
    })).toThrow(TranscribeError);
  });

  test("serialized edits round-trip through apply, pack, decode and replay (inserts)", () => {
    const result = transcribeTape({
      source: patient,
      sourceSession: plain,
      sourceStart: startSession(project, plain),
      targetSession: paged,
      targetStart: startSession(project, paged),
      checkEvery: 120,
    });
    expect(result.edits.length).toBeGreaterThan(0);
    expect(result.edits.some((e) => e.reason === "insert")).toBe(true);
    // The transcriber emits edits in frame order.
    const frames = result.edits.map((e) => e.frame);
    expect(frames).toEqual([...frames].sort((a, b) => a - b));
    // The tape file persists only the edits; the runtime rebuilds the masks.
    const serialized = JSON.parse(JSON.stringify(result.edits)) as TapeEdit[];
    const masks = applyTapeEdits(patient, serialized);
    expect(masks).toEqual(result.masks);
    // The packed entry decodes back to the same masks, and replaying them on
    // the paged session reaches the source's language-neutral end state.
    const decoded = decodeDemoTape(encodeTape(masks, "seamless-v1"));
    expect([...decoded.masks]).toEqual(masks);
    expect(neutralDigest(fold(paged, [...decoded.masks]))).toBe(neutralDigest(fold(plain, patient)));
  });

  test("serialized edits round-trip through apply, pack, decode and replay (removes)", () => {
    const result = transcribeTape({
      source: patient,
      sourceSession: paged,
      sourceStart: startSession(project, paged),
      targetSession: plain,
      targetStart: startSession(project, plain),
      checkEvery: 120,
    });
    expect(result.edits.length).toBeGreaterThan(0);
    expect(result.edits.some((e) => e.reason === "remove")).toBe(true);
    const serialized = JSON.parse(JSON.stringify(result.edits)) as TapeEdit[];
    const masks = applyTapeEdits(patient, serialized);
    expect(masks).toEqual(result.masks);
    const decoded = decodeDemoTape(encodeTape(masks, "seamless-v1"));
    expect(neutralDigest(fold(plain, [...decoded.masks]))).toBe(neutralDigest(fold(paged, patient)));
  });

  test("applyTapeEdits applies edits in order, so a shuffle is an error", () => {
    // Two edits chained on one frame: the second's source mask is the
    // first's target. Applying them in order succeeds; a shuffled order
    // must fail the source-mask check rather than silently misapply.
    const source = [0, 0, CONFIRM, 0, 0];
    const edits: TapeEdit[] = [
      { frame: 2, source: CONFIRM, target: 0, reason: "remove" },
      { frame: 2, source: 0, target: 0x10, reason: "hold" },
    ];
    const applied = applyTapeEdits(source, edits);
    expect(applied[2]).toBe(0x10);
    expect(() => applyTapeEdits(source, [...edits].reverse())).toThrow(/source mask/);
  });
});

describe("language-neutral projection", () => {
  /** A minimal SessionState-shaped tree: one idle fiber parked on a
   *  program, a language marker, nothing else that varies. */
  function stateWithProg(prog: readonly unknown[], lang = "en_US"): SessionState {
    return {
      frame: 12,
      mapId: "spyder_bedroom",
      interp: {
        frame: 12,
        main: { fiber: "main", mode: "idle", pc: 0, prog, since: 0 },
        parallels: {},
        modal: null,
      },
      ext: { lang },
    } as unknown as SessionState;
  }

  /** A minimal SessionState-shaped tree with an open modal. */
  function stateWithModal(modal: unknown): SessionState {
    return {
      frame: 12,
      mapId: "spyder_bedroom",
      interp: {
        frame: 12,
        main: { fiber: "main", mode: "idle", pc: 0, prog: [], since: 0 },
        parallels: {},
        modal,
      },
      ext: { lang: "en_US" },
    } as unknown as SessionState;
  }

  test("an open choice box keeps its cursor and cancel permission, not its words", () => {
    const mk = (index: number, cancellable: boolean): SessionState => stateWithModal({
      kind: "choices",
      fiber: "main:7",
      prompt: "What now?",
      options: ["Fight", "Run"],
      icons: [null, null],
      index,
      cancellable,
    });
    // Words and render-only icons differ; the behavior is the same.
    const english = mk(0, false);
    const chinese = mk(0, false);
    ((chinese.interp.modal as unknown as Record<string, unknown>).options as string[])[0] = "战斗";
    expect(neutralDigest(english)).toBe(neutralDigest(chinese));
    expect(neutralDiff(english, chinese)).toEqual([]);
    // The cursor the next confirm acts on, and the cancel permission, are
    // behavior: a difference must be visible (the review's index 0 -> 1
    // probe said "equal" under the old whole-modal deletion).
    expect(neutralDigest(mk(0, false))).not.toBe(neutralDigest(mk(1, false)));
    expect(neutralDigest(mk(0, false))).not.toBe(neutralDigest(mk(0, true)));
    expect(neutralDiff(mk(0, false), mk(1, false)).join("\n")).toMatch(/modal.*index/);
  });

  test("an open extChoice box keeps its logical keys and enabled rows", () => {
    const mk = (keys: string[], enabled: boolean[]): SessionState => stateWithModal({
      kind: "choices",
      fiber: "main:8",
      prompt: "Pick one",
      options: keys,
      keys,
      enabled,
      index: 0,
      cancellable: false,
    });
    expect(neutralDigest(mk(["yes", "no"], [true, true]))).toBe(neutralDigest(mk(["yes", "no"], [true, true])));
    expect(neutralDigest(mk(["yes", "no"], [true, true]))).not.toBe(neutralDigest(mk(["yes", "no"], [true, false])));
    expect(neutralDigest(mk(["yes", "no"], [true, true]))).not.toBe(neutralDigest(mk(["yes", "maybe"], [true, true])));
  });

  test("an open shop box keeps its stage, cursor, rows and gold", () => {
    const rows = [{ kind: "item", item: "potion", price: 10, owned: 0, canAfford: true, atCap: false, stock: null, sellable: true }];
    const mk = (stage: "buy" | "sell", index: number, gold: number): SessionState => stateWithModal({
      kind: "shop",
      fiber: "main:9",
      gold,
      sell: false,
      stage,
      index,
      rows,
    });
    expect(neutralDigest(mk("buy", 0, 100))).toBe(neutralDigest(mk("buy", 0, 100)));
    expect(neutralDigest(mk("buy", 0, 100))).not.toBe(neutralDigest(mk("sell", 0, 100)));
    expect(neutralDigest(mk("buy", 0, 100))).not.toBe(neutralDigest(mk("buy", 1, 100)));
    expect(neutralDigest(mk("buy", 0, 100))).not.toBe(neutralDigest(mk("buy", 0, 90)));
  });

  test("an open text box keeps only its fiber", () => {
    const mk = (lines: string[], page: number): SessionState => stateWithModal({
      kind: "text",
      fiber: "main:6",
      lines,
      total: lines.join("\n").length,
      revealed: 4,
      complete: false,
      pageStarts: [0, 20],
      page,
      box: { position: "top" },
    });
    // Words, typewriter and page state differ between languages mid-box.
    expect(neutralDigest(mk(["Good morning"], 0))).toBe(neutralDigest(mk(["早上好"], 1)));
    // The fiber identifies the open program.
    const other = mk(["Good morning"], 0);
    (other.interp.modal as unknown as Record<string, unknown>).fiber = "main:7";
    expect(neutralDigest(mk(["Good morning"], 0))).not.toBe(neutralDigest(other));
  });

  test("a real choice cursor difference on the opening tape is a difference", () => {
    const { combined } = loadTape();
    const project = readInlineProject(ROOT);
    const plain = createSession(project, 60, createTuxemonSessionOptions(project, "seamless-v1"));
    let state: SessionState = startSession(project, plain);
    let previous = 0;
    let choice: SessionState | null = null;
    for (let f = 0; f < 256 && !choice; f++) {
      const mask = combined[f]!;
      state = stepSession(plain, state, tapeInput(mask, previous));
      previous = mask;
      if (state.interp.modal?.kind === "choices") choice = state;
    }
    expect(choice).not.toBeNull();
    const moved = structuredClone(choice) as SessionState;
    (moved.interp.modal as { index: number }).index += 1;
    expect(neutralDigest(choice!)).not.toBe(neutralDigest(moved));
    expect(neutralDiff(choice!, moved).join("\n")).toMatch(/modal.*index/);
  });

  test("programs that differ only in words compare equal", () => {
    const english = stateWithProg([
      { op: "text", lines: ["Good morning"], cps: 20 },
      { op: "choices", prompt: "What now?", texts: ["Fight", "Run"], branches: [[{ op: "wait", frames: 1 }]], cancel: null, icons: [null, null] },
      { op: "extChoice", call: "x", args: {}, prompt: "Pick one", cancel: false, write: null },
    ]);
    const chinese = stateWithProg([
      { op: "text", lines: ["早上好"], cps: 20 },
      { op: "choices", prompt: "接下来？", texts: ["战斗", "逃跑"], branches: [[{ op: "wait", frames: 1 }]], cancel: null, icons: [null, null] },
      { op: "extChoice", call: "x", args: {}, prompt: "选一个", cancel: false, write: null },
    ], "zh_CN");
    expect(neutralDigest(english)).toBe(neutralDigest(chinese));
    expect(neutralDiff(english, chinese)).toEqual([]);
  });

  test("a different op is a difference (text vs transfer)", () => {
    const a = stateWithProg([{ op: "text", lines: ["x"], cps: 20 }]);
    const b = stateWithProg([{ op: "transfer", map: { map: "route1" }, x: 1, y: 1, dir: "down", fadeFrames: 0 }]);
    expect(neutralDigest(a)).not.toBe(neutralDigest(b));
    expect(neutralDiff(a, b).join("\n")).toMatch(/prog/);
  });

  test("a different jump target is a difference", () => {
    const a = stateWithProg([{ op: "jmp", to: 5 }]);
    const b = stateWithProg([{ op: "jmp", to: 9 }]);
    expect(neutralDigest(a)).not.toBe(neutralDigest(b));
    expect(neutralDiff(a, b).join("\n")).toMatch(/prog\.0\.to/);
  });

  test("a different branch count is a difference", () => {
    const branch = [{ op: "wait", frames: 1 }];
    const a = stateWithProg([{ op: "choices", prompt: "", texts: [], branches: [branch], cancel: null }]);
    const b = stateWithProg([{ op: "choices", prompt: "", texts: [], branches: [branch, branch], cancel: null }]);
    expect(neutralDigest(a)).not.toBe(neutralDigest(b));
  });

  test("a nested program's transfer target is compared", () => {
    const mk = (map: string): SessionState => stateWithProg([
      { op: "choices", prompt: "", texts: ["a"], branches: [[{ op: "transfer", map: { map }, x: 1, y: 1, dir: "down", fadeFrames: 0 }]], cancel: null },
    ]);
    expect(neutralDigest(mk("route1"))).not.toBe(neutralDigest(mk("route2")));
  });

  test("scene args keep their behavior and lose their words", () => {
    const mk = (words: { title: string; pickUp: string; box: string; done: string }, variable: string): SessionState => stateWithProg([
      { op: "scene", id: "rpgkit.nameInput", args: { variable, maxLength: 15, title: words.title }, onDone: null, onCancel: null },
      { op: "scene", id: "tux.pc", args: { labels: { pickUp: words.pickUp }, boxNames: { Kennel: words.box } }, onDone: null, onCancel: null },
      { op: "scene", id: "tux.trade", args: { variable: "trade", species: "nut", message: words.done }, onDone: null, onCancel: null },
    ]);
    const english = mk({ title: "Name", pickUp: "Pick up", box: "Kennel", done: "Done" }, "name");
    const chinese = mk({ title: "姓名", pickUp: "取出", box: "寄养处", done: "完成" }, "name");
    expect(neutralDigest(english)).toBe(neutralDigest(chinese));
    expect(neutralDiff(english, chinese)).toEqual([]);
    expect(neutralDigest(chinese)).not.toBe(neutralDigest(mk({ title: "姓名", pickUp: "取出", box: "寄养处", done: "完成" }, "other")));
  });

  test("extChoice options keep their key and code and lose their label", () => {
    const mk = (label: string, code: number): SessionState => stateWithProg([
      { op: "extChoice", call: "tux.enum_choice", args: { variable: "choice", options: [{ key: "yes", label, code }] }, prompt: "", cancel: false, write: null },
    ]);
    expect(neutralDigest(mk("Yes", 1))).toBe(neutralDigest(mk("是", 1)));
    expect(neutralDigest(mk("Yes", 1))).not.toBe(neutralDigest(mk("Yes", 2)));
  });
});

describe("committed zh_CN demo data", () => {
  const tape = JSON.parse(readFileSync(join(ROOT, ZH_TAPE_REL), "utf8")) as ZhTapeFile;
  const chapters = JSON.parse(readFileSync(join(ROOT, ZH_CHAPTERS_REL), "utf8")) as ZhChaptersFile;
  const english = JSON.parse(readFileSync(join(ROOT, "data/chapters.json"), "utf8")) as {
    chapters: { id: string; frame: number; timelineFrame: number; map: string; position: [number, number] }[];
  };

  test("was transcribed from the current English tape, font and chapters", () => {
    expect(zhTapeStaleness(ROOT)).toBeNull();
    expect(zhMainlineMasks(ROOT).length).toBe(tape.frames);
  });

  test("covers every English chapter on the same frame, with a Chinese title and a zh_CN save", () => {
    const titles = JSON.parse(readFileSync(join(ROOT, ZH_CHAPTER_TITLES_REL), "utf8")) as Record<string, string>;
    expect(chapters.chapters.map((c) => c.id)).toEqual(english.chapters.map((c) => c.id));
    for (const [i, chapter] of chapters.chapters.entries()) {
      const en = english.chapters[i]!;
      expect([chapter.frame, chapter.timelineFrame, chapter.map, chapter.position])
        .toEqual([en.frame, en.timelineFrame, en.map, en.position]);
      expect(chapter.title).toBe(titles[chapter.id]!);
      expect(chapter.title).toMatch(/[一-鿿]/);
      const snapshot = decodeEnvelopeText(chapter.snapshot);
      expect((snapshot.ext as { lang?: string }).lang).toBe("zh_CN");
      expect(snapshot.interp.modal).toBeNull();
    }
  });

  test("the importer packs the Chinese chapters only while they match the English tape", () => {
    const { combined } = loadTape();
    const english = { masks: combined, worldTraversal: "seamless-v1" } as unknown as DemoDataBuild;
    const fresh = buildZhDemoData(ROOT, english);
    expect(fresh.reason).toBeNull();
    expect(fresh.data!.index.map((entry) => entry.title)).toEqual(chapters.chapters.map((c) => c.title));
    const edited = [...combined];
    edited[120000] = edited[120000]! ^ CONFIRM;
    const stale = buildZhDemoData(ROOT, { ...english, masks: edited });
    expect(stale.data).toBeNull();
    expect(stale.reason).toMatch(/English tape changed/);
  });

  test("non-empty edits are applied to the packed Chinese demo tape", () => {
    // The production packaging must apply a non-empty edit file through the
    // same loop the transcriber's tests exercise: build the Chinese demo
    // data from a fixture tape with one edit, and decode the packed bytes
    // back. Deleting the importer's apply must make this test red.
    const scratch = join(ROOT, "dist", `zh-edits-${process.pid}`);
    rmSync(scratch, { recursive: true, force: true });
    try {
      mkdirSync(join(scratch, "data"), { recursive: true });
      const masks = [0, 0, CONFIRM, 0, 0x10, 0];
      const edit = { frame: 2, source: CONFIRM, target: 0x10 };
      const edited = applyTapeEdits(masks, [edit]);
      expect(edited[2]).toBe(0x10);
      const chapterEn = {
        id: "ch1", title: "One", map: "spyder_bedroom", position: [0, 0],
        frame: 0, timelineFrame: 0, held: 0, suffixFrames: masks.length, snapshot: "x",
      };
      const chaptersText = JSON.stringify({
        format: "pocket-tuxemon/chapters/v1",
        worldTraversal: "seamless-v1",
        chapters: [chapterEn],
        tape: { sha256: sha256(JSON.stringify(masks)), frames: masks.length },
      });
      writeFileSync(join(scratch, "data/chapters.json"), chaptersText);
      const tapeSha256 = sha256(JSON.stringify(edited));
      writeFileSync(join(scratch, "data/zh-mainline-journey.json"), JSON.stringify({
        format: "pocket-tuxemon/zh-mainline-journey/v1",
        source: {
          chaptersSha256: sha256(chaptersText),
          tape: { sha256: sha256(JSON.stringify(masks)), frames: masks.length },
        },
        frames: masks.length,
        tapeSha256,
        edits: [edit],
      }));
      writeFileSync(join(scratch, "data/chapters.zh_CN.json"), JSON.stringify({
        format: "pocket-tuxemon/chapters-zh/v1",
        source: { tapeSha256 },
        chapters: [{ ...chapterEn, title: "第一章" }],
      }));
      const english = {
        worldTraversal: "seamless-v1",
        masks,
        tapeBytes: encodeTape(masks, "seamless-v1"),
        snapshotsJson: "",
        pakEntries: [],
        index: [],
        spawns: [],
      } as unknown as DemoDataBuild;
      const built = buildZhDemoData(scratch, english);
      expect(built.reason).toBeNull();
      expect(built.data).not.toBeNull();
      const decoded = decodeDemoTape(built.data!.tapeBytes);
      expect([...decoded.masks]).toEqual(edited);
      expect(decoded.masks[2]).toBe(0x10);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("an edited English frame makes the Chinese tape stale", () => {
    const scratch = join(ROOT, "dist", `zh-stale-${process.pid}`);
    rmSync(scratch, { recursive: true, force: true });
    try {
      mkdirSync(join(scratch, "data"), { recursive: true });
      const files = [
        "data/chapters.json",
        "data/gb6-mainline-journey.json",
        "data/j1-captainreturns-journey.json",
        "data/j2-hospitalcure-journey.json",
        "data/j3-omnichannelradioannounce-journey.json",
        "data/j4-kernelquestdone-journey.json",
        ZH_TAPE_REL,
        ZH_CHAPTERS_REL,
        "fonts.json",
        "fonts",
        "vendor/pocket-rpgkit/vendor/pocketjs/assets/fonts/Inter-Regular.ttf",
      ];
      for (const file of files) {
        mkdirSync(dirname(join(scratch, file)), { recursive: true });
        cpSync(join(ROOT, file), join(scratch, file), { recursive: true });
      }
      expect(zhTapeStaleness(scratch)).toBeNull();
      const path = join(scratch, "data/j2-hospitalcure-journey.json");
      const journey = JSON.parse(readFileSync(path, "utf8")) as { masks: number[] };
      journey.masks[1000] = journey.masks[1000]! ^ CONFIRM;
      writeFileSync(path, JSON.stringify(journey));
      expect(zhTapeStaleness(scratch)).toMatch(/English j2 tape .* changed/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

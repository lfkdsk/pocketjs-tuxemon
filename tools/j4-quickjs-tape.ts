// Build the short QuickJS continuation fixture from committed inputs.
// The desktop host restores the radio-broadcast demo chapter, so this tape
// is the remaining J3 masks followed by every J4 mask. The chapter manifest
// and the five journey segments remain the authorities.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { journeyWorldTraversal, type Gb6JourneyResult } from "./gb6-journey.ts";
import type { J1JourneyResult } from "./j1-journey.ts";
import type { J2JourneyResult } from "./j2-journey.ts";
import type { J3JourneyResult } from "./j3-journey.ts";
import type { J4JourneyResult } from "./j4-journey.ts";

interface ChapterRow {
  id: string;
  frame: number;
  timelineFrame: number;
  held: number;
  map: string;
  position: [number, number];
}

export interface J4QuickjsTape {
  format: "pocket-tuxemon/j4-quickjs/v1";
  worldTraversal: "seamless-v1";
  hz: 60;
  startChapter: "radio-broadcast";
  frames: number;
  masks: number[];
  maps: { frame: number; map: string }[];
  battles: J4JourneyResult["battles"];
  terminalStateSha256: string;
  tapeSha256: string;
}

const ROOT = resolve(import.meta.dir, "..");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`j4-quickjs-tape: ${message}`);
}

export function buildJ4QuickjsTape(root: string = ROOT): J4QuickjsTape {
  const read = <T>(file: string): T =>
    JSON.parse(readFileSync(join(root, file), "utf8")) as T;
  const gb6 = read<Gb6JourneyResult>("data/gb6-mainline-journey.json");
  const j1 = read<J1JourneyResult>("data/j1-captainreturns-journey.json");
  const j2 = read<J2JourneyResult>("data/j2-hospitalcure-journey.json");
  const j3 = read<J3JourneyResult>("data/j3-omnichannelradioannounce-journey.json");
  const j4 = read<J4JourneyResult>("data/j4-kernelquestdone-journey.json");
  const chapters = read<{ worldTraversal?: unknown; chapters: ChapterRow[] }>("data/chapters.json");
  const chapter = chapters.chapters.find((candidate) => candidate.id === "radio-broadcast");
  expect(chapter, "missing radio-broadcast chapter");
  const worldTraversal = journeyWorldTraversal(j4, "J4 QuickJS tape");
  expect(worldTraversal === "seamless-v1", "J4 QuickJS tape must use seamless-v1");
  for (const [label, source] of [
    ["GB6", gb6], ["J1", j1], ["J2", j2], ["J3", j3],
  ] as const) {
    expect(journeyWorldTraversal(source, label) === worldTraversal,
      `${label} traversal identity changed`);
  }
  expect(journeyWorldTraversal(chapters, "chapters") === worldTraversal,
    "chapter manifest traversal identity changed");

  const throughJ1 = [...gb6.masks, ...j1.masks];
  const throughJ2 = [...throughJ1, ...j2.masks];
  const throughJ3 = [...throughJ2, ...j3.masks];
  expect(j1.combinedFrames === throughJ1.length, "J1 ancestry frame count changed");
  expect(j1.combinedTapeSha256 === sha256(JSON.stringify(throughJ1)), "J1 ancestry hash changed");
  expect(j2.combinedFrames === throughJ2.length, "J2 ancestry frame count changed");
  expect(j2.combinedTapeSha256 === sha256(JSON.stringify(throughJ2)), "J2 ancestry hash changed");
  expect(j3.combinedFrames === throughJ3.length, "J3 ancestry frame count changed");
  expect(j3.combinedTapeSha256 === sha256(JSON.stringify(throughJ3)), "J3 ancestry hash changed");
  expect(j4.base.frames === throughJ3.length, "J4 no longer starts at the J3 terminal");
  expect(j4.base.tapeSha256 === j3.combinedTapeSha256, "J4 parent tape hash changed");
  expect(chapter.frame <= throughJ3.length, "radio-broadcast chapter starts after J3");
  expect(chapter.timelineFrame === chapter.frame, "radio-broadcast global frame changed");
  expect(chapter.map === "spyder_radiotower", "radio-broadcast map changed");

  const parentTail = throughJ3.slice(chapter.frame);
  const masks = [...parentTail, ...j4.masks];
  const offset = parentTail.length;
  expect(offset === 23, `expected 23 J3 tail frames, got ${offset}`);
  expect(j4.frames === j4.masks.length, "J4 frame count changed");
  expect(masks.length === offset + j4.frames, "continuation frame count changed");
  const maps = [
    { frame: 0, map: chapter.map },
    ...j4.maps
      .filter((mark) => mark.frame >= 0)
      .map((mark) => ({ frame: offset + mark.frame, map: mark.map })),
  ];
  const battles = j4.battles.map((battle) => ({
    ...battle,
    startFrame: offset + battle.startFrame,
    endFrame: offset + battle.endFrame,
  }));
  return {
    format: "pocket-tuxemon/j4-quickjs/v1",
    worldTraversal,
    hz: 60,
    startChapter: "radio-broadcast",
    frames: masks.length,
    masks,
    maps,
    battles,
    terminalStateSha256: j4.terminalStateSha256,
    tapeSha256: sha256(JSON.stringify(masks)),
  };
}

if (import.meta.main) {
  const output = process.argv[2];
  if (!output) throw new Error("usage: bun tools/j4-quickjs-tape.ts <output.json>");
  const tape = buildJ4QuickjsTape();
  writeFileSync(resolve(output), JSON.stringify(tape) + "\n");
  console.log(`J4 QUICKJS TAPE frames=${tape.frames} battles=${tape.battles.length} ` +
    `state=${tape.terminalStateSha256}`);
}

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { J3JourneyResult } from "../tools/j3-journey.ts";
import type { J4JourneyResult } from "../tools/j4-journey.ts";
import { readInlineProject } from "../tools/generated-project.ts";

const ROOT = resolve(import.meta.dir, "..");
const j3 = JSON.parse(readFileSync(
  resolve(ROOT, "data/j3-omnichannelradioannounce-journey.json"),
  "utf8",
)) as J3JourneyResult;
const j4 = JSON.parse(readFileSync(
  resolve(ROOT, "data/j4-kernelquestdone-journey.json"),
  "utf8",
)) as J4JourneyResult;
const project = readInlineProject(ROOT);

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

function importedEventText(mapId: string, eventId: string): string {
  const map = project.maps.find((candidate) => candidate.id === mapId);
  const event = map?.events?.find((candidate) => candidate.id === eventId);
  if (!event) throw new Error(`missing imported event ${mapId}/${eventId}`);
  return JSON.stringify(event);
}

test("J4 is an input-only continuation of the exact J3 broadcast state", () => {
  expect(j4.format).toBe("pocket-tuxemon/j4-kernelquestdone/v1");
  expect(j4.worldTraversal).toBe("seamless-v1");
  expect(j4.base.worldTraversal).toBe("seamless-v1");
  expect(j4.hz).toBe(60);
  expect(j4.frames).toBe(j4.masks.length);
  expect(j4.tapeSha256).toBe(sha256(JSON.stringify(j4.masks)));
  expect(j4.masks.every((mask) => Number.isInteger(mask) && mask >= 0 && mask <= 0xffff)).toBeTrue();

  expect(j4.base).toMatchObject({
    format: j3.format,
    frames: j3.combinedFrames,
    tapeSha256: j3.combinedTapeSha256,
    terminalStateSha256: j3.terminalStateSha256,
    heldMask: 0,
    timelineFrame: j3.combinedFrames,
    map: "spyder_radiotower",
    position: [9, 5],
  });
  expect(j4.initialStateSha256).toBe(j3.terminalStateSha256);
  expect(j4.combinedFrames).toBe(j3.combinedFrames + j4.frames);
  expect(j4.combinedTapeSha256).toBe(
    sha256(JSON.stringify([
      ...JSON.parse(readFileSync(resolve(ROOT, "data/gb6-mainline-journey.json"), "utf8")).masks,
      ...JSON.parse(readFileSync(resolve(ROOT, "data/j1-captainreturns-journey.json"), "utf8")).masks,
      ...JSON.parse(readFileSync(resolve(ROOT, "data/j2-hospitalcure-journey.json"), "utf8")).masks,
      ...j3.masks,
      ...j4.masks,
    ])),
  );
});

test("J4 freezes the authored route, story stages, and complete Kernel epilogue", () => {
  expect(j4.steps.map((step) => step.name)).toEqual([
    "radio-broadcast",
    "network-outage",
    "kernel-briefing",
    "surfboard-collected",
    "route-b-entry",
    "datacenter-entry",
    "datacenter-lower-screens",
    "datacenter-middle-screens",
    "datacenter-upper-screens",
    "kernel-defeated",
  ]);
  expect(j4.steps.map((step) => step.frame)).toEqual([
    -1, 1226, 1870, 3239, 5418, 8930, 9100, 10764, 12464, 13386,
  ]);
  expect(j4.steps[0]).toMatchObject({
    map: "spyder_radiotower",
    position: [9, 5],
    kernelQuest: 2,
    omnichannelRadioAnnounce: 1,
    surfboard: 0,
  });
  expect(j4.steps.find((step) => step.name === "surfboard-collected")).toMatchObject({
    map: "spyder_candy_town",
    timberMom: 1,
    surfboard: 1,
  });
  expect(j4).toMatchObject({
    map: "spyder_datacenter",
    position: [7, 4],
    story: {
      kernelQuest: 1,
      omnichannelRadioAnnounce: 1,
      bumpIntoMom: 1,
      kernelQuestBegin: 1,
      timberMom: 1,
      routeBBillie: 1,
      dataScreen1: 1,
      dataScreen2: 1,
      dataScreen3: 1,
      dataScreen4: 1,
      dataScreen5: 1,
      dataScreen6: 1,
      dataScreen7: 1,
      dataCenterBillie: 1,
      spyderPass: 1,
      surfboard: 1,
      swimming: 1,
      goldPass: 0,
      beaverbrookWon: true,
      kernelWon: true,
    },
  });

  const maps = j4.maps.map((mark) => mark.map);
  for (const map of [
    "spyder_radiotower",
    "spyder_healing_center",
    "spyder_cotton_town",
    "spyder_candy_port",
    "spyder_candy_town",
    "spyder_timber_town",
    "spyder_routee",
    "spyder_routeb",
    "spyder_datacenter",
  ]) {
    expect(maps).toContain(map);
  }

  expect(importedEventText("spyder_healing_center", "npc_spyder_cottoncenter_ada"))
    .toContain("The computer system is experiencing technical");
  expect(importedEventText("spyder_cotton_town", "e037_kernel_quest_r011"))
    .toContain("Omnichannel seems to have pulled the plug on the");
  expect(importedEventText("spyder_candy_town", "npc_spyder_papertown_mom"))
    .toContain("Great job, sweetie! Here's a Surfboard");
  expect(importedEventText("spyder_datacenter", "e047_billie"))
    .toContain("You know, you're making quite a habit of saving the");
});

test("J4 wins every required fight and no wrong-answer Blasdoor", () => {
  expect(j4.battles).toHaveLength(14);
  expect(j4.battles.every((battle) => battle.outcome === "won")).toBeTrue();
  expect(j4.battles.filter((battle) => battle.kind === "trainer")).toHaveLength(12);
  expect(j4.battles.filter((battle) => battle.kind === "wild")).toHaveLength(2);
  expect(j4.battles.filter((battle) => battle.kind === "trainer").map((battle) => battle.opponent))
    .toEqual([
      "spyder_routee_calliope",
      "spyder_routee_aiolos",
      "spyder_routeb_electra",
      "spyder_routeb_cytherea",
      "spyder_routeb_nephthys",
      "spyder_routeb_sedna",
      "spyder_routeb_calypso",
      "spyder_datacenter_fermi",
      "spyder_datacenter_onnes",
      "spyder_datacenter_lagrange",
      "spyder_datacenter_bayliss",
      "spyder_datacenter_chomsky",
    ]);
  expect(j4.battles.some((battle) => battle.opponent === "wild:blasdoor")).toBeFalse();
  expect(j4.battles.filter((battle) => battle.opponent === "wild:kernel")).toEqual([
    expect.objectContaining({
      kind: "wild",
      enemy: [{ slug: "kernel", level: 50 }],
      turns: 1,
      outcome: "won",
    }),
  ]);
  expect(j4.party[0]).toMatchObject({ slug: "arthrobolt", level: 100, hp: 470, maxHp: 470 });
});

// Focused reducer coverage for the six authored Tuxemon autosaves. The test
// reads the generated importer artifact, but deliberately does not use the
// frozen GB6/J1-J4 tapes: each imported command tail runs in a tiny autorun
// map so the command-boundary snapshot can be inspected directly.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { restoreSessionSnapshot } from "../vendor/pocket-rpgkit/src/engine/save-restore.ts";
import {
  createSession,
  startSession,
  stepSession,
  type SessionHostEffect,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type {
  Command,
  GameEvent,
  MapDef,
  Project,
} from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { readInlineProject } from "../tools/generated-project.ts";

const ROOT = resolve(import.meta.dir, "..");
const IMPORTED = readInlineProject(ROOT);
const HELD = 0x2000;
const DONE = "test.autosave.continued";

const CASES = [
  { map: "spyder_omnichannel1", event: "e008_battle_enforcer_r003", afterVariable: "v.save3" },
  { map: "spyder_paper_town", event: "e012_stop_r003", afterVariable: "v.save1" },
  { map: "spyder_route2", event: "e037_billie_encounter_win" },
  { map: "spyder_route3", event: "npc_spyder_route3_zoolander" },
  { map: "spyder_route6", event: "e036_talk_richard_r037" },
  { map: "spyder_routec", event: "e034_autosave_dragon_r035", afterVariable: "v.save2" },
] as const;

interface LocatedAutosave {
  event: GameEvent;
  /** The imported command itself and the authored commands after it in the
   * same branch. Keeping that tail is what exercises save1/save2/save3 after
   * the autosave boundary instead of replacing the importer output with a
   * hand-written approximation. */
  tail: Command[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function autosaveTails(value: unknown, out: Command[][] = []): Command[][] {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const item = value[index];
      if (isRecord(item) && item.op === "autosave") {
        out.push(value.slice(index) as Command[]);
      }
      autosaveTails(item, out);
    }
  } else if (isRecord(value)) {
    for (const child of Object.values(value)) autosaveTails(child, out);
  }
  return out;
}

function importedAutosave(mapId: string, eventId: string): LocatedAutosave {
  const map = IMPORTED.maps.find((candidate) => candidate.id === mapId);
  expect(map, `missing imported map ${mapId}`).toBeDefined();
  const matches = (map!.events ?? []).flatMap((event) =>
    autosaveTails(event).map((tail) => ({ event, tail }))
  );
  expect(matches, `${mapId} must contain exactly one authored autosave`).toHaveLength(1);
  expect(matches[0]!.event.id).toBe(eventId);
  return matches[0]!;
}

const SHEET = {
  id: "plain",
  cols: 1,
  rows: 1,
  pak: "chunks",
  defaultPassage: "pass",
} as const;

function focusedProject(mapId: string, commands: readonly Command[]): Project {
  const map: MapDef = {
    id: mapId,
    name: mapId,
    width: 3,
    height: 3,
    sheets: [SHEET.id],
    ground: new Array(9).fill("plain.0"),
    events: [{
      id: "imported-autosave",
      x: 1,
      y: 1,
      pages: [
        {
          trigger: "autorun",
          commands: [...commands, { op: "switch", id: DONE, value: true }],
        },
        {
          condition: { switch: DONE },
          trigger: "action",
          commands: [],
        },
      ],
    }],
  };
  return {
    format: "rpgkit-project/v1",
    title: `Imported autosave: ${mapId}`,
    tileSize: 16,
    start: { map: mapId, x: 0, y: 0, dir: "down" },
    sheets: [SHEET],
    items: [],
    maps: [map],
  };
}

describe("imported Tuxemon autosaves", () => {
  for (const row of CASES) {
    test(`${row.map} publishes once, yields, and resumes after the authored command`, () => {
      const imported = importedAutosave(row.map, row.event);
      expect(imported.tail[0]).toEqual({ op: "autosave" });

      const project = focusedProject(row.map, imported.tail);
      const session = createSession(project, 60);
      const effects: SessionHostEffect[] = [];
      const sink = { publish: (effect: SessionHostEffect) => effects.push(effect) };

      const atBoundary = stepSession(
        session,
        startSession(project, session),
        { buttons: HELD },
        sink,
      );
      expect(effects, `${row.map} did not publish exactly once`).toHaveLength(1);
      const effect = effects[0]!;
      expect(effect.action).toBe("autosave");
      if (effect.action !== "autosave") throw new Error(`expected autosave from ${row.map}`);

      expect(effect.snapshot).toMatchObject({ autosave: true, map: row.map, held: HELD });
      expect(effect.snapshot.interp.sw.switches[DONE]).toBeUndefined();
      expect(atBoundary.sw.switches[DONE]).toBeUndefined();
      if ("afterVariable" in row) {
        // In particular, Route C's v.save2 belongs after the autosave. The
        // snapshot must retain the old value and resume into the assignment.
        expect(effect.snapshot.interp.sw.variables[row.afterVariable]).toBeUndefined();
        expect(atBoundary.sw.variables[row.afterVariable]).toBeUndefined();
      }

      const continued = stepSession(session, atBoundary, { buttons: HELD }, sink);
      expect(continued.sw.switches[DONE]).toBe(true);
      expect(effects).toHaveLength(1);
      if ("afterVariable" in row) {
        expect(continued.sw.variables[row.afterVariable]).toBe(1);
      }

      const resumeEffects: SessionHostEffect[] = [];
      const restored = stepSession(
        session,
        restoreSessionSnapshot(session, effect.snapshot),
        { buttons: effect.snapshot.held },
        { publish: (next) => resumeEffects.push(next) },
      );
      expect(restored).toEqual(continued);
      expect(resumeEffects).toEqual([]);

      // The second, conditioned page disables the autorun permanently; extra
      // ticks must not turn one authored command into repeated host writes.
      let settled = restored;
      for (let tick = 0; tick < 3; tick++) {
        settled = stepSession(session, settled, { buttons: 0 }, sink);
      }
      expect(effects).toHaveLength(1);
    });
  }
});

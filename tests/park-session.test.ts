import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createTuxemonExtensions,
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
  tuxemonExtensionProblem,
  tuxemonExtensionState,
} from "../battle/extension.ts";
import {
  activateParkSession,
  emptyParkSession,
  parkSummary,
  recordParkCapture,
  recordParkSighting,
} from "../battle/park.ts";
import { availableMapIds, buildProject, G6_IMPORT_OPTIONS } from "../importer/project.ts";
import { validateBattleDb } from "../importer/battle-schema.ts";
import type { JsonValue } from "../vendor/pocket-rpgkit/src/engine/types.ts";

const PARK_MAPS = ["eclipse_park_entrance", "eclipse_park", "eclipse_park_south", "eclipse_park_cave"];
const TUXEMON_BATTLE_DB = validateBattleDb(JSON.parse(readFileSync(
  join(import.meta.dir, "../data/battle-db.json"),
  "utf8",
)));

function nodes(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) for (const child of value) nodes(child, out);
  else if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    out.push(object);
    for (const child of Object.values(object)) nodes(child, out);
  }
  return out;
}

function commandContext(ext: JsonValue) {
  return {
    ext,
    switches: {},
    variables: {},
    items: {},
    gold: 0,
    playerName: "Park Tester",
    random: () => { throw new Error("park activation must not consume RNG"); },
  };
}

describe("Eclipse Park session state", () => {
  test("activation preserves upstream client-lifetime statistics and summary ranking", () => {
    let session = activateParkSession(undefined);
    session = recordParkSighting(session, "pairagrim");
    session = recordParkSighting(session, "pairagrim");
    session = recordParkSighting(session, "rockitten");
    session = recordParkCapture(session, "pairagrim", false);
    session = recordParkCapture(session, "pairagrim", true);
    session = { ...session, active: false };

    expect(activateParkSession(session)).toEqual({ ...session, active: true });
    expect(parkSummary(session)).toEqual({
      uniqueSeen: 2,
      attempts: 2,
      failedAttempts: 1,
      successfulCaptures: 1,
      successRate: 0.5,
      sightings: [
        { monster: "pairagrim", count: 2 },
        { monster: "rockitten", count: 1 },
      ],
      highlights: [{ monster: "pairagrim", averageTurnsRemaining: 30 }],
    });
  });

  test("extension start/stop is sparse, saved and strictly validated", () => {
    const extensions = createTuxemonExtensions(TUXEMON_BATTLE_DB);
    const command = extensions.commands!["tux.park_experience"]!;
    const initial = extensions.initial!;
    expect(tuxemonExtensionState(initial, TUXEMON_BATTLE_DB)).not.toHaveProperty("parkSession");

    const started = command(commandContext(initial), { action: "start" })!.ext!;
    expect(tuxemonExtensionState(started, TUXEMON_BATTLE_DB).parkSession).toEqual(emptyParkSession(true));
    const stopped = command(commandContext(started), { action: "stop" })!.ext!;
    expect(tuxemonExtensionState(stopped, TUXEMON_BATTLE_DB).parkSession).toEqual(emptyParkSession(false));
    expect(tuxemonExtensionProblem(stopped, TUXEMON_BATTLE_DB)).toBeNull();
    expect(() => command(commandContext(stopped), { action: "pause" })).toThrow(/start.*stop/);

    const malformed = packTuxemonExtensionState({
      ...initialTuxemonExtensionState(),
      parkSession: { ...emptyParkSession(), failedAttempts: -1 },
    });
    expect(tuxemonExtensionProblem(malformed, TUXEMON_BATTLE_DB)).toMatch(/failedAttempts/);
  });
});

describe("real Eclipse Park import", () => {
  test("all eight authored actions lower to saved session commands and blocking summaries", () => {
    const built = buildProject(PARK_MAPS, G6_IMPORT_OPTIONS);
    const all = nodes(built.project);
    const actions = all.filter((node) => node.op === "ext" && node.call === "tux.park_experience");
    expect(actions.map((node) => node.args)).toEqual([
      { action: "start" },
      { action: "stop" },
      { action: "stop" },
      { action: "stop" },
      { action: "stop" },
      { action: "stop" },
      { action: "stop" },
      { action: "stop" },
    ]);
    expect(all.filter((node) => node.op === "scene" && node.id === "tux.parkSummary")).toHaveLength(7);
    const row = built.report.coverage.actions.rows.find((entry) => entry.type === "park_experience");
    expect(row).toMatchObject({ total: 8, native: 8, degraded: 0, placeholder: 0, dropped: 0 });
  });

  test("the whole corpus keeps park_experience Native", () => {
    const full = buildProject(availableMapIds(), G6_IMPORT_OPTIONS);
    expect(full.report.coverage.actions.rows.find((entry) => entry.type === "park_experience"))
      .toMatchObject({ total: 8, native: 8, degraded: 0, placeholder: 0, dropped: 0 });
  });
});

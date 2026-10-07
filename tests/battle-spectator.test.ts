import { describe, expect, test } from "bun:test";
import battleDbJson from "../data/battle-db.json";

import {
  createTuxemonExtensions,
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
  tuxemonExtensionState,
} from "../battle/extension.ts";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import {
  createTuxemonBattleRules,
  tuxemonRuntimeBattleState,
  type SpectatorBattleSetup,
  type VariableEnums,
} from "../battle/runtime.ts";
import { spawnMonster } from "../battle/spawn.ts";
import { validateBattleDb } from "../importer/battle-schema.ts";
import type { BattleCompletion, BattleRules } from "../vendor/pocket-rpgkit/src/engine/battle.ts";
import type { JsonValue } from "../vendor/pocket-rpgkit/src/engine/types.ts";

const DB = validateBattleDb(battleDbJson);

const ENUMS: VariableEnums = {
  battle_last_result: ["draw", "lost", "won", "run", "captured"],
  battle_last_trainer: ["cam", "zeke"],
  battle_last_winner: ["cam", "zeke"],
  battle_last_loser: ["cam", "zeke"],
};

const CODES = {
  fighterWinnerCode: 11,
  foeWinnerCode: 22,
  fighterLoserCode: 33,
  foeLoserCode: 44,
  fighterTrainerCode: 55,
  foeTrainerCode: 66,
  drawCode: 77,
};

const member = (slug: string, level: number, iid: string) => ({
  iid,
  slug,
  level,
  experienceModifier: 1,
  moneyModifier: 0,
});

function json(value: unknown): JsonValue {
  return value as JsonValue;
}

/** Drive a spectator battle to completion by stepping with no player input
 *  (the auto-advance makes all AI decisions). Returns the completion. */
function driveSpectator(
  rules: BattleRules,
  started: NonNullable<ReturnType<BattleRules["start"]>>,
  ticks = 15,
): { completion: BattleCompletion; finalState: ReturnType<typeof tuxemonRuntimeBattleState> } {
  let value = started.state;
  for (let guard = 0; guard < 50_000; guard++) {
    const state = tuxemonRuntimeBattleState(value);
    const completion = rules.done(value);
    if (completion) return { completion, finalState: state };
    value = rules.step(value, { buttons: 0 }, ticks);
  }
  throw new Error("spectator battle did not finish");
}

function startSpectator(
  rules: BattleRules,
  fighter: string,
  foe: string,
  fighterParty: ReturnType<typeof member>[],
  foeParty: ReturnType<typeof member>[],
  seed: number,
) {
  const ext = {
    ...initialTuxemonExtensionState(),
    environment: "grass",
    npcParties: { [fighter]: fighterParty, [foe]: foeParty },
  };
  const setup: SpectatorBattleSetup = {
    kind: "spectate",
    fighter,
    foe,
    ...CODES,
    environment: "grass",
    hour: 12,
  };
  const extValue = json(ext);
  const started = rules.start(extValue, json(setup), seed, {
    ext: extValue,
    switches: {},
    variables: {},
    items: {},
    gold: 0,
    playerName: "Player",
  });
  if (!started) throw new Error("spectator battle failed to start");
  return started;
}

describe("Spectator (NPC-versus-NPC) battle", () => {
  test("auto-advances to completion with no player input", () => {
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const started = startSpectator(
      rules,
      "cam",
      "zeke",
      [member("lambert", 8, "txmn-000001")],
      [member("agnidon", 32, "txmn-000002")],
      0x12345678,
    );
    const state = tuxemonRuntimeBattleState(started.state);
    expect(state.spectator).toBeDefined();
    expect(state.spectator!.fighter).toBe("cam");
    expect(state.spectator!.foe).toBe("zeke");
    expect(state.spectator!.speed).toBe(1);
    const { completion } = driveSpectator(rules, started);
    expect(completion.result).toBe("lose"); // Lambert (fighter) loses to Agnidon
  });

  test("writes the same result variables as the headless npc_battle resolver", () => {
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const started = startSpectator(
      rules,
      "cam",
      "zeke",
      [member("lambert", 8, "txmn-000001")],
      [member("agnidon", 32, "txmn-000002")],
      0x12345678,
    );
    const { completion } = driveSpectator(rules, started);
    // The headless resolver (tux.npc_battle) writes winner=foe(22),
    // loser=fighter(33), trainer=loser(55) for this matchup.
    expect(completion.writes).toEqual({
      "v.battle_last_winner": 22,
      "v.battle_last_loser": 33,
      "v.battle_last_trainer": 55,
    });
  });

  test("is deterministic for a fixed seed", () => {
    const rules1 = createTuxemonBattleRules(DB, ENUMS);
    const rules2 = createTuxemonBattleRules(DB, ENUMS);
    const started1 = startSpectator(
      rules1,
      "cam",
      "zeke",
      [member("lambert", 8, "txmn-000001")],
      [member("agnidon", 32, "txmn-000002")],
      0x12345678,
    );
    const started2 = startSpectator(
      rules2,
      "cam",
      "zeke",
      [member("lambert", 8, "txmn-000001")],
      [member("agnidon", 32, "txmn-000002")],
      0x12345678,
    );
    const { completion: c1 } = driveSpectator(rules1, started1);
    const { completion: c2 } = driveSpectator(rules2, started2);
    expect(c1.writes).toEqual(c2.writes);
    expect(c1.result).toBe(c2.result);
  });

  test("produces the same outcome as the headless tux.npc_battle command", () => {
    // Run the headless resolver with the same seed and parties.
    const npcBattle = createTuxemonExtensions(DB).commands!["tux.npc_battle"]!;
    const ext = packTuxemonExtensionState({
      ...initialTuxemonExtensionState(),
      environment: "grass",
      npcParties: {
        cam: [member("lambert", 8, "txmn-000001")],
        zeke: [member("agnidon", 32, "txmn-000002")],
      },
    });
    let cursor = 0x12345678;
    const random = () => {
      cursor = (cursor * 1664525 + 1013904223) >>> 0;
      return cursor / 0x100000000;
    };
    const headless = npcBattle(
      { ext, variables: {}, switches: {}, items: {}, gold: 0, playerName: "", random } as never,
      { fighter: "cam", foe: "zeke", ...CODES },
    ) as { writes?: Record<string, number> };

    // Run the spectator battle with the same seed.
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const started = startSpectator(
      rules,
      "cam",
      "zeke",
      [member("lambert", 8, "txmn-000001")],
      [member("agnidon", 32, "txmn-000002")],
      0x12345678,
    );
    const { completion } = driveSpectator(rules, started);
    expect(completion.writes).toEqual(headless.writes);
  });

  test("confirmEdge cycles the presentation speed 1→2→4→1", () => {
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const started = startSpectator(
      rules,
      "cam",
      "zeke",
      [member("lambert", 8, "txmn-000001")],
      [member("agnidon", 32, "txmn-000002")],
      0x12345678,
    );
    let value = started.state;
    const step = (input: Parameters<BattleRules["step"]>[1]) => {
      value = rules.step(value, input, 1);
      return tuxemonRuntimeBattleState(value);
    };
    // No opening grace: a confirm edge on the first frame toggles the speed.
    expect(step({ buttons: 0, confirmEdge: true }).spectator!.speed).toBe(2);
    expect(step({ buttons: 0, confirmEdge: true }).spectator!.speed).toBe(4);
    expect(step({ buttons: 0, confirmEdge: true }).spectator!.speed).toBe(1);
  });

  test("cancelEdge on the opening frame skips to the result by design", () => {
    // The r2 review found the grace window masked confirm only; cancel during
    // the same window skipped the battle immediately. With the grace removed,
    // cancel at the opening is a real player input that skips to the result —
    // the documented spectator behaviour. Assert it explicitly so a future
    // input-ownership change cannot silently alter it.
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const started = startSpectator(
      rules,
      "cam",
      "zeke",
      [member("lambert", 8, "txmn-000001")],
      [member("agnidon", 32, "txmn-000002")],
      0x12345678,
    );
    const opening = tuxemonRuntimeBattleState(started.state);
    expect(opening.battle.phase).not.toBe("ended");
    const skipped = tuxemonRuntimeBattleState(
      rules.step(started.state, { buttons: 0, cancelEdge: true }, 1),
    );
    expect(skipped.battle.phase).toBe("ended");
    expect(skipped.eventCursor).toBe(skipped.battle.events.length);
  });

  test("cancelEdge skips the remaining decisions and completes", () => {
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const started = startSpectator(
      rules,
      "cam",
      "zeke",
      [member("lambert", 8, "txmn-000001")],
      [member("agnidon", 32, "txmn-000002")],
      0x12345678,
    );
    let value = started.state;
    // Advance a few frames so the battle is in-flight.
    for (let i = 0; i < 3; i++) value = rules.step(value, { buttons: 0 }, 1);
    const before = tuxemonRuntimeBattleState(value);
    expect(before.battle.phase).not.toBe("ended");
    // Skip.
    value = rules.step(value, { buttons: 0, cancelEdge: true }, 1);
    const after = tuxemonRuntimeBattleState(value);
    expect(after.battle.phase).toBe("ended");
    expect(after.eventCursor).toBe(after.battle.events.length);
    // The completion should be available immediately or after one more
    // presentation step (the end beat).
    let completion = rules.done(value);
    if (!completion) {
      value = rules.step(value, { buttons: 0 }, 15);
      completion = rules.done(value);
    }
    expect(completion).not.toBeNull();
    expect(completion!.writes).toEqual({
      "v.battle_last_winner": 22,
      "v.battle_last_loser": 33,
      "v.battle_last_trainer": 55,
    });
  });

  test("does not start when a party is missing or empty", () => {
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const ext = {
      ...initialTuxemonExtensionState(),
      environment: "grass",
      npcParties: { cam: [member("lambert", 8, "txmn-000001")] },
    };
    const setup: SpectatorBattleSetup = {
      kind: "spectate",
      fighter: "cam",
      foe: "zeke",
      ...CODES,
      environment: "grass",
      hour: 12,
    };
    const extValue = json(ext);
    const started = rules.start(extValue, json(setup), 42, {
      ext: extValue,
      switches: {},
      variables: {},
      items: {},
      gold: 0,
      playerName: "Player",
    });
    expect(started).toBeNull();
  });

  test("pushes the fighter/foe win-loss history pair", () => {
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const started = startSpectator(
      rules,
      "cam",
      "zeke",
      [member("lambert", 8, "txmn-000001")],
      [member("agnidon", 32, "txmn-000002")],
      0x12345678,
    );
    const { completion } = driveSpectator(rules, started);
    const ext = tuxemonExtensionState(completion.ext, DB);
    expect(ext.history).toContainEqual({ fighter: "zeke", opponent: "cam", outcome: "won" });
    expect(ext.history).toContainEqual({ fighter: "cam", opponent: "zeke", outcome: "lost" });
  });

  test("leaves the player's party and wallet untouched", () => {
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const RULE_DB = battleDbToTuxemonBattleDb(DB);
    const playerMonster = spawnMonster(DB, RULE_DB, { rng: 1, rngDraws: 0 }, "nut", 20, {
      iid: "txmn-player",
    });
    const ext = {
      ...initialTuxemonExtensionState(),
      environment: "grass",
      party: [playerMonster],
      npcParties: {
        cam: [member("lambert", 8, "txmn-000001")],
        zeke: [member("agnidon", 32, "txmn-000002")],
      },
    };
    const setup: SpectatorBattleSetup = {
      kind: "spectate",
      fighter: "cam",
      foe: "zeke",
      ...CODES,
      environment: "grass",
      hour: 12,
    };
    const extValue = json(ext);
    const started = rules.start(extValue, json(setup), 0x12345678, {
      ext: extValue,
      switches: {},
      variables: {},
      items: {},
      gold: 500,
      playerName: "Player",
    });
    if (!started) throw new Error("spectator battle failed to start");
    const { completion } = driveSpectator(rules, started);
    expect(completion.gold).toBeUndefined();
    const afterExt = tuxemonExtensionState(completion.ext, DB);
    expect(afterExt.party).toHaveLength(1);
    expect(afterExt.party[0]!.slug).toBe("nut");
    expect(afterExt.party[0]!.currentHp).toBe(playerMonster.currentHp);
  });
});

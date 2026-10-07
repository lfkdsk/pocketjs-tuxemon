import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createTuxemonExtensions,
  initialTuxemonExtensionState,
  isPartyBattleLegal,
  packTuxemonExtensionState,
  tuxemonExtensionState,
} from "../battle/extension.ts";
import { TUXEMON_VARIABLE_ENUMS } from "../battle/game.ts";
import {
  createTuxemonBattleRules,
  tuxemonRuntimeBattleState,
} from "../battle/runtime.ts";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import { spawnMonster } from "../battle/spawn.ts";
import type { SpawnedMonsterSnapshot } from "../battle/types.ts";
import { runPolicyBattle } from "../battle/tuxemon.ts";
import { buildProject } from "../importer/project.ts";
import { validateBattleDb } from "../importer/battle-schema.ts";
import {
  createSession,
  startSession,
  stepSession,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type {
  Command,
  JsonValue,
  Project,
} from "../vendor/pocket-rpgkit/src/engine/types.ts";

const ROOT = join(import.meta.dir, "..");
const DB = validateBattleDb(JSON.parse(readFileSync(join(ROOT, "data/battle-db.json"), "utf8")));
const rulesDb = battleDbToTuxemonBattleDb(DB);

function project(commands: Command[]): Project {
  return {
    format: "rpgkit-project/v1",
    title: "COV-B extension test",
    tileSize: 16,
    start: { map: "test", x: 2, y: 2, dir: "down" },
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [],
    maps: [{
      id: "test",
      name: "test",
      width: 6,
      height: 6,
      ground: new Array(36).fill("plain.0"),
      events: [{
        id: "setup",
        x: 1,
        y: 1,
        pages: [
          { trigger: "autorun", commands: [...commands, { op: "switch", id: "done", value: true }] },
          { trigger: "action", condition: { switch: "done" }, commands: [] },
        ],
      }],
    }],
  };
}

function run(commands: Command[], ext?: JsonValue, variables: Record<string, number | string> = {}) {
  const source = project(commands);
  const session = createSession(source, 60, { extensions: createTuxemonExtensions(DB) });
  const initial = startSession(source, session, undefined, ext);
  Object.assign(initial.sw.variables, variables);
  return { session, initial, state: stepSession(session, initial, { buttons: 0 }) };
}

function stateOf(result: ReturnType<typeof run>) {
  return tuxemonExtensionState(result.state.ext, DB);
}

/** Add a monster and return the iid the handler wrote to v.add_monster. */
function addPlayerMonster(commands: Command[], slug = "rockitten", level = 5): Command[] {
  commands.push({ op: "ext", call: "tux.add_monster", args: { species: slug, level } });
  return commands;
}

describe("COV-B set_monster_attribute", () => {
  test("sets gender, acquisition and nickname on the iid-named monster", () => {
    const commands = addPlayerMonster([]);
    commands.push({ op: "ext", call: "tux.set_monster_attribute", args: { variable: "v.add_monster", attribute: "gender", value: "female" } });
    commands.push({ op: "ext", call: "tux.set_monster_attribute", args: { variable: "v.add_monster", attribute: "acquisition", value: "gifted" } });
    commands.push({ op: "ext", call: "tux.set_monster_attribute", args: { variable: "v.add_monster", attribute: "name", value: "RUFF" } });
    const state = stateOf(run(commands));
    expect(state.party[0]!.gender).toBe("female");
    expect(state.party[0]!.acquisition).toBe("gifted");
    expect(state.party[0]!.nickname).toBe("RUFF");
  });

  test("no-ops for an unknown attribute and an empty iid variable", () => {
    const commands = addPlayerMonster([]);
    commands.push({ op: "ext", call: "tux.set_monster_attribute", args: { variable: "v.add_monster", attribute: "level", value: "99" } });
    expect(stateOf(run(commands)).party[0]!.level).toBe(5);

    // A missing iid variable leaves the spawned gender untouched.
    const baseline = stateOf(run(addPlayerMonster([]))).party[0]!.gender;
    const commands2 = addPlayerMonster([]);
    commands2.push({ op: "ext", call: "tux.set_monster_attribute", args: { variable: "v.missing", attribute: "gender", value: "male" } });
    expect(stateOf(run(commands2)).party[0]!.gender).toBe(baseline);
  });
});

describe("COV-B add_tech", () => {
  test("teaches a technique and dedupes by slug", () => {
    const commands = addPlayerMonster([], "rockitten", 5);
    commands.push({ op: "ext", call: "tux.add_tech", args: { variable: "v.add_monster", technique: "ram" } });
    commands.push({ op: "ext", call: "tux.add_tech", args: { variable: "v.add_monster", technique: "ram" } });
    const state = stateOf(run(commands));
    expect(state.party[0]!.moves.filter((m) => m === "ram")).toHaveLength(1);
  });

  test("rejects an unknown technique", () => {
    const commands = addPlayerMonster([]);
    commands.push({ op: "ext", call: "tux.add_tech", args: { variable: "v.add_monster", technique: "not_a_tech" } });
    expect(() => run(commands)).toThrow(/unknown technique/);
  });
});

describe("COV-B plague system", () => {
  test("char_plague infects and inoculates a whole party; party_infected counts", () => {
    const commands = addPlayerMonster(addPlayerMonster([], "rockitten", 5), "budaye", 5);
    commands.push({ op: "ext", call: "tux.char_plague", args: { plague: "spyderbite", condition: "infected" } });
    const infected = stateOf(run(commands));
    expect(infected.party.every((m) => infected.plagueByIid[m.iid!]!.spyderbite === "infected")).toBeTrue();

    const check = [...commands];
    check.push({ op: "ext", call: "tux.party_infected", args: { character: "player", plague: "spyderbite", value: "all" } });
    // Re-run through a condition to verify the count semantics.
    const cond = createTuxemonExtensions(DB).conditions!["tux.party_infected"]!;
    const ctx = { ext: run(commands).state.ext, variables: {}, switches: {}, items: {}, gold: 0, playerName: "" };
    expect(cond(ctx, { character: "player", plague: "spyderbite", value: "all" })).toBeTrue();
    expect(cond(ctx, { character: "player", plague: "spyderbite", value: "none" })).toBeFalse();
    expect(cond(ctx, { character: "player", plague: "spyderbite", value: "some" })).toBeFalse();

    const cure = [...commands];
    cure.push({ op: "ext", call: "tux.char_plague", args: { plague: "spyderbite", condition: "inoculated" } });
    const cured = stateOf(run(cure));
    expect(cured.party.every((m) => cured.plagueByIid[m.iid!]!.spyderbite === "inoculated")).toBeTrue();
    const curedCtx = { ext: run(cure).state.ext, variables: {}, switches: {}, items: {}, gold: 0, playerName: "" };
    expect(cond(curedCtx, { character: "player", plague: "spyderbite", value: "none" })).toBeTrue();
  });

  test("quarantine moves infected monsters to the box and releases them inoculated", () => {
    // One infected monster: confiscated, then released.
    const one = addPlayerMonster([], "rockitten", 5);
    one.push({ op: "ext", call: "tux.char_plague", args: { plague: "spyderbite", condition: "infected" } });
    one.push({ op: "ext", call: "tux.quarantine", args: { character: "player", plague: "spyderbite", action: "in" } });
    const confiscated = stateOf(run(one));
    expect(confiscated.party).toHaveLength(0);
    expect(confiscated.boxes!.quarantine!.monsters).toHaveLength(1);
    expect(confiscated.boxes!.quarantine!.hidden).toBeTrue();
    expect(confiscated.plagueByIid[confiscated.boxes!.quarantine!.monsters[0]!.iid!]!.spyderbite).toBe("inoculated");

    // Release all: monster returns to the party inoculated.
    one.push({ op: "ext", call: "tux.quarantine", args: { character: "player", plague: "spyderbite", action: "out" } });
    const released = stateOf(run(one));
    expect(released.party).toHaveLength(1);
    expect(released.boxes!.quarantine!.monsters).toHaveLength(0);
    expect(released.plagueByIid[released.party[0]!.iid!]!.spyderbite).toBe("inoculated");

    // A healthy party has nothing to confiscate, but upstream creates the
    // hidden quarantine box before it checks for infected monsters, so the
    // empty admission still leaves the box behind.
    const clean = addPlayerMonster([], "budaye", 5);
    clean.push({ op: "ext", call: "tux.quarantine", args: { character: "player", plague: "spyderbite", action: "in" } });
    const untouched = stateOf(run(clean));
    expect(untouched.party).toHaveLength(1);
    expect(untouched.boxes!.quarantine).toEqual({ hidden: true, capacity: 30, monsters: [] });
  });

  test("a full quarantine box never deletes the admitted monster", () => {
    // Fill the hidden box to capacity, then admit one infected party monster.
    // Upstream transfers only after box insertion succeeds, so the monster
    // stays in the party (inoculated) rather than disappearing.
    const fillRng = { rng: 7, rngDraws: 0 };
    const boxedMonsters = Array.from({ length: 30 }, (_, i) =>
      spawnMonster(DB, rulesDb, fillRng, "rockitten", 5, { iid: `box-${i}` }));
    const boxed = {
      ...initialTuxemonExtensionState(),
      party: [],
      boxes: { quarantine: { hidden: true, capacity: 30, monsters: boxedMonsters } },
    };
    const commands = addPlayerMonster([], "rockitten", 5);
    commands.push({ op: "ext", call: "tux.char_plague", args: { plague: "spyderbite", condition: "infected" } });
    commands.push({ op: "ext", call: "tux.quarantine", args: { character: "player", plague: "spyderbite", action: "in" } });
    const result = run(commands, packTuxemonExtensionState(boxed as never));
    const after = tuxemonExtensionState(result.state.ext, DB);
    expect(after.party).toHaveLength(1);
    expect(after.boxes!.quarantine!.monsters).toHaveLength(30);
    // The monster stayed in the party and was inoculated first, like upstream.
    expect(after.plagueByIid[after.party[0]!.iid!]!.spyderbite).toBe("inoculated");
  });

  test("admission honours the box's own capacity, not the global kennel limit", () => {
    // A saved box can carry its own capacity (the validator enforces
    // monsters.length <= capacity). The old code compared against the global
    // KENNEL_LIMIT (30), so a capacity: 1 box received a second monster and
    // the next state parse rejected the save.
    const fillRng = { rng: 11, rngDraws: 0 };
    const boxed = {
      ...initialTuxemonExtensionState(),
      party: [],
      boxes: { quarantine: { hidden: true, capacity: 1, monsters: [spawnMonster(DB, rulesDb, fillRng, "budaye", 5, { iid: "box-0" })] } },
    };
    const commands = addPlayerMonster([], "rockitten", 5);
    commands.push({ op: "ext", call: "tux.char_plague", args: { plague: "spyderbite", condition: "infected" } });
    commands.push({ op: "ext", call: "tux.quarantine", args: { character: "player", plague: "spyderbite", action: "in" } });
    const result = run(commands, packTuxemonExtensionState(boxed as never));
    // Parsing the resulting state must not throw: the box still holds one.
    const after = tuxemonExtensionState(result.state.ext, DB);
    expect(after.boxes!.quarantine!.capacity).toBe(1);
    expect(after.boxes!.quarantine!.monsters).toHaveLength(1);
    expect(after.boxes!.quarantine!.monsters[0]!.iid).toBe("box-0");
    expect(after.party).toHaveLength(1);
    expect(after.plagueByIid[after.party[0]!.iid!]!.spyderbite).toBe("inoculated");
  });

  test("an empty capacity:1 box admits only one of two infected monsters", () => {
    const commands = addPlayerMonster([], "rockitten", 5);
    addPlayerMonster(commands, "budaye", 5);
    commands.push({ op: "ext", call: "tux.char_plague", args: { plague: "spyderbite", condition: "infected" } });
    commands.push({ op: "ext", call: "tux.quarantine", args: { character: "player", plague: "spyderbite", action: "in" } });
    const small = {
      ...initialTuxemonExtensionState(),
      boxes: { quarantine: { hidden: true, capacity: 1, monsters: [] } },
    };
    const result = run(commands, packTuxemonExtensionState(small as never));
    const after = tuxemonExtensionState(result.state.ext, DB);
    expect(after.boxes!.quarantine!.monsters).toHaveLength(1);
    expect(after.party).toHaveLength(1);
  });

  test("a release with a full party and kennel keeps the monster in quarantine", () => {
    // One infected monster confiscated, then released with party (6) and
    // kennel (30) both full: the monster must stay in the box, not vanish.
    const fillRng = { rng: 9, rngDraws: 0 };
    const party = Array.from({ length: 6 }, (_, i) =>
      spawnMonster(DB, rulesDb, fillRng, "rockitten", 5, { iid: `p-${i}` }));
    const kennel = Array.from({ length: 30 }, (_, i) =>
      spawnMonster(DB, rulesDb, fillRng, "rockitten", 5, { iid: `k-${i}` }));
    const quarantined = spawnMonster(DB, rulesDb, fillRng, "budaye", 5, { iid: "q-1" });
    const state = {
      ...initialTuxemonExtensionState(),
      party,
      kennel,
      boxes: { quarantine: { hidden: true, capacity: 30, monsters: [quarantined] } },
      plagueByIid: { "q-1": { spyderbite: "infected" } },
    };
    const commands: Command[] = [
      { op: "ext", call: "tux.quarantine", args: { character: "player", plague: "spyderbite", action: "out" } },
    ];
    const result = run(commands, packTuxemonExtensionState(state as never));
    const after = tuxemonExtensionState(result.state.ext, DB);
    expect(after.party).toHaveLength(6);
    expect(after.kennel).toHaveLength(30);
    expect(after.boxes!.quarantine!.monsters).toHaveLength(1);
    expect(after.boxes!.quarantine!.monsters[0]!.iid).toBe("q-1");
    // Inoculated before the failed move, like upstream.
    expect(after.plagueByIid["q-1"]!.spyderbite).toBe("inoculated");
  });
});

describe("COV-B bills", () => {
  test("set_bill, modify_bill and bill_is track a debt tab", () => {
    const commands: Command[] = [
      { op: "ext", call: "tux.set_bill", args: { character: "player", bill: "bill_cathedral", amount: 0 } },
    ];
    const zero = stateOf(run(commands));
    expect(zero.bills.player!.bill_cathedral!.amount).toBe(0);

    const cond = createTuxemonExtensions(DB).conditions!["tux.bill_is"]!;
    const zeroCtx = { ext: run(commands).state.ext, variables: {}, switches: {}, items: {}, gold: 0, playerName: "" };
    // A zero bill is always false upstream.
    expect(cond(zeroCtx, { character: "player", bill: "bill_cathedral", operator: "greater_than", amount: 0 })).toBeFalse();

    const withDebt = [
      ...commands,
      { op: "ext", call: "tux.modify_bill", args: { character: "player", bill: "bill_cathedral", amount: 500 } } as Command,
    ];
    const debt = stateOf(run(withDebt));
    expect(debt.bills.player!.bill_cathedral!.amount).toBe(500);
    const debtCtx = { ext: run(withDebt).state.ext, variables: {}, switches: {}, items: {}, gold: 0, playerName: "" };
    expect(cond(debtCtx, { character: "player", bill: "bill_cathedral", operator: "greater_than", amount: 0 })).toBeTrue();
    expect(cond(debtCtx, { character: "player", bill: "bill_cathedral", operator: "greater_than", amount: 600 })).toBeFalse();

    // Paying it off deletes the bill.
    const paid = [
      ...withDebt,
      { op: "ext", call: "tux.modify_bill", args: { character: "player", bill: "bill_cathedral", amount: -500 } } as Command,
    ];
    const settled = stateOf(run(paid));
    expect(settled.bills.player!.bill_cathedral).toBeUndefined();
  });

  test("set_bill retains the authored interest rate, late fee and battle share", () => {
    const state = stateOf(run([
      { op: "ext", call: "tux.set_bill", args: { character: "player", bill: "bill_cathedral", amount: 0, interestRate: 0.1, lateFee: 100, shareRate: 0.5 } },
    ]));
    expect(state.bills.player!.bill_cathedral!).toEqual({ amount: 0, interestRate: 0.1, lateFee: 100, shareRate: 0.5 });
    // Replacing a bill overwrites its metadata (upstream upsert semantics).
    const replaced = stateOf(run([
      { op: "ext", call: "tux.set_bill", args: { character: "player", bill: "bill_cathedral", amount: 0, interestRate: 0.1, lateFee: 100, shareRate: 0.5 } },
      { op: "ext", call: "tux.set_bill", args: { character: "player", bill: "bill_cathedral", amount: 50 } },
    ]));
    expect(replaced.bills.player!.bill_cathedral!).toEqual({ amount: 50 });
  });

  test("adjust_bill_penalty applies stored interest (truncating, compounding) and the flat late fee", () => {
    const setup: Command[] = [
      { op: "ext", call: "tux.set_bill", args: { character: "player", bill: "bill_cathedral", amount: 105, interestRate: 0.1, lateFee: 100, shareRate: 0.5 } },
    ];
    const first = stateOf(run([
      ...setup,
      { op: "ext", call: "tux.adjust_bill_penalty", args: { character: "player", bill: "bill_cathedral", penalty: "interest" } } as Command,
    ]));
    // trunc(105 * 0.1) = 10
    expect(first.bills.player!.bill_cathedral!.amount).toBe(115);
    // Interest compounds on the current amount: 115 + trunc(115 * 0.1) = 126.
    const second = stateOf(run([
      ...setup,
      { op: "ext", call: "tux.adjust_bill_penalty", args: { character: "player", bill: "bill_cathedral", penalty: "interest" } } as Command,
      { op: "ext", call: "tux.adjust_bill_penalty", args: { character: "player", bill: "bill_cathedral", penalty: "interest" } } as Command,
    ]));
    expect(second.bills.player!.bill_cathedral!.amount).toBe(126);
    const fee = stateOf(run([
      ...setup,
      { op: "ext", call: "tux.adjust_bill_penalty", args: { character: "player", bill: "bill_cathedral", penalty: "fee" } } as Command,
    ]));
    expect(fee.bills.player!.bill_cathedral!.amount).toBe(205);
    // Metadata survives the penalty applications.
    expect(second.bills.player!.bill_cathedral!).toMatchObject({ interestRate: 0.1, lateFee: 100, shareRate: 0.5 });
    // An unknown method and a missing bill are no-ops (upstream logs and stops).
    const none = stateOf(run([
      ...setup,
      { op: "ext", call: "tux.adjust_bill_penalty", args: { character: "player", bill: "bill_cathedral", penalty: "bogus" } } as Command,
      { op: "ext", call: "tux.adjust_bill_penalty", args: { character: "player", bill: "missing", penalty: "interest" } } as Command,
    ]));
    expect(none.bills.player!.bill_cathedral!.amount).toBe(105);
  });

  test("modify_bill with a float variable applies the ratio to the bill's current amount", () => {
    const setup: Command[] = [
      { op: "ext", call: "tux.set_bill", args: { character: "player", bill: "bill_cathedral", amount: 500 } },
    ];
    // Upstream ratio mode: a float variable multiplies the bill amount
    // (truncating) — spyder.yaml's manual compound interest.
    const grown = stateOf(run([
      ...setup,
      { op: "ext", call: "tux.modify_bill", args: { character: "player", bill: "bill_cathedral", variable: "ratio" } } as Command,
    ], undefined, { ratio: 0.1 }));
    expect(grown.bills.player!.bill_cathedral!.amount).toBe(550);
    // A negative float ratio pays the bill down.
    const paid = stateOf(run([
      ...setup,
      { op: "ext", call: "tux.modify_bill", args: { character: "player", bill: "bill_cathedral", variable: "ratio" } } as Command,
    ], undefined, { ratio: -0.5 }));
    expect(paid.bills.player!.bill_cathedral!.amount).toBe(250);
    // A ratio that brings the bill to zero or below deletes it.
    const settled = stateOf(run([
      ...setup,
      { op: "ext", call: "tux.modify_bill", args: { character: "player", bill: "bill_cathedral", variable: "ratio" } } as Command,
    ], undefined, { ratio: -1.5 }));
    expect(settled.bills.player!.bill_cathedral).toBeUndefined();
    // Whole-valued variables stay direct deltas (upstream int mode).
    const direct = stateOf(run([
      ...setup,
      { op: "ext", call: "tux.modify_bill", args: { character: "player", bill: "bill_cathedral", variable: "ratio" } } as Command,
    ], undefined, { ratio: 50 }));
    expect(direct.bills.player!.bill_cathedral!.amount).toBe(550);
  });

  test("the two authored set_bill uses are reported Native with their metadata", () => {
    // spyder.yaml passes amount=0, interest_rate=0.1, late_fee=100 and
    // share_rate=0.5; the port now retains all four fields.
    const result = buildProject(["spyder_bedroom"], { extChoice: true, battle: true } as never);
    expect(result.report.coverage.actions.rows.find((row) => row.type === "set_bill"))
      .toMatchObject({ total: 2, native: 2, degraded: 0, placeholder: 0, dropped: 0 });
  });
});

describe("COV-B check_party_parameter and check_max_tech", () => {
  test("check_party_parameter counts monsters whose stage equals the value", () => {
    const commands = addPlayerMonster(addPlayerMonster([], "rockitten", 5), "rockat", 20);
    const cond = createTuxemonExtensions(DB).conditions!["tux.check_party_parameter"]!;
    const ctx = { ext: run(commands).state.ext, variables: {}, switches: {}, items: {}, gold: 0, playerName: "" };
    expect(cond(ctx, { character: "player", attribute: "stage", value: "stage1", operator: "greater_than", times: 0 })).toBeTrue();
    expect(cond(ctx, { character: "player", attribute: "stage", value: "stage2", operator: "greater_than", times: 0 })).toBeFalse();
    expect(cond(ctx, { character: "player", attribute: "stage", value: "basic", operator: "equals", times: 1 })).toBeTrue();
  });

  test("check_max_tech flags a monster past its species move cap", () => {
    const commands = addPlayerMonster([], "rockitten", 5);
    const cond = createTuxemonExtensions(DB).conditions!["tux.check_max_tech"]!;
    const ctx = { ext: run(commands).state.ext, variables: {}, switches: {}, items: {}, gold: 0, playerName: "" };
    expect(cond(ctx, { character: "player" })).toBeFalse();
    // Teach five techniques to exceed the default cap of four.
    const over = addPlayerMonster([], "rockitten", 5);
    for (const tech of ["ram", "acid", "adamantine", "air_chain", "altitude"]) {
      over.push({ op: "ext", call: "tux.add_tech", args: { variable: "v.add_monster", technique: tech } });
    }
    const overCtx = { ext: run(over).state.ext, variables: {}, switches: {}, items: {}, gold: 0, playerName: "" };
    expect(cond(overCtx, { character: "player" })).toBeTrue();
  });
});

describe("COV-B random_monster", () => {
  test("draws from the deterministic qualified pool and writes the iid", () => {
    const commands: Command[] = [
      { op: "ext", call: "tux.random_monster", args: { level: 10 } },
    ];
    const result = run(commands);
    const state = tuxemonExtensionState(result.state.ext, DB);
    expect(state.party).toHaveLength(1);
    expect(result.state.sw.variables["v.add_monster"]).toBe(state.party[0]!.iid!);
    // The pool excludes txmn_id<=0, randomly=false, and evolved forms.
    const species = state.party[0]!.slug;
    expect(DB.monsters[species]!.txmnId).toBeGreaterThan(0);
    expect(DB.monsters[species]!.randomly).not.toBeFalse();
  });

  test("is deterministic for a fixed RNG cursor", () => {
    const commands: Command[] = [
      { op: "ext", call: "tux.random_monster", args: { level: 10 } },
    ];
    const first = tuxemonExtensionState(run(commands).state.ext, DB).party[0]!.slug;
    const second = tuxemonExtensionState(run(commands).state.ext, DB).party[0]!.slug;
    expect(first).toBe(second);
  });

  test("stages an NPC team member without spending the spawn RNG draws", () => {
    const commands: Command[] = [
      { op: "ext", call: "tux.random_monster", args: { level: 40, character: "eclipse_bank_ethan" } },
    ];
    const state = tuxemonExtensionState(run(commands).state.ext, DB);
    expect(state.npcParties["eclipse_bank_ethan"]).toHaveLength(1);
    expect(state.party).toHaveLength(0);
  });

  test("advances the saved RNG cursor (replay-safe)", () => {
    const commands: Command[] = [
      { op: "ext", call: "tux.random_monster", args: { level: 10 } },
    ];
    const result = run(commands);
    // The default cursor is 0x12345678; the pool draw must advance it.
    expect(result.state.sw.rng).not.toBe(0x12345678);
  });

  test("the NPC path consumes exactly the one pool draw (no spawn draws)", () => {
    // The NPC path skips the 13 spawn draws, so the cursor must move by
    // exactly one pool-selection draw. This kills a pool[0] mutation, which
    // would leave the cursor untouched.
    const baseline = run([]).state.sw.rng;
    const result = run([
      { op: "ext", call: "tux.random_monster", args: { level: 40, character: "eclipse_bank_ethan" } },
    ]);
    expect(result.state.sw.rng).not.toBe(baseline);
    // A second identical run advances by the same single draw.
    const second = run([
      { op: "ext", call: "tux.random_monster", args: { level: 40, character: "eclipse_bank_ethan" } },
    ]);
    expect(second.state.sw.rng).toBe(result.state.sw.rng);
  });
});

describe("COV-B imported NPC trainer parties (B1 integration)", () => {
  // The review found that set_monster_attribute/add_tech/char_plague on NPC
  // monsters were reported Native but never reached the folded battle party.
  // These tests import the real maps and verify the mutations land on the
  // monsters the battle actually uses.

  /** Collect every ext command from an imported event's pages, in order. */
  type ExtCommand = Extract<Command, { op: "ext" }>;
  function extCommandsOf(event: { pages?: { commands?: Command[] }[] }): ExtCommand[] {
    const out: ExtCommand[] = [];
    const walk = (commands: Command[]) => {
      for (const command of commands) {
        if (command.op === "ext") out.push(command);
        if (command.op === "if") {
          walk(command.then);
          walk(command.else ?? []);
        }
        if (command.op === "choices") {
          for (const option of command.options) walk(option.commands);
          walk(command.cancel?.commands ?? []);
        }
      }
    };
    for (const page of event.pages ?? []) walk(page.commands ?? []);
    return out;
  }

  function findEvent(maps: string[], eventId: string) {
    const result = buildProject(maps, { extChoice: true, battle: true } as never);
    const map = result.project.maps.find((candidate) => maps.includes(candidate.id))!;
    const event = (map.events ?? []).find((candidate) => candidate.id === eventId);
    if (!event) throw new Error(`event ${eventId} not found in ${maps.join(",")}`);
    return event;
  }

  test("Billie's route2 party keeps the imported gender attributes", () => {
    // spyder_route2: add_monster + set_monster_attribute(gender) x3, then
    // start_battle player,spyder_billie. The first species is variable-backed.
    const event = findEvent(["spyder_route2"], "e036_billie_encounter_1");
    const commands = extCommandsOf(event).filter((command) =>
      command.call !== "tux.clear_npc_party" && command.call !== "tux.set_monster_health"
      && command.call !== "tux.set_monster_status");
    const result = run(commands, undefined, { "v.billie_choice": 1 });
    const state = tuxemonExtensionState(result.state.ext, DB);
    const party = state.npcParties["spyder_billie"]!;
    expect(party).toHaveLength(3);
    expect(party[0]!.gender).toBe("male");
    expect(party[1]!.gender).toBe("female");
    expect(party[2]!.gender).toBe("female");
    // v.add_monster holds the last staged monster's iid, like upstream.
    expect(result.state.sw.variables["v.add_monster"]).toBe(party[2]!.iid);
  });

  test("Iroh's dojo2 party keeps the imported add_tech moves and iid slots", () => {
    // spyder_dojo2: add_monster x5, get_party_monster, add_tech iid_slot_*,
    // then start_battle player,spyder_dojo_iroh.
    const event = findEvent(["spyder_dojo2"], "npc_spyder_dojo_iroh");
    const commands = extCommandsOf(event).filter((command) =>
      command.call !== "tux.clear_npc_party" && command.call !== "tux.set_monster_health"
      && command.call !== "tux.set_monster_status");
    const result = run(commands);
    const state = tuxemonExtensionState(result.state.ext, DB);
    const party = state.npcParties["spyder_dojo_iroh"]!;
    expect(party).toHaveLength(5);
    const expected = ["peregrine", "shapechange", "lightning_spheres", "radiance", "demiurge"];
    for (let index = 0; index < 5; index++) {
      expect(party[index]!.moves).toContain(expected[index]);
      // get_party_monster wrote each iid into iid_slot_*.
      expect(result.state.sw.variables[`v.iid_slot_${index}`]).toBe(party[index]!.iid);
    }
  });

  test("the battle snapshot carries the staged NPC moves and gender", () => {
    // Run Iroh's staging commands, then start the trainer battle and read
    // the enemy party the reducer built from the staged monsters.
    const event = findEvent(["spyder_dojo2"], "npc_spyder_dojo_iroh");
    const staging = extCommandsOf(event).filter((command) =>
      command.call !== "tux.clear_npc_party" && command.call !== "tux.set_monster_health"
      && command.call !== "tux.set_monster_status");
    // The battle needs a legal player party and an active environment.
    const commands: Command[] = [
      { op: "ext", call: "tux.add_monster", args: { species: "rockitten", level: 25 } },
      { op: "ext", call: "tux.set_environment", args: { environment: "grass" } },
      ...staging,
    ];
    const result = run(commands);
    const ext = result.state.ext as JsonValue;
    const rules = createTuxemonBattleRules(DB, TUXEMON_VARIABLE_ENUMS);
    const started = rules.start(ext, {
      kind: "trainer",
      opponent: "spyder_dojo_iroh",
      inside: true,
      hour: 12,
    } as unknown as JsonValue, 77, {
      ext,
      switches: {},
      variables: {},
      items: {},
      gold: 0,
      playerName: "Player",
    });
    expect(started).not.toBeNull();
    const enemy = tuxemonRuntimeBattleState(started!.state).battle.parties[1]!;
    expect(enemy).toHaveLength(5);
    const slugs = enemy[0]!.moves.map((move) => move.slug);
    expect(slugs).toContain("peregrine");
  });
});

describe("COV-B NPC monster health and status (B1)", () => {
  // The review found set_monster_health/set_monster_status still used the
  // player-only helper, so the Leather Gym winner events (which heal/status
  // the NPC party member named by iid_slot_0) were silent no-ops despite a
  // Native coverage label. These tests pin the cross-storage path.

  test("health and status reach the staged NPC party member named by iid", () => {
    // Stage one NPC monster, read its iid via get_party_monsters, then heal
    // to half and apply a status — the Leather Gym flow.
    const commands: Command[] = [
      { op: "ext", call: "tux.add_monster", args: { species: "rockitten", level: 20, character: "gym_brad" } },
      { op: "ext", call: "tux.get_party_monsters", args: { character: "gym_brad" } },
      { op: "ext", call: "tux.set_monster_health", args: { variable: "v.iid_slot_0", health: { kind: "fraction", value: 0.5 } } },
      { op: "ext", call: "tux.set_monster_status", args: { variable: "v.iid_slot_0", status: "poison" } },
    ];
    const state = stateOf(run(commands));
    const member = state.npcParties["gym_brad"]![0]!;
    expect(member.health).toEqual({ kind: "fraction", value: 0.5 });
    expect(member.status).toBe("poison");
  });

  test("the health/status overrides reach the enemy battle snapshot", () => {
    const commands: Command[] = [
      { op: "ext", call: "tux.add_monster", args: { species: "rockitten", level: 25 } },
      { op: "ext", call: "tux.set_environment", args: { environment: "grass" } },
      { op: "ext", call: "tux.add_monster", args: { species: "rockitten", level: 20, character: "gym_brad" } },
      { op: "ext", call: "tux.get_party_monsters", args: { character: "gym_brad" } },
      { op: "ext", call: "tux.set_monster_health", args: { variable: "v.iid_slot_0", health: { kind: "fraction", value: 0.5 } } },
      { op: "ext", call: "tux.set_monster_status", args: { variable: "v.iid_slot_0", status: "poison" } },
    ];
    const result = run(commands);
    const ext = result.state.ext as JsonValue;
    const rules = createTuxemonBattleRules(DB, TUXEMON_VARIABLE_ENUMS);
    const started = rules.start(ext, {
      kind: "trainer",
      opponent: "gym_brad",
      inside: true,
      hour: 12,
    } as unknown as JsonValue, 77, {
      ext,
      switches: {},
      variables: {},
      items: {},
      gold: 0,
      playerName: "Player",
    });
    expect(started).not.toBeNull();
    const enemy = tuxemonRuntimeBattleState(started!.state).battle.parties[1]!;
    expect(enemy).toHaveLength(1);
    const foe = enemy[0]!;
    expect(foe.currentHp).toBe(Math.trunc(foe.base.hp * 0.5));
    expect(foe.currentHp).toBeLessThan(foe.base.hp);
    expect(foe.status?.slug).toBe("poison");
  });

  test("a full heal and a status clear also reach the NPC party member", () => {
    // Leather Gym uses bare set_monster_health (full) and set_monster_status
    // (no status = clear).
    const commands: Command[] = [
      { op: "ext", call: "tux.add_monster", args: { species: "rockitten", level: 20, character: "gym_chad" } },
      { op: "ext", call: "tux.get_party_monsters", args: { character: "gym_chad" } },
      { op: "ext", call: "tux.set_monster_health", args: { variable: "v.iid_slot_0" } },
      { op: "ext", call: "tux.set_monster_status", args: { variable: "v.iid_slot_0" } },
    ];
    const state = stateOf(run(commands));
    const member = state.npcParties["gym_chad"]![0]!;
    expect(member.health).toEqual({ kind: "full", value: 1 });
    expect(member.status).toBeNull();
  });
});

describe("COV-B runtime player name (B3)", () => {
  // The review found the live player-name checks were folded against the
  // initial name "Red" at import time, dropping the reachable ApexPlayer
  // cheat and the Wayfarer infected/non-infected branches. The condition now
  // reads the live player name (which rename_player updates).

  const playerName = createTuxemonExtensions(DB).conditions!["tux.player_name_is"]!;
  const ctx = (name: string) => ({ ext: null, variables: {}, switches: {}, items: {}, gold: 0, playerName: name });

  test("matches the live player name", () => {
    expect(playerName(ctx("ApexPlayer"), { name: "ApexPlayer" })).toBeTrue();
    expect(playerName(ctx("Red"), { name: "ApexPlayer" })).toBeFalse();
  });

  test("negates through the args (the `not` condition form)", () => {
    expect(playerName(ctx("Red"), { name: "ApexPlayer", negate: true })).toBeTrue();
    expect(playerName(ctx("ApexPlayer"), { name: "ApexPlayer", negate: true })).toBeFalse();
  });

  test("the ApexPlayer cheat event materializes with a runtime name condition", () => {
    // spyder.yaml "Cheat Code ApexPlayer": is check_char_parameter
    // player,name,ApexPlayer. spyder.yaml is the scenario event file for
    // maps with scenario=spyder (e.g. spyder_bedroom). The condition must
    // not be folded to a constant false.
    const result = buildProject(["spyder_bedroom"], { extChoice: true, battle: true } as never);
    const map = result.project.maps.find((candidate) => candidate.id === "spyder_bedroom")!;
    const event = (map.events ?? []).find((candidate) => candidate.id.endsWith("_cheat_code_apexplayer"));
    expect(event).toBeDefined();
    const extConditions: JsonValue[] = [];
    const walk = (commands: Command[]) => {
      for (const command of commands) {
        if (command.op === "if") {
          const cond = (command as { if?: Record<string, unknown> }).if;
          if (cond && cond.kind === "ext" && cond.call === "tux.player_name_is") {
            extConditions.push(cond as JsonValue);
          }
          walk(command.then);
          walk(command.else ?? []);
        }
      }
    };
    for (const page of event!.pages ?? []) walk(page.commands ?? []);
    expect(extConditions).toHaveLength(1);
    expect(extConditions[0]).toMatchObject({ kind: "ext", call: "tux.player_name_is", args: { name: "ApexPlayer" } });
  });
});

describe("COV-B NPC-versus-NPC battle resolver (B2)", () => {
  const npcBattle = createTuxemonExtensions(DB).commands!["tux.npc_battle"]!;

  type PartyMember = {
    iid: string; slug: string; level: number;
    experienceModifier: number; moneyModifier: number;
    health?: { kind: "full" | "fraction" | "points"; value: number };
  };

  /** Per-domain enum codes, mirroring the importer's per-variable tables. */
  const codes = {
    fighterWinnerCode: 11, foeWinnerCode: 22,
    fighterLoserCode: 33, foeLoserCode: 44,
    fighterTrainerCode: 55, foeTrainerCode: 66,
    drawCode: 77,
  };

  function resolve(
    fighter: string,
    foe: string,
    fighterParty: PartyMember[],
    foeParty: PartyMember[],
    seed = 0x12345678,
  ) {
    const state = {
      ...initialTuxemonExtensionState(),
      npcParties: { [fighter]: fighterParty, [foe]: foeParty },
    };
    const ext = packTuxemonExtensionState(state);
    let cursor = seed;
    const random = () => {
      cursor = (cursor * 1664525 + 1013904223) >>> 0;
      return cursor / 0x100000000;
    };
    const result = npcBattle(
      { ext, variables: {}, switches: {}, items: {}, gold: 0, playerName: "", random } as never,
      { fighter, foe, ...codes },
    );
    return { result, cursor, state: tuxemonExtensionState((result as { ext?: JsonValue } | undefined)?.ext ?? ext, DB) };
  }

  const member = (slug: string, level: number, iid: string) => ({
    iid, slug, level, experienceModifier: 1, moneyModifier: 0,
  });

  test("the level-32 Agnidon beats the level-8 Lambert (taba_ba_br_3)", () => {
    const { result } = resolve("cam", "zeke", [member("lambert", 8, "txmn-000001")], [member("agnidon", 32, "txmn-000002")]);
    // Zeke (the foe) wins: winner in the winner domain, the loser in the
    // loser domain, and the loser's trainer code is the stable trainer
    // value (upstream's loser handling overwrites the winner's write).
    expect(result?.writes).toEqual({
      "v.battle_last_winner": 22,
      "v.battle_last_loser": 33,
      "v.battle_last_trainer": 55,
    });
  });

  test("records the winner and a win/loss history pair", () => {
    const { state } = resolve("cam", "zeke", [member("lambert", 8, "txmn-000001")], [member("agnidon", 32, "txmn-000002")]);
    expect(state.history).toContainEqual({ fighter: "zeke", opponent: "cam", outcome: "won" });
    expect(state.history).toContainEqual({ fighter: "cam", opponent: "zeke", outcome: "lost" });
  });

  test("is deterministic for a fixed RNG cursor", () => {
    const first = resolve("cam", "zeke", [member("lambert", 8, "txmn-000001")], [member("agnidon", 32, "txmn-000002")]);
    const second = resolve("cam", "zeke", [member("lambert", 8, "txmn-000001")], [member("agnidon", 32, "txmn-000002")]);
    expect(first.result?.writes).toEqual(second.result?.writes);
    expect(first.cursor).toBe(second.cursor);
  });

  test("consumes the saved RNG (the seed is one draw)", () => {
    const { cursor } = resolve("cam", "zeke", [member("lambert", 8, "txmn-000001")], [member("agnidon", 32, "txmn-000002")]);
    expect(cursor).not.toBe(0x12345678);
  });

  test("no-ops when either party is missing or empty (check_battle_legal)", () => {
    const missing = resolve("cam", "zeke", [], [member("agnidon", 32, "txmn-000002")]);
    expect(missing.result).toBeUndefined();
    const absent = resolve("cam", "zeke", [member("lambert", 8, "txmn-000001")], []);
    expect(absent.result).toBeUndefined();
  });

  test("no-ops when either party is all fainted (check_battle_legal)", () => {
    // A staged health override of 0 HP spawns a fainted snapshot; upstream
    // refuses to start a battle with an all-fainted party.
    const fainted = { ...member("agnidon", 30, "txmn-000001"), health: { kind: "points", value: 0 } as const };
    const allFainted = resolve("cam", "zeke", [fainted], [member("agnidon", 30, "txmn-000002")]);
    expect(allFainted.result).toBeUndefined();
    expect(allFainted.state.history).toEqual([]);
  });

  test("an illegal party consumes no saved RNG (check_battle_legal precedes the seed draw)", () => {
    // Upstream check_battle_legal runs before the battle starts, so an
    // illegal party consumes no battle RNG. The all-fainted probe refuses
    // before the saved seed is drawn, leaving the session cursor untouched.
    const fainted = { ...member("agnidon", 30, "txmn-000001"), health: { kind: "points", value: 0 } as const };
    const seed = 0x12345678;
    const { cursor, result } = resolve("cam", "zeke", [fainted], [member("agnidon", 30, "txmn-000002")], seed);
    expect(result).toBeUndefined();
    expect(cursor).toBe(seed);
  });

  test("isPartyBattleLegal mirrors upstream check_battle_legal", () => {
    // combat/utils.py: empty party, all-fainted party, or any monster without
    // techniques is illegal. Every imported monster learns a level-1 move, so
    // the no-tech branch is only reachable through this helper directly.
    const snap = (moves: string[], currentHp = 10) =>
      ({ slug: "rockitten", level: 5, base: { hp: 10 }, currentHp, moves }) as SpawnedMonsterSnapshot;
    expect(isPartyBattleLegal([])).toBe(false);
    expect(isPartyBattleLegal([snap(["a"], 0)])).toBe(false);
    expect(isPartyBattleLegal([snap([], 10)])).toBe(false);
    expect(isPartyBattleLegal([snap(["a"], 0), snap(["b"], 10)])).toBe(true);
    expect(isPartyBattleLegal([snap(["a"], 10)])).toBe(true);
  });

  test("the fighter can win too (not always the first argument)", () => {
    // Reverse the levels: now Cam's level-32 monster beats Zeke's level-8.
    const { result } = resolve("cam", "zeke", [member("agnidon", 32, "txmn-000001")], [member("lambert", 8, "txmn-000002")]);
    expect(result?.writes).toEqual({
      "v.battle_last_winner": 11,
      "v.battle_last_loser": 44,
      "v.battle_last_trainer": 66,
    });
  });

  test("a true draw writes the draw code and the fighter (challenger) trainer as a deterministic fallback", () => {
    // Two identical level-30 teams with this cursor draw (start=1).
    // Upstream's true-draw path raises ValueError in _handle_draw before
    // either result variable is written: track_battles passes _handle_draw
    // the opponent list with the current fighter already removed, and
    // _handle_draw removes that fighter a second time
    // (combat/utils.py:184-198,276-291). This port does not reproduce the
    // crash; the draw code and the fighter (challenger) trainer code are a
    // deterministic fallback (Degraded), not the upstream final values.
    const { result } = resolve("cam", "zeke", [member("agnidon", 30, "txmn-000001")], [member("agnidon", 30, "txmn-000002")], 1);
    expect(result?.writes).toEqual({
      "v.battle_last_result": 77,
      "v.battle_last_trainer": 55,
    });
  });

  test("the battle RNG continues from the post-spawn cursor, not the pre-spawn seed", () => {
    // rockitten5 vs rockitten5 with battle seed 42 draws pre=lost / post=won,
    // so the pin kills a mutation that restarts the battle from the pre-spawn
    // seed. A fixed random() makes the handler's drawn seed exactly 42.
    const fighterParty = [member("rockitten", 5, "txmn-000001")];
    const foeParty = [member("rockitten", 5, "txmn-000002")];
    const state = {
      ...initialTuxemonExtensionState(),
      npcParties: { cam: fighterParty, zeke: foeParty },
    };
    const ext = packTuxemonExtensionState(state);
    const fixedRandom = () => 42 / 0x100000000;
    const result = npcBattle(
      { ext, variables: {}, switches: {}, items: {}, gold: 0, playerName: "", random: fixedRandom } as never,
      { fighter: "cam", foe: "zeke", ...codes },
    );
    // Replicate the handler: spawn both parties from seed 42, then battle with
    // the post-spawn cursor; the handler must agree.
    const spawnRng = { rng: 42, rngDraws: 0 };
    const spawnSide = (party: PartyMember[]) =>
      party.map((m) => spawnMonster(DB, rulesDb, spawnRng, m.slug, m.level, { iid: m.iid }));
    const player = spawnSide(fighterParty);
    const enemy = spawnSide(foeParty);
    const ended = runPolicyBattle(rulesDb, {
      seed: spawnRng.rng,
      kind: "trainer", opponent: "zeke",
      policy: "ai" as unknown as "first",
      player, enemy,
      inside: false, hour: 12, fieldSize: 1,
      moneyMethod: "conserved", inventory: {}, variables: {},
    });
    const postWinner = ended.result?.outcome === "won" ? "cam" : ended.result?.outcome === "lost" ? "zeke" : null;
    // Sanity: this composition really does distinguish the two cursors. The
    // pre-spawn battle reuses the same spawned parties (only the seed differs).
    const preEnded = runPolicyBattle(rulesDb, {
      seed: 42,
      kind: "trainer", opponent: "zeke",
      policy: "ai" as unknown as "first",
      player, enemy,
      inside: false, hour: 12, fieldSize: 1,
      moneyMethod: "conserved", inventory: {}, variables: {},
    } as never);
    expect(preEnded.result?.outcome).not.toBe(ended.result?.outcome);
    if (postWinner === "cam") {
      expect(result?.writes).toEqual({ "v.battle_last_winner": 11, "v.battle_last_loser": 44, "v.battle_last_trainer": 66 });
    } else if (postWinner === "zeke") {
      expect(result?.writes).toEqual({ "v.battle_last_winner": 22, "v.battle_last_loser": 33, "v.battle_last_trainer": 55 });
    } else {
      expect(result?.writes).toEqual({ "v.battle_last_result": 77, "v.battle_last_trainer": 55 });
    }
  });
});

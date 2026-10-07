import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createTuxemonExtensions,
  initialTuxemonExtensionState,
  tuxemonExtensionState,
} from "../battle/extension.ts";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import {
  createTuxemonSessionOptions,
  TUXEMON_EXTENSIONS,
  TUXEMON_BATTLE_RULES,
  TUXEMON_SCENES,
} from "../battle/game.ts";
import { spawnMonster } from "../battle/spawn.ts";
import { buildProject, G6_IMPORT_OPTIONS } from "../importer/project.ts";
import { validateBattleDb, type BattleDb } from "../importer/battle-schema.ts";
import { BTN_BITS } from "../vendor/pocket-rpgkit/src/engine/camera.ts";
import type { ExtensionCommandContext, ExtensionReadContext } from "../vendor/pocket-rpgkit/src/engine/extensions.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { JsonValue, Project } from "../vendor/pocket-rpgkit/src/engine/types.ts";

const ROOT = join(import.meta.dir, "..");
const SOURCE_DB = validateBattleDb(
  JSON.parse(readFileSync(join(ROOT, "data/battle-db.json"), "utf8")),
);
const RUNTIME_DB = JSON.parse(
  readFileSync(join(ROOT, "data/battle-runtime-db.json"), "utf8"),
) as BattleDb;
const RULES_DB = battleDbToTuxemonBattleDb(RUNTIME_DB);

const extensions = createTuxemonExtensions(SOURCE_DB);
const setPartyStatus = extensions.commands!["tux.set_party_status"]!;
const modifyMoney = extensions.commands!["tux.modify_money"]!;
const info = extensions.commands!["tux.info"]!;
const moneyIs = extensions.conditions!["tux.money_is"]!;

function context(
  ext: JsonValue,
  variables: Record<string, string | number> = {},
  gold = 0,
): ExtensionCommandContext {
  return { ext, switches: {}, variables, items: {}, gold, playerName: "Player", random: () => 0 };
}

function readContext(
  ext: JsonValue,
  variables: Record<string, string | number> = {},
  gold = 0,
): ExtensionReadContext {
  return { ext, switches: {}, variables, items: {}, gold, playerName: "Player" };
}

/** A party with two monsters whose missing HP sums to a known total. */
function damagedPartyExt(lostHp: [number, number]): JsonValue {
  const state = initialTuxemonExtensionState();
  const rng = { rng: 1, rngDraws: 0 };
  const party = lostHp.map((lost, i) => {
    const monster = spawnMonster(RUNTIME_DB, RULES_DB, rng, "rockitten", 5);
    return { ...monster, iid: `iid-${i}`, currentHp: monster.base.hp - lost };
  });
  return { ...state, party } as unknown as JsonValue;
}

test("set_party_status writes the sum of the party's missing HP", () => {
  const ext = damagedPartyExt([3, 5]);
  const result = setPartyStatus(context(ext), { character: "player", variable: "v.party_lost_hp" });
  expect(result?.writes).toEqual({ "v.party_lost_hp": "8" });

  // A full-HP party writes "0" (upstream sets the variable when it changes).
  const full = damagedPartyExt([0, 0]);
  expect(setPartyStatus(context(full), { character: "player", variable: "v.party_lost_hp" })?.writes)
    .toEqual({ "v.party_lost_hp": "0" });

  // No write when the value is unchanged.
  const same = setPartyStatus(context(ext, { "v.party_lost_hp": "8" }),
    { character: "player", variable: "v.party_lost_hp" });
  expect(same).toBeUndefined();

  // An empty party writes nothing: upstream stops before the variable update
  // (set_party_status.py:36-40 logs "has no monsters" and returns).
  const empty = { ...initialTuxemonExtensionState(), party: [] } as unknown as JsonValue;
  expect(setPartyStatus(context(empty), { character: "player", variable: "v.party_lost_hp" }))
    .toBeUndefined();
  expect(setPartyStatus(context(empty, { "v.party_lost_hp": "8" }),
    { character: "player", variable: "v.party_lost_hp" })).toBeUndefined();
});

test("modify_money deducts a variable amount and refuses an overdraft", () => {
  // The cathedral flow negates party_lost_hp with format_variable -int, so
  // the variable holds "-8" when the nurse charges.
  const result = modifyMoney(context(null, { "v.party_lost_hp": "-8" }, 100),
    { character: "player", variable: "v.party_lost_hp" });
  expect(result?.gold).toBe(92);

  // A positive int variable adds.
  const added = modifyMoney(context(null, { "v.amount": "50" }, 10),
    { character: "player", variable: "v.amount" });
  expect(added?.gold).toBe(60);

  // Upstream raises when a withdrawal would overdraw.
  expect(() => modifyMoney(context(null, { "v.party_lost_hp": "-8" }, 5),
    { character: "player", variable: "v.party_lost_hp" })).toThrow();

  // A missing variable is upstream's `game_variables.get(var, 0)` default:
  // a zero-amount no-op, not an error (modify_money.py:51).
  expect(modifyMoney(context(null, {}, 100),
    { character: "player", variable: "v.missing" })).toBeUndefined();
  expect(modifyMoney(context(null, { "v.other": "5" }, 100),
    { character: "player", variable: "v.missing" })).toBeUndefined();

  // A literal amount still works.
  expect(modifyMoney(context(null, {}, 10), { character: "player", amount: -3 })?.gold).toBe(7);
});

test("money_is compares the wallet against a variable with the upstream operator", () => {
  const ctx = readContext(null, { "v.party_lost_hp": "8" }, 100);
  expect(moneyIs(ctx, { character: "player", operator: "greater_or_equal", variable: "v.party_lost_hp" })).toBeTrue();
  expect(moneyIs(ctx, { character: "player", operator: "greater_than", variable: "v.party_lost_hp" })).toBeTrue();
  expect(moneyIs(ctx, { character: "player", operator: "equals", variable: "v.party_lost_hp" })).toBeFalse();

  const poor = readContext(null, { "v.party_lost_hp": "8" }, 5);
  expect(moneyIs(poor, { character: "player", operator: "greater_or_equal", variable: "v.party_lost_hp" })).toBeFalse();
  // `not money_is ... greater_or_equal` is the cannot-afford branch.
  expect(moneyIs(poor, { character: "player", operator: "greater_or_equal", variable: "v.party_lost_hp", negate: true })).toBeTrue();

  // A missing variable compares against 0, matching upstream.
  expect(moneyIs(readContext(null, {}, 0), { character: "player", operator: "greater_or_equal", variable: "v.missing" })).toBeTrue();
});

test("info writes the selected monster's level into info_level", () => {
  const ext = damagedPartyExt([3, 5]);
  const result = info(context(ext, { "v.sold": "iid-1" }),
    { variable: "v.sold", attribute: "level", result: "v.info_level" });
  // rockitten at level 5 (spawned above).
  expect(result?.writes).toEqual({ "v.info_level": "5" });

  // A missing iid writes nothing (upstream logs and stops).
  expect(info(context(ext, { "v.sold": "iid-nope" }),
    { variable: "v.sold", attribute: "level", result: "v.info_level" })).toBeUndefined();
});

// The tests below drive the real imported cathedral events through a kit
// session: walk to the nurse at spyder_leather_center, talk, choose, and
// observe the gold/bill/dialog/party effects. No handler is called directly
// and no imported JSON is scanned.

const FULL_PROJECT = JSON.parse(
  readFileSync(join(ROOT, "dist/project.json"), "utf8"),
) as Project;

const NO_INPUT = { buttons: 0, confirmEdge: false, cancelEdge: false, upEdge: false, downEdge: false };

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** A two-rockitten level-5 party whose missing HP sums to `lost`. */
function nurseParty(lost: [number, number]): JsonValue {
  const rng = { rng: 1, rngDraws: 0 };
  const party = lost.map((hp, i) => {
    const monster = spawnMonster(RUNTIME_DB, RULES_DB, rng, "rockitten", 5);
    return { ...monster, iid: `iid-nurse-${i}`, currentHp: monster.base.hp - hp };
  });
  return json({ ...initialTuxemonExtensionState(), party });
}

interface CenterRun {
  session: Session;
  state: SessionState;
  dialog: string[];
  seenText: Set<string>;
}

/** A fresh session at the leather center's entrance row, with a damaged
 *  party and a known wallet. Map-entry parallels place the nurse and set the
 *  cathedral bill terms before the player moves. */
function startCenter(gold: number, lost: [number, number]): CenterRun {
  const project: Project = {
    ...FULL_PROJECT,
    start: { map: "spyder_leather_center", x: 6, y: 6, dir: "left" },
  };
  const session = createSession(project, 60, createTuxemonSessionOptions(project));
  const state = startSession(project, session, undefined, nurseParty(lost));
  state.sw.gold = gold;
  return { session, state, dialog: [], seenText: new Set() };
}

/** One frame: advance a completed text box, pick option `choose` of a
 *  choices box (navigating first), else hold `buttons`. Every text box that
 *  opens is recorded once in `dialog`. */
function autoStep(run: CenterRun, buttons = 0, choose = 0): void {
  const modal = run.state.interp.modal;
  const input = { ...NO_INPUT, buttons };
  if (modal?.kind === "text") {
    if (modal.complete) input.confirmEdge = true;
  } else if (modal?.kind === "choices") {
    if (modal.index < choose) input.downEdge = true;
    else if (modal.index > choose) input.upEdge = true;
    else input.confirmEdge = true;
  }
  run.state = stepSession(run.session, run.state, input);
  const current = run.state.interp.modal;
  if (current?.kind === "text") {
    const joined = current.lines.join(" ");
    if (!run.seenText.has(joined)) {
      run.seenText.add(joined);
      run.dialog.push(joined);
    }
  }
}

/** Step until a recorded dialog line contains `substring`. */
function driveUntilDialog(run: CenterRun, substring: string, choose = 0, maxFrames = 1800): void {
  for (let frame = 0; frame < maxFrames; frame++) {
    if (run.dialog.some((line) => line.includes(substring))) return;
    autoStep(run, 0, choose);
  }
  throw new Error(`dialog "${substring}" never appeared; saw:\n${run.dialog.join("\n")}`);
}

/** Walk in an L (x then y) to a walkable tile, holding one direction. */
function walkTo(run: CenterRun, tx: number, ty: number): void {
  for (const axis of ["x", "y"] as const) {
    const delta = axis === "x" ? tx - run.state.move.tx : ty - run.state.move.ty;
    if (delta === 0) continue;
    const positive = axis === "x" ? BTN_BITS.RIGHT : BTN_BITS.DOWN;
    const negative = axis === "x" ? BTN_BITS.LEFT : BTN_BITS.UP;
    const button = delta > 0 ? positive : negative;
    for (let frame = 0; frame < 300; frame++) {
      const current = axis === "x" ? run.state.move.tx : run.state.move.ty;
      if (current === (axis === "x" ? tx : ty)) break;
      autoStep(run, button);
    }
    for (let frame = 0; frame < 12; frame++) autoStep(run);
  }
  expect([run.state.move.tx, run.state.move.ty]).toEqual([tx, ty]);
}

function playerBills(run: CenterRun): Record<string, { amount: number }> {
  return (tuxemonExtensionState(run.state.ext, SOURCE_DB).bills.player ?? {}) as Record<string, { amount: number }>;
}

function partyHp(run: CenterRun): number[] {
  return tuxemonExtensionState(run.state.ext, SOURCE_DB).party
    .map((monster) => monster.currentHp ?? monster.base.hp);
}

/** Walk to the tile in front of the nurse's counter and press confirm on
 *  the real imported "Talk Nurse" action event (its tile is the counter at
 *  (5,5), solid terrain; the player faces it from (5,6)). */
function talkToNurse(run: CenterRun): void {
  walkTo(run, 5, 6);
  autoStep(run, BTN_BITS.UP); // the counter blocks the step: turn to face it
  run.state = stepSession(run.session, run.state, { ...NO_INPUT, confirmEdge: true });
}

test("the cathedral nurse charges for a heal when the party can afford it", () => {
  const run = startCenter(100, [3, 5]);
  for (let frame = 0; frame < 60; frame++) autoStep(run); // map-entry parallels
  talkToNurse(run);
  driveUntilDialog(run, "Would you like to heal");
  driveUntilDialog(run, "Thank you for choosing Cathedral");

  // party_lost_hp = 3 + 5 = 8, paid in full from the wallet.
  expect(run.state.sw.gold).toBe(92);
  expect(partyHp(run)).toHaveLength(2);
  expect(partyHp(run).every((hp, i) => hp === tuxemonExtensionState(run.state.ext, SOURCE_DB).party[i]!.base.hp)).toBeTrue();
  expect(run.dialog.join("\n")).toContain("All done. That will be $8.");
  // The map-load init creates the bill tab at 0; the afford path never
  // touches it (the debt went to the wallet, not the bill).
  expect(playerBills(run).bill_cathedral?.amount ?? 0).toBe(0);
});

test("the cathedral nurse puts an unaffordable heal on the bill and still heals", () => {
  const run = startCenter(5, [3, 5]);
  for (let frame = 0; frame < 60; frame++) autoStep(run);
  talkToNurse(run);
  driveUntilDialog(run, "Would you like to heal");
  driveUntilDialog(run, "Thank you for choosing Cathedral");

  // The wallet is untouched; the debt went onto bill_cathedral: the 8 HP
  // cost plus the interest line (trunc(8 * 0.1) = 0).
  expect(run.state.sw.gold).toBe(5);
  expect(playerBills(run).bill_cathedral?.amount).toBe(8);
  expect(partyHp(run).every((hp, i) => hp === tuxemonExtensionState(run.state.ext, SOURCE_DB).party[i]!.base.hp)).toBeTrue();
  expect(run.dialog.join("\n")).toContain("can't afford to pay");
  expect(run.dialog.join("\n")).toContain("plus 10% interest");
});

test("the shady guy buys a monster to pay down the cathedral bill", () => {
  const run = startCenter(5, [3, 5]);
  for (let frame = 0; frame < 60; frame++) autoStep(run);
  talkToNurse(run);
  driveUntilDialog(run, "Thank you for choosing Cathedral");
  expect(playerBills(run).bill_cathedral?.amount).toBe(8);

  // The bill plus a party of two spawns the shady guy at (11,9).
  for (let frame = 0; frame < 60; frame++) autoStep(run);
  walkTo(run, 11, 8); // his body blocks (11,9); the player faces him
  run.state = stepSession(run.session, run.state, { ...NO_INPUT, confirmEdge: true });
  driveUntilDialog(run, "sell me one of your tuxemon");
  // Yes -> "Which one?" -> pick the first monster -> the scoop price -> Yes.
  driveUntilDialog(run, "I can give you $250");
  driveUntilDialog(run, "cash back");

  // The monster is gone and the 250 scoop price cleared the 8 bill (the
  // map-load init re-creates an empty tab at 0 once it is paid off).
  expect(tuxemonExtensionState(run.state.ext, SOURCE_DB).party).toHaveLength(1);
  expect(playerBills(run).bill_cathedral?.amount ?? 0).toBe(0);
  expect(run.state.sw.gold).toBe(5);
});

test("the cathedral billing coverage rows stay native", () => {
  const result = buildProject(["spyder_leather_center"], G6_IMPORT_OPTIONS);
  const rows = result.report.coverage.actions.rows;
  expect(rows.find((row) => row.type === "set_party_status")?.native).toBeGreaterThanOrEqual(1);
  expect(rows.find((row) => row.type === "info")?.native).toBeGreaterThanOrEqual(1);
  expect(rows.find((row) => row.type === "modify_money")?.native).toBeGreaterThanOrEqual(1);
  const condRows = result.report.coverage.conditions.rows;
  expect(condRows.find((row) => row.type === "is money_is")?.native).toBeGreaterThanOrEqual(1);
  expect(condRows.find((row) => row.type === "not money_is")?.native).toBeGreaterThanOrEqual(1);
});

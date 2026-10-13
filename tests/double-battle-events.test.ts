import { describe, expect, test } from "bun:test";

import {
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
} from "../battle/extension.ts";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import {
  TUXEMON_BATTLE_DB,
  TUXEMON_SESSION_OPTIONS,
} from "../battle/game.ts";
import { tuxemonRuntimeBattleState } from "../battle/runtime.ts";
import { spawnMonster } from "../battle/spawn.ts";
import { getSide } from "../battle/tuxemon.ts";
import type { TuxemonBattleState } from "../battle/types.ts";
import { buildProject, G6_IMPORT_OPTIONS } from "../importer/project.ts";
import { BTN_BITS } from "../vendor/pocket-rpgkit/src/engine/camera.ts";
import { searchWalk } from "../vendor/pocket-rpgkit/src/engine/journey-search.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionInput,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { JsonValue, Project } from "../vendor/pocket-rpgkit/src/engine/types.ts";

const BTN_CONFIRM = 0x2000;
const BTN_CANCEL = 0x4000;
const RULE_DB = battleDbToTuxemonBattleDb(TUXEMON_BATTLE_DB);

function playerParty(): JsonValue {
  const state = initialTuxemonExtensionState();
  state.party = [
    spawnMonster(
      TUXEMON_BATTLE_DB,
      RULE_DB,
      { rng: 0x4549, rngDraws: 0 },
      "nut",
      50,
      { iid: "double-map-player-a" },
    ),
    spawnMonster(
      TUXEMON_BATTLE_DB,
      RULE_DB,
      { rng: 0x454a, rngDraws: 0 },
      "rockitten",
      50,
      { iid: "double-map-player-b" },
    ),
  ];
  state.nextMonsterId = 3;
  state.environment = "grass";
  return packTuxemonExtensionState(state);
}

class Driver {
  private previous = 0;
  readonly session: Session;
  state: SessionState;

  constructor(project: Project, start: Project["start"]) {
    const source = { ...project, start };
    this.session = createSession(source, 60, TUXEMON_SESSION_OPTIONS);
    this.state = startSession(source, this.session, undefined, playerParty());
  }

  private input(mask: number): SessionInput {
    const edge = (bit: number) => Boolean((mask & bit) && !(this.previous & bit));
    return {
      buttons: mask,
      confirmEdge: edge(BTN_CONFIRM),
      cancelEdge: edge(BTN_CANCEL),
      upEdge: edge(BTN_BITS.UP),
      downEdge: edge(BTN_BITS.DOWN),
      leftEdge: edge(BTN_BITS.LEFT),
      rightEdge: edge(BTN_BITS.RIGHT),
    };
  }

  tick(mask = 0): void {
    this.state = stepSession(this.session, this.state, this.input(mask));
    this.previous = mask;
  }

  press(mask: number): void {
    this.tick(mask);
    this.tick(0);
  }

  idle(frames: number): void {
    for (let frame = 0; frame < frames; frame++) this.tick(0);
  }

  walkTo(tx: number, ty: number, limit = 60): boolean {
    for (let step = 0; step < limit; step++) {
      if (this.state.interp.modal || this.state.interp.inputLocked || this.state.scene) return false;
      if (this.state.move.tx === tx && this.state.move.ty === ty && !this.state.move.moving) return true;
      const plan = searchWalk({
        session: this.session,
        state: this.state,
        prevMask: this.previous,
        tx,
        ty,
        avoid: new Set(),
        maxExpansions: 20_000,
      });
      if (!plan.masks.length) return false;
      for (const mask of plan.masks) this.tick(mask);
    }
    return this.state.move.tx === tx && this.state.move.ty === ty && !this.state.move.moving;
  }

  settleUntilBattle(limit = 3_000): void {
    for (let frame = 0; frame < limit; frame++) {
      if (this.state.scene?.kind === "battle") return;
      if (this.state.interp.modal?.kind === "text") {
        this.press(BTN_CONFIRM);
      } else {
        this.tick(0);
      }
    }
  }
}

function expectDoubleBattle(
  driver: Driver,
  opponent: string,
  enemy: Array<[slug: string, level: number]>,
): void {
  expect(driver.state.scene?.kind).toBe("battle");
  if (driver.state.scene?.kind !== "battle") return;
  const battle = tuxemonRuntimeBattleState(driver.state.scene.state).battle;
  expect(battle.kind).toBe("trainer");
  expect(battle.opponent).toBe(opponent);
  expect(battle.fieldSize).toBe(2);
  expect(battle.parties[0].map(({ slug, level }) => [slug, level])).toEqual([
    ["nut", 50],
    ["rockitten", 50],
  ]);
  expect(battle.parties[1].map(({ slug, level }) => [slug, level])).toEqual(enemy);
  expect(battle.field.map((uid) => getSide(battle, uid))).toEqual([1, 1, 0, 0]);
  expect(activeSlugs(battle, 0)).toEqual(["nut", "rockitten"]);
  expect(activeSlugs(battle, 1)).toEqual(enemy.slice(0, 2).map(([slug]) => slug));
}

function activeSlugs(battle: TuxemonBattleState, side: 0 | 1): string[] {
  return battle.field
    .filter((uid) => getSide(battle, uid) === side)
    .map((uid) => battle.parties[side].find((monster) => monster.uid === uid)!.slug);
}

const ROUTE5 = buildProject(["spyder_route5"], G6_IMPORT_OPTIONS).project;
const DRAGONS_CAVE = buildProject(["spyder_dragonscave"], G6_IMPORT_OPTIONS).project;

describe("double battles trigger through real imported map events", () => {
  test("Route 5 Tryphaena action event keeps its low-level authored party", () => {
    // Object 77 is the NPC action page at (18,5), distinct from the nearby
    // player-touch pair battle with its higher-level party. Boot beside the
    // spawned NPC, face left, and confirm through the imported dialogue.
    const driver = new Driver(ROUTE5, { map: "spyder_route5", x: 19, y: 5, dir: "left" });
    driver.idle(20);
    driver.press(BTN_CONFIRM);
    driver.settleUntilBattle();
    expectDoubleBattle(driver, "spyder_route5_tryphaena", [
      ["miaownolith", 24],
      ["criniotherme", 22],
    ]);
  });

  test("Dragon's Cave player-touch event stages Ray's four-monster party", () => {
    // Object 98 covers (16,5)-(16,6). Entering it starts the real locked
    // Ray/Tru approach, two dialogue beats, and then the imported double.
    const driver = new Driver(DRAGONS_CAVE, {
      map: "spyder_dragonscave",
      x: 15,
      y: 5,
      dir: "right",
    });
    driver.idle(20);
    expect(driver.walkTo(16, 5)).toBe(false);
    driver.settleUntilBattle();
    expectDoubleBattle(driver, "spyder_dragonscave_ray", [
      ["ghosteeth", 45],
      ["embazook", 45],
      ["arthrobolt", 45],
      ["hydrone", 45],
    ]);
  });
});

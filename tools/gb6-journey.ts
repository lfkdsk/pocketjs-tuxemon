// Deterministic input-only Spyder journey: opening -> all Route 3 trainers.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { battleAutoplayInput } from "../battle/autoplay.ts";
import { tuxemonExtensionState } from "../battle/extension.ts";
import { utilitySceneAutoplayMask } from "./scene-autoplay.ts";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import {
  createTuxemonSessionOptions,
  TUXEMON_BATTLE_DB,
} from "../battle/game.ts";
import { tuxemonRuntimeBattleState } from "../battle/runtime.ts";
import type { RuntimeBattleState } from "../battle/runtime.ts";
import type { SpawnedMonsterSnapshot } from "../battle/types.ts";
import { BTN_BITS } from "../vendor/pocket-rpgkit/src/engine/camera.ts";
import { searchWalk } from "../vendor/pocket-rpgkit/src/engine/journey-search.ts";
import { canStepFrom, type Dir4 } from "../vendor/pocket-rpgkit/src/engine/passability.ts";
import { canonicalJson } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import {
  createSession,
  startSession,
  stepSession,
  tableWithBodies,
  type Session,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { readInlineProject } from "./generated-project.ts";
import type { ProjectSource, WorldTraversalMode } from "../vendor/pocket-rpgkit/src/engine/types.ts";

const ROOT = resolve(process.env.GB6_PROJECT_ROOT ?? new URL("..", import.meta.url).pathname);
const BTN_CONFIRM = 0x2000;
const BTN_CANCEL = 0x4000;
const DX = [0, -1, 0, 1] as const;
const DY = [1, 0, -1, 0] as const;
const BTN_OF: Record<Dir4, number> = {
  0: BTN_BITS.DOWN,
  1: BTN_BITS.LEFT,
  2: BTN_BITS.UP,
  3: BTN_BITS.RIGHT,
};
const RULE_DB = battleDbToTuxemonBattleDb(TUXEMON_BATTLE_DB);

export interface Gb6PartyRow {
  slug: string;
  level: number;
  hp: number;
  maxHp: number;
}

export interface Gb6BattleCheckpoint {
  opponent: string;
  kind: "trainer" | "wild";
  startFrame: number;
  endFrame: number;
  turns: number;
  outcome: string;
  enemy: Array<{ slug: string; level: number }>;
  before: Gb6PartyRow[];
  after: Gb6PartyRow[];
}

export interface Gb6MapCheckpoint {
  name: string;
  frame: number;
  map: string;
  position: [number, number];
}

export interface Gb6JourneyResult {
  format: "pocket-tuxemon/gb6-mainline/v1";
  worldTraversal: "seamless-v1";
  hz: number;
  frames: number;
  terminalMapFrame: number;
  map: string;
  position: [number, number];
  masks: number[];
  maps: Gb6MapCheckpoint[];
  battles: Gb6BattleCheckpoint[];
  story: Record<string, number | boolean>;
  terminalStateSha256: string;
  tapeSha256: string;
}

/** Journey files predate traversal identities. Missing is the original
 * transfer timeline; unknown values are corrupt rather than forward-safe. */
export function journeyWorldTraversal(
  journey: { worldTraversal?: unknown },
  label: string,
): WorldTraversalMode {
  const identity = journey.worldTraversal ?? "legacy-transfer";
  if (identity !== "legacy-transfer" && identity !== "seamless-v1") {
    throw new Error(`${label}: unsupported world traversal identity ${String(identity)}`);
  }
  return identity;
}

/** All newly generated journey fixtures use the seamless project timeline. */
export function recordingWorldTraversal(
  project: Pick<ProjectSource, "worldTraversal" | "worldLayout">,
  label: string,
): "seamless-v1" {
  if (project.worldTraversal !== "seamless-v1" || project.worldLayout === undefined) {
    throw new Error(`${label}: recording requires a seamless-v1 project with WorldLayout`);
  }
  return project.worldTraversal;
}

interface ActiveBattle {
  opponent: string;
  kind: "trainer" | "wild";
  startFrame: number;
  before: Gb6PartyRow[];
  enemy: Array<{ slug: string; level: number }>;
}

function partyRows(party: readonly SpawnedMonsterSnapshot[]): Gb6PartyRow[] {
  return party.map((monster) => ({
    slug: monster.slug,
    level: monster.level,
    hp: monster.currentHp ?? monster.base.hp,
    maxHp: monster.base.hp,
  }));
}

function battlePartyRows(state: RuntimeBattleState): Gb6PartyRow[] {
  return state.battle.parties[0].map((monster) => ({
    slug: monster.slug,
    level: monster.level,
    hp: monster.currentHp,
    maxHp: monster.base.hp,
  }));
}

function value(state: SessionState, id: string): number {
  const current = state.sw.variables[id];
  if (current === undefined) return 0;
  if (typeof current !== "number") throw new Error(`GB6 journey: ${id} is not numeric`);
  return current;
}

export class Driver {
  readonly masks: number[] = [];
  readonly maps: Gb6MapCheckpoint[] = [];
  readonly battles: Gb6BattleCheckpoint[] = [];
  state: SessionState;
  private previousMask: number;
  private activeBattle: ActiveBattle | null = null;
  private lastMap: string;
  private lastWalkError = "";
  private lastBattleEvents: unknown[] = [];
  captureWild = false;

  constructor(readonly session: Session, readonly hz: number, initial: SessionState, previousMask = 0) {
    this.state = initial;
    this.previousMask = previousMask >>> 0;
    this.lastMap = this.state.mapId;
    this.markMap("start");
  }

  extensionParty(): Gb6PartyRow[] {
    return partyRows(tuxemonExtensionState(this.state.ext, TUXEMON_BATTLE_DB).party);
  }

  tick(mask = 0): void {
    const sceneBefore = this.state.scene;
    const input = {
      buttons: mask,
      confirmEdge: Boolean((mask & BTN_CONFIRM) && !(this.previousMask & BTN_CONFIRM)),
      cancelEdge: Boolean((mask & BTN_CANCEL) && !(this.previousMask & BTN_CANCEL)),
      downEdge: Boolean((mask & BTN_BITS.DOWN) && !(this.previousMask & BTN_BITS.DOWN)),
      upEdge: Boolean((mask & BTN_BITS.UP) && !(this.previousMask & BTN_BITS.UP)),
      leftEdge: Boolean((mask & BTN_BITS.LEFT) && !(this.previousMask & BTN_BITS.LEFT)),
      rightEdge: Boolean((mask & BTN_BITS.RIGHT) && !(this.previousMask & BTN_BITS.RIGHT)),
    };
    this.state = stepSession(this.session, this.state, input);
    this.previousMask = mask;
    this.masks.push(mask >>> 0);
    if ((!sceneBefore || sceneBefore.kind !== "battle") && this.state.scene?.kind === "battle") {
      const battle = tuxemonRuntimeBattleState(this.state.scene.state);
      this.activeBattle = {
        opponent: battle.battle.opponent,
        kind: battle.battle.kind,
        startFrame: this.masks.length - 1,
        before: battlePartyRows(battle),
        enemy: battle.battle.parties[1].map((monster) => ({ slug: monster.slug, level: monster.level })),
      };
    }
    if (sceneBefore?.kind === "battle" && this.state.scene?.kind !== "battle") {
      const battle = tuxemonRuntimeBattleState(sceneBefore.state);
      this.lastBattleEvents = battle.battle.events.slice(-40);
      const active = this.activeBattle;
      if (!active) throw new Error("GB6 journey: battle exited without an entry checkpoint");
      this.battles.push({
        ...active,
        endFrame: this.masks.length,
        turns: battle.battle.turn,
        outcome: battle.battle.result?.outcome ?? "missing",
        after: this.extensionParty(),
      });
      this.activeBattle = null;
    }
    if (this.state.mapId !== this.lastMap) {
      this.lastMap = this.state.mapId;
      this.markMap(this.state.mapId.replace(/^spyder_/, ""));
    }
    if (this.state.interp.error) throw new Error(this.state.interp.error.message);
  }

  pulse(mask: number): void {
    this.tick(mask);
    this.tick(0);
  }

  markMap(name: string): void {
    this.maps.push({
      name,
      frame: Math.max(0, this.masks.length - 1),
      map: this.state.mapId,
      position: [this.state.move.tx, this.state.move.ty],
    });
  }

  replayPrefix(): void {
    const prefix = JSON.parse(readFileSync(join(ROOT, "data/g6-journey.json"), "utf8")) as {
      masks: number[];
      worldTraversal?: unknown;
    };
    const worldTraversal = journeyWorldTraversal(prefix, "GB6 opening prefix tape");
    if (worldTraversal !== this.session.worldTraversal) {
      throw new Error(
        `GB6 journey: opening prefix traversal ${worldTraversal} does not match session ${this.session.worldTraversal}`,
      );
    }
    for (const mask of prefix.masks) this.tick(mask);
    this.expect("short journey reaches Route 1", this.state.mapId === "spyder_route1");
    this.expectWin("spyder_billie", 1);
  }

  private choose(labels: string[]): void {
    const modal = this.state.interp.modal;
    if (!modal || modal.kind !== "choices") throw new Error("GB6 journey: expected a choice modal");
    const wanted = labels.shift();
    const index = wanted === undefined ? 0 : modal.options.indexOf(wanted);
    if (index < 0) throw new Error(`GB6 journey: choice '${wanted}' not in [${modal.options.join(", ")}]`);
    while (this.state.interp.modal?.kind === "choices" && this.state.interp.modal.index !== index) {
      this.pulse(BTN_BITS.DOWN);
    }
    this.pulse(BTN_CONFIRM);
  }

  settle(labels: string[] = [], maxFrames = this.hz * 120): void {
    let idle = 0;
    for (let guard = 0; guard < maxFrames; guard++) {
      if (this.state.scene) {
        if (this.state.scene.kind === "scene") {
          this.pulse(utilitySceneAutoplayMask(this.state.scene));
          idle = 0;
          continue;
        }
        const battle = tuxemonRuntimeBattleState(this.state.scene.state);
        const input = battleAutoplayInput(RULE_DB, battle, {
          capture: this.captureWild ? "uncaught" : "never",
        });
        const mask = input.confirmEdge ? BTN_CONFIRM
          : input.cancelEdge ? BTN_CANCEL
            : input.downEdge ? BTN_BITS.DOWN
              : input.upEdge ? BTN_BITS.UP : input.buttons;
        mask === 0 ? this.tick() : this.pulse(mask);
        idle = 0;
        continue;
      }
      const modal = this.state.interp.modal;
      if (modal?.kind === "text") {
        this.pulse(BTN_CONFIRM);
        idle = 0;
        continue;
      }
      if (modal?.kind === "choices") {
        this.choose(labels);
        idle = 0;
        continue;
      }
      if (modal?.kind === "shop") {
        this.pulse(BTN_CANCEL);
        idle = 0;
        continue;
      }
      this.tick();
      if (this.state.scene || this.state.interp.modal || this.state.interp.main
        || this.state.interp.inputLocked || this.state.fade || this.state.move.moving) {
        idle = 0;
      } else if (++idle >= 12) {
        return;
      }
    }
    throw new Error(`GB6 journey: settle exceeded ${maxFrames} frames at ${this.where()}`);
  }

  private touchCells(avoidBattles = false): Set<string> {
    const map = this.session.maps.get(this.state.mapId)!;
    const cells = new Set<string>();
    for (const event of map.events ?? []) {
      if (!event.pages.some((page) => {
        if (page.trigger !== "playerTouch") return false;
        const commands = JSON.stringify(page.commands);
        return /\"op\":\"transfer\"/.test(commands)
          || (avoidBattles && /\"op\":\"battle\"/.test(commands));
      })) continue;
      for (let y = event.y; y < event.y + (event.h ?? 1); y++) {
        for (let x = event.x; x < event.x + (event.w ?? 1); x++) cells.add(`${x},${y}`);
      }
    }
    return cells;
  }

  private bfs(tx: number, ty: number, avoidBattles = false): Dir4[] | null {
    const table = tableWithBodies(this.session.tables.get(this.state.mapId)!, this.state.chars);
    const avoid = this.touchCells(avoidBattles);
    const start = `${this.state.move.tx},${this.state.move.ty}`;
    avoid.delete(start);
    const previous = new Map<string, [string, Dir4]>([[start, ["", 0]]]);
    const queue: Array<[number, number]> = [[this.state.move.tx, this.state.move.ty]];
    while (queue.length > 0) {
      const [x, y] = queue.shift()!;
      if (x === tx && y === ty) break;
      for (const direction of [0, 1, 2, 3] as Dir4[]) {
        const nx = x + DX[direction];
        const ny = y + DY[direction];
        const key = `${nx},${ny}`;
        if (previous.has(key) || !canStepFrom(table, x, y, direction)) continue;
        if (avoid.has(key) && (nx !== tx || ny !== ty)) continue;
        previous.set(key, [`${x},${y}`, direction]);
        queue.push([nx, ny]);
      }
    }
    const goal = `${tx},${ty}`;
    if (!previous.has(goal)) return null;
    const path: Dir4[] = [];
    for (let key = goal; key !== start; key = previous.get(key)![0]) path.unshift(previous.get(key)![1]);
    return path;
  }

  walkTo(tx: number, ty: number, soft = false, avoidBattles = false): boolean {
    const map = this.state.mapId;
    if (this.state.interp.modal || this.state.interp.inputLocked || this.state.scene) return false;
    if (this.state.move.tx === tx && this.state.move.ty === ty && !this.state.move.moving) return true;
    for (let tile = 0; tile < 4_000; tile++) {
      if (this.state.mapId !== map || this.state.interp.modal || this.state.interp.inputLocked || this.state.scene) {
        this.lastWalkError = `interrupted after tile step at ${this.where()}`;
        return false;
      }
      if (this.state.move.tx === tx && this.state.move.ty === ty && !this.state.move.moving) return true;
      const route = this.bfs(tx, ty, avoidBattles);
      if (!route?.length) {
        this.lastWalkError = `no terrain/body route from ${this.where()}`;
        if (soft) return false;
        throw new Error(`GB6 journey: walkTo ${tx},${ty}: ${this.lastWalkError}`);
      }
      const direction = route[0]!;
      const nextX = this.state.move.tx + DX[direction];
      const nextY = this.state.move.ty + DY[direction];
      let plan;
      try {
        plan = searchWalk({
          session: this.session,
          state: this.state,
          prevMask: this.previousMask,
          tx: nextX,
          ty: nextY,
          avoid: new Set(),
          maxExpansions: 5_000,
        });
      } catch (error) {
        this.lastWalkError = String(error);
        if (soft) {
          // A playerTouch event on the current tile can start before A* is
          // allowed to leave it.  Feed the intended direction once; goTo()
          // settles that event and replans from the resulting state.
          this.tick(BTN_OF[direction]);
          return false;
        }
        throw new Error(`GB6 journey: walkTo ${tx},${ty} from ${this.where()}: ${String(error)}`);
      }
      for (let index = 0; index < plan.masks.length; index++) {
        this.tick(plan.masks[index]!);
        if (canonicalJson(this.state) !== canonicalJson(plan.states[index])) {
          throw new Error(`GB6 journey: walk replay diverged on ${map} step ${index + 1}/${plan.masks.length}`);
        }
      }
    }
    this.lastWalkError = `tile limit exceeded from ${this.where()}`;
    return this.state.mapId === map && this.state.move.tx === tx && this.state.move.ty === ty
      && !this.state.move.moving;
  }

  goTo(tx: number, ty: number, avoidBattles = false): void {
    const map = this.state.mapId;
    let noRouteAttempts = 0;
    for (let attempt = 0; attempt < 600; attempt++) {
      if (this.walkTo(tx, ty, true, avoidBattles)) return;
      noRouteAttempts = this.lastWalkError.startsWith("no terrain/body route")
        ? noRouteAttempts + 1 : 0;
      this.settle();
      if (this.state.mapId !== map) return;
      if (noRouteAttempts >= 40) break;
    }
    throw new Error(`GB6 journey: goTo ${tx},${ty} repeatedly interrupted at ${this.where()}: ${this.lastWalkError}; `
      + `party=${JSON.stringify(this.extensionParty())} bodies=${JSON.stringify(Object.values(this.state.chars.chars)
        .filter((character) => character.blocks)
        .map((character) => ({ id: character.id, x: character.tx, y: character.ty, moving: character.moving })))} `
      + `battles=${JSON.stringify(this.battles.slice(-3))}`);
  }

  /** Cross a facing-gated playerTouch transfer from the adjacent tile.
   * Journey search intentionally avoids states that leave the requested map,
   * so targeting the transfer cell itself can find a sideways non-transfer
   * route. Raw input preserves the authored approach direction. */
  crossTo(tx: number, ty: number, direction: Dir4): void {
    const sourceMap = this.state.mapId;
    const sx = tx - DX[direction];
    const sy = ty - DY[direction];
    this.goTo(sx, sy);
    // A direction change consumes one tick before walking. Hold through the
    // tile step instead of pulsing, or a player facing sideways can merely
    // turn on the staging cell and never enter the transfer strip.
    for (let guard = 0; guard < this.hz * 2 && this.state.mapId === sourceMap
      && this.state.move.tx === sx && this.state.move.ty === sy; guard++) {
      this.tick(BTN_OF[direction]);
    }
    this.tick();
    this.settle();
  }

  interact(direction: Dir4): void {
    this.pulse(BTN_OF[direction] | BTN_CONFIRM);
    this.settle();
  }

  interactNpc(id: string, labels: string[] = []): void {
    this.settle();
    for (let attempt = 0; attempt < 200; attempt++) {
      const npc = this.state.chars.chars[id];
      if (!npc) {
        this.tick();
        continue;
      }
      const candidates = ([0, 1, 2, 3] as Dir4[]).map((direction) => ({
        direction,
        x: npc.tx + DX[direction],
        y: npc.ty + DY[direction],
      }));
      const target = candidates.find(({ x, y }) => this.bfs(x, y) !== null);
      if (!target || !this.walkTo(target.x, target.y, true)) {
        this.settle();
        continue;
      }
      // The final step can itself enter a grass/playerTouch fiber.  Finish
      // that interruption before sending the action edge; otherwise the
      // press belongs to the encounter instead of the NPC in front of us.
      this.settle();
      const current = this.state.chars.chars[id];
      if (!current || current.tx !== npc.tx || current.ty !== npc.ty ||
          this.state.move.tx !== target.x || this.state.move.ty !== target.y) continue;
      this.pulse(BTN_OF[((target.direction + 2) % 4) as Dir4]);
      this.pulse(BTN_CONFIRM);
      this.settle(labels);
      return;
    }
    throw new Error(`GB6 journey: could not interact with ${id} at ${this.where()}; `
      + `npc=${JSON.stringify(this.state.chars.chars[id] ?? null)} bodies=${JSON.stringify(Object.values(this.state.chars.chars)
        .filter((character) => character.blocks)
        .map((character) => ({ id: character.id, x: character.tx, y: character.ty, moving: character.moving })))}`);
  }

  fightTouch(opponent: string, x: number, y: number): void {
    const before = this.winCount(opponent);
    this.goTo(x, y);
    this.settle();
    this.expectWin(opponent, before + 1);
  }

  fightNpc(opponent: string, id = `npc_${opponent}`, labels: string[] = []): void {
    const before = this.winCount(opponent);
    for (let attempt = 0; attempt < 8 && this.winCount(opponent) === before; attempt++) {
      this.interactNpc(id, [...labels]);
    }
    this.expectWin(opponent, before + 1);
  }

  healAtCityPark(): void {
    this.interactNpc("npc_spyder_citypark_nurse");
    this.expect("City Park nurse restores the party", this.extensionParty().every((row) => row.hp === row.maxHp));
  }

  healAtCafe(): void {
    this.goTo(0, 6);
    this.pulse(BTN_BITS.UP | BTN_CONFIRM);
    this.settle(["Yes"]);
    this.expect("Cotton Cafe restores the party", this.extensionParty().every((row) => row.hp === row.maxHp));
  }

  healAtCenter(): void {
    this.goTo(5, 6);
    this.pulse(BTN_BITS.UP | BTN_CONFIRM);
    this.settle(["Yes"]);
    this.expect("Cathedral nurse restores the party", this.extensionParty().every((row) => row.hp === row.maxHp));
  }

  winCount(opponent: string): number {
    return tuxemonExtensionState(this.state.ext, TUXEMON_BATTLE_DB).history.filter((entry) =>
      entry.fighter === "player" && entry.opponent === opponent && entry.outcome === "won"
    ).length;
  }

  expectWin(opponent: string, count = 1): void {
    if (this.winCount(opponent) !== count) {
      throw new Error(`GB6 journey: ${opponent} win #${count} failed at ${this.where()}; `
        + `party=${JSON.stringify(this.extensionParty())} battles=${JSON.stringify(this.battles.slice(-4))} `
        + `events=${JSON.stringify(this.lastBattleEvents)}`);
    }
  }

  expect(label: string, condition: boolean): void {
    if (!condition) throw new Error(`GB6 journey: ${label} failed at ${this.where()}`);
  }

  where(): string {
    return `${this.state.mapId}@${this.state.move.tx},${this.state.move.ty} f${this.masks.length}`
      + ` moving=${this.state.move.moving} main=${this.state.interp.main?.key ?? "-"}`
      + ` modal=${this.state.interp.modal?.kind ?? "-"} scene=${this.state.scene?.kind ?? "-"}`;
  }
}

function assertEvent(map: string, id: string, session: Session): void {
  const found = session.maps.get(map)?.events?.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`GB6 journey: missing ${map}/${id}`);
}

export function runGb6Journey(hz = 60): Gb6JourneyResult {
  if (![60, 30, 20].includes(hz)) throw new Error(`GB6 journey: unsupported rate ${hz}`);
  const project = readInlineProject(ROOT);
  const worldTraversal = recordingWorldTraversal(project, "GB6 journey");
  const session = createSession(project, hz, createTuxemonSessionOptions(project, worldTraversal));
  const driver = new Driver(session, hz, startSession(project, session));
  driver.replayPrefix();

  // Route 1 -> Cotton Town; the required Cotton battle is an action choice
  // followed by a parallel Battle Processing event.
  driver.crossTo(21, 0, 2);
  driver.expect("entered Cotton Town", driver.state.mapId === "spyder_cotton_town");
  driver.fightNpc("spyder_confusedperson", "npc_spyder_confusedperson", ["Yes"]);

  // The Cotton Scoop gives the capture-device tutorial, after which the
  // player must return the unused balls to Mom before the Cafe opens.
  driver.goTo(30, 34);
  driver.settle();
  driver.expect("entered Cotton Scoop", driver.state.mapId === "spyder_cotton_scoop");
  driver.goTo(5, 8);
  driver.settle(["Yes"]);
  driver.expect("received Cotton Scoop tutorial", value(driver.state, "v.visitcottonmart") === 1);
  driver.captureWild = true;
  driver.goTo(5, 9);
  driver.goTo(5, 10);
  driver.settle();
  driver.expect("returned to Cotton Town", driver.state.mapId === "spyder_cotton_town");

  driver.crossTo(22, 39, 0);
  driver.expect("returned south on Route 1", driver.state.mapId === "spyder_route1");
  driver.crossTo(14, 19, 0);
  driver.expect("returned to Paper Town", driver.state.mapId === "spyder_paper_town");
  driver.goTo(10, 6);
  driver.settle();
  driver.expect("entered protagonist house", driver.state.mapId === "spyder_downstairs");
  driver.interactNpc("npc_spyder_papertown_mom");
  driver.expect("Mom accepted the Scoop errand", value(driver.state, "v.momthanked") === 1);
  driver.goTo(4, 5);
  driver.goTo(4, 6);
  driver.settle();
  driver.expect("left protagonist house", driver.state.mapId === "spyder_paper_town");
  driver.crossTo(14, 0, 2);
  driver.expect("returned north on Route 1", driver.state.mapId === "spyder_route1");
  driver.crossTo(21, 0, 2);
  driver.expect("returned north to Cotton Town", driver.state.mapId === "spyder_cotton_town");
  driver.goTo(25, 37);
  driver.settle();
  driver.expect("met the Cotton hacker", value(driver.state, "v.spokencottonhacker") === 1);

  // The cafe briefing is the story gate on Cotton Town's Route 2 exit.
  driver.goTo(31, 16);
  driver.settle();
  driver.expect("entered Cotton Cafe", driver.state.mapId === "spyder_cotton_cafe");
  driver.interactNpc("npc_spyder_cottontown_hacker");
  driver.expect("received Tuxepedia briefing", value(driver.state, "v.visitedcottoncafe") === 1);
  driver.healAtCafe();
  driver.goTo(7, 10);
  driver.goTo(7, 11);
  driver.settle();
  driver.expect("left Cotton Cafe", driver.state.mapId === "spyder_cotton_town");

  driver.crossTo(39, 28, 3);
  driver.expect("entered Route 2", driver.state.mapId === "spyder_route2");
  const healFromRoute2 = (): void => {
    driver.crossTo(0, 9, 1);
    driver.expect("backtracked to Cotton Town", driver.state.mapId === "spyder_cotton_town");
    driver.goTo(31, 16);
    driver.settle();
    driver.expect("backtracked to Cotton Cafe", driver.state.mapId === "spyder_cotton_cafe");
    driver.healAtCafe();
    driver.goTo(7, 10);
    driver.goTo(7, 11);
    driver.settle();
    driver.expect("left Cotton Cafe after healing", driver.state.mapId === "spyder_cotton_town");
    driver.crossTo(39, 28, 3);
    driver.expect("returned to Route 2 after healing", driver.state.mapId === "spyder_route2");
  };
  const trainOnRoute2 = (minimumLevel: number): void => {
    while (Math.max(...driver.extensionParty().map((row) => row.level)) < minimumLevel) {
      const before = driver.battles.length;
      for (let attempt = 0; attempt < 80 && driver.battles.length === before; attempt++) {
        const [x, y] = attempt % 2 === 0 ? [4, 8] : [5, 9];
        driver.goTo(x, y);
        driver.settle();
      }
      driver.expect("Route 2 training triggered a battle", driver.battles.length > before);
      driver.expect("Route 2 training battle completed", ["won", "captured"].includes(
        driver.battles.at(-1)?.outcome ?? "",
      ));
      healFromRoute2();
    }
  };
  driver.fightTouch("spyder_billie", 1, 9);
  healFromRoute2();
  trainOnRoute2(12);
  driver.fightTouch("spyder_route2_roddick", 5, 4);
  healFromRoute2();
  driver.fightTouch("spyder_route2_marion", 22, 10);
  healFromRoute2();
  driver.fightTouch("spyder_route2_graf", 29, 4);

  driver.crossTo(10, 0, 2);
  driver.expect("entered City Park", driver.state.mapId === "spyder_citypark");
  driver.healAtCityPark();
  driver.fightNpc("spyder_citypark_frances");
  driver.healAtCityPark();
  driver.fightTouch("spyder_citypark_bobette", 13, 17);
  driver.healAtCityPark();
  {
    const before = driver.winCount("spyder_citypark_edith");
    driver.goTo(35, 18);
    driver.pulse(BTN_BITS.UP);
    driver.pulse(BTN_CONFIRM);
    driver.settle();
    driver.expectWin("spyder_citypark_edith", before + 1);
  }
  driver.healAtCityPark();

  driver.crossTo(0, 13, 1);
  driver.expect("entered Leather Town", driver.state.mapId === "spyder_leather_town");
  driver.goTo(23, 9);
  driver.settle();
  driver.expect("entered Leather Center", driver.state.mapId === "spyder_leather_center");
  driver.healAtCenter();
  driver.goTo(6, 9);
  driver.goTo(6, 10);
  driver.settle();
  driver.expect("returned to Leather Town", driver.state.mapId === "spyder_leather_town");
  driver.crossTo(7, 0, 2);
  driver.expect("entered Route 3", driver.state.mapId === "spyder_route3");

  const healFromRoute3 = (): void => {
    driver.crossTo(7, 39, 0);
    driver.expect("backtracked to Leather Town", driver.state.mapId === "spyder_leather_town");
    driver.goTo(23, 9);
    driver.settle();
    driver.expect("backtracked to Leather Center", driver.state.mapId === "spyder_leather_center");
    driver.healAtCenter();
    driver.goTo(6, 9);
    driver.goTo(6, 10);
    driver.settle();
    driver.expect("left Leather Center after healing", driver.state.mapId === "spyder_leather_town");
    driver.crossTo(7, 0, 2);
    driver.expect("returned to Route 3 after healing", driver.state.mapId === "spyder_route3");
  };
  const fightRequiredTouch = (opponent: string, x: number, y: number): void => {
    if (driver.winCount(opponent) === 0) {
      driver.fightTouch(opponent, x, y);
      healFromRoute3();
    }
  };
  const fightRequiredNpc = (opponent: string): void => {
    if (driver.winCount(opponent) === 0) {
      driver.fightNpc(opponent);
      healFromRoute3();
    }
  };
  fightRequiredTouch("spyder_route3_novak", 12, 30);
  fightRequiredNpc("spyder_route3_curie");
  fightRequiredTouch("spyder_route3_wanda", 32, 18);
  fightRequiredNpc("spyder_route3_twig");
  fightRequiredNpc("spyder_route3_roxby");
  fightRequiredNpc("spyder_route3_surat");
  fightRequiredTouch("spyder_route3_weaver", 17, 9);
  fightRequiredNpc("spyder_route3_zoolander");
  driver.expect("Zoolander dropped the sledgehammer", (driver.state.sw.items.sledgehammer ?? 0) >= 1);
  driver.interactNpc("npc_spyder_boulder");
  driver.expect(`the sledgehammer cleared the boulder variable (actual ${value(driver.state, "local.npc.spyder_boulder")})`,
    value(driver.state, "local.npc.spyder_boulder") === 0);
  driver.expect(`the removed boulder stopped blocking (actual ${JSON.stringify(driver.state.chars.chars.npc_spyder_boulder ?? null)})`,
    driver.state.chars.chars.npc_spyder_boulder?.blocks !== true);
  fightRequiredNpc("spyder_route3_connor");
  driver.goTo(4, 4);
  driver.settle();
  driver.expect("entered Wayfarer Inn from lower Route 3", driver.state.mapId === "spyder_wayfarer_inn1");
  driver.goTo(4, 2);
  driver.settle();
  driver.expect("climbed to the Wayfarer Inn upper floor", driver.state.mapId === "spyder_wayfarer_inn2");
  driver.goTo(10, 3);
  driver.settle();
  driver.expect("crossed to the Wayfarer Inn north stair", driver.state.mapId === "spyder_wayfarer_inn1");
  driver.goTo(11, 1);
  driver.settle();
  driver.expect("left Wayfarer Inn beside QQQ", driver.state.mapId === "spyder_route3");
  driver.fightTouch("spyder_route3_qqq", 1, 3);

  const trainerBattles = driver.battles.filter((row) => row.kind === "trainer");
  const requiredWins: Readonly<Record<string, number>> = {
    spyder_billie: 2,
    spyder_confusedperson: 1,
    spyder_route2_graf: 1,
    spyder_route2_marion: 1,
    spyder_route2_roddick: 1,
    spyder_citypark_bobette: 1,
    spyder_citypark_edith: 1,
    spyder_citypark_frances: 1,
    spyder_route3_connor: 1,
    spyder_route3_curie: 1,
    spyder_route3_novak: 1,
    spyder_route3_qqq: 1,
    spyder_route3_roxby: 1,
    spyder_route3_surat: 1,
    spyder_route3_twig: 1,
    spyder_route3_wanda: 1,
    spyder_route3_weaver: 1,
    spyder_route3_zoolander: 1,
  };
  driver.expect("all 19 specified trainer wins were recorded", Object.entries(requiredWins).every(
    ([opponent, count]) => driver.winCount(opponent) === count,
  ));
  driver.expect("every trainer battle was won", driver.battles.filter((row) => row.kind === "trainer")
    .every((row) => row.outcome === "won"));
  driver.goTo(2, 3);
  driver.settle();
  driver.expect("returned to the Wayfarer Inn north room", driver.state.mapId === "spyder_wayfarer_inn1");
  driver.goTo(10, 3);
  driver.settle();
  driver.expect("returned to the Wayfarer Inn upper floor", driver.state.mapId === "spyder_wayfarer_inn2");
  driver.goTo(4, 2);
  driver.settle();
  driver.expect("crossed back to the Wayfarer Inn south stair", driver.state.mapId === "spyder_wayfarer_inn1");
  driver.goTo(10, 10);
  driver.pulse(BTN_BITS.DOWN);
  driver.settle();
  driver.expect("returned to lower Route 3", driver.state.mapId === "spyder_route3");
  driver.goTo(4, 6);
  driver.settle();
  driver.markMap("route-3-end");

  // Prove all target events used above still exist in the generated project;
  // this catches renamed/import-dropped sight strips before a vague path error.
  for (const [map, id] of [
    ["spyder_cotton_town", "e042_battle_confused"],
    ["spyder_route2", "e036_billie_encounter_r036"],
    ["spyder_citypark", "e047_talk_bobette_r056"],
    ["spyder_route3", "e045_rookie_talk_r009"],
  ] as const) assertEvent(map, id, session);

  const stateJson = canonicalJson(driver.state);
  const tapeJson = JSON.stringify(driver.masks);
  const variable = (id: string): number => value(driver.state, id);
  return {
    format: "pocket-tuxemon/gb6-mainline/v1",
    worldTraversal,
    hz,
    frames: driver.masks.length,
    terminalMapFrame: driver.state.interp.frame,
    map: driver.state.mapId,
    position: [driver.state.move.tx, driver.state.move.ty],
    masks: driver.masks,
    maps: driver.maps,
    battles: driver.battles,
    story: {
      firstfightend: variable("v.firstfightend"),
      firstfightdue: variable("v.firstfightdue"),
      confusedchoice: variable("v.confusedchoice"),
      visitedcottoncafe: variable("v.visitedcottoncafe"),
      route2billiefought: variable("v.route2billiefought"),
      shaftscheme: variable("v.shaftscheme"),
      zoolanderWon: driver.state.sw.switches["bo.spyder_route3_zoolander.won"] === true,
    },
    terminalStateSha256: createHash("sha256").update(stateJson).digest("hex"),
    tapeSha256: createHash("sha256").update(tapeJson).digest("hex"),
  };
}

if (import.meta.main) {
  const hz = Number(process.env.HZ ?? 60);
  const result = runGb6Journey(hz);
  const output = process.env.GB6_JOURNEY_OUT
    ?? join(ROOT, "dist", `gb6-mainline-${hz}hz.json`);
  writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  console.log(`GB6 JOURNEY PASS hz=${hz} sourceFrames=${result.frames} terminalMapFrame=${result.terminalMapFrame} `
    + `battles=${result.battles.length} end=${result.map}@${result.position.join(",")} `
    + `state=${result.terminalStateSha256}`);
}

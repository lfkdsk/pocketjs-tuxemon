import { describe, expect, test } from "bun:test";

import {
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
  tuxemonExtensionState,
  type TuxemonExtensionState,
} from "../battle/extension.ts";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import { TUXEMON_BATTLE_DB, TUXEMON_EXTENSIONS, TUXEMON_SCENES, TUXEMON_VARIABLE_ENUMS } from "../battle/game.ts";
import { spawnMonster } from "../battle/spawn.ts";
import { buildProject, G6_IMPORT_OPTIONS } from "../importer/project.ts";
import { applyTerrain, importTerrain } from "../importer/terrain.ts";
import type { BattleCompletion, BattleRules } from "../vendor/pocket-rpgkit/src/engine/battle.ts";
import { createSwitchState } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";
import {
  createSession,
  startSession,
  stepSession,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type {
  Command,
  GameEvent,
  JsonValue,
  MapDef,
  Project,
} from "../vendor/pocket-rpgkit/src/engine/types.ts";

const DOWN = 0x0040;
const RULE_DB = battleDbToTuxemonBattleDb(TUXEMON_BATTLE_DB);
const MAP_IDS = [
  "spyder_route1",
  "spyder_paper_town",
  "spyder_radiotower",
  "spyder_leather_center",
  "taba_ba_br_1",
  "taba_ba_br_2",
] as const;

const IMPORTED = buildProject([...MAP_IDS], G6_IMPORT_OPTIONS).project;

function mapById(id: string): MapDef {
  const map = IMPORTED.maps.find((candidate) => candidate.id === id);
  if (!map) throw new Error(`missing imported map ${id}`);
  return map;
}

function eventById(map: MapDef, id: string): GameEvent {
  const event = map.events?.find((candidate) => candidate.id === id);
  if (!event) throw new Error(`missing imported event ${map.id}/${id}`);
  return event;
}

function commandNodes(commands: readonly Command[], out: Command[] = []): Command[] {
  for (const command of commands) {
    out.push(command);
    if (command.op === "if") {
      commandNodes(command.then, out);
      commandNodes(command.else ?? [], out);
    } else if (command.op === "choices") {
      for (const option of command.options) commandNodes(option.commands, out);
      commandNodes(command.cancel?.commands ?? [], out);
    } else if (command.op === "battle") {
      commandNodes(command.onWin ?? [], out);
      commandNodes(command.onLose ?? [], out);
      commandNodes(command.onEscape ?? [], out);
    }
  }
  return out;
}

function eventCommands(event: GameEvent): Command[] {
  return commandNodes(event.pages.flatMap((page) => page.commands));
}

function enumValue(bank: keyof typeof TUXEMON_VARIABLE_ENUMS, value: string): number {
  const index = TUXEMON_VARIABLE_ENUMS[bank].indexOf(value);
  if (index < 0) throw new Error(`${bank} has no ${value} enum`);
  return index + 1;
}

function spawnedExtension(
  species: string,
  level: number,
  options: { faintPoint?: { map: string; x: number; y: number }; waitingToEvolve?: boolean } = {},
): TuxemonExtensionState {
  const monster = spawnMonster(
    TUXEMON_BATTLE_DB,
    RULE_DB,
    { rng: 1, rngDraws: 0 },
    species,
    level,
    { iid: "txmn-gw1" },
  );
  monster.waitingToEvolve = options.waitingToEvolve === true;
  return {
    ...initialTuxemonExtensionState(),
    party: [monster],
    caught: [species],
    faintPoints: options.faintPoint ? { player: options.faintPoint } : {},
    nextMonsterId: 2,
  };
}

interface OneTickBattleState {
  done: boolean;
  ext: JsonValue;
  opponent: string;
}

function oneTickBattle(
  finish: (ext: TuxemonExtensionState, opponent: string) => BattleCompletion,
): BattleRules {
  return {
    start(ext, rawSetup) {
      const setup = rawSetup as { opponent?: unknown };
      const opponent = typeof setup.opponent === "string" ? setup.opponent : "fixture";
      return {
        ext,
        state: { done: false, ext, opponent } as unknown as JsonValue,
      };
    },
    step(raw) {
      const state = raw as unknown as OneTickBattleState;
      return { ...state, done: true } as unknown as JsonValue;
    },
    done(raw) {
      const state = raw as unknown as OneTickBattleState;
      return state.done ? finish(tuxemonExtensionState(state.ext, TUXEMON_BATTLE_DB), state.opponent) : null;
    },
  };
}

const RADIOTOWER_LOSS = oneTickBattle((ext, opponent) => {
  if (opponent !== "spyder_omnichannel_beaverbrook") {
    throw new Error(`unexpected Radiotower opponent ${opponent}`);
  }
  const defeated: TuxemonExtensionState = {
    ...ext,
    party: ext.party.map((monster) => ({ ...monster, currentHp: 0, status: "faint" })),
    history: [
      ...ext.history,
      { fighter: "player", opponent, outcome: "lost" },
      { fighter: opponent, opponent: "player", outcome: "won" },
    ],
  };
  return {
    ext: packTuxemonExtensionState(defeated),
    result: "lose",
    writes: {
      "v.battle_last_result": enumValue("battle_last_result", "lost"),
      "v.battle_last_trainer": enumValue("battle_last_trainer", opponent),
      "v.battle_last_winner": enumValue("battle_last_winner", opponent),
      "v.battle_last_loser": enumValue("battle_last_loser", "player"),
    },
    switches: { [`bo.${opponent}.lost`]: true },
  };
});

interface RadiotowerResult {
  state: SessionState;
  battleStart: number;
  battleEnd: number;
  unlock: number;
  kernelquest: number;
  transfer: number;
  texts: Array<{ frame: number; map: string; lines: string[] }>;
}

function runRadiotowerLoss(): RadiotowerResult {
  const project = applyTerrain(
    {
      ...IMPORTED,
      start: { map: "spyder_radiotower", x: 1, y: 15, dir: "down" },
      maps: [mapById("spyder_radiotower"), mapById("spyder_leather_center")],
    },
    importTerrain({ mapIds: ["spyder_radiotower", "spyder_leather_center"] }).fragment,
  );
  const session = createSession(project, 60, {
    extensions: TUXEMON_EXTENSIONS,
    scenes: TUXEMON_SCENES,
    battle: RADIOTOWER_LOSS,
  });
  const ext = spawnedExtension("rockitten", 5, {
    faintPoint: { map: "spyder_leather_center", x: 6, y: 7 },
  });
  let state = startSession(project, session, createSwitchState(), ext as unknown as JsonValue);
  let battleStart = -1;
  let battleEnd = -1;
  let unlock = -1;
  let kernelquest = -1;
  let transfer = -1;
  let sawLock = false;
  let lastText = "";
  let settled = 0;
  const texts: RadiotowerResult["texts"] = [];

  for (let frame = 0; frame < 20_000; frame++) {
    const before = state;
    const modal = state.interp.modal;
    state = stepSession(session, state, {
      buttons: sawLock ? 0 : DOWN,
      confirmEdge: modal?.kind === "text",
      cancelEdge: false,
      upEdge: false,
      downEdge: false,
    });
    if (!before.scene && state.scene && battleStart < 0) battleStart = frame;
    if (before.scene && !state.scene && battleEnd < 0) battleEnd = frame;
    if (state.interp.inputLocked) sawLock = true;
    if (sawLock && before.interp.inputLocked && !state.interp.inputLocked && unlock < 0) unlock = frame;
    if (state.sw.variables["v.kernelquest"] === enumValue("kernelquest", "yes") && kernelquest < 0) {
      kernelquest = frame;
    }
    if (before.mapId !== state.mapId && transfer < 0) transfer = frame;

    const nextModal = state.interp.modal;
    const textKey = nextModal?.kind === "text" ? `${nextModal.fiber}|${nextModal.lines.join("\n")}` : "";
    if (nextModal?.kind === "text" && textKey !== lastText) {
      texts.push({ frame, map: state.mapId, lines: [...nextModal.lines] });
    }
    lastText = textKey;

    if (
      state.mapId === "spyder_leather_center" &&
      state.move.tx === 6 && state.move.ty === 7 &&
      state.fade === null && state.scene === null && state.interp.modal === null &&
      texts.some((entry) => entry.lines.includes("You should heal your monsters before heading off."))
    ) {
      settled++;
      if (settled >= 30) {
        return { state, battleStart, battleEnd, unlock, kernelquest, transfer, texts };
      }
    } else {
      settled = 0;
    }
    if (state.interp.error) throw new Error(state.interp.error.message);
  }
  throw new Error(`Radiotower loss did not settle: ${state.mapId}@${state.move.tx},${state.move.ty}`);
}

describe("GW1 Radiotower WorldState/worldIdle acceptance", () => {
  test("the real Stop! loss finishes its story before one fade-safe faint transfer", () => {
    const result = runRadiotowerLoss();
    const ext = tuxemonExtensionState(result.state.ext, TUXEMON_BATTLE_DB);
    const joined = result.texts.map((entry) => entry.lines.join(" "));
    const playerName = result.state.sw.playerName ?? "";
    const expectedStoryStarts = [
      `Hey ${playerName}, hold up!`,
      "I've been watching you from the shop, and I have to say, I'm impressed.",
      "Aha, it's too late for you!",
      "That was a close one! I'm just glad we were able to take down those thieves.",
      `I'm proud of you, ${playerName}. You've come a long way since we first met.`,
      "No. It's not possible.",
    ];

    expect(result.battleStart).toBeGreaterThanOrEqual(0);
    expect(result.battleEnd).toBeGreaterThan(result.battleStart);
    expect(result.kernelquest).toBeGreaterThan(result.battleEnd);
    expect(result.unlock).toBeGreaterThanOrEqual(result.kernelquest);
    expect(result.transfer).toBeGreaterThan(result.unlock);
    for (const firstPage of expectedStoryStarts) {
      expect(joined.filter((text) => text === firstPage), firstPage).toHaveLength(1);
    }
    expect(joined.filter((text) => text === "You should heal your monsters before heading off."))
      .toHaveLength(1);
    expect(result.state.mapId).toBe("spyder_leather_center");
    expect([result.state.move.tx, result.state.move.ty]).toEqual([6, 7]);
    expect(result.state.sw.variables).toMatchObject({
      "v.battle_last_result": enumValue("battle_last_result", "lost"),
      "v.kernelquest": enumValue("kernelquest", "yes"),
    });
    expect(ext.party[0]).toMatchObject({ slug: "rockitten", level: 5, currentHp: 0 });
    expect(ext.history).toContainEqual({
      fighter: "player",
      opponent: "spyder_omnichannel_beaverbrook",
      outcome: "lost",
    });

    console.log("GW1 RADIOTOWER LOCAL", JSON.stringify({
      battleStart: result.battleStart,
      battleEnd: result.battleEnd,
      unlock: result.unlock,
      kernelquest: result.kernelquest,
      transfer: result.transfer,
      faintNotices: joined.filter((text) => text === "You should heal your monsters before heading off.").length,
      final: `${result.state.mapId}@${result.state.move.tx},${result.state.move.ty}`,
      hp: `${ext.party[0]!.currentHp}/${ext.party[0]!.base.hp}`,
    }));
  });
});

interface EvolutionCase {
  map: typeof MAP_IDS[number];
  evolution: string;
  storyGate: string;
  lockPages: string[];
  battleStarts: string[];
  resultPages: string[];
  authoredLock: boolean;
}

const EVOLUTION_CASES: EvolutionCase[] = [
  {
    map: "spyder_route1",
    // Pin the integrated deterministic ordering after time, presentation,
    // moving-guard, world-layer and live player-name events materialize.
    evolution: "e036_evolution_all",
    storyGate: "battle return (no authored story lock)",
    lockPages: [],
    battleStarts: [],
    resultPages: [],
    authoredLock: false,
  },
  {
    map: "spyder_paper_town",
    // The First Fight ids remain explicit below; this pins the evolution page
    // after the integrated world/time/name guard ordering is applied.
    evolution: "e063_evolution_all",
    storyGate: "First Fight - Start / result event",
    lockPages: ["e024_first_fight_start"],
    battleStarts: ["e024_first_fight_start"],
    resultPages: ["e025_first_fight_win", "e026_first_fight_lose"],
    authoredLock: true,
  },
  {
    map: "spyder_radiotower",
    // Pin the inside-map ordering after the world-layer reset, day-cycle and
    // live player-name conditions materialize.
    evolution: "e018_evolution_all",
    storyGate: "Stop!",
    lockPages: ["e007_stop_r002"],
    battleStarts: ["e007_stop_r002"],
    resultPages: ["e007_stop_r002"],
    authoredLock: true,
  },
  {
    map: "taba_ba_br_1",
    evolution: "e015_evolution_all",
    storyGate: "move to middle / start fight / result event",
    lockPages: ["e008_move_to_middle_r001"],
    battleStarts: ["e008_move_to_middle_r001", "e009_start_fight"],
    resultPages: ["e010_won_battle", "e011_lost_battle"],
    authoredLock: true,
  },
  {
    map: "taba_ba_br_2",
    evolution: "e010_evolution_all",
    storyGate: "acolyte2 or battle redo / result event",
    lockPages: ["e004_acolyte2_r003", "e008_battle_redo_r005"],
    battleStarts: ["e004_acolyte2_r003", "e008_battle_redo_r005"],
    resultPages: ["e005_acolyte2battle_won", "e006_acolyte2battle_loss"],
    authoredLock: true,
  },
];

const EVOLUTION_BATTLE = oneTickBattle((ext) => ({
  ext: packTuxemonExtensionState({
    ...ext,
    party: ext.party.map((monster, index) => index === 0
      ? { ...monster, waitingToEvolve: true }
      : monster),
  }),
  result: "win",
}));

function evolutionHarness(entry: EvolutionCase): Project {
  const source = mapById(entry.map);
  const evolution = structuredClone(eventById(source, entry.evolution));
  const commands: Command[] = [
    ...(entry.authoredLock ? [{ op: "lockInput" } as const] : []),
    { op: "battle", setup: { kind: "trainer", opponent: `gw1_${entry.map}` } },
    { op: "switch", id: "fixture.battle-exited", value: true },
    ...(entry.authoredLock ? [
      { op: "wait", seconds: 3 / 60 } as const,
      { op: "switch", id: "fixture.story-complete", value: true } as const,
      { op: "unlockInput" } as const,
      { op: "switch", id: "fixture.story-unlocked", value: true } as const,
    ] : []),
    { op: "switch", id: "fixture.done", value: true },
  ];
  const boundary: GameEvent = {
    id: "a_gw1_battle_boundary",
    name: entry.storyGate,
    x: 0,
    y: 0,
    pages: [
      { trigger: "autorun", commands },
      { trigger: "action", condition: { switch: "fixture.done" }, commands: [] },
    ],
  };
  return {
    ...IMPORTED,
    title: `GW1 ${entry.map} evolution boundary`,
    start: { map: entry.map, x: 0, y: 0, dir: "down" },
    maps: [{ ...source, events: [boundary, evolution] }],
  };
}

function runEvolutionBoundary(entry: EvolutionCase): {
  battleExit: number;
  unlock: number;
  choice: number;
  evolved: string;
} {
  const project = evolutionHarness(entry);
  const session = createSession(project, 60, {
    extensions: TUXEMON_EXTENSIONS,
    scenes: TUXEMON_SCENES,
    battle: EVOLUTION_BATTLE,
  });
  let state = startSession(
    project,
    session,
    createSwitchState(),
    spawnedExtension("cataspike", 9) as unknown as JsonValue,
  );
  let battleExit = -1;
  let unlock = entry.authoredLock ? -1 : 0;
  let choice = -1;

  for (let frame = 0; frame < 100; frame++) {
    const before = state;
    state = stepSession(session, state, {
      buttons: 0,
      confirmEdge: state.interp.modal?.kind === "choices",
      cancelEdge: false,
      upEdge: false,
      downEdge: false,
    });
    if (before.scene && !state.scene && battleExit < 0) battleExit = frame;
    if (entry.authoredLock && state.sw.switches["fixture.story-unlocked"] && unlock < 0) unlock = frame;
    if (state.interp.modal?.kind === "choices" && choice < 0) choice = frame;

    if (state.scene !== null || state.interp.inputLocked) {
      expect(state.interp.modal?.kind, `${entry.map}: evolution while blocked`).not.toBe("choices");
    }
    if (state.interp.error) throw new Error(`${entry.map}: ${state.interp.error.message}`);
    const monster = tuxemonExtensionState(state.ext, TUXEMON_BATTLE_DB).party[0]!;
    if (choice >= 0 && monster.waitingToEvolve !== true) {
      return { battleExit, unlock, choice, evolved: monster.slug };
    }
  }
  throw new Error(`${entry.map}: evolution choice did not complete`);
}

describe("GW1 imported Evolution all gates", () => {
  test("the five real pages wait for battle/story release before evolving", () => {
    const results = EVOLUTION_CASES.map((entry) => {
      const result = runEvolutionBoundary(entry);
      expect(result.battleExit, `${entry.map}: battle exit`).toBeGreaterThanOrEqual(0);
      expect(result.choice, `${entry.map}: choice after battle`).toBeGreaterThanOrEqual(result.battleExit);
      if (entry.authoredLock) {
        expect(result.unlock, `${entry.map}: authored unlock`).toBeGreaterThan(result.battleExit);
        expect(result.choice, `${entry.map}: choice after unlock`).toBeGreaterThanOrEqual(result.unlock);
      }
      expect(result.evolved, `${entry.map}: confirmed evolution`).toBe("puparmor");
      return { map: entry.map, storyGate: entry.storyGate, ...result };
    });
    console.log("GW1 EVOLUTION LOCAL", JSON.stringify(results));
  });

  test("each locked probe is backed by the imported story's lock/battle/unlock pages", () => {
    for (const entry of EVOLUTION_CASES) {
      const map = mapById(entry.map);
      const evolution = eventCommands(eventById(map, entry.evolution));
      expect(evolution).toContainEqual(expect.objectContaining({
        op: "if",
        if: { kind: "worldIdle" },
      }));
      if (!entry.authoredLock) continue;

      for (const id of entry.lockPages) {
        const commands = eventCommands(eventById(map, id));
        expect(commands.some((command) => command.op === "lockInput"), `${entry.map}/${id} lock`).toBeTrue();
      }
      for (const id of entry.battleStarts) {
        const commands = eventCommands(eventById(map, id));
        expect(commands.some((command) => command.op === "battle"), `${entry.map}/${id} battle`).toBeTrue();
      }
      for (const id of entry.resultPages) {
        const commands = eventCommands(eventById(map, id));
        expect(commands.some((command) => command.op === "unlockInput"), `${entry.map}/${id} unlock`).toBeTrue();
      }
    }
  });
});

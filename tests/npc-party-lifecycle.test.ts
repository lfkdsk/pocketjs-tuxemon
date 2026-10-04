import { describe, expect, test } from "bun:test";

import {
  initialTuxemonExtensionState,
  tuxemonExtensionState,
} from "../battle/extension.ts";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import {
  createTuxemonSessionOptions,
  TUXEMON_BATTLE_DB as DB,
  TUXEMON_BATTLE_RULES as rules,
  TUXEMON_EXTENSIONS as extensions,
} from "../battle/game.ts";
import { tuxemonRuntimeBattleState } from "../battle/runtime.ts";
import { spawnMonster } from "../battle/spawn.ts";
import { buildProject, G6_IMPORT_OPTIONS } from "../importer/project.ts";
import { BTN_BITS } from "../vendor/pocket-rpgkit/src/engine/camera.ts";
import { createSession, startSession, stepSession, type SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { Command, JsonValue, Project, WorldTraversalMode } from "../vendor/pocket-rpgkit/src/engine/types.ts";

// Upstream drops every non-persistent NPC on each map transition
// (npc_manager.clear_npcs) and builds a fresh one on create_npc, so a trainer
// only ever fights with the monsters its current map visit added. These tests
// replay the real imported Billie and Marion events through the battle
// extension and rules, with a map visit modelled as the kit's local-bank reset
// followed by the map's imported entry event; the last test walks through a
// real imported door in a kit session.

const RULE_DB = battleDbToTuxemonBattleDb(DB);
const MAPS = ["spyder_paper_town", "spyder_route2", "spyder_route4", "spyder_routea", "spyder_dojo4"];
const build = buildProject(MAPS, G6_IMPORT_OPTIONS);

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function eventCommands(map: string, id: string): Command[] {
  const event = build.project.maps?.find((entry) => entry.id === map)?.events?.find((entry) => entry.id === id);
  if (!event) throw new Error(`${map}/${id} is not imported`);
  return event.pages.flatMap((page) => page.commands);
}

interface Visit {
  ext: JsonValue;
  variables: Record<string, number | string>;
  enemies: string[][];
  results: string[];
}

function finish(state: JsonValue) {
  let value = state;
  for (let guard = 0; guard < 20_000; guard++) {
    const runtime = tuxemonRuntimeBattleState(value);
    const completion = rules.done(value);
    if (completion) return completion;
    const presenting = runtime.eventCursor < runtime.battle.events.length;
    value = rules.step(value, presenting ? { buttons: 0 } : { buttons: 0, confirmEdge: true }, 15);
  }
  throw new Error("battle did not finish");
}

/** Replays the party-relevant commands of an imported event in order: the
 *  create/remove NPC variable writes and their tux.clear_npc_party(ies) calls,
 *  extension add_monster, and Battle Processing. Guards on `local.npc.*`
 *  are evaluated; every other branch takes its authored main path. */
function replay(visit: Visit, commands: readonly Command[], seed: number): void {
  for (const command of commands) {
    const node = command as Record<string, unknown> & Command;
    if (node.op === "variable") {
      const set = node.set as { op: string; value: number };
      if (set.op === "set") visit.variables[node.id as string] = set.value;
    } else if (node.op === "if") {
      const condition = node.if as { kind: string; id?: string; op?: string; value?: number };
      if (condition.kind === "variable" && condition.id?.startsWith("local.npc.")) {
        const current = visit.variables[condition.id] ?? 0;
        const holds = condition.op === "==" ? current === condition.value : current !== condition.value;
        replay(visit, (holds ? node.then : node.else ?? []) as Command[], seed);
      } else {
        replay(visit, node.then as Command[], seed);
      }
    } else if (node.op === "ext") {
      const handler = extensions.commands![node.call as string];
      if (!["tux.add_monster", "tux.clear_npc_party", "tux.clear_npc_parties"].includes(node.call as string)) continue;
      const result = handler!({
        ext: visit.ext,
        variables: visit.variables,
        switches: {},
        items: {},
        gold: 0,
        playerName: "Player",
        random: () => 0,
      }, node.args as JsonValue);
      if (result?.ext !== undefined) visit.ext = result.ext;
    } else if (node.op === "battle") {
      const started = rules.start(visit.ext, node.setup as JsonValue, seed, {
        ext: visit.ext,
        switches: {},
        variables: visit.variables,
        items: {},
        gold: 0,
        playerName: "Player",
      });
      if (!started) throw new Error("battle did not start");
      visit.enemies.push(tuxemonRuntimeBattleState(started.state).battle.parties[1]!
        .map((monster) => `${monster.slug}@${monster.level}`));
      const completion = finish(started.state);
      visit.results.push(completion.result);
      visit.ext = completion.ext;
    }
  }
}

/** A new map visit: the kit clears every `local.*` id on map entry, then the
 *  map's imported entry event drops every non-persistent NPC party. */
function enter(visit: Visit, map: string): void {
  for (const id of Object.keys(visit.variables)) if (id.startsWith("local.")) delete visit.variables[id];
  replay(visit, eventCommands(map, "e000_npc_parties"), 0);
}

function playerExt(level: number): JsonValue {
  const player = spawnMonster(DB, RULE_DB, { rng: 7, rngDraws: 0 }, "nut", level, { iid: "txmn-player" });
  return json({ ...initialTuxemonExtensionState(), party: [player], environment: "grass", nextMonsterId: 2 });
}

function npcParty(ext: JsonValue, npc: string): string[] | undefined {
  return tuxemonExtensionState(ext, DB).npcParties[npc]
    ?.map((monster) => `${monster.slug}@${monster.level}`);
}

describe("NPC party lifecycle follows upstream", () => {
  test("each Billie battle uses only the monsters its own map visit added", () => {
    // Billie takes the starter the mainline picks (budaye).
    const visit: Visit = { ext: playerExt(90), variables: { "v.billie_choice": "budaye" }, enemies: [], results: [] };
    const fights: [string, string][] = [
      ["spyder_paper_town", "e024_first_fight_start"],
      ["spyder_route2", "e036_billie_encounter_r036"],
      ["spyder_route4", "e038_billie_r016"],
      ["spyder_routea", "e014_billie_r019"],
      ["spyder_dojo4", "e006_billie_encounter_r001"],
    ];
    fights.forEach(([map, id], index) => {
      // By the dojo the story has moved Billie's starter variable on to its
      // evolution, as in the recorded J2 journey.
      if (map === "spyder_dojo4") visit.variables["v.billie_choice"] = "bamboon";
      enter(visit, map);
      expect(tuxemonExtensionState(visit.ext, DB).npcParties).toEqual({});
      replay(visit, eventCommands(map, id), 11 + index);
    });
    // The upstream parties: each map's add_monster calls and nothing else.
    expect(visit.enemies).toEqual([
      ["budaye@5"],
      ["budaye@6", "eyenemy@6", "cardiling@3"],
      ["budaye@18", "cardiwing@16", "eyesore@16"],
      ["budaye@20", "cardiwing@17", "eyesore@17", "viviphyta@17"],
      ["bamboon@34", "eyesore@30", "cardiwing@30", "viviphyta@30"],
    ]);
    expect(visit.results.every((result) => result === "win")).toBe(true);
  });

  test("losing to Marion and coming back does not double her party", () => {
    const visit: Visit = { ext: playerExt(2), variables: {}, enemies: [], results: [] };
    enter(visit, "spyder_route2");
    replay(visit, eventCommands("spyder_route2", "e040_create_marion"), 21);
    replay(visit, eventCommands("spyder_route2", "e047_talk_marion_r047"), 21);
    expect(visit.results).toEqual(["lose"]);
    expect(npcParty(visit.ext, "spyder_route2_marion")).toHaveLength(2);

    // The defeat teleports the player away; the next visit re-creates Marion.
    const state = tuxemonExtensionState(visit.ext, DB);
    visit.ext = json({ ...state, party: tuxemonExtensionState(playerExt(90), DB).party });
    enter(visit, "spyder_route2");
    expect(npcParty(visit.ext, "spyder_route2_marion")).toBeUndefined();
    replay(visit, eventCommands("spyder_route2", "e040_create_marion"), 22);
    replay(visit, eventCommands("spyder_route2", "e047_talk_marion_r047"), 22);
    expect(visit.enemies[1]).toEqual(visit.enemies[0]);
    expect(visit.enemies[1]).toHaveLength(2);
    expect(visit.results[1]).toBe("win");
  });

  test("an NPC already on the map keeps its party; remove_npc discards it", () => {
    const visit: Visit = { ext: playerExt(90), variables: {}, enemies: [], results: [] };
    enter(visit, "spyder_route2");
    replay(visit, eventCommands("spyder_route2", "e040_create_marion"), 31);
    replay(visit, eventCommands("spyder_route2", "e047_talk_marion_r047"), 31);
    const after = npcParty(visit.ext, "spyder_route2_marion");
    expect(after).toHaveLength(2);
    // create_npc for an NPC that already exists is a no-op upstream.
    replay(visit, eventCommands("spyder_route2", "e040_create_marion"), 32);
    expect(npcParty(visit.ext, "spyder_route2_marion")).toEqual(after);
    // Billie's Route 2 win follow-up ends with remove_npc spyder_billie.
    visit.variables["v.billie_choice"] = "budaye";
    replay(visit, eventCommands("spyder_route2", "e036_billie_encounter_r036"), 33);
    expect(visit.enemies.at(-1)).toHaveLength(3);
    expect(npcParty(visit.ext, "spyder_billie")).toHaveLength(3);
    replay(visit, eventCommands("spyder_route2", "e037_billie_encounter_win"), 34);
    expect(npcParty(visit.ext, "spyder_billie")).toBeUndefined();
  });

  test("a real transfer drops every NPC party; staying on the map keeps them", () => {
    // Route 2's west edge is an imported playerTouch transition_teleport to
    // Cotton Town; start one step east of it, facing it.
    const project: Project = {
      ...TRANSFER_BUILD.project,
      start: { map: "spyder_route2", x: 1, y: 8, dir: "left" },
    };
    const session = createSession(project, 60, createTuxemonSessionOptions(project));
    let state = startSession(project, session);
    const idle = { buttons: 0 };
    state = stepSession(session, state, idle);
    // A trainer's party built on this visit (as create_npc + add_monster do).
    const add = extensions.commands!["tux.add_monster"]!;
    for (const level of [7, 7]) {
      const result = add(context(state), json({ character: "spyder_route2_marion", species: "aardorn", level }));
      state.ext = result!.ext!;
    }
    for (let frame = 0; frame < 120; frame++) state = stepSession(session, state, idle);
    expect(state.mapId).toBe("spyder_route2");
    expect(npcParty(state.ext, "spyder_route2_marion")).toEqual(["aardorn@7", "aardorn@7"]);

    // Walk into the marked outdoor opening. This transfer sits under the
    // importer's inline stacked-area guard; it is still a root fiber command
    // and therefore starts a real seamless handoff.
    for (let frame = 0; frame < 240 && state.handoff === undefined; frame++) {
      state = stepSession(session, state, { buttons: BTN_BITS.LEFT });
    }
    expect(state.mapId).toBe("spyder_route2");
    expect(state.handoff).toMatchObject({
      sourceMapId: "spyder_route2",
      targetMapId: "spyder_cotton_town",
      phase: 0,
      totalTicks: 8,
    });
    expect(state.fade).toBeNull();
    // clearNpcParties precedes transfer, so no source or crossing frame can
    // retain a trainer party.
    expect(tuxemonExtensionState(state.ext, DB).npcParties).toEqual({});
    const phases: number[] = [];
    while (state.handoff) {
      phases.push(state.handoff.phase);
      state = stepSession(session, state, idle);
    }
    expect(phases).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(state.mapId).toBe("spyder_cotton_town");
    // Gone with the transfer itself, before the new map's first tick: no
    // frame on Cotton Town (saveable or not) still holds Route 2's NPCs.
    expect(tuxemonExtensionState(state.ext, DB).npcParties).toEqual({});
    for (let frame = 0; frame < 60; frame++) state = stepSession(session, state, idle);
    const parties = tuxemonExtensionState(state.ext, DB).npcParties;
    expect(parties["spyder_route2_marion"]).toBeUndefined();
    // Whatever is left was built by Cotton Town's own events on this visit.
    for (const npc of Object.keys(parties)) expect(COTTON_TOWN_TRAINERS.has(npc)).toBe(true);
  });

  test("seamless and legacy transfers preserve map-entry semantics with documented clock differences", () => {
    const daycareStep = extensions.commands!["tux.player_step"]!;
    const countedExtensions = {
      ...extensions,
      commands: {
        ...extensions.commands,
        "test.count_player_step": (ctx: Parameters<typeof daycareStep>[0], args: JsonValue) => {
          const result = daycareStep(ctx, args);
          const previous = ctx.variables["test.player_steps"];
          return {
            ...(result ?? {}),
            writes: {
              ...(result?.writes ?? {}),
              "test.player_steps": (typeof previous === "number" ? previous : 0) + 1,
            },
          };
        },
      },
      playerStep: { call: "test.count_player_step", args: {} },
    };

    const cross = (worldTraversal: WorldTraversalMode) => {
      const project: Project = {
        ...TRANSFER_BUILD.project,
        system: { ...TRANSFER_BUILD.project.system, mapNameDisplay: true },
        start: { map: "spyder_route2", x: 1, y: 8, dir: "left" },
      };
      const session = createSession(project, 60, createTuxemonSessionOptions(project, worldTraversal, {
        extensions: countedExtensions,
      }));
      let state = startSession(project, session);
      for (let frame = 0; frame < 180; frame++) state = stepSession(session, state, { buttons: 0 });
      const add = extensions.commands!["tux.add_monster"]!;
      state.ext = add(context(state), json({ character: "spyder_route2_marion", species: "aardorn", level: 7 }))!.ext!;
      let guard = 0;
      while (guard++ < 240 && state.handoff === undefined && state.fade === null) {
        state = stepSession(session, state, { buttons: BTN_BITS.LEFT });
      }
      const onset = structuredClone(state);
      let transferTicks = 0;
      while (state.mapId === "spyder_route2" && transferTicks++ < 60) {
        state = stepSession(session, state, { buttons: 0 });
      }
      const committed = structuredClone(state);
      while (state.fade) state = stepSession(session, state, { buttons: 0 });
      state = stepSession(session, state, { buttons: 0 });
      return { onset, committed, entered: state, transferTicks };
    };

    const legacy = cross("legacy-transfer");
    const seamless = cross("seamless-v1");
    expect(legacy.onset.fade?.phase).toBe("out");
    expect(legacy.onset.handoff).toBeUndefined();
    expect(seamless.onset.fade).toBeNull();
    expect(seamless.onset.handoff?.phase).toBe(0);
    expect(seamless.transferTicks).toBe(8);
    expect(legacy.transferTicks).toBe(9);

    for (const sample of [legacy.onset, seamless.onset, legacy.committed, seamless.committed]) {
      expect(tuxemonExtensionState(sample.ext, DB).npcParties).toEqual({});
      expect(sample.sw.variables["test.player_steps"]).toBe(1);
      expect(sample.scene).toBeNull();
    }
    expect([legacy.committed.mapId, legacy.committed.move.tx, legacy.committed.move.ty])
      .toEqual(["spyder_cotton_town", 39, 28]);
    expect([seamless.committed.mapId, seamless.committed.move.tx, seamless.committed.move.ty])
      .toEqual(["spyder_cotton_town", 39, 28]);

    const legacyOnset = tuxemonExtensionState(legacy.onset.ext, DB);
    const seamlessOnset = tuxemonExtensionState(seamless.onset.ext, DB);
    const legacyCommit = tuxemonExtensionState(legacy.committed.ext, DB);
    const seamlessCommit = tuxemonExtensionState(seamless.committed.ext, DB);
    expect(seamlessOnset.clock).toEqual(legacyOnset.clock);
    expect(seamlessCommit.clock.refTick - seamlessOnset.clock.refTick).toBe(8);
    expect(legacyCommit.clock.refTick).toBe(legacyOnset.clock.refTick);
    expect(seamlessCommit.weather).toEqual(legacyCommit.weather);

    // Audio ticks in both transitions, while source map tints/time advance
    // only during seamless handoff. Target entry creates the same banner.
    expect(seamless.committed.interp.audio?.bgm?.id).toBe(legacy.committed.interp.audio?.bgm?.id);
    expect(seamless.committed.interp.audio!.bgm!.positionTicks - seamless.onset.interp.audio!.bgm!.positionTicks).toBe(8);
    expect(legacy.committed.interp.audio!.bgm!.positionTicks - legacy.onset.interp.audio!.bgm!.positionTicks).toBe(9);
    expect(seamless.onset.interp.screen!.tints!["tux.daylight"]!.left -
      seamless.committed.interp.screen!.tints!["tux.daylight"]!.left).toBe(8);
    expect(legacy.committed.interp.screen!.tints!["tux.daylight"]!.left)
      .toBe(legacy.onset.interp.screen!.tints!["tux.daylight"]!.left);
    expect(seamless.committed.interp.screen?.mapNameBanner)
      .toEqual(legacy.committed.interp.screen?.mapNameBanner);
    expect(seamless.committed.interp.screen?.mapNameBanner?.text).toBe("Cotton Town");
    expect(seamless.entered.sw.variables["test.player_steps"]).toBe(1);
    expect(legacy.entered.sw.variables["test.player_steps"]).toBe(1);
    expect(tuxemonExtensionState(seamless.entered.ext, DB).weather)
      .toEqual(tuxemonExtensionState(legacy.entered.ext, DB).weather);
  });

  test("a map entry that is not an imported transfer (a demo warp) still drops them", () => {
    const project: Project = {
      ...TRANSFER_BUILD.project,
      start: { map: "spyder_route2", x: 1, y: 8, dir: "left" },
    };
    const session = createSession(project, 60, { extensions, battle: rules });
    let state = startSession(project, session);
    const add = extensions.commands!["tux.add_monster"]!;
    state.ext = add(context(state), json({ character: "spyder_route2_marion", species: "aardorn", level: 7 }))!.ext!;
    // The demo warp restarts the session on another map with the live banks.
    const warped: Project = { ...project, start: { map: "spyder_cotton_town", x: 39, y: 28, dir: "left" } };
    state = startSession(warped, session, state.sw, state.ext);
    expect(npcParty(state.ext, "spyder_route2_marion")).toEqual(["aardorn@7"]);
    state = stepSession(session, state, { buttons: 0 });
    expect(npcParty(state.ext, "spyder_route2_marion")).toBeUndefined();
  });
});

const TRANSFER_BUILD = buildProject(["spyder_route2", "spyder_cotton_town"], G6_IMPORT_OPTIONS);
const COTTON_TOWN_TRAINERS = new Set(
  JSON.stringify(TRANSFER_BUILD.project.maps!.find((map) => map.id === "spyder_cotton_town")!.events)
    .match(/"call":"tux\.add_monster","args":\{"character":"[^"]+"/g)
    ?.map((match) => match.slice(match.lastIndexOf(":") + 2, -1)) ?? [],
);

function context(state: SessionState) {
  return {
    ext: state.ext,
    variables: state.sw.variables,
    switches: state.sw.switches,
    items: {},
    gold: 0,
    playerName: "Player",
    random: () => 0,
  };
}

import { describe, expect, test } from "bun:test";

import {
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
  TUXEMON_EXT_SAVE_FORMAT,
  tuxemonExtensionState,
  tuxepediaEntryFor,
  type PendingMonster,
  type TuxemonExtensionState,
} from "../battle/extension.ts";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import {
  TUXEMON_BATTLE_DB as DB,
  TUXEMON_EXTENSIONS as extensions,
  TUXEMON_SCENES as scenes,
} from "../battle/game.ts";
import { spawnMonster } from "../battle/spawn.ts";
import {
  pcMenuItems,
  pcVisibleBoxes,
  TUXEMON_PC_SCENE_ID,
  type PcSceneState,
} from "../battle/storage-scenes.ts";
import { buildProject, G6_IMPORT_OPTIONS } from "../importer/project.ts";
import type {
  ExtensionCommandContext,
  ExtensionCommandResult,
} from "../vendor/pocket-rpgkit/src/engine/extensions.ts";
import type { SceneInput, SceneRules } from "../vendor/pocket-rpgkit/src/engine/scene.ts";
import type { Command, JsonValue } from "../vendor/pocket-rpgkit/src/engine/types.ts";

const RULE_DB = battleDbToTuxemonBattleDb(DB);
const NPC = "spyder_dojo_kataro";
const PRESENT = { [`local.npc.${NPC}`]: 1 };

// These maps supply the authored forms whose lowering is exercised below.
// The NPC bag action is authored directly; named-character kennel/PC variants
// are derived from the exact player-owned lowerings because the corpus has no
// NPC terminal event.
const IMPORTED = buildProject([
  "spyder_dojo2",
  "spyder_dojo4",
  "spyder_bedroom",
  "spyder_dryadsgrove",
  "spyder_nimrod_middle",
], G6_IMPORT_OPTIONS);

type ExtCommand = Extract<Command, { op: "ext" }>;
type SceneCommand = Extract<Command, { op: "scene" }>;

function objectNodes(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const child of value) objectNodes(child, out);
  } else if (value !== null && typeof value === "object") {
    const node = value as Record<string, unknown>;
    out.push(node);
    for (const child of Object.values(node)) objectNodes(child, out);
  }
  return out;
}

function importedMap(id: string) {
  const map = IMPORTED.project.maps.find((candidate) => candidate.id === id);
  if (!map) throw new Error(`map ${id} was not imported`);
  return map;
}

function importedEvent(mapId: string, eventId: string) {
  const event = importedMap(mapId).events?.find((candidate) => candidate.id === eventId);
  if (!event) throw new Error(`event ${mapId}/${eventId} was not imported`);
  return event;
}

function extCommands(value: unknown): ExtCommand[] {
  return objectNodes(value)
    .filter((node) => node.op === "ext" && typeof node.call === "string")
    .map((node) => node as unknown as ExtCommand);
}

function sceneCommands(value: unknown): SceneCommand[] {
  return objectNodes(value)
    .filter((node) => node.op === "scene" && typeof node.id === "string")
    .map((node) => node as unknown as SceneCommand);
}

function argsOf(command: ExtCommand | SceneCommand): Record<string, JsonValue> {
  const args = command.args;
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new Error(`${command.op} command has no object args`);
  }
  return args as Record<string, JsonValue>;
}

function patchedArgs(
  command: ExtCommand | SceneCommand,
  patch: Record<string, JsonValue>,
): JsonValue {
  return { ...argsOf(command), ...patch };
}

function context(
  ext: JsonValue,
  variables: Record<string, string | number> = {},
): ExtensionCommandContext {
  return {
    ext,
    switches: {},
    variables,
    items: {},
    gold: 0,
    playerName: "G18",
    random: () => 0.5,
  };
}

function execute(
  ext: JsonValue,
  call: string,
  args: JsonValue,
  variables: Record<string, string | number> = {},
): { ext: JsonValue; result: ExtensionCommandResult | void } {
  const handler = extensions.commands?.[call];
  if (!handler) throw new Error(`extension command ${call} is not registered`);
  const result = handler(context(ext, variables), args);
  return { ext: result?.ext ?? ext, result };
}

function pending(iid: string, slug: string): PendingMonster {
  return { iid, slug, level: 12, experienceModifier: 5, moneyModifier: 10 };
}

function packed(update: (state: TuxemonExtensionState) => void): JsonValue {
  const state = initialTuxemonExtensionState();
  update(state);
  return packTuxemonExtensionState(state);
}

function stepScene(rules: SceneRules, state: JsonValue, ...inputs: Partial<SceneInput>[]): JsonValue {
  let current = state;
  for (const input of inputs) {
    current = rules.step(structuredClone(current), { buttons: 0, ...input }, 1);
  }
  return current;
}

const A = { confirmEdge: true };
const B = { cancelEdge: true };
const UP = { upEdge: true };
const DOWN = { downEdge: true };

describe("G18 runtime seams", () => {
  test("real dojo4 Tuxepedia writes keep counters and character journals independent through saves", () => {
    const authored = extCommands(importedEvent("spyder_dojo4", "e006_billie_encounter_r001"))
      .filter((command) => command.call === "tux.set_tuxepedia");
    expect(authored).toHaveLength(6);
    expect(authored.map((command) => argsOf(command))).toEqual([
      "eyesore", "cardiwing", "vivipere", "viviphyta", "eyenemy", "cardiling",
    ].map((species) => ({ character: "player", species, status: "seen" })));

    let value: JsonValue = extensions.initial!;
    for (const command of authored) value = execute(value, command.call, command.args).ext;
    let state = tuxemonExtensionState(value, DB);
    expect(state.seen).toEqual(["eyesore", "cardiwing", "vivipere", "viviphyta", "eyenemy", "cardiling"]);
    expect(state.caught).toEqual([]);
    expect(state.tuxepediaEntries).toBeUndefined();

    const eyesore = authored[0]!;
    value = execute(value, eyesore.call, eyesore.args).ext;
    value = execute(value, eyesore.call, patchedArgs(eyesore, { status: "caught" })).ext;
    const refusedDowngrade = execute(value, eyesore.call, eyesore.args);
    expect(refusedDowngrade.result).toBeUndefined();
    expect(refusedDowngrade.ext).toBe(value);
    state = tuxemonExtensionState(value, DB);
    // Mutation guard: dropping repeat counts, double-counting a transition, or
    // allowing caught -> seen to weaken the entry changes this exact tuple.
    expect(tuxepediaEntryFor(state, "player", "eyesore")).toEqual({
      status: "caught",
      appearanceCount: 3,
      caughtCount: 1,
    });

    value = execute(value, eyesore.call, patchedArgs(eyesore, {
      character: NPC,
      status: "seen",
    }), PRESENT).ext;
    value = execute(value, eyesore.call, patchedArgs(eyesore, {
      character: NPC,
      status: "seen",
    }), PRESENT).ext;
    value = execute(value, eyesore.call, patchedArgs(eyesore, {
      character: NPC,
      species: "nut",
      status: "caught",
    }), PRESENT).ext;
    state = tuxemonExtensionState(value, DB);
    expect(tuxepediaEntryFor(state, NPC, "eyesore")).toEqual({
      status: "seen",
      appearanceCount: 2,
      caughtCount: 0,
    });
    expect(tuxepediaEntryFor(state, "player", "eyesore")?.status).toBe("caught");
    expect(tuxepediaEntryFor(state, NPC, "nut")).toEqual({
      status: "caught",
      appearanceCount: 1,
      caughtCount: 0,
    });
    const hasTuxepedia = extensions.conditions!["tux.has_tuxepedia"]!;
    expect(hasTuxepedia(context(value, PRESENT), {
      character: NPC,
      species: "eyesore",
      status: "seen",
      negate: false,
    })).toBeTrue();
    expect(hasTuxepedia(context(value, PRESENT), {
      character: NPC,
      species: "eyesore",
      status: "caught",
      negate: true,
    })).toBeTrue();
    // Upstream raises while resolving an absent named character, so its
    // evaluator fails both positive and negated forms instead of inverting.
    expect(hasTuxepedia(context(value), {
      character: NPC,
      species: "eyesore",
      status: "seen",
      negate: false,
    })).toBeFalse();
    expect(hasTuxepedia(context(value), {
      character: NPC,
      species: "eyesore",
      status: "seen",
      negate: true,
    })).toBeFalse();

    const encoded = JSON.parse(JSON.stringify(extensions.codec!.encode(value))) as JsonValue;
    expect(encoded).toMatchObject({ format: TUXEMON_EXT_SAVE_FORMAT });
    value = extensions.codec!.decode(encoded);
    expect(tuxemonExtensionState(value, DB)).toEqual(state);

    value = execute(value, eyesore.call, patchedArgs(eyesore, { status: "unseen" })).ext;
    state = tuxemonExtensionState(value, DB);
    // Mutation guard: player removal must not delete the identically keyed NPC entry.
    expect(tuxepediaEntryFor(state, "player", "eyesore")).toBeUndefined();
    expect(tuxepediaEntryFor(state, NPC, "eyesore")?.appearanceCount).toBe(2);

    const offMap = execute(value, eyesore.call, patchedArgs(eyesore, {
      character: NPC,
      status: "unseen",
    }));
    expect(offMap.result).toBeUndefined();
    expect(offMap.ext).toBe(value);
    expect(tuxepediaEntryFor(tuxemonExtensionState(value, DB), NPC, "eyesore")).toBeDefined();

    value = execute(value, eyesore.call, patchedArgs(eyesore, {
      character: NPC,
      status: "unseen",
    }), PRESENT).ext;
    expect(tuxepediaEntryFor(tuxemonExtensionState(value, DB), NPC, "eyesore")).toBeUndefined();

    value = execute(value, eyesore.call, patchedArgs(eyesore, {
      character: NPC,
      status: "seen",
    }), PRESENT).ext;
    const kept = execute(value, "tux.clear_npc_parties", { keep: [NPC] });
    expect(kept.result).toBeUndefined();
    expect(tuxepediaEntryFor(tuxemonExtensionState(kept.ext, DB), NPC, "eyesore")).toBeDefined();
    value = execute(value, "tux.clear_npc_parties", { keep: [] }).ext;
    expect(tuxepediaEntryFor(tuxemonExtensionState(value, DB), NPC, "eyesore")).toBeUndefined();
  });

  test("real kennel and PC lowerings drive an independent named-NPC storage round trip", () => {
    const dojoCommands = extCommands(importedMap("spyder_dojo4"));
    const authoredNpcItem = extCommands(importedMap("spyder_dojo2"))
      .find((command) => command.call === "tux.add_npc_item");
    const authoredCreate = dojoCommands.find((command) => command.call === "tux.create_kennel");
    const authoredShow = dojoCommands.find((command) =>
      command.call === "tux.set_kennel_visible" && argsOf(command).visible === true);
    const authoredHide = dojoCommands.find((command) =>
      command.call === "tux.set_kennel_visible" && argsOf(command).visible === false);
    const authoredPc = sceneCommands(importedMap("spyder_bedroom"))
      .find((command) => command.id === TUXEMON_PC_SCENE_ID);
    expect(authoredCreate).toBeDefined();
    expect(authoredNpcItem).toBeDefined();
    expect(authoredShow).toBeDefined();
    expect(authoredHide).toBeDefined();
    expect(authoredPc).toBeDefined();
    expect(argsOf(authoredCreate!)).toMatchObject({ character: "player", kennel: "quarantine", hidden: true });
    expect(argsOf(authoredShow!)).toMatchObject({ character: "player", kennel: "quarantine", visible: true });
    expect(argsOf(authoredNpcItem!)).toEqual({
      character: NPC,
      item: "wood_berry",
      quantity: 1,
    });

    let value = packed((state) => {
      state.npcParties[NPC] = [pending("npc-a", "nut"), pending("npc-b", "rockitten")];
    });
    const npcCreate = patchedArgs(authoredCreate!, { character: NPC });
    const npcShow = patchedArgs(authoredShow!, { character: NPC });
    const npcHide = patchedArgs(authoredHide!, { character: NPC });
    const npcPc = patchedArgs(authoredPc!, { character: NPC });
    const pc = scenes[TUXEMON_PC_SCENE_ID]!;

    // Off-map and missing targets are deliberate no-ops. Mutating the presence
    // gate would create saved NPC state or open a scene for no live character.
    expect(execute(value, authoredCreate!.call, npcCreate).result).toBeUndefined();
    expect(pc.start(value, npcPc, 1, context(value))).toBeNull();
    expect(() => execute(value, authoredNpcItem!.call, authoredNpcItem!.args))
      .toThrow(`tux.add_npc_item: NPC '${NPC}' not found`);
    expect(execute(value, authoredShow!.call, patchedArgs(authoredShow!, {
      character: NPC,
      kennel: "Kennel",
    })).result).toBeUndefined();

    value = execute(value, authoredNpcItem!.call, authoredNpcItem!.args, PRESENT).ext;
    value = execute(value, authoredNpcItem!.call, patchedArgs(authoredNpcItem!, {
      item: "potion",
      quantity: 2,
    }), PRESENT).ext;
    const insufficientRemoval = execute(value, authoredNpcItem!.call, patchedArgs(authoredNpcItem!, {
      item: "potion",
      quantity: -3,
    }), PRESENT);
    expect(insufficientRemoval.result).toBeUndefined();
    expect(insufficientRemoval.ext).toBe(value);
    expect(tuxemonExtensionState(value, DB).npcItems?.[NPC]).toEqual({
      bag: { wood_berry: 1, potion: 2 },
      locker: {},
    });
    value = execute(value, authoredCreate!.call, npcCreate, PRESENT).ext;
    value = execute(value, authoredCreate!.call, patchedArgs(authoredCreate!, {
      character: NPC,
      kennel: "closed",
      capacity: 0,
    }), PRESENT).ext;
    let state = tuxemonExtensionState(value, DB);
    expect(state.npcBoxes?.[NPC]?.quarantine).toEqual({ hidden: true, capacity: 30, monsters: [] });
    expect(state.npcBoxes?.[NPC]?.closed).toEqual({ hidden: true, capacity: 0, monsters: [] });
    expect(() => execute(value, authoredShow!.call, patchedArgs(authoredShow!, {
      character: NPC,
      kennel: "Kennel",
    }), PRESENT)).toThrow("Kennel cannot be made invisible");
    expect(execute(value, authoredShow!.call, npcShow).result).toBeUndefined();
    expect(tuxemonExtensionState(value, DB).npcBoxes?.[NPC]?.quarantine.hidden).toBe(true);
    expect(execute(value, authoredHide!.call, npcHide, PRESENT).result).toBeUndefined();
    expect(execute(value, authoredShow!.call, patchedArgs(authoredShow!, {
      character: NPC,
      kennel: "missing",
    }), PRESENT).result).toBeUndefined();
    value = execute(value, authoredShow!.call, npcShow, PRESENT).ext;
    expect(tuxemonExtensionState(value, DB).npcBoxes?.[NPC]?.quarantine.hidden).toBe(false);
    expect(extensions.conditions!["tux.kennel"]!(context(value, PRESENT), {
      character: NPC,
      kennel: "quarantine",
      option: "visible",
      negate: false,
    })).toBeTrue();
    expect(extensions.conditions!["tux.kennel"]!(context(value), {
      character: NPC,
      kennel: "quarantine",
      option: "visible",
      negate: false,
    })).toBeFalse();

    const started = pc.start(value, npcPc, 1, context(value, PRESENT));
    expect(started).not.toBeNull();
    state = tuxemonExtensionState(started!.ext, DB);
    expect(state.npcBoxes?.[NPC]?.Kennel).toEqual({ hidden: false, capacity: 30, monsters: [] });
    expect(state.kennelBox).toBeUndefined();

    let draft = started!.state;
    const view = () => draft as unknown as PcSceneState;
    expect(view().character).toBe(NPC);
    expect(pcMenuItems(view())).toEqual(["dropOff", "itemDropOff", "multiplayer", "logOff"]);
    expect(pcVisibleBoxes(view()).map((box) => box.id)).toEqual(["quarantine", "Kennel"]);
    draft = stepScene(pc, draft, A, A);
    const quarantine = pcVisibleBoxes(view()).findIndex((box) => box.id === "quarantine");
    for (let index = 0; index < quarantine; index++) draft = stepScene(pc, draft, DOWN);
    draft = stepScene(pc, draft, A);
    // Mutation guard: committing through the player path would move npc-a into
    // the player's kennel instead of this NPC's independent named box.
    expect(view().party).toEqual(["npc-b"]);
    expect(view().boxes.find((box) => box.id === "quarantine")?.monsters).toEqual(["npc-a"]);
    draft = stepScene(pc, draft, UP, A);
    const deposited = pc.done(draft);
    expect(deposited).not.toBeNull();
    state = tuxemonExtensionState(deposited!.ext!, DB);
    expect(state.npcParties[NPC]?.map((monster) => monster.iid)).toEqual(["npc-b"]);
    expect(state.npcBoxes?.[NPC]?.quarantine.monsters.map((monster) => monster.iid)).toEqual(["npc-a"]);
    expect(state.party).toEqual([]);
    expect(state.kennel).toEqual([]);
    expect(extensions.conditions!["tux.has_kennel"]!(context(deposited!.ext!, PRESENT), {
      character: NPC,
      kennel: "quarantine",
      operator: "equals",
      value: 1,
      negate: false,
    })).toBeTrue();
    expect(extensions.conditions!["tux.has_kennel"]!(context(deposited!.ext!), {
      character: NPC,
      kennel: "quarantine",
      operator: "equals",
      value: 1,
      negate: false,
    })).toBeFalse();
    expect(extensions.conditions!["tux.has_kennel"]!(context(deposited!.ext!), {
      character: NPC,
      kennel: "quarantine",
      operator: "equals",
      value: 1,
      negate: true,
    })).toBeTrue();

    const encoded = JSON.parse(JSON.stringify(extensions.codec!.encode(deposited!.ext!))) as JsonValue;
    value = extensions.codec!.decode(encoded);
    const reopened = pc.start(value, npcPc, 2, context(value, PRESENT));
    expect(reopened).not.toBeNull();
    draft = stepScene(pc, reopened!.state, A);
    const reopenedView = () => draft as unknown as PcSceneState;
    const storedBox = pcVisibleBoxes(reopenedView()).findIndex((box) => box.id === "quarantine");
    for (let index = 0; index < storedBox; index++) draft = stepScene(pc, draft, DOWN);
    draft = stepScene(pc, draft, A, A, A, B, UP, A);
    const returned = pc.done(draft);
    expect(returned).not.toBeNull();
    state = tuxemonExtensionState(returned!.ext!, DB);
    expect(state.npcParties[NPC]?.map((monster) => monster.iid)).toEqual(["npc-b", "npc-a"]);
    expect(state.npcBoxes?.[NPC]?.quarantine.monsters).toEqual([]);
    expect(state.party).toEqual([]);
    expect(state.itemLocker).toBeUndefined();
    expect(state.npcItems?.[NPC]).toEqual({
      bag: { wood_berry: 1, potion: 2 },
      locker: {},
    });

    // The shared item UI commits against the named owner without replacing
    // the live player's built-in backpack.
    const itemStarted = pc.start(returned!.ext!, npcPc, 3, context(returned!.ext!, PRESENT));
    expect(itemStarted).not.toBeNull();
    const itemScene = itemStarted!.state as unknown as PcSceneState;
    delete itemScene.bag.wood_berry;
    itemScene.locker.wood_berry = 1;
    itemScene.bagDirty = true;
    itemScene.phase = "done";
    const itemDone = pc.done(itemStarted!.state);
    expect(itemDone).not.toBeNull();
    expect(itemDone!.items).toBeUndefined();
    state = tuxemonExtensionState(itemDone!.ext!, DB);
    expect(state.npcItems?.[NPC]).toEqual({
      bag: { potion: 2 },
      locker: { wood_berry: 1 },
    });
    const itemSave = JSON.parse(JSON.stringify(extensions.codec!.encode(itemDone!.ext!))) as JsonValue;
    expect(tuxemonExtensionState(extensions.codec!.decode(itemSave), DB).npcItems?.[NPC])
      .toEqual(state.npcItems?.[NPC]);
    const clearedOne = execute(itemDone!.ext!, "tux.clear_npc_party", { character: NPC }).ext;
    expect(tuxemonExtensionState(clearedOne, DB).npcItems?.[NPC]).toBeUndefined();

    const kept = execute(itemDone!.ext!, "tux.clear_npc_parties", { keep: [NPC] });
    expect(kept.result).toBeUndefined();

    // Active PC scenes saved before per-character storage have no owner
    // field. Restoring and logging off must retain the historical player
    // path instead of manufacturing an "undefined" NPC owner.
    const legacyStarted = pc.start(itemDone!.ext!, authoredPc!.args!, 4, context(itemDone!.ext!));
    expect(legacyStarted).not.toBeNull();
    const legacyScene = legacyStarted!.state as unknown as PcSceneState;
    delete legacyScene.character;
    legacyScene.phase = "done";
    const legacyDone = pc.done(legacyStarted!.state);
    expect(legacyDone).not.toBeNull();
    expect(tuxemonExtensionState(legacyDone!.ext!, DB).npcParties.undefined).toBeUndefined();

    const dropped = execute(itemDone!.ext!, "tux.clear_npc_parties", { keep: [] }).ext;
    state = tuxemonExtensionState(dropped, DB);
    expect(state.npcParties[NPC]).toBeUndefined();
    expect(state.npcBoxes?.[NPC]).toBeUndefined();
    expect(state.npcItems?.[NPC]).toBeUndefined();
  });

  test("real remove/get-party lowerings respect every player container and live NPC presence", () => {
    const authoredRemove = extCommands(importedMap("spyder_dryadsgrove"))
      .find((command) => command.call === "tux.remove_monster");
    const authoredGet = extCommands(importedMap("spyder_nimrod_middle"))
      .find((command) => command.call === "tux.get_party_monsters"
        && argsOf(command).character === "spyder_nimrod_argon");
    expect(authoredRemove).toBeDefined();
    expect(authoredGet).toBeDefined();
    expect(argsOf(authoredRemove!)).toEqual({ variable: "v.ruff_back" });

    const playerParty = spawnMonster(DB, RULE_DB, { rng: 1, rngDraws: 0 }, "nut", 10, { iid: "player-party" });
    const playerKennel = spawnMonster(DB, RULE_DB, { rng: 2, rngDraws: 0 }, "rockitten", 11, { iid: "player-kennel" });
    const playerBox = spawnMonster(DB, RULE_DB, { rng: 3, rngDraws: 0 }, "budaye", 12, { iid: "player-box" });
    let value = packed((state) => {
      state.party = [playerParty];
      state.kennel = [playerKennel];
      state.kennelBox = true;
      state.boxes = { reserve: { hidden: false, capacity: 5, monsters: [playerBox] } };
      state.plagueByIid["player-box"] = { spyderbite: "infected" };
      state.npcParties[NPC] = [pending("npc-party", "eyesore")];
    });
    const variable = String(argsOf(authoredRemove!).variable);
    const remove = (iid: string, variables: Record<string, string | number> = {}) =>
      execute(value, authoredRemove!.call, authoredRemove!.args, { [variable]: iid, ...variables });

    value = remove("player-party").ext;
    let state = tuxemonExtensionState(value, DB);
    // Mutation guards: each assertion independently catches one deleted search leg.
    expect(state.party).toEqual([]);
    expect(state.kennel.map((monster) => monster.iid)).toEqual(["player-kennel"]);
    expect(state.boxes?.reserve.monsters.map((monster) => monster.iid)).toEqual(["player-box"]);
    expect(state.npcParties[NPC]?.map((monster) => monster.iid)).toEqual(["npc-party"]);

    value = remove("player-kennel").ext;
    expect(tuxemonExtensionState(value, DB).kennel).toEqual([]);
    value = remove("player-box").ext;
    state = tuxemonExtensionState(value, DB);
    expect(state.boxes?.reserve.monsters).toEqual([]);
    expect(state.plagueByIid["player-box"]).toBeUndefined();

    const offMap = remove("npc-party");
    expect(offMap.result).toBeUndefined();
    expect(offMap.ext).toBe(value);
    expect(tuxemonExtensionState(value, DB).npcParties[NPC]?.map((monster) => monster.iid)).toEqual(["npc-party"]);
    value = remove("npc-party", PRESENT).ext;
    expect(tuxemonExtensionState(value, DB).npcParties[NPC]).toEqual([]);

    const getParty = extensions.commands![authoredGet!.call]!;
    expect(() => getParty(context(value), authoredGet!.args))
      .toThrow("tux.get_party_monsters: NPC 'spyder_nimrod_argon' not found");
    expect(getParty(context(value, { "local.npc.spyder_nimrod_argon": 1 }), authoredGet!.args))
      .toEqual({ writes: {} });
  });
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createTuxemonExtensions,
  initialTuxemonExtensionState,
  KENNEL_LIMIT,
  packTuxemonExtensionState,
  PARTY_LIMIT,
  TUXEMON_EXT_SAVE_FORMAT,
  tuxemonExtensionState,
} from "../battle/extension.ts";
import { snapshotFromClock } from "../battle/time-weather.ts";
import { validateBattleDb } from "../importer/battle-schema.ts";
import { AttractController } from "../vendor/pocket-rpgkit/src/engine/attract.ts";
import { rngNext } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";
import {
  createSession,
  startSession,
  stepSession,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { createSessionSnapshot, encodeEnvelope } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import { restoreSessionEnvelope } from "../vendor/pocket-rpgkit/src/engine/save-restore.ts";
import type {
  Command,
  JsonValue,
  Project,
} from "../vendor/pocket-rpgkit/src/engine/types.ts";

const ROOT = join(import.meta.dir, "..");
const DB = validateBattleDb(JSON.parse(readFileSync(join(ROOT, "data/battle-db.json"), "utf8")));

function project(commands: Command[]): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Tuxemon extension test",
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

function readContext(ext: JsonValue, playerName = "Player") {
  return {
    ext,
    switches: {},
    variables: {},
    items: {},
    gold: 0,
    playerName,
  };
}

test("player-name conditions compare the live name exactly and support negation", () => {
  const extensions = createTuxemonExtensions(DB);
  const playerNameIs = extensions.conditions!["tux.player_name_is"]!;
  const context = {
    ext: extensions.initial!,
    switches: {},
    variables: {},
    items: {},
    gold: 0,
    playerName: "ApexPlayer",
  };

  expect(playerNameIs(context, { name: "ApexPlayer", negate: false })).toBeTrue();
  expect(playerNameIs(context, { name: "apexplayer", negate: false })).toBeFalse();
  expect(playerNameIs(context, { name: "Red", negate: true })).toBeTrue();
  expect(playerNameIs(context, { name: "ApexPlayer", negate: true })).toBeFalse();
  expect(playerNameIs(context, { name: 7 })).toBeFalse();
});

test("Tuxepedia and healed-party conditions preserve upstream edge semantics", () => {
  const extensions = createTuxemonExtensions(DB);
  const hasTuxepedia = extensions.conditions!["tux.has_tuxepedia"]!;
  const charHealed = extensions.conditions!["tux.char_healed"]!;
  const setTuxepedia = extensions.commands!["tux.set_tuxepedia"]!;
  const empty = extensions.initial!;

  expect(hasTuxepedia(readContext(empty), {
    character: "player", species: "rockitten", status: "caught", negate: false,
  })).toBeFalse();
  expect(hasTuxepedia(readContext(empty), {
    character: "player", species: "rockitten", status: "caught", negate: true,
  })).toBeTrue();
  expect(hasTuxepedia(readContext(empty), {
    character: "player", species: "rockitten", status: "invalid", negate: true,
  })).toBeFalse();
  expect(hasTuxepedia(readContext(empty), {
    character: "npc_maple", species: "rockitten", status: "caught", negate: true,
  })).toBeFalse();

  const commandContext = (ext: JsonValue) => ({
    ...readContext(ext),
    random: () => { throw new Error("Tuxepedia writes must not consume RNG"); },
  });
  const seen = setTuxepedia(commandContext(empty), {
    character: "player", species: "rockitten", status: "seen",
  })!.ext!;
  expect(hasTuxepedia(readContext(seen), {
    character: "player", species: "rockitten", status: "seen", negate: false,
  })).toBeTrue();
  expect(hasTuxepedia(readContext(seen), {
    character: "player", species: "rockitten", status: "caught", negate: false,
  })).toBeFalse();

  const caught = setTuxepedia(commandContext(seen), {
    character: "player", species: "rockitten", status: "caught",
  })!.ext!;
  expect(hasTuxepedia(readContext(caught), {
    character: "player", species: "rockitten", status: "caught", negate: false,
  })).toBeTrue();
  expect(hasTuxepedia(readContext(caught), {
    character: "player", species: "rockitten", status: "seen", negate: false,
  })).toBeFalse();

  expect(charHealed(readContext(empty), { character: "player", negate: false })).toBeFalse();
  expect(charHealed(readContext(empty), { character: "player", negate: true })).toBeTrue();

  const added = run([{ op: "ext", call: "tux.add_monster", args: { species: "nut", level: 5 } }]);
  const healthy = tuxemonExtensionState(added.state.ext, DB);
  expect(charHealed(readContext(healthy as unknown as JsonValue), {
    character: "player", negate: false,
  })).toBeTrue();
  expect(charHealed(readContext(healthy as unknown as JsonValue), {
    character: "player", negate: true,
  })).toBeFalse();

  const poisoned = {
    ...healthy,
    party: healthy.party.map((monster, index) => index === 0
      ? { ...monster, status: "poison" }
      : monster),
  };
  expect(charHealed(readContext(poisoned as unknown as JsonValue), {
    character: "player", negate: false,
  })).toBeTrue();

  const hurt = {
    ...healthy,
    party: healthy.party.map((monster, index) => index === 0
      ? { ...monster, currentHp: monster.currentHp! - 1 }
      : monster),
  };
  expect(charHealed(readContext(hurt as unknown as JsonValue), {
    character: "player", negate: false,
  })).toBeFalse();
  expect(charHealed(readContext(hurt as unknown as JsonValue), {
    character: "player", negate: true,
  })).toBeTrue();
});

describe("Tuxemon party extension", () => {
  test("uses the built-in item bank without a mirrored extension inventory", () => {
    const { state } = run([
      { op: "item", item: "potion", set: "add", count: 3 },
      { op: "item", item: "potion", set: "sub", count: 1 },
      {
        op: "if",
        if: { kind: "item", id: "potion", count: 2 },
        then: [{ op: "switch", id: "has-two-potions", value: true }],
      },
    ]);
    expect(state.sw.items.potion).toBe(2);
    expect(tuxemonExtensionState(state.ext, DB)).not.toHaveProperty("inventory");
    expect(state.sw.switches["has-two-potions"]).toBeTrue();
  });

  test("adds variable-backed player monsters and defers NPC spawning without hidden RNG", () => {
    const commands: Command[] = [
      {
        op: "ext",
        call: "tux.add_monster",
        args: {
          species: { variable: "v.billie_choice", values: ["bamboon", "bigfin", "budaye"] },
          level: 5,
          character: "player",
        },
      },
      {
        op: "ext",
        call: "tux.add_monster",
        args: { species: "nut", level: 7, character: "trainer", experienceModifier: 5, moneyModifier: 10 },
      },
      {
        op: "if",
        if: { kind: "ext", call: "tux.party_size", args: { character: "player", operator: "equals", value: 1 } },
        then: [{ op: "switch", id: "party-size", value: true }],
      },
      {
        op: "if",
        if: { kind: "ext", call: "tux.has_monster", args: { character: "player", species: "budaye" } },
        then: [{ op: "switch", id: "has-budaye", value: true }],
      },
    ];
    const { initial, state } = run(commands, undefined, { "v.billie_choice": 3 });
    const ext = tuxemonExtensionState(state.ext, DB);
    expect(ext.party).toHaveLength(1);
    expect(ext.party[0]).toMatchObject({ iid: "txmn-000001", slug: "budaye", level: 5 });
    expect(ext.npcParties.trainer).toEqual([{
      iid: "txmn-000002",
      slug: "nut",
      level: 7,
      experienceModifier: 5,
      moneyModifier: 10,
    }]);
    expect(ext.caught).toEqual(["budaye"]);
    expect(state.sw.variables["v.add_monster"]).toBe("txmn-000002");
    expect(state.sw.switches["party-size"]).toBe(true);
    expect(state.sw.switches["has-budaye"]).toBe(true);
    let expectedCursor = initial.sw.rng;
    for (let draw = 0; draw < 13; draw++) expectedCursor = rngNext(expectedCursor).next;
    expect(state.sw.rng).toBe(expectedCursor);
  });

  test("keeps Tuxepedia status monotonic and persists a selected monster nickname", () => {
    const { state } = run([
      { op: "ext", call: "tux.set_tuxepedia", args: { character: "player", species: "rockitten", status: "seen" } },
      { op: "ext", call: "tux.set_tuxepedia", args: { character: "player", species: "rockitten", status: "seen" } },
      { op: "ext", call: "tux.set_tuxepedia", args: { character: "player", species: "budaye", status: "seen" } },
      { op: "ext", call: "tux.set_tuxepedia", args: { character: "player", species: "rockitten", status: "caught" } },
      { op: "ext", call: "tux.set_tuxepedia", args: { character: "player", species: "rockitten", status: "seen" } },
      { op: "ext", call: "tux.add_monster", args: { species: "nut", level: 5 } },
      {
        op: "ext",
        call: "tux.prepare_monster_rename",
        args: { variable: "v.add_monster", nameVariable: "tux.rename.name" },
      },
    ]);
    expect(state.sw.variables["tux.rename.name"]).toBe(DB.monsters.nut.name);
    const apply = createTuxemonExtensions(DB).commands!["tux.apply_monster_rename"]!;
    const renamed = apply({
      ext: state.ext,
      switches: state.sw.switches,
      variables: { ...state.sw.variables, "tux.rename.name": "Sprout" },
      items: state.sw.items,
      gold: state.sw.gold,
      playerName: state.sw.playerName,
      random: () => { throw new Error("rename must not consume RNG"); },
    }, { variable: "v.add_monster", nameVariable: "tux.rename.name" });
    const ext = tuxemonExtensionState(renamed!.ext!, DB);
    expect(ext.seen).toEqual(["budaye"]);
    expect(ext.caught).toEqual(["rockitten", "nut"]);
    expect(ext.party[0]).toMatchObject({ slug: "nut", nickname: "Sprout" });
  });

  test("routes overflow into a bounded kennel and still consumes each spawn", () => {
    const options = createTuxemonExtensions(DB);
    const add = options.commands!["tux.add_monster"]!;
    let ext = options.initial!;
    let draws = 0;
    for (let index = 0; index < PARTY_LIMIT + KENNEL_LIMIT + 1; index++) {
      const result = add({
        ext,
        switches: {},
        variables: {},
        items: {},
        gold: 0,
        playerName: "Player",
        random: () => {
          draws++;
          return 0.25;
        },
      }, { species: "nut", level: 5 });
      expect(result).toBeDefined();
      ext = result!.ext!;
    }
    const state = tuxemonExtensionState(ext, DB);
    expect(state.party).toHaveLength(PARTY_LIMIT);
    expect(state.kennel).toHaveLength(KENNEL_LIMIT);
    expect(state.nextMonsterId).toBe(PARTY_LIMIT + KENNEL_LIMIT + 2);
    expect(draws).toBe((PARTY_LIMIT + KENNEL_LIMIT + 1) * 13);
  });

  test("targeted and whole-party health/status commands use stable monster ids", () => {
    const added = run([{
      op: "ext",
      call: "tux.add_monster",
      args: { species: "nut", level: 5 },
    }]);
    const damaged = run([
      {
        op: "ext",
        call: "tux.set_monster_health",
        args: { variable: "v.target", health: { kind: "fraction", value: 0.1 } },
      },
      {
        op: "ext",
        call: "tux.set_monster_status",
        args: { variable: "v.target", status: "poison" },
      },
    ], added.state.ext, { "v.target": "txmn-000001" });
    const hurt = tuxemonExtensionState(damaged.state.ext, DB).party[0]!;
    expect(hurt.currentHp).toBe(Math.trunc(hurt.base.hp * 0.1));
    expect(hurt.status).toBe("poison");

    const healed = run([
      { op: "ext", call: "tux.set_monster_health", args: {} },
      { op: "ext", call: "tux.set_monster_status", args: {} },
    ], damaged.state.ext);
    const healthy = tuxemonExtensionState(healed.state.ext, DB).party[0]!;
    expect(healthy.currentHp).toBe(healthy.base.hp);
    expect(healthy.status).toBeNull();
  });

  test("checks, confirms, and denies pending evolutions in party order", () => {
    const added = run([{
      op: "ext",
      call: "tux.add_monster",
      args: { species: "cataspike", level: 9 },
    }]);
    const pending = tuxemonExtensionState(added.state.ext, DB);
    pending.party[0] = {
      ...pending.party[0]!,
      nickname: "Spike",
      waitingToEvolve: true,
      captureDevice: "tuxeball_ancient",
      status: "poison",
    };
    const evolved = run([
      {
        op: "if",
        if: { kind: "ext", call: "tux.check_evolution", args: { character: "player" } },
        then: [{ op: "switch", id: "waiting", value: true }],
      },
      { op: "ext", call: "tux.evolution", args: { character: "player", inside: false } },
    ], pending as unknown as JsonValue);
    const after = tuxemonExtensionState(evolved.state.ext, DB);
    expect(evolved.state.sw.switches.waiting).toBeTrue();
    expect(after.party[0]).toMatchObject({
      iid: pending.party[0]!.iid,
      slug: "puparmor",
      nickname: "Spike",
      stage: "stage1",
      captureDevice: "tuxeball_ancient",
      status: "poison",
      waitingToEvolve: false,
      acquisition: "unknown",
      experienceModifier: 1,
      moneyModifier: 0,
      bond: 25,
    });
    expect(after.party[0]!.moves).toEqual([...pending.party[0]!.moves, "chameleon"]);
    expect(after.caught).toContain("puparmor");
    let expectedCursor = evolved.initial.sw.rng;
    for (let draw = 0; draw < 13; draw++) expectedCursor = rngNext(expectedCursor).next;
    expect(evolved.state.sw.rng).toBe(expectedCursor);

    const declined = tuxemonExtensionState(added.state.ext, DB);
    declined.party[0] = { ...declined.party[0]!, waitingToEvolve: true };
    const denied = run([
      { op: "ext", call: "tux.cancel_evolution", args: { character: "player" } },
      {
        op: "if",
        if: { kind: "ext", call: "tux.check_evolution", args: { character: "player" } },
        then: [{ op: "switch", id: "still-waiting", value: true }],
      },
    ], declined as unknown as JsonValue);
    expect(tuxemonExtensionState(denied.state.ext, DB).party[0]!.slug).toBe("cataspike");
    expect(tuxemonExtensionState(denied.state.ext, DB).party[0]!.waitingToEvolve).toBeFalse();
    expect(denied.state.sw.switches["still-waiting"]).not.toBeTrue();
    expect(denied.state.sw.rng).toBe(denied.initial.sw.rng);
  });

  test("party defeat and battle-history conditions read extension state", () => {
    const base = initialTuxemonExtensionState();
    const spawned = run([{
      op: "ext",
      call: "tux.add_monster",
      args: { species: "nut", level: 5 },
    }], base as unknown as JsonValue);
    const ext = tuxemonExtensionState(spawned.state.ext, DB);
    ext.party[0] = { ...ext.party[0]!, currentHp: 0, status: "faint" };
    ext.history.push(
      { fighter: "player", opponent: "billie", outcome: "won" },
      { fighter: "player", opponent: "billie", outcome: "won" },
      { fighter: "billie", opponent: "player", outcome: "lost" },
    );
    const commands: Command[] = [
      {
        op: "if",
        if: { kind: "ext", call: "tux.char_defeated", args: { character: "player" } },
        then: [{ op: "switch", id: "defeated", value: true }],
      },
      {
        op: "if",
        if: { kind: "ext", call: "tux.battle_outcome", args: { fighter: "player", opponent: "billie", outcome: "won" } },
        then: [{ op: "switch", id: "won", value: true }],
      },
      {
        op: "if",
        if: { kind: "ext", call: "tux.battle_outcome_count", args: { fighter: "player", opponent: "billie", outcome: "won", count: 2 } },
        then: [{ op: "switch", id: "won-twice", value: true }],
      },
    ];
    const checked = run(commands, ext as unknown as JsonValue);
    expect(checked.state.sw.switches).toMatchObject({ defeated: true, won: true, "won-twice": true });
  });

  test("faint point writes variable-addressed transfer operands", () => {
    const { state } = run([
      { op: "ext", call: "tux.set_faint_point", args: { character: "player", map: "bedroom", x: 3, y: 4 } },
      { op: "ext", call: "tux.prepare_faint_transfer", args: { character: "player" } },
      {
        op: "if",
        if: { kind: "ext", call: "tux.faint_point_is_map", args: { character: "player", map: "bedroom" } },
        then: [{ op: "switch", id: "at-faint-map", value: true }],
      },
      {
        op: "if",
        if: { kind: "ext", call: "tux.faint_point_is_map", args: { character: "player", map: "route", negate: true } },
        then: [{ op: "switch", id: "away-from-faint-map", value: true }],
      },
    ]);
    expect(tuxemonExtensionState(state.ext, DB).faintPoints.player).toEqual({ map: "bedroom", x: 3, y: 4 });
    expect(state.sw.variables).toMatchObject({
      "tux.faint.map": "bedroom",
      "tux.faint.x": 3,
      "tux.faint.y": 4,
    });
    expect(state.sw.switches).toMatchObject({ "at-faint-map": true, "away-from-faint-map": true });
  });

  test("environment and guarded faint recovery live entirely in extension state", () => {
    const added = run([{
      op: "ext",
      call: "tux.add_monster",
      args: { species: "nut", level: 5 },
    }]);
    const hurt = tuxemonExtensionState(added.state.ext, DB);
    hurt.party[0] = { ...hurt.party[0]!, currentHp: 1, status: "poison" };
    const { state } = run([
      { op: "ext", call: "tux.set_environment", args: { environment: "grass" } },
      { op: "ext", call: "tux.set_faint_point", args: { character: "player", map: "bedroom", x: 3, y: 4 } },
      {
        op: "if",
        if: { kind: "ext", call: "tux.environment_is", args: { environment: "grass" } },
        then: [{ op: "switch", id: "grass", value: true }],
      },
      {
        op: "if",
        if: { kind: "ext", call: "tux.has_faint_point", args: { character: "player" } },
        then: [{
          op: "ext",
          call: "tux.prepare_faint_transfer",
          args: { character: "player", healing: true, currentMap: "bedroom" },
        }],
      },
    ], hurt as unknown as JsonValue);
    const recovered = tuxemonExtensionState(state.ext, DB);
    expect(recovered.environment).toBe("grass");
    expect(recovered.party[0]).toMatchObject({ currentHp: recovered.party[0]!.base.hp, status: null });
    expect(state.sw.switches.grass).toBeTrue();
    expect(state.sw.variables["tux.faint.map"]).toBe("bedroom");
  });

  test("codec preserves parties through a checksummed save and rejects malformed state", () => {
    const played = run([{
      op: "ext",
      call: "tux.add_monster",
      args: { species: "nut", level: 5 },
    }]);
    const equipped = tuxemonExtensionState(played.state.ext, DB);
    equipped.party[0] = { ...equipped.party[0]!, heldItem: "xp_feeder" };
    played.state.ext = packTuxemonExtensionState(equipped);
    const snapshot = createSessionSnapshot(played.session, played.state, 0);
    expect(snapshot.ext).toMatchObject({ format: TUXEMON_EXT_SAVE_FORMAT });
    const restored = restoreSessionEnvelope(played.session, encodeEnvelope(snapshot));
    expect(restored.ext).toEqual(played.state.ext);
    expect(tuxemonExtensionState(restored.ext, DB).party[0]?.heldItem).toBe("xp_feeder");

    const legacy = {
      ...tuxemonExtensionState(played.state.ext, DB),
      inventory: { potion: 2 },
      money: 300,
    } as Record<string, unknown>;
    delete legacy.runAttempts;
    delete legacy.seen;
    delete legacy.clock;
    delete legacy.weather;
    const migrated = createTuxemonExtensions(DB).codec!.decode({
      format: TUXEMON_EXT_SAVE_FORMAT,
      state: legacy as JsonValue,
    });
    const migratedState = tuxemonExtensionState(migrated, DB);
    expect(migratedState).toMatchObject({ runAttempts: 0, seen: [] });
    expect(snapshotFromClock(migratedState.clock)).toMatchObject({
      year: 2024,
      month: 6,
      day: 15,
      hour: 9,
      minute: 0,
    });
    expect(migratedState.weather).toMatchObject({ slug: "sunny", rngCursor: 0x9e37_79b9 });
    expect(migratedState).not.toHaveProperty("inventory");
    expect(migratedState).not.toHaveProperty("money");

    const legacyParty = migratedState.party.map(({ heldItem: _heldItem, ...monster }) => monster);
    const withoutHeldSlots = createTuxemonExtensions(DB).codec!.decode({
      format: TUXEMON_EXT_SAVE_FORMAT,
      state: { ...migratedState, party: legacyParty } as unknown as JsonValue,
    });
    expect(tuxemonExtensionState(withoutHeldSlots, DB).party[0]).not.toHaveProperty("heldItem");

    for (const missing of ["clock", "weather"] as const) {
      const partial = { ...tuxemonExtensionState(played.state.ext, DB) } as Record<string, unknown>;
      delete partial[missing];
      expect(() => createTuxemonExtensions(DB).codec!.decode({
        format: TUXEMON_EXT_SAVE_FORMAT,
        state: partial as JsonValue,
      })).toThrow(/clock and weather must either both be present or both be absent/);
    }

    const invalid = { ...initialTuxemonExtensionState(), nextMonsterId: Number.MAX_SAFE_INTEGER + 1 };
    expect(() => startSession(project([]), played.session, undefined, invalid as unknown as JsonValue))
      .toThrow(/nextMonsterId must be a positive safe integer/);
    const invalidAttempts = { ...initialTuxemonExtensionState(), runAttempts: -1 };
    expect(() => startSession(project([]), played.session, undefined, invalidAttempts as unknown as JsonValue))
      .toThrow(/runAttempts must be a non-negative safe integer/);
    const overlapping = { ...initialTuxemonExtensionState(), seen: ["nut"], caught: ["nut"] };
    expect(() => startSession(project([]), played.session, undefined, overlapping as unknown as JsonValue))
      .toThrow(/seen and caught must be disjoint/);
    const invalidNickname = { ...initialTuxemonExtensionState(), party: [{
      ...tuxemonExtensionState(played.state.ext, DB).party[0]!,
      nickname: "",
    }] };
    expect(() => startSession(project([]), played.session, undefined, invalidNickname as unknown as JsonValue))
      .toThrow(/nickname must contain 1\.\.15 characters/);
    const invalidHeldItem = { ...initialTuxemonExtensionState(), party: [{
      ...tuxemonExtensionState(played.state.ext, DB).party[0]!,
      heldItem: "potion",
    }] };
    expect(() => startSession(project([]), played.session, undefined, invalidHeldItem as unknown as JsonValue))
      .toThrow(/heldItem must name an imported holdable item/);
  });

  test("rewind refolds monster identity, attributes, and RNG byte-for-byte", () => {
    const source = project([{
      op: "ext",
      call: "tux.add_monster",
      args: { species: "nut", level: 5 },
    }]);
    const extensions = createTuxemonExtensions(DB);
    const rewound = new AttractController(source, [], {
      hz: 60,
      attractEnabled: false,
      rewindSeconds: 2 / 60,
      extensions,
    });
    const fresh = new AttractController(source, [], {
      hz: 60,
      attractEnabled: false,
      rewindSeconds: 2 / 60,
      extensions,
    });
    rewound.startPlay();
    fresh.startPlay();
    for (let frame = 0; frame < 5; frame++) rewound.step(0);
    for (let frame = 0; frame < 3; frame++) fresh.step(0);
    rewound.step(0x0100);
    expect(rewound.length).toBe(3);
    expect(rewound.state).toEqual(fresh.state);
    expect(tuxemonExtensionState(rewound.state.ext, DB).party[0]?.iid).toBe("txmn-000001");
  });
});

describe("KC1 party choice and removal", () => {
  const extensions = createTuxemonExtensions(DB);
  const partyChoice = extensions.choices!["tux.party_monsters"]!;
  const pendingMoves = extensions.choices!["tux.pending_moves"]!;

  function partyExt(entries: Array<{ species: string; level: number }>): JsonValue {
    const { state } = run(entries.map((entry) => ({
      op: "ext" as const,
      call: "tux.add_monster",
      args: { species: entry.species, level: entry.level },
    })));
    return state.ext;
  }

  function partyIids(ext: JsonValue): string[] {
    return tuxemonExtensionState(ext, DB).party.map((monster) => monster.iid!);
  }

  const readContext = (ext: JsonValue, variables: Record<string, string | number> = {}) => ({
    ext,
    variables,
    switches: {},
    items: {},
    gold: 0,
    playerName: "Player",
  });

  const commandContext = (ext: JsonValue, variables: Record<string, string | number> = {}) => ({
    ...readContext(ext, variables),
    random: () => 0,
  });

  test("party_monsters lists the party with titled labels and stable iid keys", () => {
    const ext = partyExt([{ species: "rockitten", level: 5 }, { species: "agnite", level: 6 }]);
    const rows = partyChoice.options!(readContext(ext), { variable: "v.pick", filters: [] });
    expect(rows.map((row) => row.key)).toEqual(partyIids(ext));
    expect(rows.map((row) => row.label)).toEqual(["Rockitten", "Agnite"]);
    expect(rows.every((row) => typeof row.data === "object" && row.data !== null)).toBe(true);
  });

  test("party_monsters applies slug and evolution_stage filters", () => {
    const ext = partyExt([{ species: "rockitten", level: 5 }, { species: "agnite", level: 6 }]);
    const bySlug = partyChoice.options!(readContext(ext), {
      variable: "v.pick",
      filters: [{ field: "slug", value: "rockitten" }],
    });
    expect(bySlug).toHaveLength(1);
    expect(bySlug[0]!.key).toBe(partyIids(ext)[0]);
    const stage = DB.monsters.rockitten!.stage;
    const byStage = partyChoice.options!(readContext(ext), {
      variable: "v.pick",
      filters: [{ field: "evolution_stage", value: stage }],
    });
    expect(byStage.map((row) => row.key)).toContain(partyIids(ext)[0]);
  });

  test("the resolver writes the iid on select and the cancel code on cancel", () => {
    const ext = partyExt([{ species: "rockitten", level: 5 }]);
    const [iid] = partyIids(ext);
    const args = { variable: "v.pick", cancelCode: 7, filters: [] };
    const selected = partyChoice.resolve!(commandContext(ext), args, {
      kind: "select", index: 0, key: iid!, data: null,
    });
    expect(selected?.writes).toEqual({ "v.pick": iid });
    const cancelled = partyChoice.resolve!(commandContext(ext), args, { kind: "cancel" });
    expect(cancelled?.writes).toEqual({ "v.pick": 7 });
  });

  test("party_match is true only when a party monster passes every filter", () => {
    const ext = partyExt([{ species: "rockitten", level: 5 }]);
    const match = extensions.conditions!["tux.party_match"]!;
    expect(match(readContext(ext), { filters: [] })).toBe(true);
    expect(match(readContext(ext), { filters: [{ field: "slug", value: "rockitten" }] })).toBe(true);
    expect(match(readContext(ext), { filters: [{ field: "slug", value: "agnite" }] })).toBe(false);
    expect(match(readContext(extensions.initial!), { filters: [] })).toBe(false);
  });

  test("remove_monster removes the iid from the party and is a no-op when absent", () => {
    const ext = partyExt([{ species: "rockitten", level: 5 }, { species: "agnite", level: 6 }]);
    const [iid] = partyIids(ext);
    const remove = extensions.commands!["tux.remove_monster"]!;
    const result = remove(commandContext(ext, { "v.pick": iid! }), { variable: "v.pick" });
    const after = tuxemonExtensionState(result!.ext!, DB);
    expect(after.party).toHaveLength(1);
    expect(after.party[0]!.slug).toBe("agnite");
    const again = remove(commandContext(result!.ext!, { "v.pick": iid! }), { variable: "v.pick" });
    expect(again).toBeUndefined();
  });

  test("get_party_monsters dumps the party iids into iid_slot variables", () => {
    const { state } = run([
      { op: "ext" as const, call: "tux.add_monster", args: { species: "nut", level: 7, character: "spyder_nimrod_argon" } },
      { op: "ext" as const, call: "tux.add_monster", args: { species: "agnite", level: 8, character: "spyder_nimrod_argon" } },
      { op: "ext" as const, call: "tux.get_party_monsters", args: { character: "spyder_nimrod_argon" } },
    ], undefined, { "local.npc.spyder_nimrod_argon": 1 });
    expect(state.sw.variables["v.iid_slot_0"]).toBe("txmn-000001");
    expect(state.sw.variables["v.iid_slot_1"]).toBe("txmn-000002");
  });

  test("get_party_monsters defaults to the player party", () => {
    const { state } = run([
      { op: "ext" as const, call: "tux.add_monster", args: { species: "rockitten", level: 5 } },
      { op: "ext" as const, call: "tux.get_party_monsters", args: {} },
    ]);
    expect(state.sw.variables["v.iid_slot_0"]).toBe("txmn-000001");
  });

  test("remove_monster removes an NPC-owned monster by iid (the Nimrod flow)", () => {
    const { state } = run([
      { op: "ext" as const, call: "tux.add_monster", args: { species: "nut", level: 7, character: "spyder_nimrod_argon" } },
      { op: "ext" as const, call: "tux.get_party_monsters", args: { character: "spyder_nimrod_argon" } },
      { op: "ext" as const, call: "tux.remove_monster", args: { variable: "v.iid_slot_0" } },
    ], undefined, { "local.npc.spyder_nimrod_argon": 1 });
    const ext = tuxemonExtensionState(state.ext, DB);
    expect(ext.npcParties.spyder_nimrod_argon).toEqual([]);
    expect(ext.party).toHaveLength(0);
  });

  test("pending_moves removes the selected old move and reports the newest replacement", () => {
    const base = tuxemonExtensionState(partyExt([{ species: "rockitten", level: 5 }]), DB);
    const moves = ["ram", "acid", "adamantine", "air_chain", "altitude"];
    const ext = packTuxemonExtensionState({
      ...base,
      party: [{ ...base.party[0]!, moves }],
    });
    const args = {
      variable: "v.chosen_tech",
      message: {
        variable: "v.pending_move.message",
        noLearnTemplate: "Decided not to learn {tech}.",
        replacedTemplate: "{old} replaced with {new}.",
      },
    };

    expect(pendingMoves.options(readContext(ext), args)).toEqual([
      { key: "ram", label: "Ram" },
      { key: "acid", label: "Acid" },
      { key: "adamantine", label: "Adamantine" },
      { key: "air_chain", label: "Air Chain" },
      { key: "altitude", label: "Altitude" },
    ]);
    const selected = pendingMoves.resolve!(commandContext(ext), args, {
      kind: "select", index: 1, key: "acid", data: null,
    })!;
    // Mutation guard: pop(), shift(), or deleting the newest move all fail
    // this exact-order assertion even though the party would be back at four.
    expect(tuxemonExtensionState(selected.ext!, DB).party[0]!.moves).toEqual([
      "ram", "adamantine", "air_chain", "altitude",
    ]);
    expect(selected.writes).toEqual({
      "v.chosen_tech": "acid",
      "v.pending_move.message": "Acid replaced with Altitude.",
    });
  });

  test("pending_moves treats selecting the newest move as declining to learn it", () => {
    const base = tuxemonExtensionState(partyExt([{ species: "rockitten", level: 5 }]), DB);
    const ext = packTuxemonExtensionState({
      ...base,
      party: [{
        ...base.party[0]!,
        moves: ["ram", "acid", "adamantine", "air_chain", "altitude"],
      }],
    });
    const args = {
      variable: "v.chosen_tech",
      message: {
        variable: "v.pending_move.message",
        noLearnTemplate: "Decided not to learn {tech}.",
        replacedTemplate: "{old} replaced with {new}.",
      },
    };
    const selected = pendingMoves.resolve!(commandContext(ext), args, {
      kind: "select", index: 4, key: "altitude", data: null,
    })!;
    expect(tuxemonExtensionState(selected.ext!, DB).party[0]!.moves).toEqual([
      "ram", "acid", "adamantine", "air_chain",
    ]);
    expect(selected.writes?.["v.pending_move.message"]).toBe("Decided not to learn Altitude.");
  });

  test("an empty party list opens through the displaced branch and cancel resolves", () => {
    const source = project([{
      op: "extChoice",
      call: "tux.party_monsters",
      args: { variable: "v.pick", cancelCode: 1, filters: [] },
      prompt: "Choose",
      cancel: true,
    }]);
    const session = createSession(source, 60, { extensions: createTuxemonExtensions(DB) });
    let state = stepSession(session, startSession(source, session), { buttons: 0 });
    const modal = state.interp.modal;
    expect(modal?.kind).toBe("choices");
    if (modal?.kind !== "choices") throw new Error("expected choices modal");
    expect(modal.options).toEqual([]);
    expect(modal.cancellable).toBe(true);
    // The empty list is displaced: a confirm edge is ignored until a row is shown.
    state = stepSession(session, state, { buttons: 0, confirmEdge: true });
    expect(state.interp.modal?.kind).toBe("choices");
    expect(state.sw.variables["v.pick"]).toBeUndefined();
    // Cancel reaches the resolver and writes the sentinel code.
    state = stepSession(session, state, { buttons: 0, cancelEdge: true });
    expect(state.interp.modal).toBeNull();
    expect(state.sw.variables["v.pick"]).toBe(1);
  });
});

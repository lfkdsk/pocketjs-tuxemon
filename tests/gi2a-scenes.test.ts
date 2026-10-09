import { describe, expect, test } from "bun:test";

import {
  createTuxemonScenes,
  journalEntryStatus,
  selectedJournalEntry,
  TUXEMON_JOURNAL_SCENE_ID,
  TUXEMON_MONSTER_PICKER_SCENE_ID,
  type JournalSceneState,
  type MonsterPickerSceneState,
} from "../battle/scenes.ts";
import {
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
} from "../battle/extension.ts";
import { TUXEMON_BATTLE_DB } from "../battle/game.ts";
import type { SpawnedMonsterSnapshot } from "../battle/types.ts";
import type { ExtensionReadContext } from "../vendor/pocket-rpgkit/src/engine/extensions.ts";
import type { JsonValue } from "../vendor/pocket-rpgkit/src/engine/types.ts";

const bundle = createTuxemonScenes(TUXEMON_BATTLE_DB);

function context(ext: JsonValue, variables: Record<string, number | string> = {}): ExtensionReadContext {
  return {
    ext,
    switches: {},
    variables,
    items: {},
    gold: 0,
    playerName: "Red",
  };
}

function monster(iid: string, slug: string, nickname?: string): SpawnedMonsterSnapshot {
  return {
    iid,
    slug,
    ...(nickname === undefined ? {} : { nickname }),
    level: 5,
    stage: "basic",
    gender: "neuter",
    tasteCold: "tasteless",
    tasteWarm: "tasteless",
    height: 1,
    weight: 1,
    individualValues: { hp: 0, armour: 0, dodge: 0, melee: 0, ranged: 0, speed: 0 },
    birthdate: [1, 1],
    base: { hp: 10, armour: 5, dodge: 5, melee: 5, ranged: 5, speed: 5 },
    currentHp: 10,
    moves: ["struggle"],
    types: ["normal"],
    totalExperience: 125,
    experienceModifier: 1,
    moneyModifier: 0,
    bond: 25,
    trainingPoints: { hp: 0, armour: 0, dodge: 0, melee: 0, ranged: 0, speed: 0 },
    status: null,
    acquisition: "gift",
    captureDevice: "tuxeball",
    waitingToEvolve: false,
  };
}

describe("Tuxemon utility scenes", () => {
  test("journal starts on a direct reveal without mutating Tuxepedia state", () => {
    const ext = initialTuxemonExtensionState();
    ext.seen.push("budaye");
    ext.caught.push("nut");
    const packed = packTuxemonExtensionState(ext);
    const rules = bundle.rules[TUXEMON_JOURNAL_SCENE_ID]!;
    const started = rules.start(packed, { monster: "rockitten", reveal: true }, 7, context(packed));
    expect(started).not.toBeNull();
    expect(started!.ext).toBe(packed);
    const state = started!.state as unknown as JournalSceneState;
    expect(selectedJournalEntry(state, bundle.catalog)?.id).toBe("rockitten");
    expect(journalEntryStatus(state, "rockitten")).toBe("unknown");
    expect(journalEntryStatus(state, "budaye")).toBe("seen");
    expect(journalEntryStatus(state, "nut")).toBe("caught");
    expect(ext.seen).toEqual(["budaye"]);
    expect(ext.caught).toEqual(["nut"]);

    const moved = rules.step(structuredClone(started!.state), { buttons: 0, downEdge: true }, 1);
    expect((moved as unknown as JournalSceneState).cursor).toBe(state.cursor);
    const closed = rules.step(moved, { buttons: 0, cancelEdge: true }, 1);
    expect(rules.done(closed)).toEqual({ cancelled: true });
  });

  test("party picker returns stable monster identity and honors cancel", () => {
    const ext = initialTuxemonExtensionState();
    ext.party.push(monster("txmn-one", "nut", "Sprout"), monster("txmn-two", "rockitten"));
    const packed = packTuxemonExtensionState(ext);
    const rules = bundle.rules[TUXEMON_MONSTER_PICKER_SCENE_ID]!;
    const started = rules.start(packed, { variable: "v.rename" }, 9, context(packed, { "v.rename": "txmn-two" }));
    const state = started!.state as unknown as MonsterPickerSceneState;
    expect(state.entries.map(({ iid, label }) => ({ iid, label }))).toEqual([
      { iid: "txmn-one", label: "Sprout" },
      { iid: "txmn-two", label: "Rockitten" },
    ]);
    expect(state.cursor).toBe(1);
    const confirmed = rules.step(started!.state, { buttons: 0, confirmEdge: true }, 1);
    expect(rules.done(confirmed)).toEqual({ writes: { "v.rename": "txmn-two" } });

    const fresh = rules.start(packed, { variable: "v.rename", cancellable: true }, 9, context(packed))!;
    const cancelled = rules.step(fresh.state, { buttons: 0, cancelEdge: true }, 1);
    expect(rules.done(cancelled)).toEqual({ cancelled: true });

    const required = rules.start(packed, { variable: "v.rename", cancellable: false }, 9, context(packed))!;
    const ignored = rules.step(required.state, { buttons: 0, cancelEdge: true }, 1);
    expect(rules.done(ignored)).toBeNull();
    expect((ignored as unknown as MonsterPickerSceneState).phase).toBe("choose");
    const empty = packTuxemonExtensionState(initialTuxemonExtensionState());
    expect(rules.start(empty, { variable: "v.rename" }, 9, context(empty))).toBeNull();
  });
});

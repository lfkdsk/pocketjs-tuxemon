import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { BTN } from "@pocketjs/framework/input";

import {
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
  tuxemonExtensionState,
} from "../battle/extension.ts";
import type { SpawnedMonsterSnapshot } from "../battle/types.ts";
import {
  createStartMenuRuntime,
  formatStartMenuPlaytime,
  partyActions,
  playerSummary,
  sortParty,
  startMenuRows,
  type StartMenuLabels,
} from "../ui/start-menu-runtime.ts";
import type { GameViewSessionHost } from "../vendor/pocket-rpgkit/src/ui/demo-contract.ts";
import type { SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";

const labels: StartMenuLabels = {
  root: {
    tuxepedia: "Tuxepedia",
    party: "Party",
    bag: "Bag",
    nuphone: "Nu Phone",
    player: "Player",
    missions: "Missions",
    save: "Save",
    load: "Load",
    options: "Options",
    exit: "Exit",
  },
  partyActions: {
    info: "Info",
    moves: "Moves",
    move: "Move",
    sort: "Sort",
    release: "Release",
  },
  partySorts: {
    level: "Level",
    hp: "HP",
    name: "Name",
    id: "Tuxepedia ID",
  },
  yes: "Yes",
  no: "No",
};

const catalog = {
  monsters: {
    alpha: { name: "Alpha", txmnId: 30, types: ["earth"] },
    beta: { name: "beta", txmnId: 10, types: ["fire"] },
    gamma: { name: "Gamma", txmnId: 20, types: ["water"] },
  },
  techniques: {
    ram: {
      name: "Ram",
      description: "Charge forward.",
      types: ["earth"],
      accuracy: 0.9,
      potency: 1,
      power: 1,
      recharge: 0,
    },
  },
} as never;

function monster(
  slug: "alpha" | "beta" | "gamma",
  level: number,
  hp: number,
  maxHp = 10,
  nickname?: string,
): SpawnedMonsterSnapshot {
  return {
    iid: `iid-${slug}`,
    slug,
    ...(nickname === undefined ? {} : { nickname }),
    level,
    stage: "basic",
    gender: "neuter",
    tasteCold: "mild",
    tasteWarm: "zesty",
    height: 10,
    weight: 10,
    individualValues: { hp: 0, armour: 0, dodge: 0, melee: 0, ranged: 0, speed: 0 },
    birthdate: [1, 1],
    base: { hp: maxHp, armour: 5, dodge: 5, melee: 5, ranged: 5, speed: 5 },
    currentHp: hp,
    moves: ["ram"],
    types: ["earth"],
    totalExperience: level ** 3,
    experienceModifier: 1,
    moneyModifier: 1,
    bond: 0,
    trainingPoints: { hp: 0, armour: 0, dodge: 0, melee: 0, ranged: 0, speed: 0 },
    status: null,
    acquisition: "gift",
    captureDevice: "tuxeball",
    waitingToEvolve: false,
  };
}

function sessionState(party: SpawnedMonsterSnapshot[]): SessionState {
  const ext = initialTuxemonExtensionState();
  ext.party = party;
  ext.seen = ["alpha"];
  ext.caught = ["beta", "gamma"];
  ext.history = [
    { fighter: "player", opponent: "trainer-a", outcome: "won" },
    { fighter: "trainer-a", opponent: "player", outcome: "lost" },
    { fighter: "player", opponent: "trainer-b", outcome: "draw" },
  ];
  ext.clock = { ...ext.clock, refTick: 60 * 3_661 };
  return {
    frame: 17,
    sw: {
      playerName: "Red",
      gold: 4321,
      items: { potion: 2, nu_phone: 1, app_tuxepedia: 1 },
    },
    ext: packTuxemonExtensionState(ext),
  } as never;
}

function liveHost(initial: SessionState): {
  host: GameViewSessionHost;
  state(): SessionState;
  replacements(): number;
} {
  let live = initial;
  let replacements = 0;
  return {
    host: {
      project: {} as never,
      session: { content: null } as never,
      getState: () => live,
      heldButtons: () => BTN.DOWN,
      replaceState: (next) => {
        live = next;
        replacements++;
      },
    },
    state: () => live,
    replacements: () => replacements,
  };
}

describe("START root ordering", () => {
  test("inserts the two apps at their authored positions after building the base list", () => {
    const rows = startMenuRows(labels.root, { missions: true }, [
      { id: "tuxepedia", label: labels.root.tuxepedia, position: 0 },
      { id: "nuphone", label: labels.root.nuphone, position: 3 },
    ]);
    expect(rows.map((row) => row.id)).toEqual([
      "tuxepedia",
      "party",
      "bag",
      "nuphone",
      "player",
      "missions",
      "save",
      "load",
      "options",
      "exit",
    ]);
  });

  test("caps positions, keeps stable equal-position order, and suppresses duplicate labels", () => {
    const rows = startMenuRows(labels.root, { missions: false }, [
      { id: "duplicate-bag", label: labels.root.bag, position: 0 },
      { id: "early-a", label: "Early A", position: -5 },
      { id: "early-b", label: "Early B", position: -5 },
      { id: "tail", label: "Tail", position: 500 },
    ]);
    expect(rows.map((row) => row.id)).toEqual([
      "early-b",
      "early-a",
      "party",
      "bag",
      "player",
      "save",
      "load",
      "options",
      "exit",
      "tail",
    ]);
    expect(rows.some((row) => row.id === "duplicate-bag")).toBe(false);
  });
});

describe("Party pure helpers", () => {
  const party = [
    monster("alpha", 12, 2, 10, "zED"),
    monster("beta", 4, 9, 10, "amy"),
    monster("gamma", 8, 5, 10),
  ];

  test("matches upstream level, HP ratio, display-name, and Tuxepedia-ID sorting", () => {
    expect(sortParty(party, "level", catalog).map((entry) => entry.slug)).toEqual(["beta", "gamma", "alpha"]);
    expect(sortParty(party, "hp", catalog).map((entry) => entry.slug)).toEqual(["beta", "gamma", "alpha"]);
    expect(sortParty(party, "name", catalog).map((entry) => entry.slug)).toEqual(["beta", "gamma", "alpha"]);
    expect(sortParty(party, "id", catalog).map((entry) => entry.slug)).toEqual(["beta", "gamma", "alpha"]);
  });

  test("hides move/sort/release for a one-member party", () => {
    expect(partyActions(party[0]!, 1)).toEqual(["info", "moves"]);
    expect(partyActions({ ...party[0]!, moves: [] }, 1)).toEqual(["info"]);
  });
});

describe("Player summary", () => {
  test("uses live name/gold, the saved 60 Hz game clock, discovery union, and player-side battle history", () => {
    const summary = playerSummary(sessionState([monster("alpha", 5, 10)]));
    expect(summary).toMatchObject({
      name: "Red",
      gold: 4321,
      playtimeSeconds: 3_661,
      playtime: "1h 1m",
      seen: 3,
      caught: 2,
      battles: { total: 2, won: 1, lost: 0, draw: 1 },
    });
    expect(summary.history.map((entry) => entry.opponent)).toEqual(["trainer-a", "trainer-b"]);
    expect(formatStartMenuPlaytime(-5)).toBe("0h 0m");
  });
});

describe("START/Party controller", () => {
  test("hides Tuxepedia until its imported app item is owned", () => {
    const withoutApp = sessionState([monster("alpha", 5, 10)]);
    withoutApp.sw.items.app_tuxepedia = 0;
    const live = liveHost(withoutApp);
    let dispose = () => {};
    const runtime = createRoot((cleanup) => {
      dispose = cleanup;
      return createStartMenuRuntime({ catalog, labels }, live.host);
    });
    runtime.open();
    expect(runtime.rows().some((row) => row.id === "tuxepedia")).toBe(false);
    live.state().sw.items.app_tuxepedia = 1;
    runtime.open();
    expect(runtime.rows().some((row) => row.id === "tuxepedia")).toBe(true);
    dispose();
  });

  test("opens on START, persists live move/sort/release changes, and dispatches external rows", () => {
    const source = [
      monster("alpha", 12, 2, 10, "zED"),
      monster("beta", 4, 9, 10, "amy"),
      monster("gamma", 8, 5),
    ];
    const live = liveHost(sessionState(source));
    const dispatched: string[] = [];
    let dispose = () => {};
    const runtime = createRoot((cleanup) => {
      dispose = cleanup;
      return createStartMenuRuntime({
        catalog,
        labels,
        availability: { missions: "disabled" },
        onDispatch: (id) => dispatched.push(id),
      }, live.host);
    });

    expect(runtime.step(0, 0)).toEqual({ consumed: false });
    expect(runtime.step(BTN.START, BTN.START)).toEqual({ consumed: true });
    expect(runtime.rows().map(({ id, enabled }) => [id, enabled])).toEqual([
      ["tuxepedia", true],
      ["party", true],
      ["bag", true],
      ["nuphone", true],
      ["player", true],
      ["missions", false],
      ["save", true],
      ["load", true],
      ["options", true],
      ["exit", true],
    ]);

    runtime.activateIndex(runtime.rows().findIndex((row) => row.id === "party"));
    expect(runtime.state().screen).toBe("party");
    runtime.activateIndex(0); // first monster -> actions
    runtime.activateIndex(2); // Move
    expect(runtime.state().partyMenu.phase).toBe("move");
    expect(runtime.step(BTN.DOWN, BTN.DOWN)).toEqual({ consumed: true, stateChanged: true });
    expect(runtime.state().party.map((entry) => entry.slug)).toEqual(["beta", "alpha", "gamma"]);
    expect(tuxemonExtensionState(live.state().ext).party.map((entry) => entry.slug))
      .toEqual(["beta", "alpha", "gamma"]);
    runtime.applyAction("back");
    expect(runtime.state().partyMenu.phase).toBe("list");
    expect(runtime.state().party.map((entry) => entry.slug)).toEqual(["beta", "alpha", "gamma"]);

    runtime.activateIndex(0); // selected beta -> actions
    runtime.activateIndex(3); // Sort
    runtime.activateIndex(0); // Level ascending
    expect(runtime.state().party.map((entry) => entry.slug)).toEqual(["beta", "gamma", "alpha"]);

    runtime.activateIndex(0); // beta -> actions
    runtime.activateIndex(4); // Release
    expect(runtime.state().partyMenu).toMatchObject({ phase: "releaseConfirm", releaseCursor: 1 });
    runtime.applyAction("confirm"); // default No
    expect(runtime.state().party).toHaveLength(3);
    runtime.activateIndex(0);
    runtime.activateIndex(4);
    runtime.activateIndex(0); // Yes, using the shared touch-confirm path
    expect(runtime.state().party.map((entry) => entry.slug)).toEqual(["gamma", "alpha"]);
    expect(tuxemonExtensionState(live.state().ext).party.map((entry) => entry.slug)).toEqual(["gamma", "alpha"]);
    expect(live.replacements()).toBe(3);

    runtime.applyAction("back"); // party list -> root
    runtime.activateIndex(runtime.rows().findIndex((row) => row.id === "player"));
    expect(runtime.state().screen).toBe("player");
    expect(runtime.state().player).toMatchObject({ name: "Red", gold: 4321, seen: 3, caught: 2 });
    runtime.applyAction("back");
    runtime.activateIndex(runtime.rows().findIndex((row) => row.id === "bag"));
    expect(dispatched).toEqual(["bag"]);
    expect(runtime.isOpen()).toBe(true);
    dispose();
  });

  test("touch selection clamps safely and solo parties cannot enter release", () => {
    const live = liveHost(sessionState([monster("alpha", 5, 10)]));
    let dispose = () => {};
    const runtime = createRoot((cleanup) => {
      dispose = cleanup;
      return createStartMenuRuntime({ catalog, labels }, live.host);
    });
    runtime.open();
    runtime.selectIndex(10_000);
    expect(runtime.state().rootCursor).toBe(runtime.rows().length - 1);
    runtime.activateIndex(runtime.rows().findIndex((row) => row.id === "party"));
    runtime.activateIndex(0);
    expect(runtime.actionRows()).toEqual(["info", "moves"]);
    runtime.selectIndex(999);
    expect(runtime.state().partyMenu.actionCursor).toBe(1);
    dispose();
  });
});

import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { BTN } from "@pocketjs/framework/input";

import featureModesJson from "../data/feature-modes.json";
import { battleAutoplayInput, battleDbToTuxemonBattleDb } from "../battle/index.ts";
import {
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
} from "../battle/extension.ts";
import {
  TUXEMON_BATTLE_DB,
  TUXEMON_EXTENSIONS,
  TUXEMON_SCENE_CATALOG,
  TUXEMON_VARIABLE_ENUMS,
} from "../battle/game.ts";
import { emptyParkSession } from "../battle/park.ts";
import { TUXEMON_PC_SCENE_ID } from "../battle/storage-scenes.ts";
import { createTuxemonBattleRules, tuxemonRuntimeBattleState } from "../battle/runtime.ts";
import type { FeatureModesRuntimeData } from "../ui/feature-modes-data.ts";
import { createCompositeOverlay } from "../ui/game-overlay.tsx";
import {
  createTitleBattleRules,
  createTitleBattleRuntime,
  type TitleBattleOptions,
  type TitleMenuRowId,
} from "../ui/title-battle-runtime.ts";
import type {
  GameViewOverlayConfig,
  GameViewSessionHost,
} from "../vendor/pocket-rpgkit/src/ui/demo-contract.ts";
import {
  createSession,
  startSession,
  stepSession,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { Project } from "../vendor/pocket-rpgkit/src/engine/types.ts";

const DATA = (featureModesJson as unknown as FeatureModesRuntimeData).titleBattle;
const MINIGAME_DATA = (featureModesJson as unknown as FeatureModesRuntimeData).titleMinigame;
const MENU_TEXT = (featureModesJson as unknown as FeatureModesRuntimeData).startMenu.title;
const RULES_DB = battleDbToTuxemonBattleDb(TUXEMON_BATTLE_DB);
const PASS_THROUGH_OVERLAY: GameViewOverlayConfig = {
  create: () => ({
    step: () => ({ consumed: false }),
    isOpen: () => false,
    render: () => undefined,
  }),
};

const PROJECT: Project = {
  format: "rpgkit-project/v1",
  title: "title battle isolation",
  tileSize: 16,
  start: { map: "test", x: 1, y: 1, dir: "down" },
  sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
  items: [],
  maps: [{
    id: "test",
    name: "test",
    width: 4,
    height: 4,
    ground: new Array(16).fill("plain.0"),
  }],
};

type TitleMenuOverrides = Partial<Pick<TitleBattleOptions,
  | "availability"
  | "onLoad"
  | "onAutosave"
  | "onNewGame"
  | "onOptions"
  | "onExit"
>>;

function fixture(initiallyOpen = true, menu: TitleMenuOverrides = {}) {
  const base = createTuxemonBattleRules(TUXEMON_BATTLE_DB, TUXEMON_VARIABLE_ENUMS);
  const rules = createTitleBattleRules(base);
  const session = createSession(PROJECT, 60, {
    immutableState: true,
    extensions: TUXEMON_EXTENSIONS,
    battle: rules,
  });
  let live = startSession(PROJECT, session);
  live = {
    ...live,
    interp: {
      ...live.interp,
      audio: {
        bgm: {
          id: "music_title_theme",
          volume: 80,
          pitch: 110,
          positionTicks: 37,
        },
      },
    },
  };
  const campaign = live;
  const host: GameViewSessionHost = {
    project: PROJECT,
    session,
    getState: () => live,
    heldButtons: () => 0,
    replaceState(next) {
      live = next;
    },
  };
  const runtime = createTitleBattleRuntime({
    data: DATA,
    minigameData: MINIGAME_DATA,
    menuText: MENU_TEXT,
    catalog: TUXEMON_SCENE_CATALOG,
    lang: "en_US",
    rules,
    extensions: TUXEMON_EXTENSIONS,
    initiallyOpen,
    ...menu,
  }, host);
  return {
    runtime,
    rules,
    campaign,
    host,
    live: () => live,
    setLive: (next: SessionState) => { live = next; },
  };
}

describe("title Battle mode", () => {
  test("starts from real imported candidates and restores the exact campaign snapshot", () => {
    createRoot((dispose) => {
      try {
        const f = fixture();
        const before = JSON.stringify(f.campaign);
        f.runtime.applyAction("down");
        f.runtime.applyAction("confirm");
        expect(f.runtime.state()).toMatchObject({ screen: "difficulty", difficultyIndex: 0 });
        f.runtime.selectDifficulty(0);

        const temporary = f.live();
        expect(temporary).not.toBe(f.campaign);
        expect(temporary.scene?.kind).toBe("battle");
        expect(temporary.scene?.kind === "battle" ? temporary.scene.returnAudio : undefined)
          .toEqual(f.campaign.interp.audio);
        expect(temporary.interp.audio).toEqual({
          bgm: {
            id: "music_battle_loop",
            volume: 100,
            pitch: 100,
            positionTicks: 0,
          },
        });
        expect(f.runtime.ownsSession()).toBeTrue();
        const started = tuxemonRuntimeBattleState(temporary.scene!.state);
        expect(started.battle.parties.map((party) => party.length)).toEqual([1, 1]);
        const pool = new Set(DATA.difficulties[0]!.candidates);
        expect(started.battle.parties.flat().every((monster) => pool.has(monster.slug))).toBeTrue();
        expect(f.rules.done(temporary.scene!.state)).toBeNull();

        let restored = false;
        let resultTrack: string | null | undefined;
        for (let frame = 0; frame < 20_000; frame++) {
          const live = f.live();
          if (live === f.campaign) {
            restored = true;
            break;
          }
          if (live.scene?.kind !== "battle") throw new Error("title battle scene disappeared");
          const state = tuxemonRuntimeBattleState(live.scene.state);
          const input = battleAutoplayInput(RULES_DB, state, { capture: "never" });
          f.setLive(stepSession(f.host.session, live, input));
          const stepped = f.live();
          if (stepped.scene?.kind !== "battle") throw new Error("title battle scene disappeared");
          const completion = f.rules.titleCompletion(stepped.scene.state);
          if (completion !== null) resultTrack = stepped.interp.audio?.bgm?.id;
          f.runtime.step(0, 0);
        }
        expect(restored).toBeTrue();
        expect(f.live()).toBe(f.campaign);
        expect(JSON.stringify(f.live())).toBe(before);
        expect(f.runtime.state().screen).toBe("result");
        expect(f.runtime.ownsSession()).toBeFalse();
        expect(f.runtime.state().result).not.toBeNull();
        expect(["win", "lose", "draw"]).toContain(f.runtime.state().result!);
        if (f.runtime.state().result === "win") expect(resultTrack).toBe("music_win_battle_boss");
        if (f.runtime.state().result === "lose") expect(resultTrack).toBe("music_gameover");
      } finally {
        dispose();
      }
    });
  }, 30_000);

  test("starts both imported parties at every upstream difficulty size and level", () => {
    const expected = [
      { id: "beginner", partySize: 1, level: 10 },
      { id: "easy", partySize: 2, level: 15 },
      { id: "normal", partySize: 3, level: 20 },
      { id: "hard", partySize: 4, level: 25 },
      { id: "expert", partySize: 5, level: 30 },
    ] as const;

    expect(DATA.difficulties).toHaveLength(expected.length);
    for (const [index, upstream] of expected.entries()) {
      createRoot((dispose) => {
        try {
          const f = fixture();
          expect(DATA.difficulties[index]).toMatchObject(upstream);
          f.runtime.applyAction("down");
          f.runtime.applyAction("confirm");
          f.runtime.selectDifficulty(index);

          const live = f.live();
          expect(live.scene?.kind).toBe("battle");
          const started = tuxemonRuntimeBattleState(live.scene!.state);
          expect(started.battle.parties.map((party) => party.length)).toEqual([
            upstream.partySize,
            upstream.partySize,
          ]);
          const pool = new Set(DATA.difficulties[index]!.candidates);
          for (const party of started.battle.parties) {
            expect(party.map((monster) => monster.level)).toEqual(
              new Array(upstream.partySize).fill(upstream.level),
            );
            expect(party.every((monster) => pool.has(monster.slug))).toBeTrue();
          }
        } finally {
          dispose();
        }
      });
    }
  });

  test("SELECT cannot hand an owned or queued reducer scene or Park transaction to demo transport", () => {
    createRoot((dispose) => {
      try {
        const f = fixture();
        const guarded = createCompositeOverlay(PASS_THROUGH_OVERLAY, undefined).create(f.host);
        const select = (): boolean => guarded.step(BTN.SELECT, BTN.SELECT).consumed;

        f.runtime.applyAction("down");
        f.runtime.applyAction("confirm");
        f.runtime.selectDifficulty(0);
        const titleBattle = f.live();
        expect(select()).toBeTrue();
        expect(f.live()).toBe(titleBattle);
        expect(f.runtime.step(0, 0)).toEqual({ consumed: false });
        expect(f.runtime.ownsSession()).toBeTrue();

        f.setLive({
          ...f.campaign,
          scene: {
            kind: "scene",
            id: TUXEMON_PC_SCENE_ID,
            fiber: "pc-fixture",
            state: {},
            pausedTicks: 0,
          },
        });
        expect(select()).toBeTrue();

        f.setLive({
          ...f.campaign,
          interp: {
            ...f.campaign.interp,
            pendingBattles: [{ fiber: "battle-fixture", setup: null }],
          },
        });
        expect(select()).toBeTrue();

        f.setLive({
          ...f.campaign,
          interp: {
            ...f.campaign.interp,
            pendingScenes: [{ fiber: "scene-fixture", id: TUXEMON_PC_SCENE_ID, args: null }],
          },
        });
        expect(select()).toBeTrue();

        f.setLive({
          ...f.campaign,
          ext: packTuxemonExtensionState({
            ...initialTuxemonExtensionState(),
            parkSession: emptyParkSession(true),
          }),
          scene: null,
        });
        expect(select()).toBeTrue();

        f.setLive({
          ...f.campaign,
          ext: packTuxemonExtensionState({
            ...initialTuxemonExtensionState(),
            parkSession: { ...emptyParkSession(false), summaryPending: true },
          }),
          scene: null,
        });
        expect(select()).toBeTrue();

        // SELECT remains available in ordinary world play and after the Park
        // session ends; the guard must not disable the shipped demo menu.
        f.setLive({
          ...f.campaign,
          ext: packTuxemonExtensionState({
            ...initialTuxemonExtensionState(),
            parkSession: emptyParkSession(false),
          }),
          scene: null,
        });
        expect(select()).toBeFalse();
      } finally {
        dispose();
      }
    });
  });

  test("composite routes nested Language before Options, then children before START", () => {
    const f = fixture(false);
    const calls: string[] = [];
    let childOneOpen = false;
    let childTwoOpen = true;
    let languageOpen = true;
    const config = (name: string, open: () => boolean): GameViewOverlayConfig => ({
      create: () => ({
        step: () => {
          calls.push(name);
          return { consumed: true };
        },
        isOpen: open,
        render: () => undefined,
      }),
    });
    const composite = createCompositeOverlay(
      config("world", () => true),
      config("language", () => languageOpen),
      undefined,
      undefined,
      undefined,
      [
        config("child-one", () => childOneOpen),
        config("child-two", () => childTwoOpen),
      ],
    ).create(f.host);

    composite.step(0, 0);
    expect(calls).toEqual(["language"]);

    languageOpen = false;
    composite.step(0, 0);
    expect(calls).toEqual(["language", "child-two"]);

    childTwoOpen = false;
    composite.step(0, 0);
    expect(calls).toEqual(["language", "child-two", "world"]);

    childOneOpen = true;
    composite.step(0, 0);
    expect(calls.at(-1)).toBe("child-one");
  });

  test("composite advances a closed child transient without stealing world input", () => {
    const f = fixture(false);
    const calls: string[] = [];
    let transient = true;
    const world: GameViewOverlayConfig = {
      create: () => ({
        step: (buttons, pressed) => {
          calls.push(`world:${buttons}:${pressed}`);
          return { consumed: false };
        },
        isOpen: () => false,
        render: () => undefined,
      }),
    };
    const child = {
      needsPassiveStep: () => transient,
      create: () => ({
        step: (buttons: number, pressed: number) => {
          calls.push(`child:${buttons}:${pressed}`);
          transient = false;
          return { consumed: true };
        },
        isOpen: () => false,
        render: () => undefined,
      }),
    };
    const composite = createCompositeOverlay(world, undefined, undefined, undefined, undefined, child)
      .create(f.host);

    expect(composite.step(BTN.START, BTN.START)).toEqual({ consumed: false });
    expect(calls).toEqual([`child:${BTN.START}:0`, `world:${BTN.START}:${BTN.START}`]);
    expect(composite.isOpen()).toBeFalse();

    composite.step(0, 0);
    expect(calls.at(-1)).toBe("world:0:0");
    expect(calls.filter((entry) => entry.startsWith("child:"))).toHaveLength(1);
  });

  test("back returns from the real five-row difficulty picker without touching the world", () => {
    createRoot((dispose) => {
      try {
        const f = fixture();
        f.runtime.applyAction("down");
        f.runtime.applyAction("confirm");
        for (let index = 0; index < DATA.difficulties.length + 1; index++) {
          f.runtime.applyAction("down");
        }
        expect(f.runtime.state().difficultyIndex).toBe(1);
        f.runtime.applyAction("back");
        expect(f.runtime.state()).toMatchObject({ screen: "title", titleIndex: 1 });
        expect(f.live()).toBe(f.campaign);
      } finally {
        dispose();
      }
    });
  });

  test("automation bypass leaves the campaign open and consumes no input", () => {
    createRoot((dispose) => {
      try {
        const f = fixture(false);
        expect(f.runtime.isOpen()).toBeFalse();
        expect(f.runtime.step(0, 0)).toEqual({ consumed: false });
        expect(f.live()).toBe(f.campaign);
      } finally {
        dispose();
      }
    });
  });

  test("minigame input never reads or replaces the campaign and resets on re-entry", () => {
    createRoot((dispose) => {
      try {
        const f = fixture();
        const before = JSON.stringify(f.campaign);
        const rng = f.campaign.sw.rng;
        f.runtime.selectTitle(2);
        expect(f.runtime.state().screen).toBe("minigameDifficulty");
        f.runtime.step(BTN.DOWN, BTN.DOWN);
        expect(f.runtime.state().minigameDifficultyIndex).toBe(1);
        f.runtime.step(BTN.CIRCLE, BTN.CIRCLE);

        const first = f.runtime.state().minigame!;
        expect(f.runtime.state().screen).toBe("minigameQuestion");
        const correct = first.question.options.indexOf(first.question.target);
        f.runtime.selectMinigameAnswer(correct);
        expect(f.runtime.state().minigame!.score).toBe(2);
        expect(f.runtime.ownsSession()).toBeFalse();
        expect(f.live()).toBe(f.campaign);
        expect(f.live().sw.rng).toBe(rng);
        expect(JSON.stringify(f.live())).toBe(before);

        f.runtime.applyAction("back");
        expect(f.runtime.state()).toMatchObject({ screen: "title", titleIndex: 2, minigame: null });
        f.runtime.selectTitle(2);
        f.runtime.selectMinigameDifficulty(1);
        expect(f.runtime.state().minigame).toMatchObject({ score: 0, streak: 0, rounds: 0 });
        expect(f.runtime.state().minigame!.question).toEqual(first.question);
        expect(f.live()).toBe(f.campaign);
        expect(JSON.stringify(f.live())).toBe(before);
      } finally {
        dispose();
      }
    });
  });
});

describe("title root menu", () => {
  test("publishes upstream rows from deterministic save availability", () => {
    createRoot((dispose) => {
      try {
        const f = fixture();
        expect(f.runtime.menuText).toBe(MENU_TEXT);
        expect(f.runtime.titleRows()).toEqual([
          "newGame", "battle", "minigame", "options", "exit",
        ]);

        // Autosave never appears without a manual save, matching upstream.
        f.runtime.refreshAvailability({ manualSave: false, autosave: true });
        expect(f.runtime.titleRows()).toEqual([
          "newGame", "battle", "minigame", "options", "exit",
        ]);

        // The selected semantic row follows New Game as rows are inserted.
        f.runtime.refreshAvailability({ manualSave: true, autosave: false });
        expect(f.runtime.titleRows()).toEqual([
          "load", "newGame", "battle", "minigame", "options", "exit",
        ]);
        expect(f.runtime.state().titleIndex).toBe(1);
        f.runtime.refreshAvailability({ manualSave: true, autosave: true });
        expect(f.runtime.titleRows()).toEqual([
          "load", "autosave", "newGame", "battle", "minigame", "options", "exit",
        ]);
        expect(f.runtime.state().titleIndex).toBe(2);
      } finally {
        dispose();
      }
    });
  });

  test("wraps over the live row count and preserves Battle and Minigame subflows", () => {
    createRoot((dispose) => {
      try {
        const f = fixture();
        f.runtime.applyAction("up");
        expect(f.runtime.titleRows()[f.runtime.state().titleIndex]).toBe("exit");
        f.runtime.applyAction("down");
        expect(f.runtime.titleRows()[f.runtime.state().titleIndex]).toBe("newGame");

        f.runtime.refreshAvailability({ manualSave: true, autosave: true });
        for (let index = 0; index < f.runtime.titleRows().length; index++) {
          f.runtime.applyAction("down");
        }
        expect(f.runtime.titleRows()[f.runtime.state().titleIndex]).toBe("newGame");

        f.runtime.selectTitle(f.runtime.titleRows().indexOf("battle"));
        expect(f.runtime.state().screen).toBe("difficulty");
        f.runtime.applyAction("back");
        expect(f.runtime.titleRows()[f.runtime.state().titleIndex]).toBe("battle");

        f.runtime.selectTitle(f.runtime.titleRows().indexOf("minigame"));
        expect(f.runtime.state().screen).toBe("minigameDifficulty");
        f.runtime.applyAction("back");
        expect(f.runtime.titleRows()[f.runtime.state().titleIndex]).toBe("minigame");
      } finally {
        dispose();
      }
    });
  });

  test("dispatches host rows and can reopen or reset the title flow", () => {
    createRoot((dispose) => {
      try {
        const dispatched: Array<{ id: TitleMenuRowId; host: GameViewSessionHost }> = [];
        const f = fixture(true, {
          availability: { manualSave: true, autosave: true },
          onLoad: (host) => dispatched.push({ id: "load", host }),
          onAutosave: (host) => dispatched.push({ id: "autosave", host }),
          onNewGame: (host) => dispatched.push({ id: "newGame", host }),
          onOptions: (host) => dispatched.push({ id: "options", host }),
          onExit: (host) => dispatched.push({ id: "exit", host }),
        });

        for (const id of ["load", "autosave", "newGame", "options"] as const) {
          f.runtime.selectTitle(f.runtime.titleRows().indexOf(id));
          expect(dispatched.at(-1)).toEqual({ id, host: f.host });
          expect(f.runtime.state().screen).toBe("closed");
          expect(f.runtime.isOpen()).toBeFalse();
          f.runtime.openTitle();
          expect(f.runtime.state().screen).toBe("title");
          expect(f.runtime.titleRows()[f.runtime.state().titleIndex]).toBe(id);
        }

        f.runtime.selectTitle(f.runtime.titleRows().indexOf("exit"));
        expect(dispatched.at(-1)).toEqual({ id: "exit", host: f.host });
        expect(f.runtime.state().screen).toBe("quit");
        expect(f.runtime.isOpen()).toBeTrue();
        expect(f.runtime.step(BTN.CROSS, BTN.CROSS)).toEqual({ consumed: true });
        expect(f.runtime.state().screen).toBe("quit");
        f.runtime.openTitle();
        expect(f.runtime.state().screen).toBe("title");

        f.runtime.selectTitle(f.runtime.titleRows().indexOf("exit"));
        expect(f.runtime.state().screen).toBe("quit");
        f.runtime.resetTitle();
        expect(f.runtime.state()).toMatchObject({
          screen: "title",
          battleCount: 0,
          result: null,
          minigame: null,
        });
        expect(f.runtime.titleRows()).toHaveLength(7);
      } finally {
        dispose();
      }
    });
  });

  test("keeps placeholder rows open without handlers", () => {
    createRoot((dispose) => {
      try {
        const f = fixture(true, { availability: { manualSave: true, autosave: true } });
        for (const id of ["load", "autosave", "options"] as const) {
          f.runtime.selectTitle(f.runtime.titleRows().indexOf(id));
          expect(f.runtime.state().screen).toBe("title");
        }
        f.runtime.selectTitle(f.runtime.titleRows().indexOf("exit"));
        expect(f.runtime.state().screen).toBe("quit");
        expect(f.runtime.isOpen()).toBeTrue();
      } finally {
        dispose();
      }
    });
  });
});

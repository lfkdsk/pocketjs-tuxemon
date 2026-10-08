import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { lowerRenamePlayerAction } from "../importer/project.ts";
import { decodePng } from "../importer/png.ts";
import {
  IDENTITY_RACES,
  enterImportedIdentityBattle,
  identityBuildVariables,
  identityProject,
  objectCommands,
  runImportedIdentity,
} from "../tools/g-identity-fixture.ts";
import {
  TUXEMON_BATTLE_DB,
  TUXEMON_SCENES,
  TUXEMON_SESSION_OPTIONS,
} from "../battle/game.ts";
import { BTN_BITS } from "../vendor/pocket-rpgkit/src/engine/camera.ts";
import { createSwitchState } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";
import type { NameInputState } from "../vendor/pocket-rpgkit/src/engine/name-input.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionInput,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type {
  Command,
  GameEvent,
  Project,
  TileId,
} from "../vendor/pocket-rpgkit/src/engine/types.ts";

const ROOT = resolve(import.meta.dir, "..");
const BTN_CONFIRM = 0x2000;
const BTN_CANCEL = 0x4000;

const RANDOM_POOLS = {
  female: ["Lyra", "Seren", "Elowen", "Talia", "Imara"],
  male: ["Finnick", "Alden", "Corbin", "Silas", "Dorian"],
  neutral: ["Penguin", "Pulsar", "Pebble", "Zephyr", "Indigo", "Linus", "Ubuntu", "Fedora", "Solus", "Debian", "Red"],
} as const;

function page(commands: Command[], condition?: GameEvent["pages"][number]["condition"]): GameEvent["pages"][number] {
  return { trigger: "autorun", sprite: null, commands, ...(condition ? { condition } : {}) };
}

function harness(commands: Command[], eventId = "identity_event"): Project {
  const tile = "identity.0" as TileId;
  return {
    format: "rpgkit-project/v1",
    title: "Identity acceptance",
    tileSize: 16,
    system: { characterNames: true },
    start: { map: "identity_lab", x: 1, y: 1, dir: "down" },
    sheets: [{ id: "identity", cols: 1, rows: 1, pak: "unused", defaultPassage: "pass" }],
    items: [],
    maps: [{
      id: "identity_lab",
      name: "Identity lab",
      width: 3,
      height: 3,
      sheets: ["identity"],
      ground: new Array(9).fill(tile),
      events: [{
        id: eventId,
        x: 0,
        y: 0,
        pages: [
          page([...commands, { op: "switch", id: "identity.done", value: true }]),
          { trigger: "action", condition: { switch: "identity.done" }, sprite: null, commands: [] },
        ],
      }],
    }],
  };
}

function input(mask: number, previous: number): SessionInput {
  const pressed = mask & ~previous;
  return {
    buttons: mask,
    confirmEdge: Boolean(pressed & BTN_CONFIRM),
    cancelEdge: Boolean(pressed & BTN_CANCEL),
    upEdge: Boolean(pressed & BTN_BITS.UP),
    rightEdge: Boolean(pressed & BTN_BITS.RIGHT),
    downEdge: Boolean(pressed & BTN_BITS.DOWN),
    leftEdge: Boolean(pressed & BTN_BITS.LEFT),
  };
}

function openNameInput(
  project: Project,
  gender: number,
  variables: Record<string, number> = {},
): {
  session: Session;
  state: SessionState;
  press(mask: number): void;
} {
  const session = createSession(project, 60, TUXEMON_SESSION_OPTIONS);
  let state = startSession(project, session, createSwitchState({
    playerName: "Red",
    variables: { ...variables, "v.gender_choice": gender },
  }));
  let previous = 0;
  const tick = (mask = 0): void => {
    state = stepSession(session, state, input(mask, previous));
    previous = mask;
  };
  const press = (mask: number): void => {
    tick(mask);
    tick(0);
  };
  for (let frame = 0; frame < 20 && state.scene === null; frame++) tick();
  if (state.scene?.kind !== "scene" || state.scene.id !== "rpgkit.nameInput") {
    throw new Error("G identity: imported name-input scene did not open");
  }
  return {
    session,
    get state() { return state; },
    press,
  };
}

function healingCenterRenameProject(): Project {
  const project = identityProject();
  project.start = { map: "healing_center", x: 8, y: 8, dir: "down" };
  return project;
}

function nameState(state: SessionState): NameInputState {
  if (state.scene?.kind !== "scene") throw new Error("G identity: name input is not active");
  return state.scene.state as unknown as NameInputState;
}

function goldenPixel(
  file: string,
  x: number,
  y: number,
): { width: number; height: number; rgba: number[] } {
  const path = join(ROOT, "tests", "goldens", file);
  const image = decodePng(new Uint8Array(readFileSync(path)), path);
  const offset = (y * image.width + x) * 4;
  return {
    width: image.width,
    height: image.height,
    rgba: [...image.rgba.slice(offset, offset + 4)],
  };
}

describe("G identity imported runtime", () => {
  test("real healing_center rename_player selects numeric gender pools and commits RANDOM", () => {
    const project = healingCenterRenameProject();
    const cases = [
      { value: 1, pool: RANDOM_POOLS.female },
      { value: 2, pool: RANDOM_POOLS.male },
      { value: 3, pool: RANDOM_POOLS.neutral },
      // A fresh variable bank reads as numeric zero. Unknown numeric values
      // follow upstream's invalid-gender -> neutral behavior as well.
      { value: 0, pool: RANDOM_POOLS.neutral },
      { value: 99, pool: RANDOM_POOLS.neutral },
    ] as const;
    for (const row of cases) {
      // The imported e006_rename_player parallel page opens only while the
      // original story variable `shady` is `yes` (enum code 2). Starting the
      // real map with that bank exercises its authored condition and action.
      const run = openNameInput(project, row.value, { "v.shady": 2 });
      expect(nameState(run.state).randomPool, `gender_choice=${row.value}`).toEqual([...row.pool]);
      run.press(BTN_BITS.LEFT); // cursor 0 wraps to RANDOM
      run.press(BTN_CONFIRM);
      const picked = nameState(run.state).buffer;
      expect((row.pool as readonly string[]).includes(picked), `gender_choice=${row.value} pick`).toBe(true);
      run.press(BTN_BITS.LEFT); // RANDOM -> CANCEL
      run.press(BTN_BITS.LEFT); // CANCEL -> OK
      run.press(BTN_CONFIRM);
      for (let frame = 0; frame < 10 && run.state.scene !== null; frame++) run.press(0);
      expect(run.state.sw.playerName).toBe(picked);
    }
  });

  test("synthetic NPC rename writes the live character name and the next visible token reads it", () => {
    // Upstream rename_player.py:41-42 assigns the callback result directly
    // to char.name; lines 44-60 resolve the NPC and open the blocking input.
    const lowered = lowerRenamePlayerAction("guide", false, "guide");
    expect(lowered).toEqual([
      expect.objectContaining({
        op: "scene",
        id: "rpgkit.nameInput",
        args: expect.objectContaining({ variable: "v.tux.npc_name.guide", default: "", maxLength: 15 }),
      }),
      {
        op: "changeName",
        target: "this",
        name: { variable: "v.tux.npc_name.guide" },
      },
    ]);
    const project = harness([
      ...lowered,
      { op: "text", lines: ["Welcome, {char:this}!"] },
    ], "npc_guide");
    const session = createSession(project, 60, { scenes: TUXEMON_SCENES });
    let state = startSession(project, session);
    for (let frame = 0; frame < 20 && state.scene === null; frame++) {
      state = stepSession(session, state, { buttons: 0 });
    }
    expect(state.scene?.kind).toBe("scene");
    const sceneState = state.scene!.state as unknown as NameInputState;
    sceneState.buffer = "Nova";
    sceneState.cursor = sceneState.charset.length + 1; // OK
    state = stepSession(session, state, { buttons: BTN_CONFIRM, confirmEdge: true });
    state = stepSession(session, state, { buttons: 0 });
    for (let frame = 0; frame < 20 && state.interp.modal === null; frame++) {
      state = stepSession(session, state, { buttons: 0 });
    }
    expect((state.sw as unknown as { eventNames?: Record<string, string> }).eventNames)
      .toMatchObject({ "identity_lab/npc_guide": "Nova" });
    expect(state.interp.modal).toMatchObject({
      kind: "text",
      lines: ["Welcome, Nova!"],
    });
  });

  test("all six real start_tuxemon branches preserve their walker and combat-sheet identity", () => {
    expect(identityBuildVariables().race_choice).toEqual([
      "black_female",
      "black_male",
      "gender_enby",
      "gender_whatever",
      "white_female",
      "white_male",
    ]);
    for (const race of IDENTITY_RACES) {
      const project = identityProject();
      const choice = objectCommands(project.maps.find((map) => map.id === "start_tuxemon"))
        .find((command) => command.op === "choices" && command.options.length === 6);
      if (choice?.op !== "choices") throw new Error("G identity: six-row appearance choice missing");
      const option = choice.options.find((candidate) => candidate.text.includes(race.option));
      expect(option?.icon).toEqual({ sprite: race.sprite });
      expect(option?.commands).toContainEqual({
        op: "variable",
        id: "v.race_choice",
        set: { op: "set", value: race.code },
      });

      const state = runImportedIdentity(race);
      expect(state.sw.variables["v.race_choice"]).toBe(race.code);
      expect(state.sw.playerAppearance).toMatchObject({
        defaultSprite: race.sprite,
        defaultCombatSheet: race.combatSheet,
      });
    }
  });

  test("two independent race branches enter real First Fight Battle Processing with non-adventurer pixels", () => {
    const cases = [IDENTITY_RACES[3], IDENTITY_RACES[5]] as const;
    const expectedPixel: Record<string, readonly [number, number, number, number]> = {
      heroineblack: [204, 252, 254, 255],
      penguin: [63, 63, 63, 255],
    };
    const adventurerPath = join(ROOT, "assets/battle/gfx/sprites/player/adventurer.png");
    const adventurer = decodePng(new Uint8Array(readFileSync(adventurerPath)), adventurerPath);
    const pixel = (rgba: Uint8Array, width: number, x: number, y: number) =>
      [...rgba.slice((y * width + x) * 4, (y * width + x) * 4 + 4)];
    expect(pixel(adventurer.rgba, adventurer.width, 40, 60)).toEqual([241, 195, 168, 255]);

    for (const race of cases) {
      const reached = enterImportedIdentityBattle(race);
      expect(reached.battle.battle.opponent).toBe("spyder_billie");
      expect(reached.battle.visuals.trainers.player).toEqual(
        TUXEMON_BATTLE_DB.ui.trainerSheets[race.combatSheet],
      );
      expect(reached.battle.visuals.trainers.player).not.toEqual(
        TUXEMON_BATTLE_DB.ui.trainerSheets.adventurer,
      );
      const path = join(ROOT, `assets/battle/gfx/sprites/player/${race.combatSheet}.png`);
      const image = decodePng(new Uint8Array(readFileSync(path)), path);
      // This is a fixed opaque costume pixel in the player trainer frame.
      // The old runtime's hard-coded adventurer ref yields [241,195,168,255]
      // here, so either identity branch turns this assertion red immediately.
      expect(pixel(image.rgba, image.width, 40, 60), race.option)
        .toEqual([...expectedPixel[race.combatSheet]!]);
    }
  }, 30_000);

  test("both golden resolutions contain the selected trainer sheet at the rendered costume pixel", () => {
    // Source (40,60) lands at (152,148) in the 480-wide trainer slot and at
    // exactly twice that coordinate at 960. PSM_4444 quantizes heroine cyan
    // to ccffff and penguin charcoal to 333333. These are rendered-frame
    // assertions: an unchanged manifest or a correctly named source file is
    // insufficient if the view paints the wrong sheet.
    const cases = [
      { id: "black-female", colour: [204, 255, 255, 255] },
      { id: "whatever", colour: [51, 51, 51, 255] },
    ] as const;
    for (const row of cases) {
      expect(goldenPixel(`g-identity-${row.id}.480x272.png`, 152, 148)).toEqual({
        width: 480,
        height: 272,
        rgba: [...row.colour],
      });
      expect(goldenPixel(`g-identity-${row.id}.960x544.png`, 304, 296)).toEqual({
        width: 960,
        height: 544,
        rgba: [...row.colour],
      });
    }
  });
});

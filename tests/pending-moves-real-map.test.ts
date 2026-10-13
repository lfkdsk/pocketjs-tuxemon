import { afterEach, describe, expect, test } from "bun:test";

import {
  TUXEMON_BATTLE_DB,
  TUXEMON_SESSION_OPTIONS,
} from "../battle/game.ts";
import {
  TUXEMON_SESSION_OPTIONS_ZH,
} from "../battle/game-zh.ts";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import {
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
  tuxemonExtensionState,
} from "../battle/extension.ts";
import { spawnMonster } from "../battle/spawn.ts";
import { buildProject, G6_IMPORT_OPTIONS, setImportLang } from "../importer/project.ts";
import { createSession, startSession, stepSession } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { ChoiceModal } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";
import type { Project } from "../vendor/pocket-rpgkit/src/engine/types.ts";

type Lang = "en_US" | "zh_CN";

const DB = TUXEMON_BATTLE_DB;
const RULES = battleDbToTuxemonBattleDb(DB);
const MOVES = ["bullet", "frighten", "buzz", "blade", "lineage"] as const;

afterEach(() => setImportLang("en_US"));

function importedEventProject(lang: Lang): Project {
  setImportLang(lang);
  const project = buildProject(["spyder_greenwash_greenhouse"], G6_IMPORT_OPTIONS).project;
  const map = project.maps.find((candidate) => candidate.id === "spyder_greenwash_greenhouse")!;
  const event = map.events?.find((candidate) => candidate.id === "e037_check_max_moves");
  if (!event) throw new Error("real Spyder Check Max Moves event was not imported");
  map.events = [event];
  project.maps = [map];
  project.start = { map: map.id, x: 1, y: 1, dir: "down" };
  return project;
}

function overCapState() {
  const monster = spawnMonster(DB, RULES, { rng: 71, rngDraws: 0 }, "puparmor", 16, {
    iid: "pending-puparmor",
  });
  monster.moves = [...MOVES];
  return packTuxemonExtensionState({
    ...initialTuxemonExtensionState(),
    party: [monster],
  });
}

function runRealEvent(lang: Lang, selection: number) {
  const project = importedEventProject(lang);
  const session = createSession(
    project,
    60,
    lang === "zh_CN" ? TUXEMON_SESSION_OPTIONS_ZH : TUXEMON_SESSION_OPTIONS,
  );
  let state = startSession(project, session, undefined, overCapState());
  const lines: string[] = [];
  let choice: ChoiceModal | null = null;

  for (let frame = 0; frame < 1200; frame++) {
    const modal = state.interp.modal;
    if (modal?.kind === "choices") {
      choice = modal;
      break;
    }
    if (modal?.kind === "text" && modal.complete) lines.push(modal.lines.join(" "));
    state = stepSession(session, state, {
      buttons: 0,
      confirmEdge: modal?.kind === "text" && modal.complete,
    });
  }
  if (!choice) throw new Error("real Check Max Moves event did not open its move list");
  for (let index = 0; index < selection; index++) {
    state = stepSession(session, state, { buttons: 0, downEdge: true });
    state = stepSession(session, state, { buttons: 0 });
  }
  expect((state.interp.modal as ChoiceModal).index).toBe(selection);
  state = stepSession(session, state, { buttons: 0, confirmEdge: true });

  let report = "";
  for (let frame = 0; frame < 600; frame++) {
    const modal = state.interp.modal;
    if (modal?.kind === "text" && modal.complete) {
      report = modal.lines.join(" ");
      state = stepSession(session, state, { buttons: 0, confirmEdge: true });
      break;
    }
    state = stepSession(session, state, { buttons: 0 });
  }
  for (let frame = 0; frame < 60; frame++) state = stepSession(session, state, { buttons: 0 });
  expect(state.interp.error ?? null).toBeNull();
  expect(state.interp.modal).toBeNull();
  return { choice, lines, report, state };
}

describe("pending move replacement on the real imported Spyder event", () => {
  test("English replaces the selected old move, keeps the newest move and ends the parallel page", () => {
    const result = runRealEvent("en_US", 1);
    expect(result.lines).toEqual([
      "Tuxemon has too many techniques.",
      "Which technique do you want to delete?",
    ]);
    expect(result.choice.prompt).toBe("Forget which technique?");
    expect(result.choice.cancellable).toBeFalse();
    expect(result.choice.keys).toEqual([...MOVES]);
    expect(result.choice.options).toEqual(["Bullet", "Frighten", "Buzz", "Blade", "Lineage"]);
    expect(result.report).toBe("Frighten replaced with Lineage.");
    expect(tuxemonExtensionState(result.state.ext, DB).party[0]!.moves)
      .toEqual(["bullet", "buzz", "blade", "lineage"]);
    expect(result.state.sw.variables["v.chosen_tech"]).toBe("frighten");
  });

  test("Chinese selecting the newest move declines it with localized rows and report", () => {
    const result = runRealEvent("zh_CN", 4);
    expect(result.lines).toEqual([
      "精灵的招式太多了。",
      "你想忘记哪个招式？",
    ]);
    expect(result.choice.prompt).toBe("要遗忘哪个招式？");
    expect(result.choice.cancellable).toBeFalse();
    expect(result.choice.keys).toEqual([...MOVES]);
    expect(result.choice.options).toEqual(["高速球", "恐吓", "嗡嗡", "叶之刃", "血统"]);
    expect(result.report).toBe("决定不学习 血统。");
    expect(tuxemonExtensionState(result.state.ext, DB).party[0]!.moves)
      .toEqual(["bullet", "frighten", "buzz", "blade"]);
    expect(result.state.sw.variables["v.chosen_tech"]).toBe("lineage");
  });
});

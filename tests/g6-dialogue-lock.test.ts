import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BTN_BITS } from "../vendor/pocket-rpgkit/src/engine/camera.ts";
import {
  createSession,
  startSession,
  stepSession,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { Project } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { TUXEMON_BATTLE_RULES, TUXEMON_EXTENSIONS, TUXEMON_SCENES } from "../battle/game.ts";

const ROOT = resolve(import.meta.dir, "..");
const project = JSON.parse(readFileSync(resolve(ROOT, "dist/project.json"), "utf8")) as Project;
const NONE = { buttons: 0, confirmEdge: false, cancelEdge: false, upEdge: false, downEdge: false };

function numericVariable(state: SessionState, id: string): number {
  const value = state.sw.variables[id];
  if (value === undefined) return 0;
  if (typeof value !== "number") throw new Error(`expected numeric variable ${id}, got ${typeof value}`);
  return value;
}

function bedroom(x = 4, y = 4, dir: "down" | "left" = "down") {
  const runProject: Project = { ...project, start: { map: "spyder_bedroom", x, y, dir } };
  const session = createSession(runProject, 60, {
    extensions: TUXEMON_EXTENSIONS,
    battle: TUXEMON_BATTLE_RULES,
    scenes: TUXEMON_SCENES,
  });
  return { session, state: startSession(runProject, session) };
}

function chooseNo(
  session: ReturnType<typeof createSession>,
  initial: SessionState,
): SessionState {
  let state = initial;
  for (let frame = 0; frame < 200; frame++) {
    const modal = state.interp.modal;
    const confirmEdge = modal?.kind === "choices" ||
      (modal?.kind === "text" && modal.complete && frame % 2 === 0);
    state = stepSession(session, state, { ...NONE, confirmEdge });
    if (modal?.kind === "choices" && confirmEdge) return state;
  }
  throw new Error("Spyder intro choice did not open");
}

test("Tuxemon dialog boxes hold movement and consume action input", () => {
  expect(project.system).toEqual({
    inventory: { maxKinds: 99 },
    messageBlocksPlayer: true,
    // ${{var:name}} dialogue prints stored text variables through {v:id}.
    textVariables: true,
  });

  // The opening parallel question freezes the first attempted step at its
  // documented 2 px offset, then holds that exact position while LEFT stays
  // pressed.
  {
    const { session, state: initial } = bedroom();
    let state = stepSession(session, initial, { ...NONE, buttons: BTN_BITS.LEFT });
    expect(state.interp.modal?.fiber).toContain("e002_intro_question");
    const frozen = [state.move.tx, state.move.ty, state.move.px, state.move.py];
    for (let frame = 0; frame < 59; frame++) {
      state = stepSession(session, state, { ...NONE, buttons: BTN_BITS.LEFT });
    }
    expect([state.move.tx, state.move.ty, state.move.px, state.move.py]).toEqual(frozen);
    expect([state.move.tx, state.move.ty]).toEqual([4, 4]);
  }

  // Confirming the opening box while facing the bed must belong only to that
  // box; it cannot start the action page named "Resting in Bed".
  {
    const { session, state: initial } = bedroom(1, 2, "left");
    const state = chooseNo(session, initial);
    const running = [state.interp.main?.key, ...Object.keys(state.interp.parallels)]
      .filter((key): key is string => key !== undefined);
    expect(running.some((key) => key.includes("resting_in_bed"))).toBeFalse();
  }
});

test("declining the skip cannot escape the CEO monologue and preserves story order", () => {
  {
    const { session, state: initial } = bedroom();
    let state = chooseNo(session, initial);
    const plan = [
      [BTN_BITS.RIGHT, 60],
      [BTN_BITS.UP, 40],
      [BTN_BITS.LEFT, 12],
    ] as const;
    for (const [buttons, count] of plan) {
      for (let frame = 0; frame < count; frame++) {
        state = stepSession(session, state, { ...NONE, buttons });
      }
    }
    expect(state.interp.modal?.fiber).toContain("e006_spyder_intro");
    expect([state.mapId, state.move.tx, state.move.ty]).toEqual(["spyder_bedroom", 4, 4]);
    expect(numericVariable(state, "v.spyder_intro")).toBe(0);
  }

  // With normal confirmation input, question_intro is committed first, then
  // the CEO script commits spyder_intro, and only then does its transfer run.
  {
    const { session, state: initial } = bedroom();
    let state = initial;
    let choseNo = false;
    const seen: Record<string, number> = {};
    for (let frame = 0; frame < 2_500; frame++) {
      const modal = state.interp.modal;
      let confirmEdge = false;
      if (modal?.kind === "text" && modal.complete && frame % 2 === 0) confirmEdge = true;
      if (modal?.kind === "choices" && !choseNo && frame % 2 === 0) {
        confirmEdge = true;
        choseNo = true; // index 0 is "No"
      }
      state = stepSession(session, state, { ...NONE, confirmEdge });
      for (const id of ["v.question_intro", "v.spyder_intro"] as const) {
        if (seen[id] === undefined && numericVariable(state, id) > 0) seen[id] = frame;
      }
      if (state.mapId !== "spyder_bedroom") {
        seen.transfer = frame;
        break;
      }
    }
    expect(seen["v.question_intro"]).toBeDefined();
    expect(seen["v.spyder_intro"]).toBeGreaterThan(seen["v.question_intro"]!);
    expect(seen.transfer).toBeGreaterThan(seen["v.spyder_intro"]!);
    expect(state.mapId).toBe("spyder_paper_scoop");
    expect(state.interp.error).toBeUndefined();
  }
});

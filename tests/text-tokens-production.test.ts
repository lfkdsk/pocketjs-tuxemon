// Production-path tests for the {v:}/{x:} dialog tokens: each template kind
// opens from its REAL imported event in the REAL generated project, through
// the kit's session (createSession + the game's textTokens resolver), so the
// modal text is expanded by the kit's expandTextTokens exactly as in the
// live game. These complement tests/text-tokens.test.ts, which probes the
// resolver directly with real imported lines and writes.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createSession,
  startSession,
  stepSession,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { Project } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { BTN_BITS } from "../vendor/pocket-rpgkit/src/engine/camera.ts";
import { TUXEMON_SESSION_OPTIONS } from "../battle/game.ts";

const ROOT = resolve(import.meta.dir, "..");
const project = JSON.parse(readFileSync(resolve(ROOT, "dist/project.json"), "utf8")) as Project;
const NONE = { buttons: 0, confirmEdge: false, cancelEdge: false, upEdge: false, downEdge: false };

/** Step the session until a text modal opens (or the frame budget runs out).
 *  Returns the modal's joined lines — the kit expands tokens when the modal
 *  opens, so the full expanded text is in `lines` regardless of the
 *  typewriter reveal state. */
function openDialog(
  runProject: Project,
  pressActionAt: number,
  budget = 120,
): { state: SessionState; text: string } {
  const session = createSession(runProject, 60, TUXEMON_SESSION_OPTIONS);
  let state = startSession(runProject, session);
  for (let frame = 0; frame < budget; frame++) {
    state = stepSession(session, state, { ...NONE, confirmEdge: frame === pressActionAt });
    const modal = state.interp.modal;
    if (modal?.kind === "text" && modal.lines.length > 0) {
      return { state, text: modal.lines.join(" ") };
    }
  }
  throw new Error("dialog did not open within the frame budget");
}

/** Step the session: walk in `direction` until the player reaches `target`,
 *  then hold confirm to fast-forward through the dialog sequence. Returns
 *  each complete dialog's joined lines, in order. */
function walkAndAdvance(
  runProject: Project,
  direction: number,
  target: { x: number; y: number },
  budget = 600,
): string[] {
  const session = createSession(runProject, 60, TUXEMON_SESSION_OPTIONS);
  let state = startSession(runProject, session);
  const dialogs: string[] = [];
  let last = "";
  for (let frame = 0; frame < budget; frame++) {
    const onTarget = state.move.tx === target.x && state.move.ty === target.y;
    state = stepSession(session, state, onTarget
      ? { ...NONE, confirmEdge: true }
      : { ...NONE, buttons: direction });
    const modal = state.interp.modal;
    if (modal?.kind === "text" && modal.complete) {
      const text = modal.lines.join(" ");
      if (text !== last) {
        last = text;
        dialogs.push(text);
      }
    }
  }
  return dialogs;
}

test("var tokens: the leather_gym scoreboard opens from its real event and shows 'Chad 0 vs Brad 0'", () => {
  // e001_board_r002 (action, no conditions) at (6,2) runs format_variable on
  // chad_points/brad_points, then shows "Chad {v:v.chad_points} vs Brad {v:v.brad_points}".
  // The cathedral init writes both as the text "0", so the production
  // expander shows "Chad 0 vs Brad 0" — not the enum code 1.
  const runProject: Project = {
    ...project,
    start: { map: "spyder_leather_gym", x: 6, y: 3, dir: "up" },
  };
  const { text } = openDialog(runProject, 10);
  expect(text).toContain("Chad 0 vs Brad 0");
  expect(text).not.toContain("???");
});

test("money token: the cotton_artshop wallet opens from its real playerTouch event and shows '$ 500'", () => {
  // e008_pay_up_r002 (playerTouch, facing-up condition) at (0,9) runs a
  // gallery dialog sequence whose 4th text is "{name}'s wallet: {x:money}".
  // Start below, walk up onto the event, and fast-forward with confirm.
  const runProject: Project = {
    ...project,
    start: { map: "spyder_cotton_artshop", x: 0, y: 10, dir: "up" },
  };
  const dialogs = walkAndAdvance(runProject, BTN_BITS.UP, { x: 0, y: 9 });
  const wallet = dialogs.find((d) => d.includes("wallet"));
  expect(wallet, `wallet dialog not found; saw: ${JSON.stringify(dialogs)}`).toBeDefined();
  expect(wallet!).toContain("$ 500");
  expect(wallet!).not.toContain("???");
});

test("map_desc token: the timber_town welcome sign opens from its real event and shows the description", () => {
  // e016_sign_timber_town_r021 (action) at (6,1) shows
  // "Welcome to Timber Town Town: {x:map_desc}". The description comes from
  // dist/map-descriptions.json, which contains 粮 — a glyph the font subset
  // must cover (B2).
  const runProject: Project = {
    ...project,
    start: { map: "spyder_timber_town", x: 6, y: 2, dir: "up" },
  };
  const { text } = openDialog(runProject, 10);
  expect(text).toContain("Welcome to Timber Town Town:");
  expect(text).not.toContain("???");
  expect(text.length).toBeGreaterThan("Welcome to Timber Town Town:".length);
});

test("map_desc token: the lion_mountain_low welcome sign shows the 尺 description", () => {
  // e016_welcome_sign_r009 (action) at (12,8) shows
  // "Welcome to Lion Mountain: {x:map_desc}". The description contains 尺,
  // a glyph the font subset must cover (B2).
  const runProject: Project = {
    ...project,
    start: { map: "eclipse_lion_mountain_low", x: 12, y: 9, dir: "up" },
  };
  const { text } = openDialog(runProject, 10);
  expect(text).toContain("Welcome to Lion Mountain:");
  expect(text).not.toContain("???");
  expect(text.length).toBeGreaterThan("Welcome to Lion Mountain:".length);
});

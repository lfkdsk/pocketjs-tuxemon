import { expect, test } from "bun:test";

import { TUXEMON_EXTENSIONS } from "../battle/game.ts";
import { buildProject, G6_IMPORT_OPTIONS } from "../importer/project.ts";
import {
  createSession,
  startSession,
  stepSession,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";

const IDLE = { buttons: 0 } as const;

function finishText(
  session: ReturnType<typeof createSession>,
  initial: SessionState,
): SessionState {
  let state = initial;
  for (let frame = 0; frame < 120 && state.interp.modal?.kind === "text" && !state.interp.modal.complete; frame++) {
    state = stepSession(session, state, IDLE);
  }
  expect(state.interp.modal).toMatchObject({ kind: "text", complete: true });
  return stepSession(session, state, { buttons: 0, confirmEdge: true });
}

function openRealPasscodeChoice(): {
  session: ReturnType<typeof createSession>;
  state: SessionState;
} {
  const imported = buildProject(["spyder_candy_hospital1"], G6_IMPORT_OPTIONS);
  const coverage = imported.report.coverage.actions.rows.find((row) => row.type === "translated_dialog_choice")!;
  expect(coverage.native).toBeGreaterThan(0);
  expect(coverage.degraded).toBe(0);

  const map = imported.project.maps[0]!;
  const passcode = map.events?.find((event) => event.id === "e027_passcode_number");
  expect(passcode?.name).toBe("Passcode Number");
  map.events = [passcode!];
  imported.project.start = { map: map.id, x: 9, y: 12, dir: "up" };

  const session = createSession(imported.project, 60);
  let state = startSession(imported.project, session);
  state.sw.variables["v.passcode_color"] = 1;
  state = stepSession(session, state, IDLE);
  expect(state.interp.modal).toMatchObject({ kind: "text", lines: ["And number?"] });
  state = finishText(session, state);
  expect(state.interp.modal).toMatchObject({
    kind: "choices",
    options: ["2!", "02", "05", "10", "2F", "II", "B", "..---"],
    index: 0,
    cancellable: true,
  });
  return { session, state };
}

test("the real eight-option passcode choice is flat, selects its last row, and cancels without a write", () => {
  const selected = openRealPasscodeChoice();
  for (let row = 1; row < 8; row++) {
    selected.state = stepSession(selected.session, selected.state, { buttons: 0, downEdge: true });
  }
  expect(selected.state.interp.modal).toMatchObject({ kind: "choices", index: 7 });
  selected.state = stepSession(selected.session, selected.state, { buttons: 0, confirmEdge: true });
  expect(selected.state.sw.variables["v.passcode_number"]).toBe(1);

  const cancelled = openRealPasscodeChoice();
  cancelled.state = stepSession(cancelled.session, cancelled.state, { buttons: 0, cancelEdge: true });
  expect(cancelled.state.interp.modal).toBeNull();
  expect(cancelled.state.sw.variables["v.passcode_number"] ?? 0).toBe(0);
});

test("the real hospital load_yaml exposes appended events on the next update", () => {
  const imported = buildProject(["spyder_flower_center"], G6_IMPORT_OPTIONS);
  expect(imported.report.coverage.actions.rows.find((row) => row.type === "load_yaml"))
    .toMatchObject({ native: 1, degraded: 0 });

  const map = imported.project.maps[0]!;
  map.events = map.events?.filter((event) => [
    "e001_create_nurse",
    "e020_agree_no",
    "npc_spyder_cathedral_nurse",
  ].includes(event.id));
  imported.project.start = { map: map.id, x: 1, y: 1, dir: "down" };

  const session = createSession(imported.project, 60, { extensions: TUXEMON_EXTENSIONS });
  let state = startSession(imported.project, session);
  state.sw.variables["v.isitok"] = 1;

  state = stepSession(session, state, IDLE);
  expect(state.sw.variables["v.__loaded_yaml.spyder_flower_center.spyder_cathedral"] ?? 0).toBe(0);
  expect(state.sw.variables["v.isitok"]).toBe(1);
  expect(state.sw.variables["v.selltuxemon"] ?? 0).toBe(0);

  state = stepSession(session, state, IDLE);
  expect(state.sw.variables["v.__loaded_yaml.spyder_flower_center.spyder_cathedral"]).toBe(1);
  expect(state.sw.variables["v.isitok"]).toBe(2);
  expect(state.sw.variables["v.selltuxemon"]).toBe(2);
  expect(state.interp.modal).toMatchObject({
    kind: "text",
    lines: ["Let me know if you change your mind!"],
  });
});

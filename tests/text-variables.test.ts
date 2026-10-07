import { describe, expect, test } from "bun:test";

import { TUXEMON_SESSION_OPTIONS, TUXEMON_VARIABLE_ENUMS } from "../battle/game.ts";
import {
  formatVariable,
  formatVariableCommand,
  pyFloatText,
  variableMath,
  variableTextCondition,
  type MathOperator,
  type VariableFormat,
} from "../battle/text-variables.ts";
import { availableMapIds, buildProject, G6_IMPORT_OPTIONS } from "../importer/project.ts";
import type { ExtensionCommandContext } from "../vendor/pocket-rpgkit/src/engine/extensions.ts";
import { createSession, startSession, stepSession, type SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { Project } from "../vendor/pocket-rpgkit/src/engine/types.ts";

// Ground truth printed by CPython 3 with upstream's ops_dict / safe_floordiv
// (tuxemon/tools.py) and format_variable's int()/float() on the str() of a
// float or int value: [operand1, operator, operand2, str(result)].
const PY_MATH: [string, MathOperator, string, string][] = [
  ["0", "+", "1", "1.0"], ["1.0", "+", "1", "2.0"], ["0.5", "*", "100", "50.0"], ["0.1", "*", "100", "10.0"],
  ["7", "/", "2", "3"], ["-7", "/", "2", "-4"], ["1", "/", "0.1", "9"], ["5", "/", "0", "5"],
  ["3", "-", "10", "-7.0"], ["250", "*", "1e20", "2.5e+22"], ["1", "*", "1e-05", "1e-05"],
  ["0.1", "+", "0.2", "0.30000000000000004"], ["2", "=", "3", "3.0"], ["12", "*", "50", "600.0"],
];
const PY_FORMAT: [string, VariableFormat, string][] = [
  ["0", "int", "0"], ["0", "-int", "0"], ["0", "float", "0.0"], ["0", "-float", "-0.0"],
  ["1.0", "int", "1"], ["1.0", "-int", "-1"], ["1.0", "float", "1.0"], ["1.0", "-float", "-1.0"],
  ["50.0", "int", "50"], ["50.0", "-int", "-50"], ["0.5", "int", "0"], ["0.5", "-int", "0"],
  ["0.5", "float", "0.5"], ["0.5", "-float", "-0.5"], ["-2.7", "int", "-2"], ["-2.7", "-int", "2"],
  ["123", "int", "123"], ["123", "-int", "-123"], ["123", "float", "123.0"], ["123", "-float", "-123.0"],
  ["1e+16", "int", "10000000000000000"], ["1e+16", "float", "1e+16"], ["0.0001", "float", "0.0001"],
  ["1e-05", "int", "0"], ["1e-05", "-float", "-1e-05"],
];

function objectNodes(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) for (const child of value) objectNodes(child, out);
  else if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    out.push(object);
    for (const child of Object.values(object)) objectNodes(child, out);
  }
  return out;
}

const CONFIRM = 0x2000;

function enumValue(bank: keyof typeof TUXEMON_VARIABLE_ENUMS, value: string): number {
  const index = TUXEMON_VARIABLE_ENUMS[bank].indexOf(value);
  if (index < 0) throw new Error(`${bank} has no ${value} enum`);
  return index + 1;
}

describe("Python number semantics", () => {
  test("variable_math matches CPython for literal and variable operands", () => {
    for (const [left, operator, right, expected] of PY_MATH) {
      expect(variableMath({}, { value: Number(left) }, operator, { value: Number(right) })).toBe(expected);
      expect(variableMath({ a: left, b: right }, { variable: "a" }, operator, { variable: "b" })).toBe(expected);
    }
  });

  test("format_variable matches CPython int()/float() and negation", () => {
    for (const [text, format, expected] of PY_FORMAT) expect(formatVariable(text, format)).toBe(expected);
    expect(pyFloatText(1e16)).toBe("1e+16");
    expect(pyFloatText(1.5e-7)).toBe("1.5e-07");
  });

  test("upstream error paths leave the variable unchanged", () => {
    expect(variableMath({}, { variable: "missing" }, "+", { value: 1 })).toBeNull();
    expect(variableMath({ a: "yes" }, { variable: "a" }, "+", { value: 1 })).toBeNull();
    expect(variableMath({ a: 3 }, { variable: "a" }, "+", { value: 1 })).toBeNull();
    expect(formatVariable("yes", "int")).toBeNull();
    expect(formatVariable("inf", "int")).toBeNull();
    const context = { ext: null, switches: {}, variables: { a: 0 }, items: {}, gold: 0, playerName: "A", random: () => 0 };
    expect(formatVariableCommand(context as ExtensionCommandContext, { variable: "a", format: "int" })).toBeUndefined();
  });

  test("a text variable is set while it holds a string", () => {
    const context = { ext: null, switches: {}, items: {}, gold: 0, playerName: "A" };
    const check = (variables: Record<string, number | string>, args: Record<string, string | boolean>) =>
      variableTextCondition({ ...context, variables }, { variable: "v", ...args });
    expect(check({ v: "0" }, {})).toBe(true);
    expect(check({ v: "" }, {})).toBe(true);
    expect(check({ v: 0 }, {})).toBe(false);
    expect(check({}, { negate: true })).toBe(true);
    expect(check({ v: "1.0" }, { value: "1.0" })).toBe(true);
    expect(check({ v: "1" }, { value: "1.0" })).toBe(false);
  });
});

describe("real variable transforms import", () => {
  const build = buildProject(["spyder_leather_gym", "spyder_healing_center", "spyder_citypark_house1"], G6_IMPORT_OPTIONS);
  const nodes = objectNodes(build.project);
  const calls = (call: string) => nodes.filter((node) => node.op === "ext" && node.call === call).map((node) => node.args);

  test("leather gym points and board, cathedral fees and scoop price", () => {
    expect(calls("tux.variable_math")).toEqual([
      { left: { variable: "v.brad_points" }, operator: "+", right: { value: 1 }, result: "v.brad_points" },
      { left: { variable: "v.chad_points" }, operator: "+", right: { value: 1 }, result: "v.chad_points" },
      { left: { variable: "v.cathedral_share_full" }, operator: "*", right: { value: 100 }, result: "v.cathedral_share_full" },
      { left: { variable: "v.cathedral_interest_full" }, operator: "*", right: { value: 100 }, result: "v.cathedral_interest_full" },
      { left: { variable: "v.info_level" }, operator: "*", right: { variable: "v.scoop_coeff" }, result: "v.scoop_price" },
    ]);
    expect(calls("tux.format_variable")).toContainEqual({ variable: "v.cathedral_share", format: "float" });
    expect(calls("tux.format_variable")).toContainEqual({ variable: "v.scoop_price", format: "-int" });
    expect(calls("tux.set_variable_text")).toContainEqual({ writes: { "v.cathedral_fee": "100" } });
    expect(calls("tux.set_variable_text")).toContainEqual({ writes: { "v.chad_points": "0" } });
    const texts = nodes.filter((node) => node.op === "text").map((node) => (node.lines as string[]).join(" "));
    expect(texts).toContain("Chad {v:v.chad_points} vs Brad {v:v.brad_points}");
    expect(texts).toContain("I can give you ${v:v.scoop_price}, is it ok?");
    expect(texts.some((text) => text.includes("???"))).toBe(false);
    expect(build.project.system?.textVariables).toBe(true);
  });

  test("set_mission is the upstream no-op", () => {
    const house = build.project.maps.find((map) => map.id === "spyder_citypark_house1")!;
    const transfer = house.events!.find((event) => event.name === "Transfer Missions" && JSON.stringify(event).includes("book_wishes"))!;
    const commands = JSON.stringify(transfer.pages);
    expect(commands).not.toContain("mission");
    expect(commands).toContain("v.maniac_help");
  });

  test("the whole corpus is converted", () => {
    const full = buildProject(availableMapIds(), G6_IMPORT_OPTIONS).report.coverage.actions.rows;
    const row = (type: string) => full.find((r) => r.type === type);
    expect(row("set_mission")).toMatchObject({ total: 6, native: 6, dropped: 0 });
    // The cathedral heal events' money_is(variable) guard is converted, so
    // their variable_math and format_variable uses are all native.
    expect(row("variable_math")).toMatchObject({ total: 5, native: 5, dropped: 0 });
    expect(row("format_variable")).toMatchObject({ total: 10, native: 10, dropped: 0 });
  });
});

describe("leather gym scoreboard in a session", () => {
  const build = buildProject(["spyder_leather_gym"], G6_IMPORT_OPTIONS);
  const gym = build.project.maps[0]!;

  test("a win adds a float point that the board prints as an int", () => {
    // Board is an action event on (6, 2); read it from the tile below.
    const project: Project = { ...build.project, start: { map: gym.id, x: 6, y: 3, dir: "up" } };
    // First visit: the Variables event initializes both scores to "0".
    let session = createSession(project, 60, TUXEMON_SESSION_OPTIONS);
    let state: SessionState = startSession(project, session);
    for (let frame = 0; frame < 30; frame++) state = stepSession(session, state, { buttons: 0 });
    expect(state.sw.variables["v.chad_points"]).toBe("0");
    expect(state.sw.variables["v.brad_points"]).toBe("0");
    // Brad wins a scripted match.
    session = createSession(project, 60, TUXEMON_SESSION_OPTIONS);
    state = startSession(project, session, {
      ...state.sw,
      variables: {
        ...state.sw.variables,
        "v.chadvsbrad": enumValue("chadvsbrad", "done"),
        "v.battle_last_winner": enumValue("battle_last_winner", "spyder_leathergym_brad"),
      },
    });
    for (let frame = 0; frame < 30; frame++) state = stepSession(session, state, { buttons: 0 });
    expect(state.sw.variables["v.chad_points"]).toBe("0");
    expect(state.sw.variables["v.brad_points"]).toBe("1.0");
    let shown = "";
    for (let frame = 0; frame < 30 && !shown; frame++) {
      state = stepSession(session, state, { buttons: frame === 0 ? CONFIRM : 0, confirmEdge: frame === 0 });
      if (state.interp.modal?.kind === "text") shown = state.interp.modal.lines.join(" ");
    }
    expect(shown).toBe("Chad 0 vs Brad 1");
    expect(state.sw.variables["v.brad_points"]).toBe("1");
  });
});

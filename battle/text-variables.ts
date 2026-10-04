// Tuxemon game variables that scripts use as numbers (variable_math,
// format_variable) or print in dialogue (${{var:name}}).
//
// Upstream stores a Python str, int or float per variable. Here such a
// variable holds the text Python's str() gives for its value, so dialogue
// prints it unchanged. The value's type is read back from that text: str()
// of a float always carries ".", an exponent, "inf" or "nan", and str() of
// an int never does. Only string values that merely look like numbers are
// read differently, and upstream raises on those in every numeric use.

import type { ExtensionCommandContext, ExtensionReadContext } from "../vendor/pocket-rpgkit/src/engine/extensions.ts";
import type { JsonValue, VariableValue } from "../vendor/pocket-rpgkit/src/engine/types.ts";

export type PyNumber = { kind: "int"; value: number } | { kind: "float"; value: number };

const DIGITS = String.raw`\d(?:_?\d)*`;
const PY_FLOAT = new RegExp(
  String.raw`^[+-]?(?:(?:${DIGITS})?\.${DIGITS}(?:[eE][+-]?${DIGITS})?|${DIGITS}\.?(?:[eE][+-]?${DIGITS})?|inf(?:inity)?|nan)$`,
  "i",
);
const PY_INT = new RegExp(String.raw`^[+-]?${DIGITS}$`);

/** Python float(text); null where Python raises ValueError. */
export function pyFloatFromText(text: string): number | null {
  const trimmed = text.trim();
  if (!PY_FLOAT.test(trimmed)) return null;
  const lower = trimmed.toLowerCase().replace(/_/g, "");
  const sign = lower.startsWith("-") ? -1 : 1;
  const body = lower.replace(/^[+-]/, "");
  if (body === "inf" || body === "infinity") return sign * Infinity;
  if (body === "nan") return NaN;
  return Number(lower);
}

/** The typed value a stored text stands for (see the file comment). */
export function pyValueFromText(text: string): PyNumber | null {
  const trimmed = text.trim();
  if (PY_INT.test(trimmed)) return { kind: "int", value: Number(trimmed.replace(/_/g, "")) };
  const value = pyFloatFromText(trimmed);
  return value === null ? null : { kind: "float", value };
}

/** Python repr/str of a float. */
export function pyFloatText(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (value === Infinity) return "inf";
  if (value === -Infinity) return "-inf";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const abs = Math.abs(value);
  if (abs >= 1e16 || abs < 1e-4) {
    const [mantissa, exponent] = value.toExponential().split("e") as [string, string];
    const sign = exponent.startsWith("-") ? "-" : "+";
    const digits = exponent.replace(/^[+-]/, "").padStart(2, "0");
    return `${mantissa}e${sign}${digits}`;
  }
  const text = String(value);
  return text.includes(".") ? text : `${text}.0`;
}

/** Python str of an int (the bank keeps only safe integers exactly). */
export function pyIntText(value: number): string {
  return Object.is(value, -0) ? "0" : BigInt(value).toString();
}

/** Python int(x) for a float: truncation; null where Python raises. */
function pyTruncate(value: number): number | null {
  return Number.isFinite(value) ? Math.trunc(value) + 0 : null;
}

/** CPython float floor division (Objects/floatobject.c float_floor_div). */
export function pyFloorDiv(a: number, b: number): number {
  const mod = a % b;
  let div = (a - mod) / b;
  if (mod && (b < 0) !== (mod < 0)) div -= 1;
  if (!div) return 0 * (a / b);
  let floor = Math.floor(div);
  if (div - floor > 0.5) floor += 1;
  return floor;
}

/** One variable_math / format_variable operand or target as stored. */
function storedText(variables: Readonly<Record<string, VariableValue>>, id: string): string | null {
  const value = Object.prototype.hasOwnProperty.call(variables, id) ? variables[id] : undefined;
  return typeof value === "string" ? value : null;
}

export type MathOperand = { variable: string } | { value: number };
export type MathOperator = "+" | "-" | "*" | "/" | "=";

/** Upstream number_or_variable: float(literal) or float(variable). */
function operandValue(variables: Readonly<Record<string, VariableValue>>, operand: MathOperand): number | null {
  if ("value" in operand) return operand.value;
  const text = storedText(variables, operand.variable);
  if (text === null) return null;
  const parsed = pyValueFromText(text);
  return parsed ? parsed.value : null;
}

/** variable_math; null where upstream raises (the game stops the event here
 *  instead, leaving the variables unchanged). */
export function variableMath(
  variables: Readonly<Record<string, VariableValue>>,
  left: MathOperand,
  operator: MathOperator,
  right: MathOperand,
): string | null {
  const a = operandValue(variables, left);
  const b = operandValue(variables, right);
  if (a === null || b === null) return null;
  switch (operator) {
    case "+": return pyFloatText(a + b);
    case "-": return pyFloatText(a - b);
    case "*": return pyFloatText(a * b);
    case "=": return pyFloatText(b);
    case "/": {
      const quotient = pyTruncate(b === 0 ? a : pyFloorDiv(a, b));
      return quotient === null ? null : pyIntText(quotient);
    }
  }
}

export type VariableFormat = "int" | "-int" | "float" | "-float";

/** format_variable; null leaves the variable unchanged (missing variable, or
 *  a value upstream's int()/float() rejects). */
export function formatVariable(text: string, format: VariableFormat): string | null {
  const typed = pyValueFromText(text);
  if (!typed) return null;
  const negate = format.startsWith("-");
  if (format.endsWith("int")) {
    const value = typed.kind === "int" ? typed.value : pyTruncate(typed.value);
    if (value === null) return null;
    return pyIntText(negate ? -value : value);
  }
  return pyFloatText(negate ? -typed.value : typed.value);
}

function record(value: JsonValue, call: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${call}: arguments must be an object`);
  }
  return value as Record<string, unknown>;
}

function variableId(value: unknown, call: string, name: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${call}: ${name} must be a variable id`);
  return value;
}

function mathOperand(value: unknown, call: string): MathOperand {
  const operand = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  if (operand && typeof operand.variable === "string" && operand.variable !== "") return { variable: operand.variable };
  if (operand && typeof operand.value === "number" && !Number.isNaN(operand.value)) return { value: operand.value };
  throw new Error(`${call}: operands must be { variable } or { value }`);
}

/** set_variable for these variables: the literal Python str. */
export function setVariableTextCommand(_context: ExtensionCommandContext, value: JsonValue) {
  const args = record(value, "tux.set_variable_text");
  const writes = args.writes;
  if (writes === null || typeof writes !== "object" || Array.isArray(writes)
    || !Object.values(writes).every((text) => typeof text === "string")) {
    throw new Error("tux.set_variable_text: writes must map variable ids to strings");
  }
  return { writes: writes as Record<string, string> };
}

const OPERATORS = new Set<string>(["+", "-", "*", "/", "="]);

export function variableMathCommand(context: ExtensionCommandContext, value: JsonValue) {
  const call = "tux.variable_math";
  const args = record(value, call);
  if (typeof args.operator !== "string" || !OPERATORS.has(args.operator)) {
    throw new Error(`${call}: unsupported operator`);
  }
  const result = variableMath(
    context.variables,
    mathOperand(args.left, call),
    args.operator as MathOperator,
    mathOperand(args.right, call),
  );
  return result === null ? undefined : { writes: { [variableId(args.result, call, "result")]: result } };
}

const FORMATS = new Set<string>(["int", "-int", "float", "-float"]);

export function formatVariableCommand(context: ExtensionCommandContext, value: JsonValue) {
  const call = "tux.format_variable";
  const args = record(value, call);
  const id = variableId(args.variable, call, "variable");
  if (typeof args.format !== "string" || !FORMATS.has(args.format)) throw new Error(`${call}: unsupported format`);
  const text = storedText(context.variables, id);
  const formatted = text === null ? null : formatVariable(text, args.format as VariableFormat);
  return formatted === null || formatted === text ? undefined : { writes: { [id]: formatted } };
}

/** variable_set for these variables: present (any text), or equal to `value`. */
export function variableTextCondition(context: ExtensionReadContext, value: JsonValue): boolean {
  const call = "tux.variable_text";
  const args = record(value, call);
  const text = storedText(context.variables, variableId(args.variable, call, "variable"));
  if (args.value !== undefined && typeof args.value !== "string") throw new Error(`${call}: value must be a string`);
  const result = text !== null && (args.value === undefined || text === args.value);
  return args.negate === true ? !result : result;
}

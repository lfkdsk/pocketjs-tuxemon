// Exercise every imported lockInput page in isolation and prove that the
// resulting lock is released either by unlockInput or by a map transfer.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { BTN_BITS } from "../vendor/pocket-rpgkit/src/engine/camera.ts";
import { createSwitchState, type SwitchState } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";
import { canStepFrom, type Dir4 } from "../vendor/pocket-rpgkit/src/engine/passability.ts";
import type { BattleRules } from "../vendor/pocket-rpgkit/src/engine/battle.ts";
import type { SceneRules } from "../vendor/pocket-rpgkit/src/engine/scene.ts";
import { createSession, startSession, stepSession } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { Command, Condition, Dir, GameEvent, Page, PageCondition, Project } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { materializeShardedProject } from "./generated-project.ts";

const ROOT = resolve(import.meta.dir, "..");
const DIRS = ["down", "left", "up", "right"] as const satisfies readonly Dir[];
const DX = [0, -1, 0, 1] as const;
const DY = [1, 0, -1, 0] as const;
// The lock checker instruments isolated control-flow paths across the entire
// imported world, including maps outside the shipped Spyder battle-data
// slice. Extension calls are deliberately preview no-ops and battle requests
// complete immediately: only lock acquisition/release is under test here.
const LOCK_BATTLE_RULES: BattleRules = {
  start: () => null,
  step: (state) => state,
  done: () => null,
};
const LOCK_SCENE_RULES: SceneRules = {
  start: () => null,
  step: (state) => state,
  done: () => null,
};
const GAME_OPTIONS = {
  extensions: { allowUnknown: true },
  battle: LOCK_BATTLE_RULES,
  scenes: {
    "rpgkit.nameInput": LOCK_SCENE_RULES,
    "tux.journal": LOCK_SCENE_RULES,
    "tux.monsterPicker": LOCK_SCENE_RULES,
    "tux.pc": LOCK_SCENE_RULES,
    "tux.trade": LOCK_SCENE_RULES,
    "tux.monsterShop": LOCK_SCENE_RULES,
    "tux.daycare": LOCK_SCENE_RULES,
    "tux.radio": LOCK_SCENE_RULES,
    "tux.parkSummary": LOCK_SCENE_RULES,
  },
} as const;

export interface LockCheckRow {
  map: string;
  event: string;
  name: string;
  page: number;
  trigger: Page["trigger"];
  locks: number;
  outcome: "unlocked" | "transferred" | "unresolved" | "error";
  lockedAt: number;
  resolvedAt: number;
  finalMap: string;
  /** Structural analysis is diagnostic only; it never changes outcome. */
  staticHint?: "local-unlock" | "local-transfer" | "reachable";
  resolutionPath?: string[];
  checks: LockCheckAttempt[];
  error?: string;
}

export interface LockCheckAttempt {
  lock: number;
  outcome: LockCheckRow["outcome"];
  lockedAt: number;
  resolvedAt: number;
  finalMap: string;
  seededBy?: string;
  error?: string;
}

export interface LockCheckReport {
  format: "pocket-tuxemon/g6-lock-check/v2";
  pages: number;
  lockCommands: number;
  dynamicChecks: number;
  outcomes: Record<LockCheckRow["outcome"], number>;
  failures: LockCheckRow[];
  exceptions: { map: string; event: string; page: number; explanation: string }[];
  rows: LockCheckRow[];
}

function walk(commands: readonly Command[], visit: (command: Command) => void): void {
  for (const command of commands) {
    visit(command);
    if (command.op === "if") {
      walk(command.then, visit);
      walk(command.else ?? [], visit);
    } else if (command.op === "choices") {
      for (const option of command.options) walk(option.commands, visit);
      walk(command.cancel?.commands ?? [], visit);
    }
  }
}

function countOp(commands: readonly Command[], op: Command["op"]): number {
  let count = 0;
  walk(commands, (command) => { if (command.op === op) count++; });
  return count;
}

function containsLock(commands: readonly Command[]): boolean {
  return countOp(commands, "lockInput") > 0;
}

function lockCommands(commands: readonly Command[]): Command[] {
  const locks: Command[] = [];
  walk(commands, (command) => { if (command.op === "lockInput") locks.push(command); });
  return locks;
}

function containsCommand(commands: readonly Command[], target: Command): boolean {
  let found = false;
  walk(commands, (command) => { if (command === target) found = true; });
  return found;
}

/** Instrument one real lock branch. Ancestor guards/choices are selected so
 * the requested lock is reached, other lock-bearing sibling branches are
 * suppressed, and a one-tick wait makes an instant lock/unlock observable. */
function forceLockBranch(commands: readonly Command[], target: Command): Command[] {
  const out: Command[] = [];
  for (const command of commands) {
    if (command === target) {
      out.push(command, { op: "wait", seconds: 1 / 60 });
    } else if (command.op === "lockInput") {
      // A different lock on this merged page gets its own dynamic run.
    } else if (command.op === "if") {
      if (containsCommand(command.then, target)) {
        out.push(...forceLockBranch(command.then, target));
      } else if (containsCommand(command.else ?? [], target)) {
        out.push(...forceLockBranch(command.else ?? [], target));
      } else if (!containsLock(command.then) && !containsLock(command.else ?? [])) {
        out.push(command);
      }
    } else if (command.op === "choices") {
      const selected = command.options.find((option) => containsCommand(option.commands, target))?.commands ??
        (containsCommand(command.cancel?.commands ?? [], target) ? command.cancel!.commands : undefined);
      if (selected) out.push(...forceLockBranch(selected, target));
      else if (!command.options.some((option) => containsLock(option.commands)) &&
        !containsLock(command.cancel?.commands ?? [])) out.push(command);
    } else {
      out.push(command);
    }
  }
  return out;
}

function pageConditions(condition: PageCondition | undefined): Condition[] {
  if (!condition) return [];
  const out = [...(condition.all ?? [])];
  if (condition.switch !== undefined) out.push({ kind: "switch", id: condition.switch, value: true });
  if (condition.variable !== undefined) out.push({ kind: "variable", ...condition.variable });
  if (condition.selfSwitch !== undefined) out.push({ kind: "selfSwitch", key: condition.selfSwitch, value: true });
  if (condition.item !== undefined) out.push({ kind: "item", id: condition.item, count: 1 });
  return out;
}

function satisfy(
  conditions: readonly Condition[],
  eventKey: string,
): { sw: SwitchState; localVariables: Record<string, number>; facing: Dir } {
  const sw = createSwitchState({ variables: { "sys.party_size": 1 }, gold: 999_999 });
  const localVariables: Record<string, number> = {};
  let facing: Dir = "down";
  for (const condition of conditions) {
    if (condition.kind === "variable") {
      const value = condition.op === "!=" ? (condition.value === 0 ? 1 : 0) : condition.value;
      if (condition.id.startsWith("local.")) localVariables[condition.id] = value;
      else sw.variables[condition.id] = value;
    } else if (condition.kind === "switch") {
      sw.switches[condition.id] = condition.value ?? true;
    } else if (condition.kind === "selfSwitch") {
      sw.self[eventKey] = (condition.value ?? true) ? condition.key : undefined;
    } else if (condition.kind === "item") {
      sw.items[condition.id] = condition.count;
    } else if (condition.kind === "gold") {
      sw.gold = condition.amount;
    } else if (condition.kind === "facing") {
      facing = condition.dir;
    }
  }
  return { sw, localVariables, facing };
}

function startCell(project: Project, mapId: string, event: GameEvent, dir: Dir): { x: number; y: number } {
  const session = createSession(project, 60, GAME_OPTIONS);
  const table = session.tables.get(mapId)!;
  const d = DIRS.indexOf(dir) as Dir4;
  const cells: [number, number][] = [];
  for (let y = event.y; y < event.y + (event.h ?? 1); y++) {
    for (let x = event.x; x < event.x + (event.w ?? 1); x++) cells.push([x, y]);
  }
  for (const [x, y] of cells) {
    const sx = x - DX[d]!;
    const sy = y - DY[d]!;
    if (sx >= 0 && sy >= 0 && sx < table.width && sy < table.height && canStepFrom(table, sx, sy, d)) {
      return { x: sx, y: sy };
    }
  }
  return { x: Math.max(0, event.x - DX[d]!), y: Math.max(0, event.y - DY[d]!) };
}

function checkPage(
  project: Project,
  mapId: string,
  event: GameEvent,
  page: Page,
  target: Command,
  lockIndex: number,
  seed?: ResolutionSeed,
): LockCheckAttempt {
  const eventKey = `${mapId}/${event.id}`;
  const initial = satisfy(pageConditions(page.condition), eventKey);
  if (seed) {
    const extra = satisfy(seed.conditions, seed.eventKey);
    Object.assign(initial.sw.variables, extra.sw.variables);
    Object.assign(initial.sw.switches, extra.sw.switches);
    Object.assign(initial.sw.self, extra.sw.self);
    Object.assign(initial.sw.items, extra.sw.items);
    Object.assign(initial.localVariables, extra.localVariables);
  }
  const start = startCell(project, mapId, event, initial.facing);
  const forced: GameEvent = {
    ...event,
    pages: [{
      ...page,
      trigger: "autorun",
      condition: undefined,
      commands: [...forceLockBranch(page.commands, target), { op: "erase" }],
    }],
  };
  const runProject: Project = {
    ...project,
    start: { map: mapId, x: start.x, y: start.y, dir: initial.facing },
    maps: project.maps.map((map) => map.id === mapId
      ? { ...map, events: (map.events ?? []).map((candidate) => candidate.id === event.id ? forced : candidate) }
      : map),
  };
  const session = createSession(runProject, 60, GAME_OPTIONS);
  let state = startSession(runProject, session, initial.sw);
  Object.assign(state.sw.variables, initial.localVariables);
  let lockedAt = -1;
  let resolvedAt = -1;
  let outcome: LockCheckAttempt["outcome"] = "unresolved";
  for (let frame = 0; frame < 12_000; frame++) {
    const modal = state.interp.modal;
    state = stepSession(session, state, {
      buttons: 0,
      confirmEdge: modal !== null && frame % 2 === 0,
      cancelEdge: false,
      upEdge: false,
      downEdge: false,
    });
    if (state.interp.error) {
      outcome = "error";
      resolvedAt = frame;
      break;
    }
    if (lockedAt < 0 && state.interp.inputLocked) lockedAt = frame;
    if (state.mapId !== mapId) {
      outcome = "transferred";
      resolvedAt = frame;
      break;
    }
    if (lockedAt >= 0 && !state.interp.inputLocked) {
      outcome = "unlocked";
      resolvedAt = frame;
      break;
    }
  }
  return {
    lock: lockIndex,
    outcome,
    lockedAt,
    resolvedAt,
    finalMap: state.mapId,
    ...(seed ? { seededBy: seed.label } : {}),
    ...(lockedAt < 0 && !state.interp.error ? { error: "instrumented lock was not reached" } : {}),
    ...(state.interp.error ? { error: state.interp.error.message } : {}),
  };
}

type Fact =
  | { kind: "variable"; id: string; value: number }
  | { kind: "switch"; id: string; value: boolean };

function factsWritten(commands: readonly Command[]): Fact[] {
  const facts: Fact[] = [];
  walk(commands, (command) => {
    if (command.op === "variable" && command.set.op === "set") {
      facts.push({ kind: "variable", id: command.id, value: command.set.value });
    } else if (command.op === "switch") {
      facts.push({ kind: "switch", id: command.id, value: command.value });
    }
  });
  return facts;
}

function conditionsRead(page: Page): Condition[] {
  const conditions = pageConditions(page.condition);
  walk(page.commands, (command) => { if (command.op === "if") conditions.push(command.if); });
  return conditions;
}

function factSatisfies(fact: Fact, condition: Condition): boolean {
  if (fact.kind === "switch" && condition.kind === "switch") {
    return fact.id === condition.id && fact.value === (condition.value ?? true);
  }
  if (fact.kind !== "variable" || condition.kind !== "variable" || fact.id !== condition.id) return false;
  if (condition.op === "==") return fact.value === condition.value;
  if (condition.op === "!=") return fact.value !== condition.value;
  if (condition.op === ">=") return fact.value >= condition.value;
  return fact.value <= condition.value;
}

interface LockFlowState {
  unresolved: ReadonlySet<number>;
  terminated: boolean;
}

/** Prove each individual lock on at least one executable control-flow path.
 * Branches are kept separate, so an unlock in an `else` arm cannot resolve a
 * lock that only exists in the sibling `then` arm. */
function localResolution(commands: readonly Command[]): "local-unlock" | "local-transfer" | undefined {
  const lockIds = new Map<Command, number>();
  walk(commands, (command) => {
    if (command.op === "lockInput") lockIds.set(command, lockIds.size);
  });
  if (!lockIds.size) return undefined;

  const unlocked = new Set<number>();
  const transferred = new Set<number>();
  const dedupe = (states: readonly LockFlowState[]): LockFlowState[] => {
    const unique = new Map<string, LockFlowState>();
    for (const state of states) {
      const key = `${state.terminated}:${[...state.unresolved].sort((a, b) => a - b).join(",")}`;
      unique.set(key, state);
    }
    return [...unique.values()];
  };
  const run = (sequence: readonly Command[], inputs: readonly LockFlowState[]): LockFlowState[] => {
    let states = [...inputs];
    for (const command of sequence) {
      const outputs: LockFlowState[] = [];
      for (const state of states) {
        if (state.terminated) {
          outputs.push(state);
          continue;
        }
        if (command.op === "lockInput") {
          outputs.push({ unresolved: new Set([...state.unresolved, lockIds.get(command)!]), terminated: false });
        } else if (command.op === "unlockInput" || command.op === "transfer") {
          const sink = command.op === "unlockInput" ? unlocked : transferred;
          for (const id of state.unresolved) sink.add(id);
          outputs.push({ unresolved: new Set(), terminated: command.op === "transfer" });
        } else if (command.op === "if") {
          outputs.push(...run(command.then, [state]));
          outputs.push(...run(command.else ?? [], [state]));
        } else if (command.op === "choices") {
          for (const option of command.options) outputs.push(...run(option.commands, [state]));
          if (command.cancel) outputs.push(...run(command.cancel.commands, [state]));
          if (!command.options.length && !command.cancel) outputs.push(state);
        } else {
          outputs.push(state);
        }
      }
      states = dedupe(outputs);
    }
    return states;
  };
  run(commands, [{ unresolved: new Set(), terminated: false }]);
  const resolved = new Set([...unlocked, ...transferred]);
  if (resolved.size !== lockIds.size) return undefined;
  return transferred.size ? "local-transfer" : "local-unlock";
}

/** Conservative event-dependency proof for locks intentionally handed to a
 * later automatic event. A produced exact variable/switch value enables the
 * next parallel fiber; historical facts are retained because sibling fibers
 * sample their guards together before any of them completes. */
function crossEventPath(map: Project["maps"][number], source: GameEvent, page: Page): string[] | undefined {
  const facts = factsWritten(page.commands).map((fact) => ({ fact, path: [source.id] }));
  const seenFacts = new Set(facts.map(({ fact }) => JSON.stringify(fact)));
  const visited = new Set([source.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const event of map.events ?? []) {
      if (visited.has(event.id)) continue;
      for (const candidate of event.pages) {
        if (candidate.trigger !== "parallel") continue;
        const conditions = conditionsRead(candidate);
        const predecessor = facts.find(({ fact }) =>
          conditions.some((condition) => factSatisfies(fact, condition))
        );
        if (!predecessor) continue;
        visited.add(event.id);
        const path = [...predecessor.path, event.id];
        const resolution = localResolution(candidate.commands);
        if (resolution || countOp(candidate.commands, "unlockInput") || countOp(candidate.commands, "transfer")) return path;
        for (const fact of factsWritten(candidate.commands)) {
          const key = JSON.stringify(fact);
          if (!seenFacts.has(key)) {
            seenFacts.add(key);
            facts.push({ fact, path });
          }
        }
        changed = true;
        break;
      }
    }
  }
  return undefined;
}

function negate(condition: Condition): Condition | undefined {
  if (condition.kind === "switch" || condition.kind === "selfSwitch") {
    return { ...condition, value: !(condition.value ?? true) };
  }
  if (condition.kind === "variable") {
    if (condition.op === "==") return { ...condition, op: "!=" };
    if (condition.op === "!=") return { ...condition, op: "==" };
    if (condition.op === ">=") return { ...condition, op: "<=", value: condition.value - 1 };
    return { ...condition, op: ">=", value: condition.value + 1 };
  }
  if (condition.kind === "facing") {
    return { kind: "facing", dir: DIRS.find((dir) => dir !== condition.dir)! };
  }
  return undefined;
}

/** Conditions on one branch leading to a dynamic resolution command. */
function resolutionConditions(commands: readonly Command[]): Condition[] | undefined {
  for (const command of commands) {
    if (command.op === "unlockInput" || command.op === "transfer") return [];
    if (command.op === "if") {
      const yes = resolutionConditions(command.then);
      if (yes) return [command.if, ...yes];
      const no = resolutionConditions(command.else ?? []);
      const inverse = negate(command.if);
      if (no && inverse) return [inverse, ...no];
    } else if (command.op === "choices") {
      for (const option of command.options) {
        const path = resolutionConditions(option.commands);
        if (path) return path;
      }
      const path = resolutionConditions(command.cancel?.commands ?? []);
      if (path) return path;
    }
  }
  return undefined;
}

interface ResolutionSeed {
  label: string;
  eventKey: string;
  conditions: Condition[];
}

function resolutionSeed(
  map: Project["maps"][number],
  path: readonly string[] | undefined,
): ResolutionSeed | undefined {
  const id = path?.at(-1);
  const event = id ? map.events?.find((candidate) => candidate.id === id) : undefined;
  if (!event) return undefined;
  for (const page of event.pages) {
    const conditions = resolutionConditions(page.commands);
    if (!conditions) continue;
    return {
      label: event.id,
      eventKey: `${map.id}/${event.id}`,
      conditions: [...pageConditions(page.condition), ...conditions],
    };
  }
  return undefined;
}

export function verifyProjectLocks(project: Project): LockCheckReport {
  const rows: LockCheckRow[] = [];
  for (const map of project.maps) {
    for (const event of map.events ?? []) {
      event.pages.forEach((page, pageIndex) => {
        if (!containsLock(page.commands)) return;
        const local = localResolution(page.commands);
        const path = local ? undefined : crossEventPath(map, event, page);
        const seed = resolutionSeed(map, path);
        const locks = lockCommands(page.commands);
        const checks = locks.map((target, lockIndex) => {
          let result = checkPage(project, map.id, event, page, target, lockIndex);
          if (result.outcome !== "unresolved" || !seed) return result;

          // The source page writes the linking fact; the seed supplies any
          // additional guard needed by the downstream automatic release page.
          result = checkPage(
            project,
            map.id,
            event,
            page,
            target,
            lockIndex,
            seed,
          );
          return result;
        });
        const outcome: LockCheckRow["outcome"] = checks.some((check) => check.outcome === "error")
          ? "error"
          : checks.some((check) => check.outcome === "unresolved")
            ? "unresolved"
            : checks.every((check) => check.outcome === "transferred")
              ? "transferred"
              : "unlocked";
        const lockedFrames = checks.map((check) => check.lockedAt).filter((frame) => frame >= 0);
        const resolvedFrames = checks.map((check) => check.resolvedAt).filter((frame) => frame >= 0);
        rows.push({
          map: map.id,
          event: event.id,
          name: event.name ?? "",
          page: pageIndex,
          trigger: page.trigger,
          locks: locks.length,
          outcome,
          lockedAt: lockedFrames.length ? Math.min(...lockedFrames) : -1,
          resolvedAt: resolvedFrames.length ? Math.max(...resolvedFrames) : -1,
          finalMap: checks.at(-1)?.finalMap ?? map.id,
          ...(local ? { staticHint: local } : path ? { staticHint: "reachable" as const, resolutionPath: path } : {}),
          checks,
          ...(outcome === "unresolved" || outcome === "error"
            ? { error: checks.filter((check) => check.outcome === "unresolved" || check.outcome === "error")
              .map((check) => `lock ${check.lock}: ${check.error ?? check.outcome}`).join("; ") }
            : {}),
        });
      });
    }
  }
  const outcomes: LockCheckReport["outcomes"] = {
    unlocked: 0,
    transferred: 0,
    unresolved: 0,
    error: 0,
  };
  for (const row of rows) outcomes[row.outcome]++;
  const failures = rows.filter((row) => row.outcome === "unresolved" || row.outcome === "error");
  return {
    format: "pocket-tuxemon/g6-lock-check/v2",
    pages: rows.length,
    lockCommands: rows.reduce((sum, row) => sum + row.locks, 0),
    dynamicChecks: rows.reduce((sum, row) => sum + row.checks.length, 0),
    outcomes,
    failures,
    exceptions: failures.map((row) => ({
      map: row.map,
      event: row.event,
      page: row.page,
      explanation: row.error ?? "dynamic execution did not release the input lock",
    })),
    rows,
  };
}

if (import.meta.main) {
  const projectArg = process.argv.find((arg) => arg.startsWith("--project="));
  const outArg = process.argv.find((arg) => arg.startsWith("--out="));
  const projectPath = projectArg ? resolve(ROOT, projectArg.slice("--project=".length)) : null;
  const outPath = resolve(ROOT, outArg?.slice("--out=".length) ?? "reports/G6-lock-report.json");
  const project = projectPath
    ? JSON.parse(readFileSync(projectPath, "utf8")) as Project
    : materializeShardedProject(ROOT);
  const report = verifyProjectLocks(project);
  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({
    pages: report.pages,
    lockCommands: report.lockCommands,
    dynamicChecks: report.dynamicChecks,
    outcomes: report.outcomes,
    exceptions: report.exceptions.length,
  }));
  if (report.failures.length) {
    for (const failure of report.failures) console.error(JSON.stringify(failure));
    process.exitCode = 1;
  }
}

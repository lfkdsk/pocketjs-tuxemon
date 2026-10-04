import { describe, expect, test } from "bun:test";

import {
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
  tuxemonExtensionState,
  type TuxemonExtensionState,
} from "../battle/extension.ts";
import { TUXEMON_BATTLE_DB as DB, TUXEMON_EXTENSIONS as extensions, TUXEMON_SESSION_OPTIONS } from "../battle/game.ts";
import {
  addStepTracker,
  advanceStepTracker,
  markMilestoneShown,
  milestonePending,
  removeStepTracker,
  stepTrackersProblem,
  type StepTrackerState,
} from "../battle/step-tracker.ts";
import { availableMapIds, buildProject, G6_IMPORT_OPTIONS } from "../importer/project.ts";
import { BTN_BITS } from "../vendor/pocket-rpgkit/src/engine/camera.ts";
import type { ExtensionReadContext } from "../vendor/pocket-rpgkit/src/engine/extensions.ts";
import { createSession, startSession, stepSession, type Session, type SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { JsonValue, MapDef, Project } from "../vendor/pocket-rpgkit/src/engine/types.ts";

const PARK_MAPS = ["eclipse_park_entrance", "eclipse_park", "eclipse_park_south", "eclipse_park_cave"];
const BUILD = buildProject(PARK_MAPS, G6_IMPORT_OPTIONS);

function objectNodes(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) for (const child of value) objectNodes(child, out);
  else if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    out.push(object);
    for (const child of Object.values(object)) objectNodes(child, out);
  }
  return out;
}

/** Upstream's StepTracker() defaults: countdown 100, milestones 500/250/100/50. */
function tracker(overrides: Partial<StepTrackerState> = {}): StepTrackerState {
  return { countdown: 100, initialCountdown: 100, milestones: [500, 250, 100, 50], status: {}, ...overrides };
}

function ext(update: (state: TuxemonExtensionState) => void = () => {}): JsonValue {
  const state = initialTuxemonExtensionState();
  update(state);
  return packTuxemonExtensionState(state);
}

function context(value: JsonValue): ExtensionReadContext {
  return { ext: value, switches: {}, variables: {}, items: {}, gold: 0, playerName: "A" };
}

describe("step tracker rules (upstream tests/tuxemon/test_step_tracker.py)", () => {
  test("a positive move counts down and fires every crossed milestone once", () => {
    expect(advanceStepTracker(tracker(), 15).countdown).toBe(85);
    const crossed = advanceStepTracker(tracker({ countdown: 260 }), 250);
    expect(crossed.countdown).toBe(10);
    for (const m of [500, 250, 100, 50]) expect(crossed.status[String(m)]).toBe(false);
    expect(advanceStepTracker(tracker({ countdown: 10 }), 15)).toMatchObject({ countdown: 0 });
    expect(advanceStepTracker(tracker({ milestones: [], countdown: 10 }), 10).status).toEqual({});
  });

  test("auto-reset restarts the cycle and clears milestones", () => {
    expect(advanceStepTracker(tracker({ countdown: 10, autoReset: true }), 15))
      .toMatchObject({ countdown: 95, cycleCount: 1 });
    expect(advanceStepTracker(tracker({ countdown: 0, autoReset: true }), 10))
      .toMatchObject({ countdown: 90, cycleCount: 1 });
    expect(advanceStepTracker(tracker({ countdown: 20, autoReset: true }), 20))
      .toMatchObject({ countdown: 100, cycleCount: 1 });
    expect(advanceStepTracker(tracker({ countdown: 10, autoReset: true }), 300).cycleCount).toBeGreaterThanOrEqual(2);
  });

  test("a non-positive move winds the countdown back without milestones", () => {
    expect(advanceStepTracker(tracker(), -15)).toEqual(tracker({ countdown: 115 }));
  });

  test("add keeps an existing tracker; condition is triggered-and-unshown; remove prunes", () => {
    const spec = { countdown: 500, milestones: [100, 0], autoReset: false };
    const added = addStepTracker(undefined, "player", "steps_park", spec)!;
    expect(added.player!.steps_park).toEqual({ countdown: 500, initialCountdown: 500, milestones: [100, 0], status: {} });
    expect(addStepTracker(added, "player", "steps_park", { ...spec, countdown: 9 })).toBeUndefined();
    expect(milestonePending(added, "player", "steps_park", 100)).toBe(false);
    const reached = { player: { steps_park: advanceStepTracker(added.player!.steps_park!, 400) } };
    expect(milestonePending(reached, "player", "steps_park", 100)).toBe(true);
    expect(markMilestoneShown(added, "player", "steps_park", 100)).toBeUndefined();
    const shown = markMilestoneShown(reached, "player", "steps_park", 100)!;
    expect(milestonePending(shown, "player", "steps_park", 100)).toBe(false);
    expect(markMilestoneShown(shown, "player", "steps_park", 100)).toBeUndefined();
    expect(removeStepTracker(shown, "player", "steps_park")).toEqual({});
    expect(removeStepTracker(shown, "player", "other")).toBeUndefined();
    expect(stepTrackersProblem(shown)).toBeNull();
    expect(stepTrackersProblem({ player: {} })).not.toBeNull();
  });
});

describe("real step-tracker import", () => {
  const ops = objectNodes(BUILD.project);

  test("Eclipse Park pays for a 500-step tracker with milestones 100 and 0", () => {
    expect(ops.filter((node) => node.op === "ext" && node.call === "tux.add_step_tracker").map((node) => node.args))
      .toEqual([{ character: "player", tracker: "steps_park", countdown: 500, milestones: [100, 0] }]);
    const conditions = ops.filter((node) => node.kind === "ext" && node.call === "tux.step_tracker").map((node) => node.args);
    expect(conditions).toContainEqual({ character: "player", tracker: "steps_park", milestone: 100, negate: false });
    expect(conditions).toContainEqual({ character: "player", tracker: "steps_park", milestone: 0, negate: false });
    expect(ops.filter((node) => node.op === "ext" && node.call === "tux.set_step_tracker_milestone_shown"))
      .toHaveLength(3);
    expect(ops.filter((node) => node.op === "ext" && node.call === "tux.remove_step_tracker").length).toBeGreaterThanOrEqual(4);
  });

  test("the whole corpus is converted", () => {
    const full = buildProject(availableMapIds(), G6_IMPORT_OPTIONS).report.coverage;
    const row = (kind: "actions" | "conditions", type: string) => full[kind].rows.find((r) => r.type === type);
    expect(row("actions", "add_step_tracker")).toMatchObject({ total: 3, native: 0, degraded: 3, dropped: 0 });
    expect(row("actions", "remove_step_tracker")).toMatchObject({ total: 5, native: 5, dropped: 0 });
    expect(row("actions", "set_step_tracker_milestone_shown")).toMatchObject({ total: 3, native: 3, dropped: 0 });
    expect(row("conditions", "is step_tracker")).toMatchObject({ total: 7, native: 7, dropped: 0 });
  });
});

describe("step trackers in a session", () => {
  const park = BUILD.project.maps.find((map) => map.id === "eclipse_park")!;

  function landOne(session: Session, value: SessionState, buttons: number): SessionState {
    const start = [value.move.tx, value.move.ty] as const;
    let state = stepSession(session, value, { buttons });
    let guard = 0;
    while (state.move.tx === start[0] && state.move.ty === start[1] && guard++ < 60) {
      state = stepSession(session, state, { buttons: 0 });
    }
    expect(Math.abs(state.move.tx - start[0]) + Math.abs(state.move.ty - start[1])).toBe(1);
    return state;
  }

  function parkSession(countdown: number, status: Record<string, boolean>) {
    const project: Project = { ...BUILD.project, start: { map: park.id, ...clearVerticalStep(park), dir: "down" } };
    const session = createSession(project, 60, TUXEMON_SESSION_OPTIONS);
    const value = ext((state) => {
      state.stepTrackers = {
        player: { steps_park: { countdown, initialCountdown: 500, milestones: [100, 0], status } },
      };
    });
    // The park's Tuxeball event sends a player without park balls back out.
    const fresh = startSession(project, createSession(project, 60, TUXEMON_SESSION_OPTIONS)).sw;
    let state = startSession(project, session, { ...fresh, items: { ...fresh.items, tuxeball_park: 25 } }, value);
    for (let frame = 0; frame < 30; frame++) state = stepSession(session, state, { buttons: 0 });
    expect(state.mapId).toBe(park.id);
    return { session, state };
  }

  /** A cell whose southern neighbour is open and outside every authored event. */
  function clearVerticalStep(map: MapDef): { x: number; y: number } {
    const blocked = new Set((map.passage ?? []).filter(([, passage]) => passage === "block").map(([index]) => index));
    const inEvent = (x: number, y: number) => (map.events ?? []).some((event) =>
      x >= event.x && x < event.x + (event.w ?? 1) && y >= event.y && y < event.y + (event.h ?? 1));
    for (let y = 2; y < map.height - 2; y++) for (let x = 2; x < map.width - 2; x++) {
      if (blocked.has(y * map.width + x) || blocked.has((y + 1) * map.width + x)) continue;
      if (inEvent(x, y) || inEvent(x, y + 1)) continue;
      return { x, y };
    }
    throw new Error(`no clear vertical step in ${map.id}`);
  }

  const trackers = (state: SessionState) => tuxemonExtensionState(state.ext, DB).stepTrackers;

  test("each completed tile counts once and the 100-steps alert is shown once", () => {
    let { session, state } = parkSession(101, {});
    expect(state.interp.modal).toBeFalsy();
    state = landOne(session, state, BTN_BITS.DOWN);
    expect(trackers(state)?.player?.steps_park?.countdown).toBe(100);
    let seen = "";
    for (let frame = 0; frame < 30 && !seen; frame++) {
      state = stepSession(session, state, { buttons: 0 });
      const modal = state.interp.modal;
      if (modal?.kind === "text") seen = modal.lines.join(" ");
    }
    expect(seen).toBe("You still have 100 steps left!");
    for (let frame = 0; frame < 60; frame++) {
      state = stepSession(session, state, { buttons: 0, confirmEdge: state.interp.modal?.kind === "text" });
    }
    expect(state.interp.modal).toBeFalsy();
    expect(trackers(state)?.player?.steps_park?.status).toEqual({ "100": true });
  });

  test("running out of steps sends the player back to the entrance and removes the tracker", () => {
    let { session, state } = parkSession(1, { "100": true });
    state = landOne(session, state, BTN_BITS.DOWN);
    for (let frame = 0; frame < 240 && state.mapId === park.id; frame++) {
      state = stepSession(session, state, { buttons: 0, confirmEdge: state.interp.modal?.kind === "text" });
    }
    for (let frame = 0; frame < 120; frame++) state = stepSession(session, state, { buttons: 0 });
    expect(state.mapId).toBe("eclipse_park_entrance");
    // Steps' transition_teleport player,eclipse_park_entrance.tmx,5,4
    expect([state.move.tx, state.move.ty]).toEqual([5, 4]);
    expect(trackers(state)).toBeUndefined();
  });

  test("the step hook is a no-op without trackers or daycare", () => {
    expect(extensions.commands!["tux.player_step"]!({ ...context(ext()), random: () => 0.5 }, {})).toBeUndefined();
  });
});

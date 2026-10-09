// Time/weather and screen-layer coverage fixtures: time_is/update_time use
// live tux.* handlers while set_layer uses the kit's native layer command.
//
// S5 §5.1 census: time_is 128 source uses, update_time 3, set_layer 79.

import { describe, expect, test } from "bun:test";
import {
  availableMapIds,
  buildProject,
  G6_IMPORT_OPTIONS,
} from "../importer/project.ts";
import {
  createTuxemonExtensions,
  tuxemonExtensionState,
} from "../battle/extension.ts";
import {
  DAYLIGHT_STAGE_VARIABLE,
  DAYLIGHT_TARGET_VARIABLE,
} from "../battle/daylight.ts";
import type {
  Command,
  Condition,
  PageCondition,
  Project,
} from "../vendor/pocket-rpgkit/src/engine/types.ts";

type ExtCommand = Extract<Command, { op: "ext" }>;
type ExtCondition = Extract<Condition, { kind: "ext" }>;
type LayerCommand = Extract<Command, { op: "layer" }>;

/** Every ext command in a page's command tree (if/choices/battle nested). */
function collectExtCommands(commands: readonly Command[], out: ExtCommand[]): void {
  for (const command of commands) {
    if (command.op === "ext") out.push(command);
    else if (command.op === "if") {
      collectExtCommands(command.then, out);
      collectExtCommands(command.else ?? [], out);
    } else if (command.op === "choices") {
      for (const option of command.options) collectExtCommands(option.commands, out);
      collectExtCommands(command.cancel?.commands ?? [], out);
    } else if (command.op === "battle") {
      collectExtCommands(command.onWin ?? [], out);
      collectExtCommands(command.onLose ?? [], out);
      collectExtCommands(command.onEscape ?? [], out);
    }
  }
}

function collectLayerCommands(commands: readonly Command[], out: LayerCommand[]): void {
  for (const command of commands) {
    if (command.op === "layer") out.push(command);
    else if (command.op === "if") {
      collectLayerCommands(command.then, out);
      collectLayerCommands(command.else ?? [], out);
    } else if (command.op === "choices") {
      for (const option of command.options) collectLayerCommands(option.commands, out);
      collectLayerCommands(command.cancel?.commands ?? [], out);
    } else if (command.op === "battle") {
      collectLayerCommands(command.onWin ?? [], out);
      collectLayerCommands(command.onLose ?? [], out);
      collectLayerCommands(command.onEscape ?? [], out);
    }
  }
}

function collectExtConditions(condition: PageCondition | undefined, out: ExtCondition[]): void {
  if (!condition?.all) return;
  for (const child of condition.all) {
    if (child.kind === "ext") out.push(child);
  }
}

function projectExtCommands(project: Project, call: string): ExtCommand[] {
  const out: ExtCommand[] = [];
  for (const map of project.maps) {
    for (const event of map.events ?? []) {
      for (const page of event.pages) collectExtCommands(page.commands, out);
    }
  }
  return out.filter((command) => command.call === call);
}

function projectExtConditions(project: Project, call: string): ExtCondition[] {
  const out: ExtCondition[] = [];
  for (const map of project.maps) {
    for (const event of map.events ?? []) {
      for (const page of event.pages) collectExtConditions(page.condition, out);
    }
  }
  return out.filter((condition) => condition.call === call);
}

function projectLayerCommands(project: Project): LayerCommand[] {
  const out: LayerCommand[] = [];
  for (const map of project.maps) {
    for (const event of map.events ?? []) {
      for (const page of event.pages) collectLayerCommands(page.commands, out);
    }
  }
  return out.filter((command) => command.layer === "tux_overlay");
}

describe("D1 time and GI-1a set_layer imported shapes (G6)", () => {
  test("time_is stage_of_day becomes a tux.time_is ext condition", () => {
    const { project } = buildProject(["spyder_paper_town"], G6_IMPORT_OPTIONS);
    const night = projectExtConditions(project, "tux.time_is")
      .filter((c) => (c.args as Record<string, unknown>).value === "night");
    // The Day Cycle pair carries both `is ... night` (Night Day Cycle Outside)
    // and `not ... night` (Day Cycle Outside) on this map.
    const isNight = night.find((c) => (c.args as Record<string, unknown>).negate === false);
    const notNight = night.find((c) => (c.args as Record<string, unknown>).negate === true);
    expect(isNight).toBeDefined();
    expect(notNight).toBeDefined();
    expect(isNight!.args).toMatchObject({
      property: "stage_of_day",
      operation: "equals",
      value: "night",
      negate: false,
    });
  });

  test("time_is date easter egg becomes a tux.time_is ext condition", () => {
    const { project } = buildProject(["maple_bedroom"], G6_IMPORT_OPTIONS);
    const date = projectExtConditions(project, "tux.time_is")
      .find((c) => (c.args as Record<string, unknown>).property === "date");
    expect(date).toBeDefined();
    expect(date!.args).toMatchObject({
      property: "date",
      operation: "equals",
      value: "4-27",
    });
  });

  test("set_layer RGBA colour selects a native screen-layer variant", () => {
    const { project } = buildProject(["spyder_paper_town"], G6_IMPORT_OPTIONS);
    expect(projectLayerCommands(project)).toContainEqual({
      op: "layer",
      layer: "tux_overlay",
      variant: "color_0_0_128_128",
      visible: true,
    });
  });

  test("set_layer with no argument clears the native screen layer", () => {
    const { project } = buildProject(["eclipse_crystal_center"], G6_IMPORT_OPTIONS);
    const layers = projectLayerCommands(project);
    expect(layers).toContainEqual({
      op: "layer",
      layer: "tux_overlay",
      visible: null,
      variant: null,
    });
    // The same cutscene also darkens with an opaque black overlay.
    expect(layers).toContainEqual({
      op: "layer",
      layer: "tux_overlay",
      variant: "color_0_0_0_255",
      visible: true,
    });
  });

  test("set_layer PNG selects the prepackaged native image variant", () => {
    const { project } = buildProject(["spyder_candy_hospital1"], G6_IMPORT_OPTIONS);
    expect(projectLayerCommands(project)).toContainEqual({
      op: "layer",
      layer: "tux_overlay",
      variant: "image_gfx_ui_overlay_torchlight_png",
      visible: true,
    });
  });
});

describe("time/weather coverage dispositions (all maps, G6)", () => {
  const { report } = buildProject(availableMapIds(), G6_IMPORT_OPTIONS);
  const rows = [
    ...report.coverage.actions.rows,
    ...report.coverage.conditions.rows,
  ];
  const row = (type: string) => rows.find((candidate) => candidate.type === type);

  test("time_is (128 source uses) is native wherever its event materializes", () => {
    // S5 §5.1: 128 source uses = 67 `is` + 61 `not`. The COV-B check_world
    // layer-variant mirror materializes the two day-cycle events that the old
    // const-false check_world guard used to drop, so all 128 are native.
    const isTime = row("is time_is")!;
    const notTime = row("not time_is")!;
    expect(isTime.total + notTime.total).toBe(128);
    expect(isTime.native + notTime.native).toBe(128);
    expect(isTime.placeholder + notTime.placeholder).toBe(0);
    expect(isTime.dropped + notTime.dropped).toBe(0);
    for (const candidate of [isTime, notTime]) {
      expect(candidate.reasons.native?.[0]).toContain("saved deterministic calendar");
    }
  });

  test("set_layer (79 source uses) is native when its source asset is available", () => {
    // The two day-cycle set_layer calls dropped by the old check_world
    // const-false guard now materialize (COV-B layer-variant mirror).
    const setLayer = row("set_layer")!;
    expect(setLayer.total).toBe(79);
    expect(setLayer.native).toBe(79);
    expect(setLayer.placeholder).toBe(0);
    expect(setLayer.dropped).toBe(0);
    expect(setLayer.reasons.native?.[0]).toContain("KV1");
  });

  test("update_time lowers both transfer hooks and leaves only the absent battle menu dropped", () => {
    // Spyder and Xero share an `is current_state TeleporterState` event. The
    // kit runs no map fiber during transfer, so each is emitted at the
    // equivalent destination-map entry point. battle_menu has no .tmx and is
    // outside the imported title-screen Battle mode.
    const updateTime = row("update_time")!;
    expect(updateTime.total).toBe(3);
    expect(updateTime.native).toBe(2);
    expect(updateTime.placeholder).toBe(0);
    expect(updateTime.dropped).toBe(1);
    expect(updateTime.reasons.native).toContain(
      "TeleporterState update lowered to the destination map's once-per-entry page; tux.update_time reads the saved deterministic calendar",
    );
    const reasons = updateTime.reasons.dropped ?? [];
    expect(reasons).toContain("source event is not materialized by any map");
  });

  test("the weather table is exported with 10 entries", () => {
    expect(report.weather.entries).toHaveLength(10);
    expect(report.weather.source).toBe("mods/tuxemon/db/weather/weathers.yaml");
    expect(report.weather.entries.map((entry) => entry.slug)).toEqual([
      "cloudy", "foggy", "freezing", "hot", "misty",
      "rain", "snow", "sunny", "thunderstorm", "windy",
    ]);
  });
});

describe("time/weather runtime handlers", () => {
  const extensions = createTuxemonExtensions({} as never);
  const timeIs = extensions.conditions!["tux.time_is"]!;
  const updateTime = extensions.commands!["tux.update_time"]!;
  const tick = extensions.commands!["tux.tick_time_weather"]!;
  const ctx = {
    ext: extensions.initial!,
    switches: {},
    variables: {},
    items: {},
    gold: 0,
    playerName: "Player",
    random: () => { throw new Error("time/weather must not consume battle RNG"); },
  };

  test("tux.time_is reads all three comparison paths from the fixed clock", () => {
    expect(timeIs(ctx, { property: "stage_of_day", operation: "equals", value: "morning", negate: false })).toBe(true);
    expect(timeIs(ctx, { property: "stage_of_day", operation: "equals", value: "night", negate: false })).toBe(false);
    expect(timeIs(ctx, { property: "stage_of_day", operation: "equals", value: "night", negate: true })).toBe(true);
    expect(timeIs(ctx, { property: "stage_of_day", operation: "not_equals", value: "morning", negate: false })).toBe(false);
    expect(timeIs(ctx, { property: "daytime", operation: "equals", value: "true", negate: false })).toBe(true);
    expect(timeIs(ctx, { property: "hour", operation: ">=", value: "9", negate: false })).toBe(true);
    expect(timeIs(ctx, { property: "date", operation: "equals", value: "6-15", negate: false })).toBe(true);
    expect(timeIs(ctx, { property: "season", operation: "equals", value: "spring", negate: false })).toBe(true);
  });

  test("tux.update_time publishes the eight upstream variables", () => {
    expect(updateTime(ctx, { character: "player" })).toEqual({ writes: {
      "v.hour": "9",
      "v.day_of_year": "167",
      "v.year": "2024",
      "v.weekday": "saturday",
      "v.leap_year": "true",
      "v.daytime": "true",
      "v.stage_of_day": "morning",
      "v.season": "spring",
    } });
  });

  test("tux.tick_time_weather advances only the extension stream", () => {
    const result = tick(ctx, {});
    expect(result?.writes).toBeUndefined();
    const beforeWire = ctx.ext as string;
    const afterWire = result!.ext! as string;
    expect(afterWire.startsWith("pocket-tuxemon/ext-runtime/v2:")).toBeTrue();
    expect(afterWire.split("\n")[0]).toBe(beforeWire.split("\n")[0]);
    const state = tuxemonExtensionState(result!.ext!, undefined);
    expect(state.clock).toMatchObject({ refTick: 1, subMinuteTicks: 1 });
    expect(state.weather).toEqual(tuxemonExtensionState(ctx.ext).weather);
  });

  test("tux.tick_time_weather publishes the daylight target only when it changes", () => {
    const first = tick(ctx, { daylight: true });
    expect(first?.writes).toEqual({ [DAYLIGHT_TARGET_VARIABLE]: 2 });
    const stable = tick({
      ...ctx,
      ext: first!.ext!,
      variables: { [DAYLIGHT_STAGE_VARIABLE]: 2, [DAYLIGHT_TARGET_VARIABLE]: 0 },
    }, { daylight: true });
    expect(stable?.writes).toBeUndefined();
  });

  test("runtime v2 validates its trust boundary and rejects a stale deadline", () => {
    const isolated = createTuxemonExtensions({} as never);
    const isolatedTick = isolated.commands!["tux.tick_time_weather"]!;
    const initial = isolated.initial! as string;
    expect(isolated.validate!(initial)).toBeUndefined();
    const advanced = isolatedTick({ ...ctx, ext: initial }, {})!.ext! as string;
    expect(isolated.validate!(advanced)).toBeUndefined();

    const forged = advanced.split("\n");
    forged[1] = String(Number.MAX_SAFE_INTEGER);
    forged[7] = "0";
    forged[8] = "1";
    expect(isolated.validate!(forged.join("\n"))).toContain("must be > clock.refTick");
  });

  test("reads legacy runtime v1 and emits v2 on the next tick", () => {
    const isolated = createTuxemonExtensions({} as never);
    const state = tuxemonExtensionState(isolated.initial!);
    const legacy = `pocket-tuxemon/ext-runtime/v1:${JSON.stringify(state)}`;
    expect(tuxemonExtensionState(legacy)).toEqual(state);
    const advanced = isolated.commands!["tux.tick_time_weather"]!({ ...ctx, ext: legacy }, {})!;
    expect(String(advanced.ext).startsWith("pocket-tuxemon/ext-runtime/v2:")).toBeTrue();
    expect(tuxemonExtensionState(advanced.ext!).clock.refTick).toBe(1);
  });
});

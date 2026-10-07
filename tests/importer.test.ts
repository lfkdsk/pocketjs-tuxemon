import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  availableMapIds,
  buildProject,
  DEFAULT_IMPORT_OPTIONS,
  G6_IMPORT_OPTIONS,
  KIT_V2_IMPORT_OPTIONS,
  K1_IMPORT_OPTIONS,
  dialogLayout,
  lowerCurrentStateCondition,
} from "../importer/project.ts";
import { jsonBytes } from "../importer/index.ts";
import { loadAllFileEvents, TUXEMON_SRC } from "../importer/source.ts";
import { applyTerrain, importTerrain } from "../importer/terrain.ts";
import { TUXEMON_BATTLE_RULES, TUXEMON_EXTENSIONS, TUXEMON_SCENES } from "../battle/game.ts";
import { tuxemonExtensionState } from "../battle/extension.ts";
import { BTN_BITS } from "../vendor/pocket-rpgkit/src/engine/camera.ts";
import { canStepFrom, type Dir4 } from "../vendor/pocket-rpgkit/src/engine/passability.ts";
import { createSwitchState, evalCondition } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";
import {
  createSession,
  startSession,
  stepSession,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { Command, Condition, JsonValue } from "../vendor/pocket-rpgkit/src/engine/types.ts";

const ROOT = resolve(import.meta.dir, "..");
const BTN_CONFIRM = 0x2000;

test("dialog layout maps Tuxemon enums and preserves absent/default bytes", () => {
  expect(dialogLayout(["key"])).toEqual({});
  expect(dialogLayout(["key", "", "bottom", "left", "top"])).toEqual({});
  expect(dialogLayout(["key", "", "topleft", "center", "bottom"])).toEqual({
    position: "topLeft",
    align: "center",
    valign: "bottom",
  });
  expect(dialogLayout(["key", "", "bottomright", "right", "center"])).toEqual({
    position: "bottomRight",
    align: "right",
    valign: "center",
  });
  expect(dialogLayout(["key", "", "not-a-position", "sideways", "middle"])).toEqual({});
});

type TransferCommand = Extract<Command, { op: "transfer" }>;
type LiteralTransferCommand = TransferCommand & { map: string; x: number; y: number };

function assertLiteralTransfer(command: TransferCommand): asserts command is LiteralTransferCommand {
  if (
    typeof command.map !== "string" ||
    typeof command.x !== "number" ||
    typeof command.y !== "number"
  ) {
    throw new Error("importer produced a variable-addressed transfer");
  }
}

function numericVariable(state: SessionState, id: string): number {
  const value = state.sw.variables[id];
  if (value === undefined) return 0;
  if (typeof value !== "number") throw new Error(`expected numeric variable ${id}, got ${typeof value}`);
  return value;
}

function objectNodes(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const child of value) objectNodes(child, out);
  } else if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    out.push(object);
    for (const child of Object.values(object)) objectNodes(child, out);
  }
  return out;
}

test("imported opening names and corner flashbacks retain authored dialog layout", () => {
  const result = buildProject(["spyder_bedroom", "spyder_nimrod_room"], KIT_V2_IMPORT_OPTIONS);
  const bedroom = result.project.maps.find((map) => map.id === "spyder_bedroom")!;
  const opening = bedroom.events?.find((event) => event.name === "Spyder Intro")!;
  const openingNames = objectNodes(opening.pages.flatMap((page) => page.commands))
    .filter((node) => node.op === "text" && node.align === "center" && ["Dollfin", "Ignibus", "Memnomnom", "Budaye", "Grintot"]
      .includes((node.lines as string[] | undefined)?.[0] ?? ""));
  expect(openingNames).toHaveLength(5);
  expect(openingNames.map(({ position, align, valign }) => ({ position, align, valign }))).toEqual(
    Array.from({ length: 5 }, () => ({ position: undefined, align: "center", valign: "center" })),
  );

  const nimrod = result.project.maps.find((map) => map.id === "spyder_nimrod_room")!;
  const flashback = nimrod.events?.find((event) => event.name === "Enforcers Rapid Response")!;
  const texts = objectNodes(flashback.pages.flatMap((page) => page.commands))
    .filter((node) => node.op === "text");
  expect(texts.map((node) => node.position)).toEqual([
    "top", "top", "topLeft", "top", "top", undefined, undefined,
    "top", "top", "bottomLeft", "top",
  ]);
});

test("all maps pass schema and reference valid transfer destinations", () => {
  const result = buildProject(availableMapIds());
  expect(result.project.system).toEqual({ messageBlocksPlayer: true, inventory: { maxKinds: 99 } });
  expect(result.project.maps).toHaveLength(263);
  expect(result.report.schemaErrors).toEqual([]);
  expect(result.report.transferErrors).toEqual([]);
  expect(result.report.coverage).toMatchObject({
    view: "source-file",
    accounting: "conversion-path",
    sourceEvents: 4_578,
  });
  expect(result.report.coverage.actions.summary).toMatchObject({
    // Merged counts: G-COV-C step/numeric work, translated_dialog layout
    // args lowered natively to the kit's text-window layout, and the starter
    // portrait backdrops (change_bg_monster) now native.
    types: 98,
    uses: 13_617,
    native: 6_864,
    degraded: 2_819,
    placeholder: 708,
    dropped: 3_226,
    nativePercent: 50.4,
    tier1: {
      uses: 6_318,
      percent: 46.4,
      requiredUses: 6_246,
      meetsBaseline: true,
    },
  });
  expect(result.report.coverage.conditions.summary).toMatchObject({
    types: 64,
    uses: 8_663,
    native: 4_371,
    degraded: 1_245,
    placeholder: 859,
    dropped: 2_188,
    nativePercent: 50.5,
    tier1: {
      uses: 4_308,
      percent: 49.73,
      requiredUses: 4_591,
      meetsBaseline: false,
    },
  });
  // Mutation guard: these conversion-derived counts fail if the recorder's
  // disposition mapping is changed to return `dropped` for every branch.
  const coverageRows = [
    ...result.report.coverage.actions.rows,
    ...result.report.coverage.conditions.rows,
  ];
  expect(coverageRows.find((row) => row.type === "char_face")).toMatchObject({
    native: 868,
    degraded: 442,
    dropped: 717,
  });
  expect(coverageRows.find((row) => row.type === "char_move")).toMatchObject({
    degraded: 13,
    dropped: 64,
  });
  expect(coverageRows.find((row) => row.type === "is char_facing")).toMatchObject({
    native: 0,
    degraded: 4,
    dropped: 1_004,
  });
  expect(coverageRows.find((row) => row.type === "set_monster_health")).toMatchObject({
    placeholder: 0,
    dropped: 83,
  });
  // Dialogs with upstream position/alignment args lower natively to the
  // kit's text-window layout, in the same row as the other dialogs.
  expect(coverageRows.find((row) => row.type === "translated_dialog")).toMatchObject({
    native: 2019,
    degraded: 0,
    dropped: 49,
  });
  expect(coverageRows.find((row) => row.type === "translated_dialog(layout)")).toBeUndefined();
  expect(coverageRows.find((row) => row.type === "set_monster_status")).toMatchObject({
    placeholder: 0,
    dropped: 83,
  });
  expect(coverageRows.find((row) => row.type === "autosave")).toMatchObject({
    total: 6,
    native: 6,
    degraded: 0,
    placeholder: 0,
    dropped: 0,
  });
  const autosaveMaps = result.project.maps
    .filter((map) => objectNodes(map.events).some((node) => node.op === "autosave"))
    .map((map) => map.id)
    .sort();
  expect(autosaveMaps).toEqual([
    "spyder_omnichannel1",
    "spyder_paper_town",
    "spyder_route2",
    "spyder_route3",
    "spyder_route6",
    "spyder_routec",
  ]);
  for (const [type, total] of [
    ["screen_transition", 25],
    ["camera_position", 6],
    ["set_bubble", 16],
    ["change_bg", 15],
  ] as const) {
    expect(coverageRows.find((row) => row.type === type)).toMatchObject({
      total,
      native: total,
      degraded: 0,
      placeholder: 0,
      dropped: 0,
    });
  }
  expect(new Set(result.report.rows.map((row) => row.key)).size).toBe(result.report.rows.length);
  expect(result.report.rows.some((row) => row.key === "trigger:touch:facing:T1-lowered")).toBeTrue();
  expect(Object.keys(result.variables)).toHaveLength(499);
  expect(Object.values(result.variables).filter((values) => values.length === 0)).toHaveLength(6);
  expect(
    result.report.coverage.actions.summary.native +
    result.report.coverage.actions.summary.degraded +
    result.report.coverage.actions.summary.placeholder +
    result.report.coverage.actions.summary.dropped,
  ).toBe(13_617);
  expect(
    result.report.coverage.conditions.summary.native +
    result.report.coverage.conditions.summary.degraded +
    result.report.coverage.conditions.summary.placeholder +
    result.report.coverage.conditions.summary.dropped,
  ).toBe(8_663);

  const maps = new Map(result.project.maps.map((map) => [map.id, map]));
  let transfers = 0;
  const visit = (commands: readonly Command[]): void => {
    for (const command of commands) {
      if (command.op === "transfer") {
        assertLiteralTransfer(command);
        transfers++;
        const target = maps.get(command.map);
        expect(target, `missing transfer target ${command.map}`).toBeDefined();
        expect(command.x).toBeGreaterThanOrEqual(0);
        expect(command.y).toBeGreaterThanOrEqual(0);
        expect(command.x).toBeLessThan(target!.width);
        expect(command.y).toBeLessThan(target!.height);
      } else if (command.op === "if") {
        visit(command.then);
        visit(command.else ?? []);
      } else if (command.op === "choices") {
        for (const option of command.options) visit(option.commands);
        visit(command.cancel?.commands ?? []);
      }
    }
  };
  for (const map of result.project.maps) {
    for (const event of map.events ?? []) {
      expect(event.x).toBeGreaterThanOrEqual(0);
      expect(event.y).toBeGreaterThanOrEqual(0);
      expect(event.x).toBeLessThan(map.width);
      expect(event.y).toBeLessThan(map.height);
      for (const page of event.pages) visit(page.commands);
    }
  }
  expect(transfers).toBeGreaterThan(1_000);
}, 30_000);

test("the complete import is byte-stable", () => {
  const ids = availableMapIds();
  const first = buildProject(ids);
  const second = buildProject(ids);
  expect(jsonBytes(first)).toBe(jsonBytes(second));
}, 30_000);

test("KA1 imports source map and tile animations with deterministic definitions", () => {
  const result = buildProject(["spyder_dryadsgrove", "spyder_route3"], G6_IMPORT_OPTIONS);
  expect(result.report.schemaErrors).toEqual([]);
  expect(result.project.animations).toEqual([
    {
      id: "tux_dragonbirth_100000us",
      sheet: "animations/tileset/dragonbirth.png",
      frameW: 48,
      frameH: 64,
      cols: 60,
      count: 60,
      frameDuration: 0.1,
    },
    {
      id: "tux_grass_100000us",
      sheet: "animations/tileset/grass.png",
      frameW: 16,
      frameH: 16,
      cols: 2,
      count: 2,
      frameDuration: 0.1,
    },
  ]);

  const commands = objectNodes(result.project).filter((node) => node.op === "mapAnim");
  expect(commands).toContainEqual({
    op: "mapAnim",
    id: "tux_map_grass",
    anim: "tux_grass_100000us",
    target: "player",
    follow: false,
    layer: "above",
    loop: false,
  });
  expect(commands).toContainEqual({
    op: "mapAnim",
    id: "tux_map_dragonbirth",
    anim: "tux_dragonbirth_100000us",
    x: 10,
    y: 4,
    layer: "above",
    loop: false,
  });
  expect(result.report.coverage.actions.rows.find((row) => row.type === "play_tile_animation"))
    .toMatchObject({ total: 1, native: 1, dropped: 0 });
});

test("KS1 imports fades, scripted camera, balloons, and blocking backdrops", () => {
  const result = buildProject(["spyder_bedroom", "spyder_greenwash_level3"], G6_IMPORT_OPTIONS);
  expect(result.report.schemaErrors).toEqual([]);
  expect(result.project.animations).toContainEqual({
    id: "tux_bubble_exclamation",
    sheet: "gfx/bubbles/exclamation.png",
    frameW: 16,
    frameH: 16,
    cols: 1,
    count: 1,
    frameDuration: 1,
    loop: true,
  });
  expect(result.presentation.backdrops).toEqual([
    {
      variant: "bg_gradient_blue_budaye_monster",
      background: "gfx/ui/background/gradient_blue.png",
      foreground: "gfx/sprites/battle/budaye-sheet.png",
      foregroundCrop: { x: 0, y: 0, w: 64, h: 64 },
      lazy: true,
    },
    {
      variant: "bg_gradient_blue_dollfin_monster",
      background: "gfx/ui/background/gradient_blue.png",
      foreground: "gfx/sprites/battle/dollfin-sheet.png",
      foregroundCrop: { x: 0, y: 0, w: 64, h: 64 },
      lazy: true,
    },
    {
      variant: "bg_gradient_blue_grintot_monster",
      background: "gfx/ui/background/gradient_blue.png",
      foreground: "gfx/sprites/battle/grintot-sheet.png",
      foregroundCrop: { x: 0, y: 0, w: 64, h: 64 },
      lazy: true,
    },
    {
      variant: "bg_gradient_blue_ignibus_monster",
      background: "gfx/ui/background/gradient_blue.png",
      foreground: "gfx/sprites/battle/ignibus-sheet.png",
      foregroundCrop: { x: 0, y: 0, w: 64, h: 64 },
      lazy: true,
    },
    {
      variant: "bg_gradient_blue_memnomnom_monster",
      background: "gfx/ui/background/gradient_blue.png",
      foreground: "gfx/sprites/battle/memnomnom-sheet.png",
      foregroundCrop: { x: 0, y: 0, w: 64, h: 64 },
      lazy: true,
    },
    {
      variant: "bg_gradient_blue_spyder_monsters_image",
      background: "gfx/ui/background/gradient_blue.png",
      foreground: "gfx/ui/background/spyder_monsters.png",
    },
    {
      variant: "bg_gradient_blue_spyder_morph_image",
      background: "gfx/ui/background/gradient_blue.png",
      foreground: "gfx/ui/background/spyder_morph.png",
    },
    {
      variant: "bg_gradient_blue_spyder_omnichannel_beaverbrook_character",
      background: "gfx/ui/background/gradient_blue.png",
      foreground: "gfx/sprites/player/ceo.png",
      foregroundCrop: { x: 64, y: 0, w: 64, h: 64 },
    },
    {
      variant: "bg_gradient_blue_spyder_tumble_image",
      background: "gfx/ui/background/gradient_blue.png",
      foreground: "gfx/ui/background/spyder_tumble.png",
    },
  ]);

  const commands = objectNodes(result.project);
  expect(commands).toContainEqual({
    op: "screenFade",
    direction: "out",
    duration: 1,
    color: { r: 0, g: 0, b: 0, a: 255 },
    wait: true,
  });
  expect(commands).toContainEqual({
    op: "screenFade",
    direction: "in",
    duration: 1,
    color: { r: 0, g: 0, b: 0, a: 255 },
    wait: true,
  });
  expect(commands).toContainEqual({
    op: "camera",
    target: { x: 3, y: 4 },
    duration: 0,
  });
  expect(commands).toContainEqual({ op: "camera", target: "player", duration: 0 });
  expect(commands).toContainEqual({
    op: "balloon",
    target: { event: "npc_spyder_greenwash_heidenstam" },
    icon: "tux_bubble_exclamation",
  });
  expect(commands).toContainEqual({
    op: "balloon",
    target: { event: "npc_spyder_greenwash_heidenstam" },
  });
  expect(commands).toContainEqual({
    op: "screenBackdrop",
    layer: "tux_backdrop",
    variant: "bg_gradient_blue_spyder_tumble_image",
  });
});

test("KV1 imports overlays, runtime appearances, and exact surface passage updates", () => {
  const result = buildProject([
    "player_house_bedroom",
    "spyder_citypark",
    "spyder_greenwash_level3",
    "spyder_scoop3",
    "start_tuxemon",
  ], G6_IMPORT_OPTIONS);
  expect(result.report.schemaErrors).toEqual([]);
  expect(result.presentation.overlays).toEqual([
    { variant: "color_0_0_0_255", color: "#000000ff" },
    { variant: "color_0_0_128_128", color: "#00008080" },
    { variant: "color_102_51_0_128", color: "#66330080" },
  ]);
  expect(result.presentation.backdrops).toContainEqual({
    variant: "bg_gradient_blue_aeble_character",
    background: "gfx/ui/background/gradient_blue.png",
    foreground: "gfx/sprites/player/adventurer.png",
    foregroundCrop: { x: 64, y: 0, w: 64, h: 64 },
  });

  expect(result.project.sprites?.invisible).toEqual({
    kind: "image",
    src: "sprites/invisible.png",
  });
  expect(result.project.sprites?.swimmer).toEqual({
    kind: "image",
    src: "sprites/swimmer.png",
  });
  const nodes = objectNodes(result.project);
  expect(nodes).toContainEqual({
    op: "layer",
    layer: "tux_overlay",
    variant: "color_102_51_0_128",
    visible: true,
  });
  expect(nodes).toContainEqual({
    op: "layer",
    layer: "tux_overlay",
    visible: null,
    variant: null,
  });
  expect(nodes).toContainEqual({ op: "appearance", target: "player", sprite: "invisible" });
  expect(nodes).toContainEqual({ op: "appearance", target: "player", sprite: null });
  expect(nodes).toContainEqual({
    op: "appearance",
    target: "player",
    sprite: "adventurer",
    saveDefault: true,
  });
  expect(nodes).toContainEqual({
    kind: "appearance",
    target: "player",
    sprite: "swimmer",
  });

  const surfaceWriters = result.project.maps.flatMap((map) => map.events ?? [])
    .filter((event) => event.name === "Allow Swim" || event.name === "Forbid Swim");
  const tileCommands = objectNodes(surfaceWriters).filter((node) => node.op === "tileProperty");
  expect(tileCommands).toHaveLength(46);
  expect(tileCommands.filter((node) => node.passage === "pass")).toHaveLength(23);
  expect(tileCommands.filter((node) => node.passage === null)).toHaveLength(23);
  expect(tileCommands).toContainEqual({ op: "tileProperty", x: 2, y: 8, passage: "pass" });
  expect(tileCommands).toContainEqual({ op: "tileProperty", x: 8, y: 10, passage: null });

  // The source corpus starts the complete label at zero and has only two
  // whole-label writers. A representative cell therefore preserves both
  // all(cells) and NOT(all(cells)) for every reachable state.
  const tilesetDir = join(TUXEMON_SRC, "mods/tuxemon/gfx/tilesets");
  const authoredSurfableValues = new Set(readdirSync(tilesetDir)
    .filter((name) => name.endsWith(".tsx"))
    .flatMap((name) => [...readFileSync(join(tilesetDir, name), "utf8")
      .matchAll(/<property name="surfable" value="([^"]+)"/g)]
      .map((match) => match[1]!)));
  expect([...authoredSurfableValues]).toEqual(["0"]);
  expect(loadAllFileEvents()
    .flatMap((event) => event.acts)
    .filter((action) => action.type === "update_tile_properties")
    .map((action) => action.raw)
    .sort()).toEqual([
      "update_tile_properties surfable,0",
      "update_tile_properties surfable,1",
    ]);

  const allowSwim = result.project.maps.find((map) => map.id === "spyder_citypark")!.events!
    .find((event) => event.name === "Allow Swim")!;
  const commands = allowSwim.pages[0]!.commands;
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({
    op: "if",
    if: { kind: "tileProperty", x: 2, y: 8, passage: "pass" },
    then: [],
  });
  const allowCommand = commands[0]!;
  if (allowCommand.op !== "if") throw new Error("Allow Swim must use a guarded tile update");
  expect(objectNodes(allowCommand.else).filter((command) => command.op === "tileProperty"))
    .toHaveLength(23);

  expect(result.report.coverage.actions.rows.find((row) => row.type === "update_tile_properties"))
    .toMatchObject({ total: 2, native: 2, dropped: 0 });
  expect(result.report.coverage.conditions.rows.find((row) => row.type === "not tile_property_updated"))
    .toMatchObject({ total: 2, degraded: 2, dropped: 0 });
});

test("inert source events cannot freeze the Cotton Cafe", () => {
  const result = buildProject(["spyder_cotton_cafe"]);
  const cafe = result.project.maps[0]!;
  expect(cafe.events?.some((event) => event.name === "Rand facing")).toBeFalse();

  result.project.start = {
    map: "spyder_cotton_cafe",
    x: 8,
    y: 10,
    dir: "down",
  };
  const session = createSession(result.project, 60, { extensions: TUXEMON_EXTENSIONS, scenes: TUXEMON_SCENES });
  let state = startSession(result.project, session);
  for (let frame = 0; frame < 20; frame++) {
    state = stepSession(session, state, { buttons: 0 });
  }
  const start = [state.move.tx, state.move.ty];
  for (let frame = 0; frame < 300; frame++) {
    state = stepSession(session, state, { buttons: BTN_BITS.LEFT });
  }
  expect([state.move.tx, state.move.ty]).not.toEqual(start);
  expect(state.interp.error).toBeUndefined();

  const wait = result.report.coverage.actions.rows.find((row) => row.type === "wait")!;
  expect(wait.reasons.dropped).toContain(
    "Tuxemon never starts an event without source conditions or behavior",
  );

  const zeroSize = buildProject(["tt_paper_town"]);
  const paperTown = zeroSize.project.maps[0]!;
  expect(paperTown.events?.some((event) => event.name === "Teleport to Sea Route")).toBeFalse();
  const transfers = zeroSize.report.coverage.actions.rows.find(
    (row) => row.type === "transition_teleport",
  )!;
  expect(transfers.reasons.dropped).toContain(
    "Tuxemon's integer tile boundary never contains a point for a zero-size TMX event",
  );
});

test("clamped transfers use the nearest deterministic walkable landing", () => {
  const result = buildProject(availableMapIds());
  const repair = result.report.transferRepairs.find(
    (entry) => entry.sourceMap === "leather_town" && entry.targetMap === "flower_city",
  );
  expect(repair).toEqual({
    sourceMap: "leather_town",
    targetMap: "flower_city",
    requested: { x: 59, y: 0 },
    clamped: { x: 39, y: 0 },
    emitted: { x: 38, y: 3 },
  });

  const landings: { x: number; y: number }[] = [];
  const collect = (commands: readonly Command[]): void => {
    for (const command of commands) {
      if (command.op === "transfer" && command.map === "flower_city") {
        assertLiteralTransfer(command);
        landings.push({ x: command.x, y: command.y });
      } else if (command.op === "if") {
        collect(command.then);
        collect(command.else ?? []);
      } else if (command.op === "choices") {
        for (const option of command.options) collect(option.commands);
      }
    }
  };
  const leather = result.project.maps.find((map) => map.id === "leather_town")!;
  for (const event of leather.events ?? []) {
    for (const page of event.pages) collect(page.commands);
  }
  expect(landings).toEqual([{ x: 38, y: 3 }, { x: 38, y: 3 }]);

  const session = createSession(result.project, 60, { extensions: TUXEMON_EXTENSIONS, scenes: TUXEMON_SCENES });
  const flower = session.tables.get("flower_city")!;
  const exits = ([0, 1, 2, 3] as Dir4[]).filter((dir) =>
    canStepFrom(flower, repair!.emitted.x, repair!.emitted.y, dir)
  );
  expect(exits.length).toBeGreaterThan(0);
});

test("default import output remains byte-pinned", () => {
  const maps = ["spyder_downstairs", "spyder_paper_town"];
  const bytes = jsonBytes(buildProject(maps, DEFAULT_IMPORT_OPTIONS));
  // This pins the complete ImportBuild: condition lowering, the stable source
  // inputs, the generated outdoor world index and its compact report summary,
  // its runtime WorldLayout projection, seamless traversal identity and safe
  // transfer handoff metadata, and the indoor-map list for the weather
  // particle overlay.
  // The deterministic clock, native presentation/terrain mappings, the full
  // content-derived GM1 audio table and commands, sys.music_fading fadeout
  // guard, GI scene lowering, and the
  // GI-1b movement/party lowering (choice_npc icon rows, dropped char_run,
  // get_party_monster iid slots, NPC-lifetime party clears), the G-PORTRAIT
  // monster backdrops and choice_monster menu-face icons (lazy on-demand IMG
  // entries), the GI-2b storage/trade/shop dispositions, imported item icon
  // atlas metadata, the COV-B live NPC party staging and NPC-versus-NPC
  // resolver, the moving-guard step triggers, the live-clock daytime filter,
  // the map-entry layer reset, the runtime player-name condition, the
  // per-domain NPC battle result codes, COV-C step trackers, text-valued
  // numeric transforms and set_mission no-op, the Spyder-only collision-folded
  // Surf boundary pages, native text-window layout for dialogs that carry
  // upstream position/alignment args, the starter portrait backdrops, and
  // the dialog
  // template mapping (${{var:X}} to {v:v.X}, the
  // ${{today}}/${{map_desc}}/${{monster_0_*}}/${{money_formatted}} to {x:}
  // tokens), the system.textVariables/textTokens declarations and the
  // slug->description table for the {x:map_desc} resolver are all in this
  // combined pin. The economy limitations summary also lives here, so the
  // G-PC-LOCKER fix-2 lockerOverflow wording (the locker is implemented)
  // moves this hash.
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    "a175c3145c22d722ade345a06c08b01ada47272aeafa3390c6ba0e9994fa855c",
  );
});

test("dialog templates map to kit text tokens and the project declares them", () => {
  // One map per template family: today (calendar), money (wallet), map_desc
  // (welcome sign), monster_0_* (TV flavor), and var: (cathedral/gym).
  const result = buildProject([
    "taba_house1",
    "spyder_cotton_artshop",
    "spyder_cotton_town",
    "sphalian_town_house",
    "spyder_leather_gym",
  ], G6_IMPORT_OPTIONS);
  const system = result.project.system as Record<string, unknown>;
  expect(system.textVariables).toBe(true);
  expect(system.textTokens).toEqual(["today", "map_desc", "monster_0_name", "monster_0_level", "money"]);

  // Every text/choices string under every map, flattened.
  const strings: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  result.project.maps.forEach((m) => walk(m.events));

  // No unknown template survives as "???" and no ${{...}} fragment remains.
  expect(strings.some((s) => s.includes("???") && !s.startsWith("???"))).toBe(false);
  expect(strings.some((s) => s.includes("${{"))).toBe(false);
  // Each token family is present on its map.
  const all = strings.join("\n");
  expect(all).toContain("{x:today}");
  expect(all).toContain("{x:money}");
  expect(all).toContain("{x:map_desc}");
  expect(all).toContain("{x:monster_0_name}");
  expect(all).toContain("{x:monster_0_level}");
  expect(all).toContain("{v:v.chad_points}");
  expect(all).toContain("{v:v.brad_points}");
  // The cathedral_fee variable is written by the spyder scenario; its token
  // resolves at runtime. scoop_price/party_lost_hp/cathedral_share_full/
  // cathedral_interest_full have no imported writer and render the kit's
  // unset-variable default ("0").
});

test("the importer emits a slug->description table for {x:map_desc}", () => {
  const result = buildProject(["spyder_cotton_town", "spyder_route1", "taba_house1"]);
  // spyder_cotton_town's tuxemon slug is cotton_town, whose description is
  // "A growing force!"; route1 has one too. taba_house1 is an interior with
  // no <slug>_description catalog entry, so it is absent from the table.
  expect(result.mapDescriptions["spyder_cotton_town"]).toBe("A growing force!");
  expect(result.mapDescriptions["spyder_route1"]).toBe("Take care!");
  expect(result.mapDescriptions["taba_house1"]).toBeUndefined();
  // The table is keyed by kit map id, not tuxemon slug.
  expect(result.mapDescriptions["cotton_town"]).toBeUndefined();
});

test("ImportOptions.areas emits a K1 rectangular event", () => {
  const result = buildProject(["spyder_candy_town"], { areas: true });
  const events = result.project.maps[0]!.events?.filter((candidate) =>
    candidate.name?.includes("Entry Candy")
  ) ?? [];
  const covered = new Set<number>();
  for (const event of events) {
    if (event.y !== 3) continue;
    for (let x = event.x; x < event.x + (event.w ?? 1); x++) covered.add(x);
  }
  expect([...covered].sort((a, b) => a - b)).toEqual(
    Array.from({ length: 22 }, (_, index) => index + 14),
  );
  expect(result.report.options?.areas).toBeTrue();
});

test("ImportOptions.areas partitions overlaps and latches every guard before bodies", () => {
  const result = buildProject(["spyder_paper_town"], {
    areas: true,
    facing: true,
    condAll: true,
    localReset: true,
    place: true,
    inputLock: true,
  });
  const overlap = result.project.maps[0]!.events?.find((event) =>
    event.name === "Stop! + Autosave Cotton + Mom Quest Intercept"
  ) as (Record<string, unknown> | undefined);
  expect(overlap).toMatchObject({ x: 13, y: 1, w: 2, h: 1 });
  const commands = ((overlap?.pages as { commands: Command[] }[])[0]!.commands);
  const firstBody = commands.findIndex((entry) => entry.op === "if" &&
    JSON.stringify(entry).includes("Hey! What do you think you're doing?"));
  const lastLatch = commands.findLastIndex((entry) => entry.op === "switch" && entry.value === false);
  expect(lastLatch).toBeGreaterThanOrEqual(0);
  expect(firstBody).toBeGreaterThan(lastLatch);
  expect(commands.filter((entry) => entry.op === "switch" && entry.value === false)).toHaveLength(3);
});

test("ImportOptions.facing emits a K1 facing condition", () => {
  const result = buildProject(["spyder_downstairs"], { facing: true });
  const nodes = objectNodes(result.project);
  expect(nodes.some((node) => node.kind === "facing" && node.dir === "down")).toBeTrue();
  expect(result.report.options?.facing).toBeTrue();
});

test("ImportOptions.condAll emits a K1 compound page condition", () => {
  const result = buildProject(["spyder_paper_town"], { condAll: true });
  const compound = objectNodes(result.project).find((node) =>
    Array.isArray(node.all) && node.all.length >= 2
  );
  expect(compound).toBeDefined();
  expect(result.report.options?.condAll).toBeTrue();
});

test("ImportOptions.localReset selects K1 local-state semantics", () => {
  const result = buildProject(["spyder_paper_town"], { localReset: true });
  expect(JSON.stringify(result.project)).toContain("local.npc.");
  const row = result.report.coverage.conditions.rows.find(
    (candidate) => candidate.type === "not char_exists",
  )!;
  expect(row.native).toBeGreaterThan(0);
  expect(row.degraded).toBe(0);
  expect(result.report.options?.localReset).toBeTrue();
});

test("ImportOptions.place emits K1 place and page-direction constructs", () => {
  const result = buildProject(["spyder_candy_town"], { place: true });
  const nodes = objectNodes(result.project);
  expect(nodes.some((node) =>
    node.op === "place" && typeof node.target === "object"
  )).toBeTrue();
  expect(nodes.some((node) =>
    node.trigger === "action" && typeof node.dir === "string"
  )).toBeTrue();
  expect(result.report.options?.place).toBeTrue();
});

test("ImportOptions.inputLock emits K1 cross-event lock commands", () => {
  const result = buildProject(["spyder_paper_town"], { inputLock: true });
  const ops = objectNodes(result.project).map((node) => node.op);
  expect(ops).toContain("lockInput");
  expect(ops).toContain("unlockInput");
  expect(result.report.options?.inputLock).toBeTrue();
});

test("K1 appends a safety unlock when a source map has no unlock path", () => {
  const result = buildProject(["taba_ba_br_master_foyer"], K1_IMPORT_OPTIONS);
  const stop = result.project.maps[0]!.events!.find((event) => event.name === "Stop and talk")!;
  expect(stop.pages[0]!.commands.at(-1)).toEqual({ op: "unlockInput" });
  expect(result.report.rows).toContainEqual(expect.objectContaining({
    key: "trigger:orphan input lock repair:T1-lowered",
    count: 1,
  }));
});

test("all 14 labelled collision cells are removable K1 event bodies", () => {
  const result = buildProject([
    "spyder_candy_hospital3",
    "spyder_dragonscave",
    "spyder_dryadsgrove",
    "spyder_omnichannel1",
    "spyder_omnichannel2",
  ], K1_IMPORT_OPTIONS);
  const bodies = result.project.maps.flatMap((map) =>
    (map.events ?? []).filter((event) => event.name?.startsWith("collision:"))
      .map((event) => ({ map: map.id, event })),
  );
  expect(bodies).toHaveLength(14);
  for (const { map, event } of bodies) {
    const key = event.name!.slice("collision:".length);
    expect(event.pages[0]).toMatchObject({ blocks: true });
    expect(event.pages[1]).toMatchObject({
      blocks: false,
      condition: { variable: { id: `local.collision.${map}.${key}`, op: "==", value: 1 } },
    });
  }
  const writes = objectNodes(result.project).filter((node) =>
    node.op === "variable" && typeof node.id === "string" && node.id.startsWith("local.collision.")
  );
  expect(writes).toHaveLength(5);
  expect(result.report.coverage.actions.rows.find((row) => row.type === "remove_collision")).toMatchObject({
    native: 5,
    degraded: 0,
    dropped: 0,
  });
});

test("a blocking spawn cutscene survives its own presence write and unlocks input", () => {
  const options = {
    areas: true,
    facing: true,
    condAll: true,
    localReset: true,
    place: true,
    inputLock: true,
  };
  const result = buildProject(["tuxe_mart_taba"], options);
  const session = createSession(result.project, 60);
  let state = startSession(result.project, session);
  const seen = new Set<string>();
  for (let frame = 0; frame < 1_000; frame++) {
    if (state.interp.modal?.kind === "text") seen.add(state.interp.modal.lines.join(" "));
    state = stepSession(session, state, {
      buttons: 0,
      confirmEdge: state.interp.modal?.kind === "text" && frame % 2 === 0,
      cancelEdge: false,
      upEdge: false,
      downEdge: false,
    });
    if (numericVariable(state, "v.proftalk2") > 0 && !state.interp.modal) break;
  }
  expect([...seen].some((line) => line.includes("I'll take 12 potions please."))).toBeTrue();
  expect([...seen].some((line) => line.includes("My name is Kay Wren"))).toBeTrue();
  expect(numericVariable(state, "v.proftalk2")).toBeGreaterThan(0);
  expect(state.interp.inputLocked).toBeFalse();
  expect(state.interp.error).toBeUndefined();
});

test("ImportOptions.routes emits K2 arbitrary targets and path steps", () => {
  const result = buildProject(["spyder_paper_town"], { routes: true });
  const nodes = objectNodes(result.project);
  expect(nodes.some((node) =>
    node.op === "moveRoute" && node.target !== null && typeof node.target === "object"
  )).toBeTrue();
  expect(nodes.some((node) => node.pathTo !== undefined)).toBeTrue();
  expect(nodes.some((node) => node.approach !== undefined)).toBeTrue();
  expect(nodes.some((node) => node.turnToward !== undefined)).toBeTrue();
  const routeNodes = objectNodes(buildProject(["route1"], { routes: true }).project);
  const charMoves = routeNodes.filter((node) =>
    node.op === "moveRoute" && node.wait === true &&
    typeof node.route === "object" && node.route !== null &&
    Array.isArray((node.route as { steps?: unknown }).steps) &&
    (node.route as { steps: unknown[] }).steps.every((step) =>
      typeof step === "string" && step.startsWith("move")
    )
  );
  expect(charMoves.length).toBeGreaterThan(0);
  expect(charMoves.every((node) =>
    (node.route as { skippable?: boolean }).skippable === true
  )).toBeTrue();
  expect(result.report.options?.routes).toBeTrue();
});

test("ImportOptions.moveControl emits KM1 stop, run, speed and facing controls", () => {
  const nodes = objectNodes(buildProject(["route1", "taba_town", "tuxe_mart_taba"], { moveControl: true }).project);
  // char_stop player -> a stop control on the player
  expect(nodes.some((node) =>
    node.op === "moveControl" && node.target === "player" &&
    (node.control as { kind?: string })?.kind === "stop"
  )).toBeTrue();
  // char_run christie -> a routeSpeed control: the run rate (7.35 tiles/s)
  // is grade 5, scoped to her next forced route (the following pathfind),
  // and gone when that route ends.
  expect(nodes.some((node) =>
    node.op === "moveControl" && (node.control as { kind?: string; value?: number })?.kind === "routeSpeed" &&
    (node.control as { value?: number })?.value === 5
  )).toBeTrue();
  // no persistent run control is emitted (it would speed every later route)
  expect(nodes.some((node) =>
    node.op === "moveControl" && (node.control as { kind?: string })?.kind === "run"
  )).toBeFalse();
  // char_speed kay_wren,7 -> the nearest MV grade to 7 tiles/s is 5
  expect(nodes.some((node) =>
    node.op === "moveControl" && (node.control as { kind?: string; value?: number })?.kind === "speed" &&
    (node.control as { value?: number })?.value === 5
  )).toBeTrue();
  // set_facing_mode callie_wren,locked -> facingMode locked
  expect(nodes.some((node) =>
    node.op === "moveControl" && (node.control as { kind?: string; value?: string })?.kind === "facingMode" &&
    (node.control as { value?: string })?.value === "locked"
  )).toBeTrue();
  // and the follow_movement arm maps back to followMovement
  expect(nodes.some((node) =>
    node.op === "moveControl" && (node.control as { kind?: string; value?: string })?.kind === "facingMode" &&
    (node.control as { value?: string })?.value === "followMovement"
  )).toBeTrue();
});

test("char_position becomes a clamped place command under moveControl", () => {
  const nodes = objectNodes(buildProject(["spyder_paper_rival_downstairs"], { moveControl: true }).project);
  expect(nodes.some((node) =>
    node.op === "place" && node.target === "player" && node.x === 6 && node.y === 8
  )).toBeTrue();
});

test("char_position followed by char_face folds the facing into the placement", () => {
  const result = buildProject(["spyder_paper_rival_downstairs"], { moveControl: true });
  const nodes = objectNodes(result.project);
  // the real "TV Yes" event places the player at (6,8) and immediately faces
  // left; the adjacent char_face must fold into the placement dir instead of
  // a separate route that the placement's stopPlayerRoute would swallow
  const place = nodes.find((node) =>
    node.op === "place" && node.target === "player" && node.x === 6 && node.y === 8
  ) as { dir?: string } | undefined;
  expect(place?.dir).toBe("left");

  const session = createSession(result.project, 60, {
    extensions: TUXEMON_EXTENSIONS,
    battle: TUXEMON_BATTLE_RULES,
  });
  let state = startSession(result.project, session);
  state.sw.variables["v.billie_tv"] = 2;
  for (let frame = 0; frame < 10; frame++) {
    state = stepSession(session, state, { buttons: 0 });
  }
  // the event placed the player at (6,8) facing left and the facing sticks
  expect([state.move.tx, state.move.ty]).toEqual([6, 8]);
  expect(state.move.facing).toBe(1);
  state = stepSession(session, state, { buttons: 0 });
  expect(state.move.facing).toBe(1);
});

test("spawn char_wander becomes a KM1 wander control and a page frequency grade", () => {
  const result = buildProject(["spyder_leather_museum"], { moveControl: true });
  const nodes = objectNodes(result.project);
  // historian wanders at 0.8s -> the nearest MV grade is 3 (1s cadence)
  expect(nodes.some((node) =>
    node.op === "moveControl" && (node.control as { kind?: string; frequency?: number })?.kind === "wander" &&
    (node.control as { frequency?: number })?.frequency === 3
  )).toBeTrue();
  // the NPC page keeps random movement as the fallback, at the same grade
  expect(nodes.some((node) => node.moveType === "random" && node.moveFrequency === 3)).toBeTrue();
  // a char_wander naming an NPC the spawn never creates is dropped, not emitted
  const miner = nodes.filter((node) =>
    node.op === "moveControl" && (node.control as { kind?: string })?.kind === "wander" &&
    typeof node.target === "object" && node.target !== null &&
    (node.target as { event?: string }).event === "npc_spyder_leathermuseum_miner"
  );
  expect(miner.length).toBe(0);
});

test("moveControl is off by default and the legacy lowerings stay byte-stable", () => {
  const nodes = objectNodes(buildProject(["route1"], DEFAULT_IMPORT_OPTIONS).project);
  expect(nodes.some((node) => node.op === "moveControl")).toBeFalse();
});

test("get_player_monster becomes a guarded KC1 extChoice over the live party", () => {
  const nodes = objectNodes(buildProject(["spyder_dojo1"], { extChoice: true, battle: true }).project);
  // the party_match guard wraps the extChoice
  const match = nodes.filter((node) =>
    node.op === "ext" || (node as { call?: string }).call === "tux.party_match"
  );
  expect(match.some((node) => (node as { call?: string }).call === "tux.party_match")).toBeTrue();
  const choice = nodes.find((node) =>
    node.op === "extChoice" && (node as { call?: string }).call === "tux.party_monsters"
  ) as { args?: { variable?: string; cancelCode?: number; filters?: unknown[] }; cancel?: boolean } | undefined;
  expect(choice).toBeDefined();
  expect(choice?.args?.variable).toBe("v.dojo_stage");
  expect(typeof choice?.args?.cancelCode).toBe("number");
  // a filtered choice is cancellable (upstream lets the player back out)
  expect(choice?.cancel).toBeTrue();
  expect(choice?.args?.filters).toEqual([{ field: "evolution_stage", value: "stage2" }]);
  // the empty-party arm writes the no_options enum code, not a menu
  const noOptions = nodes.some((node) =>
    node.op === "variable" && (node as { id?: string }).id === "v.dojo_stage"
  );
  expect(noOptions).toBeTrue();
});

test("an unfiltered get_player_monster is non-cancellable", () => {
  const nodes = objectNodes(buildProject(["spyder_dojo1"], { extChoice: true, battle: true }).project);
  const choices = nodes.filter((node) =>
    node.op === "extChoice" && (node as { call?: string }).call === "tux.party_monsters"
  ) as Array<{ args?: { filters?: unknown[] }; cancel?: boolean }>;
  const unfiltered = choices.find((node) => (node.args?.filters ?? []).length === 0);
  expect(unfiltered).toBeDefined();
  expect(unfiltered?.cancel).toBeUndefined();
});

test("choice_monster becomes authored choices whose rows show the monster menu face", () => {
  const result = buildProject(["spyder_paper_scoop", "manhattan_beach"], { extChoice: true, battle: true });
  const nodes = objectNodes(result.project);
  // The static extChoice path is gone: both uses are authored choices.
  expect(nodes.some((node) =>
    node.op === "extChoice" && (node as { call?: string }).call === "tux.enum_choice"
  )).toBeFalse();
  const scoop = nodes.find((node) =>
    node.op === "choices" && ((node as { options?: unknown[] }).options?.length ?? 0) === 5
  ) as {
    options?: Array<{ text: string; icon?: { sprite: string }; commands: Array<Record<string, unknown>> }>;
  } | undefined;
  expect(scoop).toBeDefined();
  const options = scoop!.options!;
  // Upstream's ChoiceMonster draws each monster's animated 24x24 menu face;
  // the kit's 16 px icon cell bakes menu frame 1 (menu1_rect).
  expect(options.map((o) => o.icon?.sprite)).toEqual([
    "tux_monster_menu_budaye",
    "tux_monster_menu_dollfin",
    "tux_monster_menu_grintot",
    "tux_monster_menu_ignibus",
    "tux_monster_menu_memnomnom",
  ]);
  for (const option of options) {
    expect(result.project.sprites?.[option.icon!.sprite]).toEqual({
      kind: "image",
      src: `gfx/sprites/battle/${option.icon!.sprite.slice("tux_monster_menu_".length)}-sheet.png`,
    });
  }
  // Every row writes its positive enum code into myintrochoice.
  const codes = options.map((o) => (o.commands[0] as { id?: string; set?: { value?: number } }));
  expect(codes.every((c) => c.id === "v.myintrochoice" && (c.set?.value ?? 0) > 0)).toBeTrue();
  expect(new Set(codes.map((c) => c.set?.value)).size).toBe(5);
  // The manhattan_beach use (hydrone:rockitten:fruitera) gets icons too.
  const manhattan = result.presentation.monsterMenuIcons.filter((icon) =>
    ["hydrone", "rockitten", "fruitera"].includes(icon.sprite.slice("tux_monster_menu_".length))
  );
  expect(manhattan).toHaveLength(3);
  for (const icon of manhattan) {
    expect(icon.crop).toEqual({ x: 0, y: 64, w: 24, h: 24 });
  }
  // Every registered icon has a cooker entry with the default menu1 crop.
  const scoopIcons = result.presentation.monsterMenuIcons.filter((icon) =>
    ["budaye", "dollfin", "grintot", "ignibus", "memnomnom"].includes(icon.sprite.slice("tux_monster_menu_".length))
  );
  expect(scoopIcons).toHaveLength(5);
  for (const icon of scoopIcons) {
    expect(icon.sheet).toBe(`gfx/sprites/battle/${icon.sprite.slice("tux_monster_menu_".length)}-sheet.png`);
    expect(icon.crop).toEqual({ x: 0, y: 64, w: 24, h: 24 });
  }
});

test("change_bg_monster shows the front battle sprite on the story backdrop", () => {
  const result = buildProject(["player_house_bedroom", "spyder_bedroom"], G6_IMPORT_OPTIONS);
  const nodes = objectNodes(result.project);
  const backdrops = nodes.filter((node) =>
    node.op === "screenBackdrop" && (node as { variant?: string }).variant?.endsWith("_monster")
  ) as Array<{ layer: string; variant: string }>;
  // rockitten (player_house_bedroom, twice) + the five Spyder starters.
  expect(backdrops.map((b) => b.variant).sort()).toEqual([
    "bg_gradient_blue_budaye_monster",
    "bg_gradient_blue_dollfin_monster",
    "bg_gradient_blue_grintot_monster",
    "bg_gradient_blue_ignibus_monster",
    "bg_gradient_blue_memnomnom_monster",
    "bg_gradient_blue_rockitten_monster",
    "bg_gradient_blue_rockitten_monster",
  ]);
  for (const backdrop of backdrops) expect(backdrop.layer).toBe("tux_backdrop");
  // The old name card is gone. player_house_bedroom has no
  // `translated_dialog rockitten`, so any "Rockitten" text there would be
  // the removed name card; spyder_bedroom keeps the five `translated_dialog
  // <starter>` lines that open on top of each portrait (one per starter).
  const bedroom = objectNodes(result.project.maps.find((m) => m.id === "player_house_bedroom")!);
  const rockittenCards = bedroom.filter((node) =>
    node.op === "text" && (node as { lines?: string[] }).lines?.[0] === "Rockitten"
  );
  expect(rockittenCards).toEqual([]);
  const spyder = objectNodes(result.project.maps.find((m) => m.id === "spyder_bedroom")!);
  const starterDialogs = spyder.filter((node) =>
    node.op === "text" && ((node as { lines?: string[] }).lines?.length ?? 0) === 1 &&
    ["Dollfin", "Ignibus", "Memnomnom", "Budaye", "Grintot"].includes(
      (node as { lines?: string[] }).lines![0]!,
    )
  );
  expect(starterDialogs).toHaveLength(5);
  // Every portrait variant has a composited backdrop source.
  for (const variant of new Set(backdrops.map((b) => b.variant))) {
    expect(result.presentation.backdrops).toContainEqual(expect.objectContaining({ variant }));
  }
});

test("choice_npc shows each appearance with its walker icon", () => {
  const { project } = buildProject(["start_tuxemon"], { extChoice: true, battle: true });
  const nodes = objectNodes(project);
  const choice = nodes.find((node) =>
    node.op === "choices" && ((node as { options?: unknown[] }).options?.length ?? 0) === 6
  ) as { options?: Array<{ text: string; icon?: { sprite: string }; commands: Array<Record<string, unknown>> }> } | undefined;
  expect(choice).toBeDefined();
  const options = choice!.options!;
  // Upstream tells the six appearances apart by each option NPC's picture;
  // the icon is that NPC's walker (db/npc/appearance_options.yaml), and every
  // line also carries the appearance name.
  expect(options.map((o) => o.icon?.sprite)).toEqual([
    "adventurer", "adventurerblack", "heroine", "brownheroine_brown", "enbyasian", "penguin",
  ]);
  for (const option of options) expect(project.sprites?.[option.icon!.sprite]).toBeDefined();
  const labels = options.map((o) => o.text);
  expect(new Set(labels).size).toBe(6);
  for (const name of ["White male", "Black male", "White female", "Black female", "Nonbinary", "Whatever"]) {
    expect(labels.some((l) => l.includes(name))).toBeTrue();
  }
  // Each row writes its enum code into race_choice, as tux.enum_choice did.
  const codes = options.map((o) => (o.commands[0] as { id?: string; set?: { value?: number } }));
  expect(codes.every((c) => c.id === "v.race_choice" && (c.set?.value ?? 0) > 0)).toBeTrue();
  expect(new Set(codes.map((c) => c.set?.value)).size).toBe(6);
  expect(nodes.some((node) => node.op === "extChoice" && (node as { args?: { variable?: string } }).args?.variable === "v.race_choice")).toBeFalse();
});

test("remove_monster becomes a tux.remove_monster ext command", () => {
  const nodes = objectNodes(buildProject(["spyder_dryadsgrove"], { extChoice: true, battle: true }).project);
  expect(nodes.some((node) =>
    node.op === "ext" && (node as { call?: string }).call === "tux.remove_monster" &&
    (node as { args?: { variable?: string } }).args?.variable === "v.ruff_back"
  )).toBeTrue();
  // the old party_size placeholder is gone
  expect(nodes.some((node) =>
    node.op === "variable" && (node as { id?: string }).id === "sys.party_size"
  )).toBeFalse();
});

test("get_party_monster becomes a tux.get_party_monsters ext command", () => {
  const nodes = objectNodes(buildProject(["spyder_nimrod_middle"], { extChoice: true, battle: true }).project);
  const calls = nodes.filter((node) =>
    node.op === "ext" && (node as { call?: string }).call === "tux.get_party_monsters"
  ) as Array<{ args?: { character?: string } }>;
  // the Nimrod event dumps argon's party iids so remove_monster can delete
  // her first monster by its owner
  expect(calls.some((c) => c.args?.character === "spyder_nimrod_argon")).toBeTrue();
});

test("get_party_monster is Native wherever the NPC's party is staged", () => {
  const result = buildProject(["spyder_nimrod_middle", "spyder_dojo2", "spyder_leather_gym"], G6_IMPORT_OPTIONS);
  // NPC parties are staged live (not folded) when the event inspects them,
  // and NPC-versus-NPC battles keep the parties in npcParties, so every
  // get_party_monster writes iid_slot_*. The shared spyder.yaml cheat-code
  // event now materializes too (its player-name check is a runtime
  // condition, not a folded false guard).
  expect(result.report.coverage.actions.rows.find((row) => row.type === "get_party_monster"))
    .toMatchObject({ total: 9, native: 9, degraded: 0, placeholder: 0, dropped: 0 });
});

test("create_npc and remove_npc bound the NPC's party lifetime", () => {
  const nodes = objectNodes(buildProject(["spyder_route2"], G6_IMPORT_OPTIONS).project);
  const clears = nodes.filter((node) =>
    node.op === "ext" && (node as { call?: string }).call === "tux.clear_npc_party"
    && (node as { args?: { character?: string } }).args?.character === "spyder_billie");
  // A fresh create_npc clears the party only when the NPC is not on the map.
  const guarded = nodes.filter((node) => {
    const branch = node as { op?: string; if?: { kind?: string; id?: string; op?: string; value?: number }; then?: unknown[] };
    return branch.op === "if" && branch.if?.kind === "variable" && branch.if.id === "local.npc.spyder_billie"
      && branch.if.op === "==" && branch.if.value === 0
      && (branch.then ?? []).some((command) => clears.includes(command as never));
  });
  expect(guarded.length).toBeGreaterThan(0);
  expect(clears.length).toBeGreaterThan(guarded.length);
});

test("open_shop imports item economies and monster shop scenes", () => {
  const result = buildProject(availableMapIds(), G6_IMPORT_OPTIONS);
  expect(result.report.dialogLayout).toEqual({
    actionsWithLayout: 255,
    native: 255,
    dropped: 0,
    parameters: {
      position: { source: 249, native: 249, dropped: 0 },
      hAlignment: { source: 110, native: 110, dropped: 0 },
      vAlignment: { source: 102, native: 102, dropped: 0 },
    },
  });
  const row = result.report.coverage.actions.rows.find((candidate) => candidate.type === "open_shop");
  expect(row).toMatchObject({ total: 28, native: 28, degraded: 0, placeholder: 0, dropped: 0 });
  expect(result.report.coverage.actions.rows.find((candidate) => candidate.type === "set_economy"))
    .toMatchObject({ total: 16, native: 16, degraded: 0, placeholder: 0, dropped: 0 });
  expect(result.report.economy).toMatchObject({
    sourceEconomies: 14,
    itemGoods: 75,
    monsterGoods: 10,
    finiteStockGoods: 6,
    conditionedGoods: 4,
    itemCatalog: { sourceRows: 230, uniqueItems: 224 },
    limitations: { lockerOverflow: { disposition: "degraded" } },
  });
  expect(result.report.economy.itemCatalog.descriptions.potion).toBe("Heals a monster by 50 HP.");
  expect(result.project.system?.inventory).toEqual({ maxKinds: 99 });
  expect(result.project.items.find((item) => item.id === "potion")).toEqual({
    id: "potion",
    name: "Potion",
    sprite: "items.73",
    usable: true,
    price: 100,
    sellable: true,
  });

  const shopNodes = objectNodes(result.project).filter((node) => node.op === "shop");
  expect(shopNodes).toHaveLength(21);
  const uniqueShops = new Map(shopNodes.map((node) => [node.id, node]));
  expect(uniqueShops.size).toBe(13);
  const goods = [...uniqueShops.values()].flatMap((node) => node.goods as Record<string, unknown>[]);
  expect(goods).toHaveLength(75);
  expect(goods.filter((good) => good.stock !== undefined)).toHaveLength(6);
  expect(goods.filter((good) => good.condition !== undefined)).toHaveLength(4);
  expect(uniqueShops.get("spyder_cotton_tech")?.goods).toContainEqual({
    item: "tm_avalanche",
    price: 2_000,
    sellPrice: 400,
    stock: 1,
  });
  expect(uniqueShops.get("spyder_flower_scoop")?.goods).toContainEqual({
    item: "tuxeball_diurnal",
    price: 300,
    sellPrice: 150,
    condition: { all: [{ kind: "variable", id: "v.daytime", op: "==", value: 2 }] },
  });
  const shopLines = objectNodes(result.project)
    .filter((node) => node.op === "text" && Array.isArray(node.lines))
    .flatMap((node) => node.lines as string[]);
  expect(shopLines.filter((line) => line.startsWith("[SHOP]"))).toHaveLength(0);

  // Every buy_monster menu opens the monster shop with its economy's stock.
  const monsterShops = objectNodes(result.project)
    .filter((node) => node.op === "scene" && node.id === "tux.monsterShop");
  expect(monsterShops).toHaveLength(7);
  const byEconomy = new Map(monsterShops.map((node) => {
    const args = node.args as { economy: string; entries: unknown[] };
    return [args.economy, args.entries];
  }));
  expect([...byEconomy.keys()].sort()).toEqual([
    "spyder_candy_tech",
    "spyder_cotton_tech",
    "spyder_flower_petshop",
    "spyder_flower_tech",
    "spyder_leather_tech",
    "spyder_timber_tech",
  ]);
  expect(byEconomy.get("spyder_candy_tech")).toEqual([{ slug: "budaye", price: 4_000, level: 10, stock: 1 }]);
  expect(byEconomy.get("spyder_flower_petshop")).toEqual(
    ["squink", "potturmeist", "fuzzlet", "woodoor", "ziggurat"]
      .map((slug) => ({ slug, price: 500, level: 10, stock: 1 })),
  );
});

test("world destroy tools lower to held-item interactions for matching sprites", () => {
  const result = buildProject(["spyder_route3"], G6_IMPORT_OPTIONS);
  const route3 = result.project.maps.find((map) => map.id === "spyder_route3")!;
  const boulder = route3.events?.find((event) => event.id === "npc_spyder_boulder");
  expect(boulder).toBeDefined();
  const nodes = objectNodes(boulder);
  expect(nodes).toContainEqual(expect.objectContaining({
    op: "if",
    if: { kind: "item", id: "sledgehammer", count: 1 },
  }));
  expect(nodes).toContainEqual({
    op: "text",
    lines: ["The sledgehammer smashes the boulder apart."],
  });
  expect(nodes).toContainEqual({
    op: "variable",
    id: "v.spyder_boulder",
    set: { op: "set", value: 1 },
  });
  expect(nodes).toContainEqual({
    op: "variable",
    id: "local.npc.spyder_boulder",
    set: { op: "set", value: 0 },
  });
  expect(result.report.rows).toContainEqual(expect.objectContaining({
    key: "behav:world remove_entity item:T1-lowered",
    count: 1,
  }));

  const session = createSession(result.project, 60, {
    extensions: TUXEMON_EXTENSIONS,
    battle: TUXEMON_BATTLE_RULES,
    scenes: TUXEMON_SCENES,
  });
  let state = startSession(result.project, session);
  state.move = {
    ...state.move,
    tx: 32,
    ty: 8,
    px: 32 * result.project.tileSize,
    py: 8 * result.project.tileSize,
    facing: 2,
    stepDir: 2,
  };
  state.sw.items.sledgehammer = 1;
  state.sw.variables["local.npc.spyder_boulder"] = 1;
  for (let frame = 0; frame < 20; frame++) {
    state = stepSession(session, state, { buttons: 0 });
  }
  expect(state.chars.chars.npc_spyder_boulder?.blocks).toBeTrue();
  state = stepSession(session, state, { buttons: BTN_CONFIRM, confirmEdge: true });
  state = stepSession(session, state, { buttons: 0 });
  for (let frame = 0; frame < 20; frame++) {
    const confirm = state.interp.modal?.kind === "text" && frame % 2 === 0;
    state = stepSession(session, state, { buttons: confirm ? BTN_CONFIRM : 0, confirmEdge: confirm });
  }
  expect(state.sw.variables["v.spyder_boulder"]).toBe(1);
  expect(numericVariable(state, "local.npc.spyder_boulder")).toBe(0);
  expect(state.chars.chars.npc_spyder_boulder?.blocks).not.toBeTrue();
});

test("G6 emits native party state and Battle Processing for the first fight", () => {
  const result = buildProject(["spyder_paper_town"], G6_IMPORT_OPTIONS);
  const nodes = objectNodes(result.project);
  const billie = nodes.find((node) => node.op === "ext" && node.call === "tux.add_monster" &&
    (node.args as { character?: string } | undefined)?.character === "spyder_billie");
  expect(billie?.args).toEqual({
    species: {
      variable: "v.billie_choice",
      values: ["bamboon", "bigfin", "budaye", "dollfin", "eruptibus", "grintot", "grintrock", "ignibus", "memnomnom", "miaownolith"],
    },
    level: 5,
    character: "spyder_billie",
    experienceModifier: 5,
    moneyModifier: 10,
  });
  expect(nodes).toContainEqual({
    op: "battle",
    setup: { kind: "trainer", opponent: "spyder_billie", inside: false, hour: 12 },
  });
  expect(nodes.some((node) => node.op === "variable" && node.id === "sys.party_size")).toBeFalse();
  expect(nodes.some((node) => node.kind === "ext" && node.call === "tux.party_size")).toBeTrue();
  expect(result.variables.battle_last_loser).toContain("spyder_billie");
  expect(result.variables.battle_last_result).toEqual(expect.arrayContaining(["captured", "run"]));
});

test("G6 lowers Tuxemon rename and journal actions to registered scenes", () => {
  const result = buildProject([
    "healing_center",
    "player_house_bedroom",
    "professor_lab",
    "spyder_dojo4",
  ], G6_IMPORT_OPTIONS);
  const nodes = objectNodes(result.project);
  expect(result.project.playerName).toBe("Red");
  expect(JSON.stringify(result.project)).toContain("{name}");

  const playerRename = nodes.find((node) => node.op === "scene" && node.id === "rpgkit.nameInput"
    && (node.args as { default?: string } | undefined)?.default === "");
  expect(playerRename?.args).toMatchObject({ maxLength: 15, swallowCancel: true, columns: 10 });

  const picker = nodes.find((node) => node.op === "scene" && node.id === "tux.monsterPicker");
  expect(picker?.args).toEqual({ variable: "v.rename", title: "Choose a Tuxemon" });
  expect(picker?.onDone).toEqual([
    {
      op: "ext",
      call: "tux.prepare_monster_rename",
      args: { variable: "v.rename", nameVariable: "tux.rename.name" },
    },
    expect.objectContaining({ op: "scene", id: "rpgkit.nameInput" }),
    {
      op: "ext",
      call: "tux.apply_monster_rename",
      args: { variable: "v.rename", nameVariable: "tux.rename.name" },
    },
  ]);
  expect(nodes.filter((node) => node.op === "scene" && node.id === "tux.journal")).toHaveLength(3);
  expect(nodes.filter((node) => node.op === "ext" && node.call === "tux.set_tuxepedia")).toHaveLength(6);

  const rows = result.report.coverage.actions.rows;
  expect(rows.find((row) => row.type === "rename_player")).toMatchObject({ degraded: 3, dropped: 2 });
  expect(rows.find((row) => row.type === "rename_monster")).toMatchObject({ native: 1, dropped: 1 });
  expect(rows.find((row) => row.type === "open_journal")).toMatchObject({ degraded: 3, dropped: 11 });
  expect(rows.find((row) => row.type === "set_tuxepedia")).toMatchObject({ degraded: 6, dropped: 0 });
});

test("faint recovery preserves its notice and yields to the first-loss cutscene", () => {
  const result = buildProject(["spyder_route3", "spyder_leather_center", "spyder_paper_town"], G6_IMPORT_OPTIONS);
  const route3 = result.project.maps.find((map) => map.id === "spyder_route3")!;
  const center = result.project.maps.find((map) => map.id === "spyder_leather_center")!;
  const paper = result.project.maps.find((map) => map.id === "spyder_paper_town")!;
  const transfer = route3.events?.find((event) => event.name === "Teleport Faint");
  const transferNodes = objectNodes(transfer);
  expect(transferNodes).toContainEqual({ op: "switch", id: "sys.faint_notice", value: true });
  expect(transferNodes.some((node) => node.op === "transfer" &&
    (node.map as { variable?: string } | undefined)?.variable === "tux.faint.map")).toBeTrue();
  expect(transferNodes.some((node) => node.op === "text")).toBeFalse();

  const notice = center.events?.find((event) => event.name === "Faint Recovery Notice");
  expect(notice?.pages[0]?.condition).toBeUndefined();
  const noticeNodes = objectNodes(notice);
  expect(noticeNodes).toContainEqual({ kind: "switch", id: "sys.faint_notice", value: true });
  expect(noticeNodes).toContainEqual({
    op: "text",
    lines: ["You should heal your monsters before heading off."],
  });
  expect(noticeNodes).toContainEqual({ op: "switch", id: "sys.faint_notice", value: false });
  expect(noticeNodes.findIndex((node) => node.op === "switch" && node.id === "sys.faint_notice" && node.value === false))
    .toBeLessThan(noticeNodes.findIndex((node) => node.op === "text"));

  const paperTransfer = paper.events?.find((event) => event.name === "Teleport Faint");
  const paperTransferNodes = objectNodes(paperTransfer);
  expect(paperTransferNodes).toContainEqual({ kind: "worldIdle" });
  expect(paperTransferNodes.some((node) =>
    node.kind === "variable" && ["v.firstfightdue", "v.firstfightend"].includes(String(node.id))))
    .toBeFalse();

  const firstLoss = paper.events?.find((event) => event.name === "First Fight - Lose");
  expect(objectNodes(firstLoss).some((node) => node.kind === "ext" && node.call === "tux.char_defeated")).toBeFalse();
});

test("current_state maps WorldState and folds states while kit map fibers are suspended", () => {
  expect(lowerCurrentStateCondition("is", "WorldState")).toEqual({ kind: "worldIdle" });
  expect(lowerCurrentStateCondition("not", "WorldState")).toEqual({ kind: "worldIdle", negate: true });
  expect(lowerCurrentStateCondition("is", "MainCombatMenuState:WorldState")).toEqual({ kind: "worldIdle" });
  expect(lowerCurrentStateCondition("is", "MainCombatMenuState")).toBe(false);
  expect(lowerCurrentStateCondition("is", "MainCombatMenuState:WorldMenuState")).toBe(false);
  expect(lowerCurrentStateCondition("is", "TeleporterState")).toBe(false);
  expect(lowerCurrentStateCondition("not", "TeleporterState")).toBe(true);

  const result = buildProject(["spyder_route1"], G6_IMPORT_OPTIONS);
  const evolution = result.project.maps[0]!.events?.find((event) => event.name === "Evolution all");
  expect(objectNodes(evolution)).toContainEqual({ kind: "worldIdle" });
  expect(result.report.rows).toContainEqual(expect.objectContaining({
    key: "cond:is current_state:T1",
    note: "WorldState arm -> derived worldIdle condition; scene/menu alternatives freeze map fibers",
  }));
});

test("imports live player-name guards and rejects impossible legacy triggers", () => {
  const result = buildProject([
    "mansion",
    "spyder_wayfarer_inn1",
    "water_underwater",
  ], G6_IMPORT_OPTIONS);
  const nodes = objectNodes(result.project);
  const nameConditions = nodes.filter((node) =>
    node.kind === "ext" && node.call === "tux.player_name_is"
  );
  expect(nameConditions).toEqual(expect.arrayContaining([
    expect.objectContaining({ args: { name: "ApexPlayer", negate: false } }),
    expect.objectContaining({ args: { name: "ApexPlayer", negate: true } }),
  ]));
  expect(result.report.coverage.conditions.rows.find((row) =>
    row.type === "is check_char_parameter"
  )).toMatchObject({ total: 40, native: 2, dropped: 38 });
  expect(result.report.coverage.conditions.rows.find((row) =>
    row.type === "not check_char_parameter"
  )).toMatchObject({ total: 1, native: 1, dropped: 0 });

  const inn = result.project.maps.find((map) => map.id === "spyder_wayfarer_inn1")!;
  expect(inn.events?.some((event) => event.name === "Talk Maniac - Got Botbot - Cheat")).toBeTrue();

  // The pinned source stores Direction values as up/down/left/right. Its
  // legacy `bottom` guard can never pass, so only the valid basement portals
  // remain (the bad one was at x=1,y=16).
  const mansion = result.project.maps.find((map) => map.id === "mansion")!;
  expect(mansion.events?.some((event) =>
    event.name === "Teleport to Basement" && event.x === 1 && event.y === 16
  )).toBeFalse();

  // K_RETURN is a pygame key name, not one of the intention names accepted
  // by ButtonPressedCondition in this source revision.
  const underwater = result.project.maps.find((map) => map.id === "water_underwater")!;
  expect(underwater.events?.some((event) => event.name === "Water Gemuar Battle")).toBeFalse();

  // Maps without authored surfable cells must not gain unconditional shared
  // scenario dialogue, movement, or appearance changes.
  const spyder = buildProject(["spyder_cotton_cafe"], G6_IMPORT_OPTIONS).project.maps[0]!;
  for (const name of [
    "Choice Surf",
    "Push Into Water Down",
    "Push Into Water Left",
    "Push Into Water Right",
    "Push Into Water Up",
    "Surfable",
    "Not surfable",
  ]) {
    expect(spyder.events?.some((event) => event.name === name), name).toBeFalse();
  }
});

test("Spyder surf boundaries require the Surfboard, enter water, and dismount", () => {
  const result = buildProject([
    "spyder_timber_town",
    "spyder_routee",
    "spyder_route1",
    "spyder_routed",
  ], G6_IMPORT_OPTIONS);
  const timber = result.project.maps.find((map) => map.id === "spyder_timber_town")!;
  const route1 = result.project.maps.find((map) => map.id === "spyder_route1")!;
  // Generated Surf boundaries are intentionally outside the source-authored
  // area partition. Otherwise their cells split and renumber frozen rNNN ids
  // even before the player owns a Surfboard.
  expect(route1.events?.some((event) => event.id === "e003_teleport_to_route1_r046")).toBeTrue();
  expect(route1.events?.filter((event) => event.id.startsWith("tux_surf_"))
    .every((event) => event.name === "Choice Surf" || event.name === "Not surfable")).toBeTrue();
  const entry = timber.events?.find((event) =>
    event.name?.includes("Choice Surf") &&
    event.x <= 33 && 33 < event.x + (event.w ?? 1) &&
    event.y <= 38 && 38 < event.y + (event.h ?? 1)
  );
  expect(entry?.pages[0]?.condition).toEqual({
    all: [
      { kind: "item", id: "surfboard", count: 1 },
      { kind: "variable", id: "v.swimming", op: "!=", value: 2 },
    ],
  });
  expect(objectNodes(entry)).toContainEqual({
    op: "tileProperty",
    x: 33,
    y: 38,
    passage: "pass",
  });
  expect(objectNodes(entry)).toContainEqual({
    op: "appearance",
    target: "player",
    sprite: "swimmer",
  });
  expect(objectNodes(entry)).toContainEqual(expect.objectContaining({
    op: "moveRoute",
    target: "player",
    route: expect.objectContaining({ steps: ["stepForward"] }),
  }));

  result.project.start = { map: "spyder_timber_town", x: 32, y: 38, dir: "right" };
  const session = createSession(result.project, 60, {
    extensions: TUXEMON_EXTENSIONS,
    battle: TUXEMON_BATTLE_RULES,
    scenes: TUXEMON_SCENES,
  });
  let state = startSession(result.project, session);
  for (let frame = 0; frame < 20; frame++) state = stepSession(session, state, { buttons: 0 });

  state = stepSession(session, state, { buttons: 0, confirmEdge: true });
  for (let frame = 0; frame < 10; frame++) state = stepSession(session, state, { buttons: 0 });
  expect(state.interp.modal).toBeNull();
  expect([state.move.tx, state.move.ty]).toEqual([32, 38]);

  state.sw.items.surfboard = 1;
  state = stepSession(session, state, { buttons: 0, confirmEdge: true });
  for (let frame = 0; frame < 180; frame++) {
    const modal = state.interp.modal;
    const confirm = modal?.kind === "choices" || (modal?.kind === "text" && modal.complete);
    state = stepSession(session, state, { buttons: 0, confirmEdge: confirm });
  }
  expect([state.move.tx, state.move.ty]).toEqual([33, 38]);
  expect(numericVariable(state, "v.swimming")).toBe(2);
  expect(state.sw.playerAppearance?.sprite).toBe("swimmer");
  expect(Object.keys(state.interp.tileProperties ?? {})).toHaveLength(144);

  state = stepSession(session, state, { buttons: BTN_BITS.LEFT });
  for (let frame = 0; frame < 30; frame++) state = stepSession(session, state, { buttons: 0 });
  expect([state.move.tx, state.move.ty]).toEqual([32, 38]);
  expect(numericVariable(state, "v.swimming")).toBe(1);
  expect(state.sw.playerAppearance?.sprite).toBeUndefined();
  expect(state.interp.tileProperties).toBeUndefined();

  // Route D has an authored moving-guard encounter on (8,0) and a generated
  // Surf dismount rectangle covering that same playerTouch cell. The importer
  // folds dismount into the source guard-latch/body chain and removes (8,0)
  // from the standalone Surf event, so one completed-step edge runs both.
  const routed = result.project.maps.find((map) => map.id === "spyder_routed")!;
  const encounter = routed.events?.find((event) =>
    event.id.startsWith("e011_swim_encounters_day") &&
    event.x === 8 && event.y === 0
  );
  const competingDismount = routed.events?.find((event) =>
    event.id.startsWith("tux_surf_dismount") &&
    event.x <= 8 && 8 < event.x + (event.w ?? 1) &&
    event.y <= 0 && 0 < event.y + (event.h ?? 1)
  );
  expect(encounter?.pages[0]?.trigger).toBe("playerTouch");
  expect(competingDismount).toBeUndefined();
  expect(objectNodes(encounter)).toContainEqual({
    op: "appearance",
    target: "player",
    sprite: null,
  });
  expect(objectNodes(encounter)).toContainEqual({
    op: "variable",
    id: "v.swimming",
    set: { op: "set", value: 1 },
  });

  result.project.start = { map: "spyder_routed", x: 7, y: 0, dir: "right" };
  const routedSession = createSession(result.project, 60, {
    extensions: TUXEMON_EXTENSIONS,
    battle: TUXEMON_BATTLE_RULES,
    scenes: TUXEMON_SCENES,
  });
  let routedState = startSession(result.project, routedSession);
  for (let frame = 0; frame < 20; frame++) {
    routedState = stepSession(routedSession, routedState, { buttons: 0 });
  }
  routedState.sw.playerAppearance = { sprite: "swimmer" };
  routedState.sw.variables["v.swimming"] = 2;
  routedState = stepSession(routedSession, routedState, { buttons: BTN_BITS.RIGHT });
  for (let frame = 0; frame < 30; frame++) {
    routedState = stepSession(routedSession, routedState, { buttons: 0 });
  }
  expect([routedState.move.tx, routedState.move.ty]).toEqual([8, 0]);
  expect(routedState.sw.switches["tracker.routed"]).toBeTrue();
  expect(numericVariable(routedState, "v.swimming")).toBe(1);
  expect(routedState.sw.playerAppearance?.sprite).toBeUndefined();
});

test("real Benden and Dryad's Grove conversations follow caught and healed state", () => {
  const result = buildProject([
    "spyder_cotton_tunnel",
    "spyder_dryadsgrove",
  ], G6_IMPORT_OPTIONS);
  const session = createSession(result.project, 60, {
    extensions: TUXEMON_EXTENSIONS,
    battle: TUXEMON_BATTLE_RULES,
    scenes: TUXEMON_SCENES,
  });
  const switches = createSwitchState();
  const event = (mapId: string, name: string) => {
    const map = result.project.maps.find((candidate) => candidate.id === mapId)!;
    const found = map.events?.find((candidate) => candidate.name === name);
    expect(found, `${mapId}: ${name}`).toBeDefined();
    return { map, event: found! };
  };
  const guardResults = (
    mapId: string,
    name: string,
    call: string,
    ext: JsonValue,
  ) => {
    const found = event(mapId, name);
    const guards = objectNodes(found.event).filter((node) =>
      node.kind === "ext" && node.call === call
    ) as unknown as Condition[];
    expect(guards).toHaveLength(2);
    return guards.map((guard) => evalCondition(
      guard,
      switches,
      `${found.map.id}/${found.event.id}`,
      undefined,
      { runtime: session.extensions, ext },
    ));
  };
  const commandContext = (ext: JsonValue) => ({
    ext,
    switches: switches.switches,
    variables: switches.variables,
    items: switches.items,
    gold: switches.gold,
    playerName: switches.playerName,
    random: () => 0.5,
  });

  const empty = TUXEMON_EXTENSIONS.initial!;
  const benden = event("spyder_cotton_tunnel", "spyder_dragonscave_benden").event;
  const bendenNodes = objectNodes(benden);
  expect(bendenNodes.some((node) => Array.isArray(node.lines)
    && node.lines.some((line) => String(line).includes("You captured it")))).toBeTrue();
  expect(bendenNodes.some((node) => Array.isArray(node.lines)
    && node.lines.some((line) => String(line).includes("It... escaped")))).toBeTrue();
  expect(guardResults(
    "spyder_cotton_tunnel", "spyder_dragonscave_benden", "tux.has_tuxepedia", empty,
  )).toEqual([false, true]);
  const caught = TUXEMON_EXTENSIONS.commands!["tux.set_tuxepedia"]!(commandContext(empty), {
    character: "player", species: "drokoro", status: "caught",
  })!.ext!;
  expect(guardResults(
    "spyder_cotton_tunnel", "spyder_dragonscave_benden", "tux.has_tuxepedia", caught,
  )).toEqual([true, false]);

  const boy = event("spyder_dryadsgrove", "spyder_dryadsgrove_boy").event;
  const boyNodes = objectNodes(boy);
  expect(boyNodes.some((node) => Array.isArray(node.lines)
    && node.lines.some((line) => String(line).includes("really healthy")))).toBeTrue();
  expect(boyNodes.some((node) => Array.isArray(node.lines)
    && node.lines.some((line) => String(line).includes("rough shape")))).toBeTrue();
  expect(guardResults(
    "spyder_dryadsgrove", "spyder_dryadsgrove_boy", "tux.char_healed", empty,
  )).toEqual([false, true]);
  const healthy = TUXEMON_EXTENSIONS.commands!["tux.add_monster"]!(commandContext(empty), {
    character: "player", species: "nut", level: 5,
  })!.ext!;
  expect(guardResults(
    "spyder_dryadsgrove", "spyder_dryadsgrove_boy", "tux.char_healed", healthy,
  )).toEqual([true, false]);
  const decoded = tuxemonExtensionState(healthy);
  const hurt = {
    ...decoded,
    party: decoded.party.map((monster, index) => index === 0
      ? { ...monster, currentHp: monster.currentHp! - 1 }
      : monster),
  } as unknown as JsonValue;
  expect(guardResults(
    "spyder_dryadsgrove", "spyder_dryadsgrove_boy", "tux.char_healed", hurt,
  )).toEqual([false, true]);
});

test("G6 imports item mutations and conditions through the shared session backpack", () => {
  const result = buildProject(["spyder_citypark", "spyder_timber_town"], G6_IMPORT_OPTIONS);
  const nodes = objectNodes(result.project);
  expect(nodes.some((node) => node.op === "item" && node.item === "tuxeball" && node.set === "add")).toBeTrue();
  expect(nodes.some((node) => node.op === "ext" && node.call === "tux.change_item")).toBeFalse();
  expect(nodes.some((node) => node.kind === "item" && node.id === "gold_pass")).toBeTrue();
  expect(nodes.some((node) => node.kind === "ext" && node.call === "tux.has_item")).toBeFalse();
});

test("G6 emits pending-evolution guards and an explicit confirmation choice", () => {
  const result = buildProject(["spyder_paper_town"], G6_IMPORT_OPTIONS);
  const nodes = objectNodes(result.project);
  expect(nodes.some((node) => node.kind === "ext" && node.call === "tux.check_evolution" &&
    (node.args as { character?: string } | undefined)?.character === "player")).toBeTrue();
  const prompt = nodes.find((node) => node.op === "choices" && node.prompt === "Allow evolution?");
  expect(prompt).toBeDefined();
  expect(nodes.some((node) => node.op === "ext" && node.call === "tux.evolution")).toBeTrue();
  expect(nodes.some((node) => node.op === "ext" && node.call === "tux.cancel_evolution")).toBeTrue();
});

test("G6 emits all eight Spyder double battles as native Battle Processing", () => {
  const result = buildProject(["spyder_route5", "spyder_dragonscave"], G6_IMPORT_OPTIONS);
  const nodes = objectNodes(result.project);
  const doubles = nodes.filter((node) =>
    node.op === "battle" && (node.setup as { fieldSize?: number } | undefined)?.fieldSize === 2
  );
  expect(doubles).toHaveLength(8);
  expect(doubles.every((node) => {
    const setup = node.setup as { kind: string; opponent: string; party?: unknown[] };
    return setup.kind === "trainer" && setup.opponent.startsWith("spyder_") && (setup.party?.length ?? 0) >= 2;
  })).toBeTrue();
  expect(result.report.coverage.actions.rows.find((row) => row.type === "start_double_battle"))
    .toMatchObject({ total: 8, native: 8, degraded: 0, placeholder: 0, dropped: 0 });
});

test("simultaneously eligible route1 automatic events run concurrently and release input (N1)", () => {
  const result = buildProject(["route1"], G6_IMPORT_OPTIONS);
  const projectWithTerrain = applyTerrain(result.project, importTerrain({ mapIds: ["route1"] }).fragment);
  const route = projectWithTerrain.maps[0]!;
  for (const name of ["omnigruntmove", "omnigrunt2move", "omnigrunt3move", "omnigrunt4move"]) {
    expect(route.events?.find((event) => event.name === name)?.pages[0]?.trigger).toBe("parallel");
  }

  const project = {
    ...projectWithTerrain,
    start: { map: "route1", x: 31, y: 25, dir: "down" as const },
  };
  const session = createSession(project, 60, {
    extensions: TUXEMON_EXTENSIONS,
    battle: TUXEMON_BATTLE_RULES,
    scenes: TUXEMON_SCENES,
  });
  let state = startSession(project, session, createSwitchState({
    variables: { "sys.party_size": 1, "v.whoartthou": 5 },
  }));
  let locked = false;
  for (let frame = 0; frame < 12_000; frame++) {
    const modal = state.interp.modal;
    state = stepSession(session, state, {
      buttons: frame < 4 ? BTN_BITS.DOWN : 0,
      confirmEdge: modal ? frame % 2 === 0 : frame === 6,
      cancelEdge: false,
      upEdge: false,
      downEdge: false,
    });
    locked ||= state.interp.inputLocked;
    if (locked && !state.interp.inputLocked) break;
  }
  expect(locked).toBeTrue();
  expect(state.interp.inputLocked).toBeFalse();
  expect(numericVariable(state, "v.completethis")).toBeGreaterThan(0);
  expect(numericVariable(state, "v.left")).toBeGreaterThan(0);
  expect(state.interp.error).toBeUndefined();
});

test("Spyder first-fight win and loss complete equivalently at 60, 30, 20, and 4 Hz", () => {
  const maintainedProject = resolve(ROOT, "dist/project.json");
  const before = readFileSync(maintainedProject);
  const scratchParent = resolve(process.env.G6_SCRATCH_ROOT ?? join(tmpdir(), "pocket-tuxemon"));
  mkdirSync(scratchParent, { recursive: true });
  const isolatedRoot = mkdtempSync(join(scratchParent, "g6-hz-"));
  const transcripts: string[] = [];
  const results: Record<string, unknown>[] = [];
  let firstWin: Record<string, unknown> | undefined;
  const runAt = (hz: number, outcome: "win" | "lose" = "win") => {
    const run = spawnSync(process.execPath, ["tools/smoke-spyder.ts"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, G6_PROJECT_ROOT: isolatedRoot, HZ: String(hz), GB4_OUTCOME: outcome },
      timeout: 30_000,
    });
    if (run.status !== 0) {
      throw new Error(`smoke ${hz} Hz failed\n${run.stdout}\n${run.stderr}`);
    }
    const tag = outcome === "win" ? `${hz}hz` : `lose-${hz}hz`;
    const result = JSON.parse(readFileSync(resolve(isolatedRoot, `dist/journey-spyder-${tag}.json`), "utf8")) as Record<string, unknown>;
    return { run, result };
  };
  try {
    const generated = spawnSync(process.execPath, ["gen-assets.ts"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, G6_OUTPUT_ROOT: isolatedRoot },
      timeout: 120_000,
    });
    if (generated.status !== 0) {
      throw new Error(`isolated G6 cook failed\n${generated.stdout}\n${generated.stderr}`);
    }
    const assetReport = JSON.parse(readFileSync(resolve(isolatedRoot, "data/g6-assets-report.json"), "utf8"));
    expect(assetReport.project).toMatchObject({ maps: 263, options: G6_IMPORT_OPTIONS });

    const beats = (transcript: string) => transcript
      .split("\n")
      // PASS lines can straddle a new map's first autorun text at low host
      // rates because one folded host frame advances both. The observable
      // story sequence and final state must still be identical.
      .filter((line) => /(?:TEXT|PICK|MAP)/.test(line));
    const outcome = (result: Record<string, unknown>) => ({
      map: result.map,
      story: result.story,
      checkpoints: (result.checkpoints as { name: string; map: string; position: [number, number] }[])
        .map(({ name, map, position }) => ({ name, map, ...(name === "route-1" ? {} : { position }) })),
    });
    for (const wanted of ["win", "lose"] as const) {
      transcripts.length = 0;
      results.length = 0;
      for (const hz of [60, 30, 20, 4]) {
        const { run, result } = runAt(hz, wanted);
        expect(run.stdout).not.toContain("FAIL  ");
        expect(run.stdout).toContain("PASS  L rewind crossed back into the active battle");
        expect(run.stdout).toContain("PASS  replaying after L rewind restores the identical result");
        expect(run.stdout).toContain('"map":"spyder_route1"');
        transcripts.push(run.stdout.replace(/\[\s*\d+\]/g, "[frame]"));
        results.push(result);
      }
      if (wanted === "win") {
        expect(beats(transcripts[1]!)).toEqual(beats(transcripts[0]!));
        expect(beats(transcripts[2]!)).toEqual(beats(transcripts[0]!));
        expect(beats(transcripts[3]!)).toEqual(beats(transcripts[0]!));
      } else {
        // Upstream keeps Teleport Faint gated behind SinkState until the
        // first-loss fiber heals the party. The same visible order must hold
        // even when one host frame folds many reference ticks.
        for (const transcript of transcripts) {
          expect(transcript).toContain("As expected! Old models can't compare to new ones!");
          expect(transcript).toContain("I'll heal you up this time, but I'm not a charity.");
          expect(transcript).toContain("FIRST-LOSS spyder_paper_town");
          expect(transcript).toContain("Teleport Faint stayed suppressed during the first-loss cutscene");
          expect(transcript).not.toContain("spyder_paper_town -> spyder_bedroom @3,4");
          expect(transcript).not.toContain("You should heal your monsters before heading off.");
        }
      }
      for (const result of results) {
        expect(result.map).toBe("spyder_route1");
        const [x, y] = result.position as [number, number];
        expect(x).toBe(14);
        // At 4/20/30 Hz one host sample can contain the eight-tick handoff
        // plus the first held north tick; 60 Hz observes the exact landing.
        expect([18, 19]).toContain(y);
      }
      for (const result of results.slice(1)) expect(outcome(result)).toEqual(outcome(results[0]!));
      if (wanted === "win") firstWin = results[0];
    }

    const repeated = runAt(60, "win").result;
    expect(repeated.sha256).toBe(firstWin!.sha256);
    expect(repeated.masks).toEqual(firstWin!.masks);
  } finally {
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
  expect(readFileSync(maintainedProject)).toEqual(before);
}, 300_000);

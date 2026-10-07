// Spectator (NPC-versus-NPC) battle fixture. Boots the real game from
// dist/main.{js,pak} through the PocketJS wasm sim host, then starts a
// spectator battle directly through the battle rules and drives it to
// completion, capturing presentation frames at 480x272 and 960x544.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import battleDbJson from "../data/battle-db.json";
import variableEnumsJson from "../dist/variable-enums.json";
import {
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
  type PendingMonster,
} from "../battle/extension.ts";
import {
  createTuxemonBattleRules,
  tuxemonRuntimeBattleState,
  type SpectatorBattleSetup,
  type VariableEnums,
} from "../battle/runtime.ts";
import { validateBattleDb } from "../importer/battle-schema.ts";
import type { SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { JsonValue } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import {
  bootWorld,
  type SimWorld,
} from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { FIXED_TIME_HOST_GLOBALS } from "../battle/time-weather.ts";

const ROOT = resolve(import.meta.dir, "..");
const DB = validateBattleDb(battleDbJson);
const ENUMS = variableEnumsJson as VariableEnums;

interface BattleSpec {
  id: string;
  fighter: string;
  foe: string;
  fighterParty: PendingMonster[];
  foeParty: PendingMonster[];
}

export type { BattleSpec };

const member = (slug: string, level: number, iid: string): PendingMonster => ({
  iid,
  slug,
  level,
  experienceModifier: 1,
  moneyModifier: 0,
});

const BATTLES: BattleSpec[] = [
  {
    id: "leather-gym-chad-brad",
    fighter: "spyder_leathergym_chad",
    foe: "spyder_leathergym_brad",
    fighterParty: [member("boxali", 24, "txmn-000001")],
    foeParty: [member("sumchon", 24, "txmn-000002")],
  },
  {
    id: "leather-gym-brad-chad",
    fighter: "spyder_leathergym_brad",
    foe: "spyder_leathergym_chad",
    fighterParty: [member("sumchon", 24, "txmn-000001")],
    foeParty: [member("boxali", 24, "txmn-000002")],
  },
  {
    id: "nimrod-zircon-argon",
    fighter: "spyder_nimrod_zircon",
    foe: "spyder_nimrod_argon",
    fighterParty: [member("dark_robo", 30, "txmn-000001")],
    foeParty: [member("chrome_robo", 30, "txmn-000002")],
  },
  {
    id: "taba-cam-zeke",
    fighter: "cam",
    foe: "zeke",
    fighterParty: [member("lambert", 8, "txmn-000001")],
    foeParty: [member("agnidon", 32, "txmn-000002")],
  },
  {
    id: "scoop-reese-arachne",
    fighter: "spyder_scoop_reese",
    foe: "spyder_scoop_arachne",
    fighterParty: [member("rockat", 40, "txmn-000001")],
    foeParty: [
      member("cardiwing", 40, "txmn-000002"),
      member("spighter", 40, "txmn-000003"),
      member("abesnaki", 40, "txmn-000004"),
    ],
  },
];

export { BATTLES };

function enumCode(variable: string, value: string): number {
  const vals = ENUMS[variable];
  const i = vals ? vals.indexOf(value) : -1;
  if (i < 0) throw new Error(`no enum code for ${variable}:${value}`);
  return i + 1;
}

function sessionState(): SessionState {
  const state = (globalThis as typeof globalThis & { __rpgSessionState?: SessionState }).__rpgSessionState;
  if (!state) throw new Error("spectator fixture: GameView did not publish SessionState");
  return state;
}

function startSpectatorBattle(spec: BattleSpec, seed: number) {
  const rules = createTuxemonBattleRules(DB, ENUMS);
  const ext = {
    ...initialTuxemonExtensionState(),
    environment: "grass",
    npcParties: {
      [spec.fighter]: spec.fighterParty.map((m) => ({ ...m })),
      [spec.foe]: spec.foeParty.map((m) => ({ ...m })),
    },
  };
  const setup: SpectatorBattleSetup = {
    kind: "spectate",
    fighter: spec.fighter,
    foe: spec.foe,
    fighterWinnerCode: enumCode("battle_last_winner", spec.fighter),
    foeWinnerCode: enumCode("battle_last_winner", spec.foe),
    fighterLoserCode: enumCode("battle_last_loser", spec.fighter),
    foeLoserCode: enumCode("battle_last_loser", spec.foe),
    fighterTrainerCode: enumCode("battle_last_trainer", spec.fighter),
    foeTrainerCode: enumCode("battle_last_trainer", spec.foe),
    drawCode: enumCode("battle_last_result", "draw"),
    environment: "grass",
    hour: 12,
  };
  const extValue = packTuxemonExtensionState(ext) as JsonValue;
  const started = rules.start(extValue, setup as unknown as JsonValue, seed, {
    ext: extValue,
    switches: {},
    variables: {},
    items: {},
    gold: 0,
    playerName: "Player",
  });
  if (!started) throw new Error(`spectator fixture: battle ${spec.id} failed to start`);
  return { rules, started };
}

export interface SpectatorFrame {
  name: string;
  rgba: Uint8Array;
  width: number;
  height: number;
  hostFrame: number;
}

export interface SpectatorBattleCapture {
  spec: BattleSpec;
  frames: SpectatorFrame[];
  completionWrites: Record<string, number> | undefined;
}

/** Boot the real game and capture one spectator battle's presentation
 *  frames. Exported for the layout pixel assertion test. */
export async function captureBattle(
  spec: BattleSpec,
  viewport: { width: number; height: number },
  lang: "en_US" | "zh_CN" = "en_US",
  seed = 0x12345678,
): Promise<SpectatorBattleCapture> {
  const bundle = join(ROOT, "dist/main");
  if (!existsSync(bundle + ".js") || !existsSync(bundle + ".pak")) {
    throw new Error("spectator fixture: run `bun run build` first");
  }
  // The boot language comes from localStorage (ui/language.ts). Inject a
  // minimal storage so the zh_CN boot loads the Chinese battle names and
  // scene labels; the en_US boot is the default.
  const langStorage = {
    getItem: (key: string) => (key === "pocket-tuxemon/lang" ? (lang === "zh_CN" ? "zh" : "en") : null),
    setItem: () => {},
    removeItem: () => {},
  };
  const world = await bootWorld(bundle, 60, { ...FIXED_TIME_HOST_GLOBALS, localStorage: langStorage }, undefined, viewport);
  // Let the game boot to its start map.
  for (let i = 0; i < 120; i++) {
    world.frame(0, 0x8080);
    for (let t = 0; t < world.ticksPerFrame; t++) world.tick();
  }

  const { started } = startSpectatorBattle(spec, seed);
  const state = sessionState();
  state.scene = {
    kind: "battle",
    fiber: "spectator-fixture",
    state: started.state,
    pausedTicks: 0,
  };
  state.ext = started.ext;

  const frames: SpectatorFrame[] = [];
  let hostFrame = 0;
  const step = (): void => {
    world.frame(0, 0x8080);
    for (let t = 0; t < world.ticksPerFrame; t++) world.tick();
    hostFrame++;
  };
  const capture = (name: string): void => {
    frames.push({
      name,
      rgba: world.render().slice(),
      width: viewport.width,
      height: viewport.height,
      hostFrame,
    });
  };

  // Capture the opening frame (send-out / banner).
  step();
  capture("opening");

  // Capture a technique frame (advance until a technique event is presenting).
  // A short battle (e.g. Lambert L8 vs Agnidon L32) reaches phase "ended"
  // while the presentation is still playing the send-out/decision beats, so
  // the loop runs until the presentation itself is done — not until the
  // battle phase flips — or the technique event is missed entirely.
  for (let i = 0; i < 600; i++) {
    step();
    const rs = tuxemonRuntimeBattleState(sessionState().scene!.state as JsonValue);
    const event = rs.battle.events[rs.eventCursor];
    if (event?.type === "technique" && rs.eventTicks >= 14) {
      capture("technique");
      break;
    }
    if (rs.eventCursor >= rs.battle.events.length) break;
  }

  // Capture a faint frame if the battle lasts long enough.
  for (let i = 0; i < 600; i++) {
    step();
    const rs = tuxemonRuntimeBattleState(sessionState().scene!.state as JsonValue);
    const event = rs.battle.events[rs.eventCursor];
    if (event?.type === "faint" && rs.eventTicks >= 20) {
      capture("faint");
      break;
    }
    if (rs.eventCursor >= rs.battle.events.length) break;
  }

  // Run to completion.
  let completionWrites: Record<string, number> | undefined;
  for (let i = 0; i < 3000; i++) {
    step();
    const scene = sessionState().scene;
    if (!scene || scene.kind !== "battle") break;
    const rs = tuxemonRuntimeBattleState(scene.state as JsonValue);
    if (rs.battle.phase === "ended" && rs.eventCursor >= rs.battle.events.length) {
      // One more step to let the engine process the completion.
      step();
      break;
    }
  }
  // The completion writes land in the session variables.
  const vars = sessionState().interp.sw.variables as Record<string, number>;
  completionWrites = {};
  for (const key of ["v.battle_last_winner", "v.battle_last_loser", "v.battle_last_trainer", "v.battle_last_result"]) {
    if (vars[key] !== undefined) completionWrites[key] = vars[key];
  }

  return { spec, frames, completionWrites };
}

export async function captureSpectatorBattles(
  outDir: string,
  viewport: { width: number; height: number },
  lang: "en_US" | "zh_CN" = "en_US",
): Promise<SpectatorBattleCapture[]> {
  mkdirSync(outDir, { recursive: true });
  const results: SpectatorBattleCapture[] = [];
  for (const spec of BATTLES) {
    const result = await captureBattle(spec, viewport, lang);
    for (const frame of result.frames) {
      const path = join(outDir, `${spec.id}-${frame.name}-${frame.width}x${frame.height}-${lang === "zh_CN" ? "zh" : "en"}.png`);
      writeFileSync(path, encodePNG(frame.rgba, frame.width, frame.height));
    }
    results.push(result);
  }
  return results;
}

// CLI entry: bun tools/spectator-battle-fixture.ts [outdir]
if (import.meta.main) {
  const outDir = process.argv[2] ?? join(ROOT, "reports/spectator-battles");
  const small = await captureSpectatorBattles(outDir, { width: 480, height: 272 });
  const large = await captureSpectatorBattles(outDir, { width: 960, height: 544 });
  const smallZh = await captureSpectatorBattles(outDir, { width: 480, height: 272 }, "zh_CN");
  const largeZh = await captureSpectatorBattles(outDir, { width: 960, height: 544 }, "zh_CN");
  for (const result of [...small, ...large, ...smallZh, ...largeZh]) {
    console.log(`${result.spec.id}: ${result.frames.map((f) => f.name).join(", ")} — writes: ${JSON.stringify(result.completionWrites)}`);
  }
}

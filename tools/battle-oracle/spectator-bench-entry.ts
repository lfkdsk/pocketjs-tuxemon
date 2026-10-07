// QuickJS bench entry for a spectator (NPC-versus-NPC) battle. Bundled by
// tools/bench-spectator-quickjs.sh and evaluated in a bare rquickjs Guest by
// tools/spectator-quickjs-bench.rs. Mirrors tools/battle-oracle/bench-entry.ts
// but drives the runtime's spectator step (auto-advance, no player input).

import battleDbJson from "../../data/battle-db.json";
import enumsJson from "../../dist/variable-enums.json";
import {
  createTuxemonBattleRules,
  tuxemonRuntimeBattleState,
  type SpectatorBattleSetup,
  type VariableEnums,
} from "../../battle/runtime.ts";
import {
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
  type PendingMonster,
} from "../../battle/extension.ts";
import { validateBattleDb } from "../../importer/battle-schema.ts";
import type { JsonValue } from "../../vendor/pocket-rpgkit/src/engine/types.ts";

declare const __benchNow: (() => number) | undefined;
const now = typeof __benchNow === "function" ? __benchNow : () => Date.now();

const db = validateBattleDb(battleDbJson);
const enums = enumsJson as VariableEnums;

const member = (slug: string, level: number, iid: string): PendingMonster => ({
  iid,
  slug,
  level,
  experienceModifier: 1,
  moneyModifier: 0,
});

const enumCode = (variable: string, value: string): number => {
  const vals = enums[variable];
  const i = vals ? vals.indexOf(value) : -1;
  if (i < 0) throw new Error(`no enum code for ${variable}:${value}`);
  return i + 1;
};

function runSpectatorBattle(measure: boolean): { frames: number[]; total: number; turns: number } {
  const rules = createTuxemonBattleRules(db, enums);
  const ext = {
    ...initialTuxemonExtensionState(),
    environment: "grass",
    npcParties: {
      cam: [member("lambert", 8, "txmn-000001")],
      zeke: [member("agnidon", 32, "txmn-000002")],
    },
  };
  const setup: SpectatorBattleSetup = {
    kind: "spectate",
    fighter: "cam",
    foe: "zeke",
    fighterWinnerCode: enumCode("battle_last_winner", "cam"),
    foeWinnerCode: enumCode("battle_last_winner", "zeke"),
    fighterLoserCode: enumCode("battle_last_loser", "cam"),
    foeLoserCode: enumCode("battle_last_loser", "zeke"),
    fighterTrainerCode: enumCode("battle_last_trainer", "cam"),
    foeTrainerCode: enumCode("battle_last_trainer", "zeke"),
    drawCode: enumCode("battle_last_result", "draw"),
    environment: "grass",
    hour: 12,
  };
  const extValue = packTuxemonExtensionState(ext) as JsonValue;
  const started = rules.start(extValue, setup as unknown as JsonValue, 0x12345678, {
    ext: extValue,
    switches: {},
    variables: {},
    items: {},
    gold: 0,
    playerName: "Player",
  });
  if (!started) throw new Error("spectator bench: battle failed to start");

  const frames: number[] = [];
  const totalStart = now();
  let value = started.state;
  let guard = 0;
  for (; guard < 50_000; guard++) {
    const rs = tuxemonRuntimeBattleState(value);
    const completion = rules.done(value);
    if (completion) break;
    const frameStart = now();
    value = rules.step(value, { buttons: 0 }, 15);
    if (measure) frames.push(now() - frameStart);
  }
  if (guard >= 50_000) throw new Error("spectator bench: battle did not finish");
  const rs = tuxemonRuntimeBattleState(value);
  return { frames, total: now() - totalStart, turns: rs.battle.turn };
}

function stats(values: number[]): { mean: number; p95: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    mean: values.reduce((s, v) => s + v, 0) / values.length,
    p95: sorted[Math.ceil((sorted.length - 1) * 0.95)]!,
    max: sorted[sorted.length - 1]!,
  };
}

// Warm up.
for (let i = 0; i < 5; i++) runSpectatorBattle(false);

const frames: number[] = [];
const totals: number[] = [];
let turns = 0;
for (let i = 0; i < 50; i++) {
  const r = runSpectatorBattle(true);
  frames.push(...r.frames);
  totals.push(r.total);
  turns = r.turns;
}

const output = JSON.stringify({
  engine: "PocketJS QuickJS",
  fixture: "spectator cam(lambert L8) vs zeke(agnidon L32) seed=0x12345678",
  battles: totals.length,
  turns,
  activeFrameMs: stats(frames),
  completeBattleMs: stats(totals),
  frameSamples: frames.length,
});
(globalThis as { __out?: string }).__out = output;
if (typeof __benchNow !== "function") console.log(output);

// GP1 fix 1 (non-blocking): isolates the reducer's contribution to the
// battle-exit frame. tools/bench-g6-quickjs.rs measures the exit frame's
// total QuickJS cost (js_ms) as one number; this script replays the
// maintained journey through the production sharded battle path (Bun, not
// QuickJS — this is a relative-share estimate, not a budget gate) and times
// `BattleRules.done()` on the exact state that ends the battle, in
// isolation. The remainder (frame total minus this reducer share) is
// GameView/session scene teardown + map remount + draw, which live in
// vendor/pocket-rpgkit and are out of this task's scope to instrument
// further.
//
// vendor/pocket-rpgkit/src/engine/session.ts's advanceBattleScene steps and
// checks done() in the same tick it clears the scene, so the public
// SessionState never exposes the exact value that satisfied done() — by the
// time a caller observes `scene === null`, that value is gone. This script
// reconstructs it: capture the scene state from the last frame the public
// API still reports "battle", then replay advanceBattleScene's own
// step-then-done call (ticksPerFrame is 1 at this journey's 60 Hz) on that
// captured value plus the next frame's real input.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createProductionTuxemonBattle } from "../battle/production.ts";
import battleRuntimeShell from "../dist/battle-runtime-shell.json";
import type { BattleRuntimeShell } from "../importer/battle-schema.ts";
import { createSession, startSession, stepSession, type SessionInput } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { readShardedProject } from "./generated-project.ts";

const ROOT = resolve(import.meta.dir, "..");
const journey = JSON.parse(readFileSync(join(ROOT, "data/g6-journey.json"), "utf8")) as { masks: number[] };
const { project, repository: maps } = readShardedProject(ROOT);

function input(mask: number, previous: number): SessionInput {
  const pressed = mask & ~previous;
  return {
    buttons: mask,
    confirmEdge: !!(pressed & 0x2000),
    cancelEdge: !!(pressed & 0x4000),
    upEdge: !!(pressed & 0x0010),
    downEdge: !!(pressed & 0x0040),
    leftEdge: !!(pressed & 0x0080),
    rightEdge: !!(pressed & 0x0020),
  };
}

const readEntry = (entry: string) => readFileSync(join(ROOT, "dist", entry));
const { extensions, rules, scenes } = createProductionTuxemonBattle(
  { read: readEntry },
  battleRuntimeShell as unknown as BattleRuntimeShell,
);
const session = createSession(project, 60, { maps, extensions, battle: rules, scenes });

let state = startSession(project, session);
let previous = 0;
let previousBattleState: unknown = null;
let lastBattleValue: unknown = null;
for (let frame = 0; frame < journey.masks.length; frame++) {
  const mask = journey.masks[frame]!;
  const frameInput = input(mask, previous);
  const wasBattle = state.scene?.kind === "battle";
  if (wasBattle) previousBattleState = state.scene!.state;
  state = stepSession(session, state, frameInput);
  if (wasBattle && state.scene === null && lastBattleValue === null) {
    const stepped = rules.step(structuredClone(previousBattleState) as never, frameInput as never, 1);
    if (rules.done(structuredClone(stepped) as never) !== null) lastBattleValue = stepped;
  }
  previous = mask;
}
if (lastBattleValue === null) throw new Error("gp1 exit-frame probe: could not reconstruct the battle-ending state");

const samples: number[] = [];
for (let i = 0; i < 50; i++) {
  const started = performance.now();
  const completion = rules.done(lastBattleValue as never);
  samples.push(performance.now() - started);
  if (i === 0 && completion === null) throw new Error("gp1 exit-frame probe: captured state did not complete the battle");
}
samples.sort((a, b) => a - b);
const median = samples[Math.floor(samples.length / 2)]!;
const p95 = samples[Math.floor(samples.length * 0.95)]!;
console.log(JSON.stringify({
  format: "gp1-exit-frame-probe/v1",
  host: "bun",
  samples: samples.length,
  doneMs: { min: samples[0], median, p95, max: samples[samples.length - 1] },
}));

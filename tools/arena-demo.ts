// Deterministic example client: a random legal-action agent versus normal AI.
// The random-agent stream is derived from the same user-provided 64-hex seed,
// so redirecting this command twice produces the same tape byte-for-byte.

import {
  createArenaBattle,
  isOver,
  observe,
  result,
  stateHash,
  submit,
  tape,
} from "../battle/arena.ts";
import { nextRandom, type RngState } from "../battle/core.ts";
import { sha256Bytes } from "../vendor/pocket-rpgkit/src/engine/map-repository.ts";
import { utf8Encode } from "../vendor/pocket-rpgkit/src/engine/save.ts";

const DEFAULT_SEED = "0123456789abcdef".repeat(4);
const seedFlag = process.argv.find((arg) => arg.startsWith("--seed="));
const seed = seedFlag?.slice("--seed=".length) ?? DEFAULT_SEED;
const digest = sha256Bytes(utf8Encode(`pocket-tuxemon/arena-demo/v1\n${seed.toLowerCase()}`));
const random: RngState = { rng: Number.parseInt(digest.slice(0, 8), 16) >>> 0, rngDraws: 0 };

let battle = createArenaBattle({
  seed,
  format: "single",
  sides: [{ kind: "agent" }, { kind: "ai", difficulty: "normal" }],
});

while (!isOver(battle)) {
  const actions = observe(battle, 0).legalActions;
  if (actions.length === 0) throw new Error("arena demo: agent has no legal action");
  const action = actions[Math.floor(nextRandom(random) * actions.length)]!;
  const submitted = submit(battle, 0, action);
  if (!submitted.ok) throw new Error(`arena demo: action rejected: ${submitted.error}`);
  battle = submitted.battle;
}

console.log(JSON.stringify({
  tape: tape(battle),
  result: result(battle),
  stateHash: stateHash(battle),
}, null, 2));

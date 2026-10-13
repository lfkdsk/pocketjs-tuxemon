// Deterministic end-to-end expedition client. It only chooses actions returned
// by the public legal-action API, validates the resulting provenance records,
// then carries that team into a normal Arena match and emits both recordings.

import {
  createArenaBattle,
  isOver as arenaIsOver,
  observe as observeArena,
  result as arenaResult,
  stateHash,
  submit as submitArena,
  tape as arenaTape,
  validateBattleTape,
  validateTeam,
} from "../battle/arena.ts";
import { nextRandom, type RngState } from "../battle/core.ts";
import {
  applyExpeditionAction,
  checkExpeditionConservation,
  createExpedition,
  legalExpeditionActions,
  observeExpedition,
  type ExpeditionAction,
} from "../battle/expedition.ts";
import { sha256Bytes } from "../vendor/pocket-rpgkit/src/engine/map-repository.ts";
import { utf8Encode } from "../vendor/pocket-rpgkit/src/engine/save.ts";

const DEFAULT_SEED = "0123456789abcdef".repeat(4);
const seedFlag = process.argv.find((argument) => argument.startsWith("--seed="));
const seed = seedFlag?.slice("--seed=".length) ?? DEFAULT_SEED;

function randomStream(domain: string): RngState {
  const digest = sha256Bytes(utf8Encode(
    `pocket-tuxemon/expedition-demo/v1\n${domain}\n${seed.toLowerCase()}\n`,
  ));
  return { rng: Number.parseInt(digest.slice(0, 8), 16) >>> 0, rngDraws: 0 };
}

function chooseExpeditionAction(actions: ExpeditionAction[], random: RngState): ExpeditionAction {
  // Auto battle is one server action. The CLI still demonstrates manual turns
  // later in Arena without filling its expedition recording with battle internals.
  const encounterChoices = actions.filter((action) =>
    action.type === "catch" || action.type === "flee" ||
    (action.type === "battle" && action.mode === "auto")
  );
  const nonTerminal = actions.filter((action) => action.type !== "end");
  const candidates = encounterChoices.length > 0
    ? encounterChoices
    : nonTerminal.length > 0 ? nonTerminal : actions;
  if (candidates.length === 0) throw new Error("expedition demo: no legal action");
  return candidates[Math.floor(nextRandom(random) * candidates.length)]!;
}

const expeditionRandom = randomStream("expedition-policy");
let expedition = createExpedition({
  seed,
  rules: {
    cycle: "persistent",
    stepBudget: 32,
    starter: { species: "rockitten", level: 20 },
  },
});
const expeditionActions: ExpeditionAction[] = [];

while (!expedition.ended) {
  const actions = legalExpeditionActions(expedition);
  const action = chooseExpeditionAction(actions, expeditionRandom);
  const applied = applyExpeditionAction(expedition, action);
  if (!applied.ok) throw new Error(`expedition demo: action rejected: ${applied.error}`);
  expeditionActions.push(action);
  expedition = applied.expedition;
}

const conservation = checkExpeditionConservation(expedition);
if (conservation.length > 0) {
  throw new Error(`expedition demo: conservation failed: ${conservation.join("; ")}`);
}
const teamValidation = validateTeam(expedition.team, {
  minSize: 1,
  maxSize: 5,
  levelCap: expedition.rules.levelCap,
  requiredKind: "expedition",
});
if (!teamValidation.ok) {
  throw new Error(`expedition demo: team validation failed: ${teamValidation.errors.join("; ")}`);
}

let battle = createArenaBattle({
  seed: sha256Bytes(utf8Encode(`pocket-tuxemon/expedition-demo/arena/v1\n${seed}\n`)),
  format: "single",
  sides: [{ kind: "agent", team: expedition.team }, { kind: "ai", difficulty: "normal" }],
  teamRules: {
    minSize: 1,
    maxSize: 5,
    levelCap: expedition.rules.levelCap,
    requiredKind: "expedition",
  },
});
const arenaRandom = randomStream("arena-policy");
while (!arenaIsOver(battle)) {
  const actions = observeArena(battle, 0).legalActions;
  if (actions.length === 0) throw new Error("expedition demo: Arena agent has no legal action");
  const action = actions[Math.floor(nextRandom(arenaRandom) * actions.length)]!;
  const submitted = submitArena(battle, 0, action);
  if (!submitted.ok) throw new Error(`expedition demo: Arena action rejected: ${submitted.error}`);
  battle = submitted.battle;
}

const recording = arenaTape(battle);
validateBattleTape(recording);
console.log(JSON.stringify({
  format: "pocket-tuxemon/expedition-demo/v1",
  expedition: {
    actions: expeditionActions,
    observation: observeExpedition(expedition),
    team: expedition.team,
  },
  arena: {
    tape: recording,
    result: arenaResult(battle),
    stateHash: stateHash(battle),
  },
}, null, 2));

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
  appendExpeditionJournal,
  startExpeditionJournal,
  type ExpeditionJournal,
} from "../battle/expedition-journal.ts";
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
const journalOutFlag = process.argv.find((argument) => argument.startsWith("--journal-out="));
const journalOut = journalOutFlag?.slice("--journal-out=".length);
if (journalOutFlag && !journalOut) throw new Error("expedition demo: --journal-out requires a path");

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
const expeditionCycles: Array<{
  run: number;
  actions: ExpeditionAction[];
  observation: ReturnType<typeof observeExpedition>;
  journal: ExpeditionJournal;
}> = [];

for (let cycle = 0; cycle < 2; cycle++) {
  const cycleActions: ExpeditionAction[] = [];
  let journal = startExpeditionJournal({
    cycle: expedition.rules.cycle,
    stepBudget: expedition.rules.stepBudget,
    levelCap: expedition.rules.levelCap,
    startingArea: expedition.area,
  }, observeExpedition(expedition));
  while (!expedition.ended) {
    const actions = legalExpeditionActions(expedition);
    const action = chooseExpeditionAction(actions, expeditionRandom);
    const applied = applyExpeditionAction(expedition, action);
    if (!applied.ok) throw new Error(`expedition demo: action rejected: ${applied.error}`);
    cycleActions.push(action);
    expeditionActions.push(action);
    expedition = applied.expedition;
    journal = appendExpeditionJournal(journal, action, observeExpedition(expedition));
  }
  expeditionCycles.push({
    run: expedition.run,
    actions: cycleActions,
    observation: observeExpedition(expedition),
    journal,
  });
  if (cycle > 0 || expedition.endReason !== "defeated") break;

  expedition = createExpedition({
    seed: sha256Bytes(utf8Encode(`pocket-tuxemon/expedition-demo/continuation/v1\n${seed}\n`)),
    rules: {
      cycle: "persistent",
      stepBudget: 32,
      levelCap: expedition.rules.levelCap,
      startingArea: expedition.rules.startingArea,
      continuation: expedition,
    },
  });
  const continuedConservation = checkExpeditionConservation(expedition);
  if (continuedConservation.length > 0) {
    throw new Error(`expedition demo: continuation conservation failed: ${continuedConservation.join("; ")}`);
  }
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
if (journalOut) {
  const journal = expeditionCycles.at(-1)?.journal;
  if (!journal) throw new Error("expedition demo: no journal was produced");
  await Bun.write(journalOut, `${JSON.stringify(journal, null, 2)}\n`);
}
console.log(JSON.stringify({
  format: "pocket-tuxemon/expedition-demo/v1",
  expedition: {
    cycles: expeditionCycles,
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

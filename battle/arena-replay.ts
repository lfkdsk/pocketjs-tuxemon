/**
 * Web-replay helpers kept outside the production game entry graph.
 *
 * The replay page imports this module from its own bundle. The normal game
 * does not, so parsing tapes and the Arena database add no ordinary boot or
 * frame cost.
 */

import battleDbJson from "../data/battle-db.json";
import { validateBattleDb } from "../importer/battle-schema.ts";
import {
  ArenaTapeError,
  createArenaReplayStart,
  replay,
  replayArenaPair,
  stateHash,
  validateBattleTape,
  type ArenaBattle,
  type ArenaTapeValidation,
  type BattleTape,
} from "./arena.ts";
import { initialTuxemonExtensionState } from "./extension.ts";
import {
  TUXEMON_BATTLE_STATE_FORMAT,
  type RuntimeBattleState,
} from "./runtime.ts";
import {
  ReplaySourceError,
  assertReplayJsonSize,
  loadReplayJsonText,
  resolveReplayJsonSource,
  type ReplayJsonFetch,
  type ReplayJsonResponse,
  type ReplayJsonSource,
  type ReplayJsonSourcePolicy,
} from "./replay-source.ts";

export const ARENA_REPLAY_MAX_BYTES = 4 * 1024 * 1024;

export type ArenaReplaySource = ReplayJsonSource;
export type ArenaReplayResponse = ReplayJsonResponse;
export type ArenaReplayFetch = ReplayJsonFetch;

export interface PreparedArenaReplay {
  tape: BattleTape;
  initial: ArenaBattle;
  terminalHash: string;
}

const SOURCE_DB = validateBattleDb(battleDbJson);
const ARENA_SOURCE_POLICY: ReplayJsonSourcePolicy = {
  sourceParam: "battleReplay",
  externalParam: "battleReplayExternal",
  maxBytes: ARENA_REPLAY_MAX_BYTES,
  errorPrefix: "battle replay",
};

function replayError(message: string): never {
  throw new ArenaTapeError(`battle replay: ${message}`);
}

/** Resolve the replay query without fetching or evaluating any source text.
 * Cross-origin HTTPS is opt-in through battleReplayExternal=1; it is fetched
 * without credentials and still parsed only as JSON. */
export function resolveArenaReplaySource(search: string, baseUrl: string): ArenaReplaySource {
  try {
    return resolveReplayJsonSource(search, baseUrl, ARENA_SOURCE_POLICY, "tape");
  } catch (error) {
    if (error instanceof ReplaySourceError) throw new ArenaTapeError(error.message);
    throw error;
  }
}

export function parseArenaReplayTape(text: string): BattleTape {
  try {
    assertReplayJsonSize(text, ARENA_SOURCE_POLICY, "tape");
  } catch (error) {
    if (error instanceof ReplaySourceError) throw new ArenaTapeError(error.message);
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    replayError("source is not valid JSON");
  }
  const checked: ArenaTapeValidation = validateBattleTape(value);
  if (!checked.ok) replayError(checked.error);
  return checked.tape;
}

/** Load one bounded JSON tape. Redirects must preserve the source's trust
 * class: same-origin stays same-origin; explicit external input stays HTTPS. */
export async function loadArenaReplayTape(
  search: string,
  baseUrl: string,
  fetcher: ArenaReplayFetch,
): Promise<BattleTape> {
  try {
    return parseArenaReplayTape(await loadReplayJsonText(
      search,
      baseUrl,
      fetcher,
      ARENA_SOURCE_POLICY,
      "tape",
    ));
  } catch (error) {
    if (error instanceof ReplaySourceError) throw new ArenaTapeError(error.message);
    throw error;
  }
}

/** Validate the complete semantic replay before the first frame is shown.
 * The second create keeps the playback cursor at the initial boundary. */
export function prepareArenaReplay(value: unknown): PreparedArenaReplay {
  const checked = validateBattleTape(value);
  if (!checked.ok) throw new ArenaTapeError(checked.error);
  const terminal = replay(checked.tape);
  return {
    tape: checked.tape,
    initial: createArenaReplayStart({ seed: checked.tape.seed, ...checked.tape.config }),
    terminalHash: stateHash(terminal),
  };
}

/** Apply exactly one already-validated simultaneous action pair. */
export function advanceArenaReplay(
  battle: ArenaBattle,
  tape: BattleTape,
  index: number,
): ArenaBattle {
  const pair = tape.actions[index];
  if (!pair) replayError(`turn ${index} is outside the tape`);
  if (battle.turn !== index) replayError(`playback cursor ${battle.turn} does not match turn ${index}`);
  return replayArenaPair(battle, pair, index);
}

/** Project an authoritative Arena boundary into the production battle scene.
 * The view-only copy clears `awaiting` so replay never exposes an interactive
 * command menu; reducer state and the tape remain untouched. */
export function arenaReplayRuntimeState(arena: ArenaBattle): RuntimeBattleState {
  const environment = SOURCE_DB.environments.interior!;
  const techniques = Object.fromEntries(
    [...new Set(arena.core.parties.flat().flatMap((monster) => [
      monster.fallback,
      ...monster.moves.map((move) => move.slug),
    ]))].map((slug) => {
      const technique = SOURCE_DB.techniques[slug]!;
      return [slug, {
        range: technique.range,
        types: [...technique.types],
        messages: technique.messages,
        ...(technique.animation ? { animation: technique.animation } : {}),
      }];
    }),
  );
  return {
    format: TUXEMON_BATTLE_STATE_FORMAT,
    battle: { ...arena.core, awaiting: null },
    ext: initialTuxemonExtensionState(),
    startingGold: 0,
    environment: "interior",
    audio: SOURCE_DB.battleMusic.environments.interior!,
    visuals: {
      environment,
      ui: { hpBar: SOURCE_DB.ui.hpBar, expBar: SOURCE_DB.ui.expBar },
      trainers: {
        player: SOURCE_DB.ui.trainerSheets.adventurer ?? null,
        opponent: SOURCE_DB.npcs.professor?.art ?? null,
      },
      monsters: Object.fromEntries(
        arena.core.parties.flat().map((monster) => [monster.slug, SOURCE_DB.monsters[monster.slug]!.art]),
      ),
      techniques,
      items: {},
      statusIcons: Object.fromEntries(Object.entries(SOURCE_DB.statuses).flatMap(([slug, status]) =>
        status.icon ? [[slug, status.icon] as const] : []
      )),
    },
    presentationRewards: [],
    menu: [],
    menuMode: "root",
    eventCursor: arena.core.events.length,
    eventTicks: 0,
    menuIndex: 0,
  };
}

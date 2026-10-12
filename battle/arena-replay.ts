/**
 * Web-replay helpers kept outside the production game entry graph.
 *
 * The replay page imports this module from its own bundle. The normal game
 * does not, so parsing tapes and the Arena database add no ordinary boot or
 * frame cost.
 */

import battleDbJson from "../data/battle-db.json";
import { validateBattleDb } from "../importer/battle-schema.ts";
import { base64ToBytes } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/src/bytes.ts";
import { utf8Encode } from "../vendor/pocket-rpgkit/src/engine/save.ts";
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

export const ARENA_REPLAY_MAX_BYTES = 4 * 1024 * 1024;

export type ArenaReplaySource =
  | { kind: "inline"; json: string }
  | { kind: "url"; url: string; external: boolean };

export interface ArenaReplayResponse {
  ok: boolean;
  status: number;
  url: string;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}

export type ArenaReplayFetch = (
  url: string,
  init: { credentials: "same-origin" | "omit" },
) => Promise<ArenaReplayResponse>;

export interface PreparedArenaReplay {
  tape: BattleTape;
  initial: ArenaBattle;
  terminalHash: string;
}

const SOURCE_DB = validateBattleDb(battleDbJson);
const JSON_MIME = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/i;

function replayError(message: string): never {
  throw new ArenaTapeError(`battle replay: ${message}`);
}

function checkedJson(text: string): string {
  if (utf8Encode(text).byteLength > ARENA_REPLAY_MAX_BYTES) {
    replayError(`tape exceeds ${ARENA_REPLAY_MAX_BYTES} decoded bytes`);
  }
  return text;
}

async function readResponseJson(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) replayError("source response has no body");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      length += value.byteLength;
      if (length > ARENA_REPLAY_MAX_BYTES) {
        await reader.cancel();
        replayError(`tape exceeds ${ARENA_REPLAY_MAX_BYTES} decoded bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    replayError("source is not valid UTF-8 JSON");
  }
}

function decodeDataUrl(value: string): string {
  const comma = value.indexOf(",");
  if (comma < 0) replayError("malformed data URL");
  const metadata = value.slice(5, comma).split(";");
  if (metadata.shift()?.toLowerCase() !== "application/json") {
    replayError("data URLs must use application/json");
  }
  let base64 = false;
  for (const raw of metadata) {
    const token = raw.toLowerCase();
    if (token === "base64" && !base64) base64 = true;
    else if (token === "charset=utf-8" || token === "charset=utf8") continue;
    else replayError(`unsupported data URL metadata '${raw}'`);
  }
  const payload = value.slice(comma + 1);
  try {
    if (!base64) return checkedJson(decodeURIComponent(payload));
    if (payload.length > Math.ceil(ARENA_REPLAY_MAX_BYTES / 3) * 4 + 4) {
      replayError(`tape exceeds ${ARENA_REPLAY_MAX_BYTES} decoded bytes`);
    }
    const bytes = base64ToBytes(payload);
    if (bytes.byteLength > ARENA_REPLAY_MAX_BYTES) {
      replayError(`tape exceeds ${ARENA_REPLAY_MAX_BYTES} decoded bytes`);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof ArenaTapeError) throw error;
    replayError("data URL is not valid UTF-8 JSON");
  }
}

/** Resolve the replay query without fetching or evaluating any source text.
 * Cross-origin HTTPS is opt-in through battleReplayExternal=1; it is fetched
 * without credentials and still parsed only as JSON. */
export function resolveArenaReplaySource(search: string, baseUrl: string): ArenaReplaySource {
  const params = new URLSearchParams(search);
  const value = params.get("battleReplay");
  if (!value) replayError("missing battleReplay query parameter");
  if (value.slice(0, 5).toLowerCase() === "data:") {
    return { kind: "inline", json: decodeDataUrl(value) };
  }
  let base: URL;
  let url: URL;
  try {
    base = new URL(baseUrl);
    url = new URL(value, base);
  } catch {
    replayError("source URL is malformed");
  }
  if (url.username || url.password || (url.protocol !== "http:" && url.protocol !== "https:")) {
    replayError("source URL must use HTTP(S) without embedded credentials");
  }
  const external = url.origin !== base.origin;
  if (external && params.get("battleReplayExternal") !== "1") {
    replayError("cross-origin source requires battleReplayExternal=1");
  }
  if (external && url.protocol !== "https:") {
    replayError("cross-origin source must use HTTPS");
  }
  return { kind: "url", url: url.href, external };
}

export function parseArenaReplayTape(text: string): BattleTape {
  checkedJson(text);
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
  const source = resolveArenaReplaySource(search, baseUrl);
  if (source.kind === "inline") return parseArenaReplayTape(source.json);
  const response = await fetcher(source.url, {
    credentials: source.external ? "omit" : "same-origin",
  });
  if (!response.ok) replayError(`source request failed with HTTP ${response.status}`);
  let finalUrl: URL;
  try {
    finalUrl = new URL(response.url || source.url);
  } catch {
    replayError("source returned an invalid final URL");
  }
  const base = new URL(baseUrl);
  if (!source.external && finalUrl.origin !== base.origin) {
    replayError("same-origin source redirected across origins");
  }
  if (source.external && finalUrl.protocol !== "https:") {
    replayError("external source redirected away from HTTPS");
  }
  const mime = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim();
  if (!JSON_MIME.test(mime)) replayError("source response must be JSON");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > ARENA_REPLAY_MAX_BYTES) {
    replayError(`tape exceeds ${ARENA_REPLAY_MAX_BYTES} decoded bytes`);
  }
  return parseArenaReplayTape(await readResponseJson(response.body));
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

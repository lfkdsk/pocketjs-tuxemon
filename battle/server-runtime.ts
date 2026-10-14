/**
 * Stable, host-neutral ARENA-1 entry point.
 *
 * Cloud and test hosts should import only this module. Its explicit surface
 * prevents UI/replay presentation helpers and general game runtime APIs from
 * becoming accidental server dependencies.
 */

import { ARENA_VERSION as arenaVersion } from "./arena.ts";

/** Semantic reducer revision. Deployments additionally pin the game gitlink. */
export const SERVER_ENGINE_REVISION = "pocket-tuxemon/arena-engine/v1" as const;
/** Pinned upstream data revision carried by both localized battle databases. */
export const SERVER_DATA_REVISION = "9e6258ff726b786040a267e8bdbbf037b560285e" as const;
/**
 * SHA-256 of canonical JSON containing battle-db.json,
 * battle-db.zh_CN.json, and feature-modes.json.titleBattle, prefixed with
 * `pocket-tuxemon/arena-server-data/v1\n`.
 */
export const SERVER_DATA_DIGEST =
  "49cc9fc9b11899d511689ea9a59169bcaa41c86262f3e46f3b0a25a475e002a3" as const;

export {
  ARENA_DEADLINE_TICKS,
  ARENA_DIFFICULTIES,
  ARENA_MAX_TURNS,
  ARENA_VERSION,
  ArenaTapeError,
  DEFAULT_ARENA_TEAM_RULES,
  createArenaBattle,
  createArenaReplayStart,
  defaultAction,
  isOver,
  observe,
  replay,
  replayArenaPair,
  result,
  stateHash,
  submit,
  tape,
  validateBattleTape,
  validateTeam,
  validateTeamRules,
} from "./arena.ts";

export const SERVER_RUNTIME_IDENTITY = Object.freeze({
  arenaVersion,
  engineRevision: SERVER_ENGINE_REVISION,
  dataRevision: SERVER_DATA_REVISION,
  dataDigest: SERVER_DATA_DIGEST,
});

export type {
  ArenaAction,
  ArenaBattle,
  ArenaConfig,
  ArenaDifficulty,
  ArenaErrorCode,
  ArenaFormat,
  ArenaObservation,
  ArenaProvenanceEvent,
  ArenaResult,
  ArenaResultReason,
  ArenaSide,
  ArenaSideConfig,
  ArenaSubmitResult,
  ArenaTapeConfig,
  ArenaTapeValidation,
  ArenaTeamRecord,
  ArenaTeamRules,
  ArenaTeamValidation,
  BattleTape,
  LocalizedArenaName,
} from "./arena.ts";

/** Strict, revision-pinned Tuxemon Link replay envelopes.
 *
 * This module is used only by the dedicated replay entry. It deliberately
 * keeps transport trust separate from the Arena tape: an otherwise valid
 * terminal override is authoritative only when the fetched response itself
 * ends inside the configured replay origin and path prefix. Production is
 * HTTPS-only; an exact loopback HTTP base is accepted for local development.
 */

import {
  ArenaTapeError,
  replay,
  stateHash,
  validateBattleTape,
  type ArenaBattle,
  type ArenaSide,
  type BattleTape,
} from "./arena.ts";
import {
  ReplaySourceError,
  loadReplayJsonTextWithMetadata,
  type LoadedReplayJsonText,
  type ReplayJsonFetch,
  type ReplayJsonSource,
  type ReplayJsonSourcePolicy,
} from "./replay-source.ts";

export const LINK_REPLAY_KIND = "tux-link-replay" as const;
export const LINK_REPLAY_VERSION = 1 as const;
export const ARENA_REPLAY_MAX_BYTES = 4 * 1024 * 1024;

export const ARENA_REPLAY_SOURCE_POLICY: ReplayJsonSourcePolicy = {
  sourceParam: "battleReplay",
  externalParam: "battleReplayExternal",
  maxBytes: ARENA_REPLAY_MAX_BYTES,
  errorPrefix: "battle replay",
};

export interface LinkReplayIdentity {
  engineRevision: string;
  dataDigest: string;
}

export type LinkTerminalOverride =
  | { winner: ArenaSide; reason: "forfeit"; atTurn: number }
  | { winner: null; reason: "abandoned"; atTurn: number };

export interface LinkReplayEnvelope extends LinkReplayIdentity {
  kind: typeof LINK_REPLAY_KIND;
  v: typeof LINK_REPLAY_VERSION;
  tape: BattleTape;
  preTerminalHash: string;
  terminalOverride?: LinkTerminalOverride;
}

export interface LinkReplayValidationOptions {
  expectedIdentity: LinkReplayIdentity;
  trustedReplayBase: string;
}

export interface LoadedLinkReplayEnvelope {
  envelope: LinkReplayEnvelope;
  source: ReplayJsonSource;
  finalUrl: string | null;
  finalBattle: ArenaBattle;
  terminalHash: string;
  terminalOverride: LinkTerminalOverride | null;
}

export class LinkReplayError extends ArenaTapeError {
  constructor(message: string) {
    super(`link replay: ${message}`);
    this.name = "LinkReplayError";
  }
}

const REVISION = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function linkError(message: string): never {
  throw new LinkReplayError(message);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => allowed.has(key));
}

function terminalOverride(value: unknown): LinkTerminalOverride | null {
  if (!record(value) || !exactKeys(value, ["winner", "reason", "atTurn"]) ||
    !Number.isSafeInteger(value.atTurn) || (value.atTurn as number) < 0) return null;
  if (value.reason === "forfeit" && (value.winner === 0 || value.winner === 1)) {
    return value as unknown as LinkTerminalOverride;
  }
  if (value.reason === "abandoned" && value.winner === null) {
    return value as unknown as LinkTerminalOverride;
  }
  return null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    linkError("source is not valid JSON");
  }
}

/** The final response, rather than the requested URL, decides authority. */
export function isTrustedLinkReplayResponse(
  finalUrl: string | null,
  trustedReplayBase: string,
): boolean {
  if (finalUrl === null) return false;
  let final: URL;
  let trusted: URL;
  try {
    final = new URL(finalUrl);
    trusted = new URL(trustedReplayBase);
  } catch {
    return false;
  }
  const secure = final.protocol === "https:" && trusted.protocol === "https:";
  const local = final.protocol === "http:" && trusted.protocol === "http:" &&
    loopbackHost(final.hostname) && loopbackHost(trusted.hostname);
  if ((!secure && !local) ||
    final.username || final.password || trusted.username || trusted.password ||
    trusted.search || trusted.hash) return false;
  const prefix = trusted.pathname.endsWith("/") ? trusted.pathname : `${trusted.pathname}/`;
  return final.origin === trusted.origin && final.pathname.startsWith(prefix);
}

/** Strictly validate a parsed envelope and its transport provenance. */
export function validateLinkReplayEnvelope(
  value: unknown,
  loaded: Pick<LoadedReplayJsonText, "source" | "finalUrl">,
  options: LinkReplayValidationOptions,
): LoadedLinkReplayEnvelope {
  if (!record(value) || !exactKeys(value, [
    "kind", "v", "engineRevision", "dataDigest", "tape", "preTerminalHash",
  ], ["terminalOverride"])) {
    linkError("envelope must contain only its versioned public fields");
  }
  if (value.kind !== LINK_REPLAY_KIND || value.v !== LINK_REPLAY_VERSION) {
    linkError(`kind/version must be ${LINK_REPLAY_KIND}/v${LINK_REPLAY_VERSION}`);
  }
  if (typeof value.engineRevision !== "string" || !REVISION.test(value.engineRevision)) {
    linkError("engineRevision is invalid");
  }
  if (typeof value.dataDigest !== "string" || !SHA256.test(value.dataDigest)) {
    linkError("dataDigest must be a lowercase SHA-256 digest");
  }
  if (value.engineRevision !== options.expectedIdentity.engineRevision ||
    value.dataDigest !== options.expectedIdentity.dataDigest) {
    linkError("engine/data identity does not match this replay player");
  }
  if (typeof value.preTerminalHash !== "string" || !SHA256.test(value.preTerminalHash)) {
    linkError("preTerminalHash must be a lowercase SHA-256 digest");
  }

  const checked = validateBattleTape(value.tape);
  if (!checked.ok) linkError(checked.error);
  let finalBattle: ArenaBattle;
  try {
    finalBattle = replay(checked.tape);
  } catch (error) {
    linkError(error instanceof Error ? error.message : String(error));
  }
  const terminalHash = stateHash(finalBattle);
  if (value.preTerminalHash !== terminalHash) {
    linkError("preTerminalHash does not match the replayed tape boundary");
  }

  let override: LinkTerminalOverride | null = null;
  if (value.terminalOverride !== undefined) {
    override = terminalOverride(value.terminalOverride);
    if (!override) linkError("terminalOverride has an invalid winner/reason/turn combination");
    if (override.atTurn !== checked.tape.actions.length) {
      linkError("terminalOverride.atTurn must equal the tape action count");
    }
    if (finalBattle.terminal !== null) {
      linkError("a naturally terminal tape must not have terminalOverride");
    }
    if (loaded.source.kind !== "url" ||
      !isTrustedLinkReplayResponse(loaded.finalUrl, options.trustedReplayBase)) {
      linkError("terminalOverride requires a trusted replay response");
    }
  } else if (finalBattle.terminal === null) {
    linkError("a non-terminal tape requires terminalOverride");
  }

  const envelope: LinkReplayEnvelope = {
    kind: LINK_REPLAY_KIND,
    v: LINK_REPLAY_VERSION,
    engineRevision: value.engineRevision,
    dataDigest: value.dataDigest,
    tape: checked.tape,
    preTerminalHash: value.preTerminalHash,
    ...(override === null ? {} : { terminalOverride: override }),
  };
  return {
    envelope,
    source: loaded.source,
    finalUrl: loaded.finalUrl,
    finalBattle,
    terminalHash,
    terminalOverride: override,
  };
}

/** Load and validate only a Tuxemon Link envelope. Raw tapes are handled by
 * the document dispatcher in arena-replay.ts. */
export async function loadLinkReplayEnvelope(
  search: string,
  baseUrl: string,
  fetcher: ReplayJsonFetch,
  options: LinkReplayValidationOptions,
): Promise<LoadedLinkReplayEnvelope> {
  try {
    const loaded = await loadReplayJsonTextWithMetadata(
      search,
      baseUrl,
      fetcher,
      ARENA_REPLAY_SOURCE_POLICY,
      "document",
      options.trustedReplayBase,
    );
    return validateLinkReplayEnvelope(parseJson(loaded.text), loaded, options);
  } catch (error) {
    if (error instanceof ReplaySourceError) throw new LinkReplayError(error.message);
    throw error;
  }
}

function loopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const octets = hostname.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((octet) =>
    /^(0|[1-9][0-9]{0,2})$/.test(octet) && Number(octet) <= 255
  );
}

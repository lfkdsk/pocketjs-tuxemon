/**
 * Frozen Tuxemon Link wire-v1 client contract.
 *
 * This module is deliberately transport- and host-neutral. Every decoder
 * checks the complete public shape instead of casting server JSON, so a new
 * field cannot accidentally expose private battle state to the UI.
 */

import type { ArenaAction, ArenaFormat, ArenaSide } from "./arena.ts";

export const TUX_WIRE_VERSION = 1 as const;
export const TUX_ARENA_VERSION = 1 as const;
export const TUX_CAP_PUBLIC_PRESENTATION_V1 = 1 << 0;
export const TUX_CAP_REPLAY_URL_V1 = 1 << 1;
export const TUX_KNOWN_CAPS =
  TUX_CAP_PUBLIC_PRESENTATION_V1 | TUX_CAP_REPLAY_URL_V1;
export const TUX_SUPPORTED_CAPS = TUX_CAP_PUBLIC_PRESENTATION_V1;
export const TUX_REQUIRED_CAPS = TUX_CAP_PUBLIC_PRESENTATION_V1;
export const TUX_MAX_CLIENT_FRAME_BYTES = 1_024;

export const TUX_REQUEST_ID = /^[A-Za-z0-9_-]{16,64}$/;
export const TUX_MATCH_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{21,63}$/;
export const TUX_INVITE_SECRET = /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{27,64}$/;
export const TUX_PUBLIC_ID = /^p_[A-Za-z0-9_-]{8,62}$/;

const ITEM_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PROTOCOL_REASON = /^[A-Z][A-Z0-9_]{0,63}$/;
const RESULT_REASON = /^[a-z][a-z0-9-]{0,63}$/;
const encoder = new TextEncoder();

export interface TuxCapabilitiesResponse {
  service: "tux-battle";
  enabled: boolean;
  wireV: number;
  arenaV: number;
  caps: number;
  requiredCaps: number;
}

export interface TuxCreateMatchRequest {
  v: typeof TUX_WIRE_VERSION;
  ticket: string;
  requestId: string;
}

export interface TuxCreateMatchSuccess {
  ok: true;
  v: typeof TUX_WIRE_VERSION;
  matchId: string;
  invite: string;
  expiresAtMs: number;
}

export interface TuxCreateMatchFailure {
  ok: false;
  reason: string;
}

export type TuxCreateMatchResponse = TuxCreateMatchSuccess | TuxCreateMatchFailure;

export interface TuxInviteParts {
  matchId: string;
  secret: string;
}

export interface TuxHelloFrame {
  type: "hello";
  v: typeof TUX_WIRE_VERSION;
  caps: number;
  ticket: string;
  requestId: string;
  invite?: string;
}

export interface TuxSubmitFrame {
  type: "submit";
  v: typeof TUX_WIRE_VERSION;
  turnRevision: number;
  requestId: string;
  action: ArenaAction;
}

export type TuxClientFrame = TuxHelloFrame | TuxSubmitFrame;

export interface TuxLocalizedName {
  en_US: string;
  zh_CN: string;
}

export interface TuxPublicStats {
  armour: number;
  dodge: number;
  hp: number;
  melee: number;
  ranged: number;
  speed: number;
}

export type TuxPublicStages = Partial<TuxPublicStats>;

export interface TuxPublicOwnMonster {
  party: number;
  active: boolean;
  species: { slug: string; displayName: TuxLocalizedName };
  level: number;
  hp: { current: number; max: number; percent: number };
  status: string | null;
  types: string[];
  gender: string;
  base: TuxPublicStats;
  stages: TuxPublicStages;
  moves: Array<{
    slot: number;
    slug: string;
    displayName: TuxLocalizedName;
    cooldown: number;
  }>;
}

export interface TuxPublicOpponentMonster {
  position: number;
  species: { slug: string; displayName: TuxLocalizedName };
  level: number;
  hpPercent: number;
  status: string | null;
  revealedMoves: Array<{ slug: string; displayName: TuxLocalizedName }>;
  publicId: string;
}

export type TuxPresentationAction =
  | { type: "move"; move?: string; target?: number }
  | { type: "swap" }
  | { type: "item"; target?: number }
  | { type: "run" };

export interface TuxPublicObservation {
  v: typeof TUX_ARENA_VERSION;
  side: ArenaSide;
  format: ArenaFormat;
  turn: number;
  round: number;
  deadlineTicks: number;
  actingParty: number | null;
  own: {
    active: number[];
    party: TuxPublicOwnMonster[];
  };
  opponent: {
    active: TuxPublicOpponentMonster[];
  };
  legalActions: ArenaAction[];
  result: {
    winner: ArenaSide | null;
    turns: number;
    reason: "knockout" | "draw" | "escape" | "capture" | "turn-limit";
  } | null;
}

export type TuxPublicPresentation = Array<
  | {
    kind: "action";
    actor: "self" | "opponent";
    action: TuxPresentationAction;
  }
  | {
    kind: "hp";
    target: { side: "self"; party: number } | { side: "opponent"; publicId: string };
    percent: number;
    status: string | null;
  }
  | { kind: "result"; winner: "self" | "opponent" | null; reason: string }
>;

export interface TuxWelcomeFrame {
  type: "welcome";
  v: typeof TUX_WIRE_VERSION;
  arenaV: typeof TUX_ARENA_VERSION;
  caps: number;
  side: ArenaSide;
  connectionEpoch: number;
  turnRevision: number;
  deadlineAtMs: number;
  selfSubmitted: boolean;
  observation: TuxPublicObservation;
}

export interface TuxAcceptedFrame {
  type: "accepted";
  v: typeof TUX_WIRE_VERSION;
  turnRevision: number;
  requestId: string;
  selfSubmitted: true;
}

export interface TuxResolvedFrame {
  type: "resolved";
  v: typeof TUX_WIRE_VERSION;
  turnRevision: number;
  deadlineAtMs: number;
  observation: TuxPublicObservation;
  presentation: TuxPublicPresentation;
}

export interface TuxRejectedFrame {
  type: "rejected";
  v: typeof TUX_WIRE_VERSION;
  turnRevision: number;
  requestId: string;
  reason: string;
}

export interface TuxEndedFrame {
  type: "ended";
  v: typeof TUX_WIRE_VERSION;
  turnRevision: number;
  result: { winner: "self" | "opponent" | null; reason: string };
  observation: TuxPublicObservation;
}

export type TuxServerFrame =
  | TuxWelcomeFrame
  | TuxAcceptedFrame
  | TuxResolvedFrame
  | TuxRejectedFrame
  | TuxEndedFrame;

/** Decode the capability document without treating incompatibility as malformed JSON. */
export function decodeTuxCapabilities(value: unknown): TuxCapabilitiesResponse | null {
  const raw = jsonRecord(value);
  if (!raw || !exactKeys(raw, ["service", "enabled", "wireV", "arenaV", "caps", "requiredCaps"]) ||
    raw.service !== "tux-battle" || typeof raw.enabled !== "boolean") return null;
  const wireV = nonNegativeSafeInteger(raw.wireV);
  const arenaV = nonNegativeSafeInteger(raw.arenaV);
  const caps = uint32(raw.caps);
  const requiredCaps = uint32(raw.requiredCaps);
  if (wireV === null || arenaV === null || caps === null || requiredCaps === null) return null;
  if (!raw.enabled && (caps !== 0 || requiredCaps !== 0)) return null;
  return { service: "tux-battle", enabled: raw.enabled, wireV, arenaV, caps, requiredCaps };
}

/** Whether a structurally valid capability document enables this exact client. */
export function supportsTuxLinkV1(value: TuxCapabilitiesResponse): boolean {
  return value.enabled && value.wireV === TUX_WIRE_VERSION && value.arenaV === TUX_ARENA_VERSION &&
    (value.caps & TUX_REQUIRED_CAPS) === TUX_REQUIRED_CAPS &&
    (value.requiredCaps & ~TUX_KNOWN_CAPS) === 0 &&
    (value.requiredCaps & TUX_REQUIRED_CAPS) === value.requiredCaps;
}

export function decodeTuxCreateMatchResponse(value: unknown): TuxCreateMatchResponse | null {
  const raw = jsonRecord(value);
  if (!raw || typeof raw.ok !== "boolean") return null;
  if (!raw.ok) {
    if (!exactKeys(raw, ["ok", "reason"]) || !boundedString(raw.reason, 1, 64)) return null;
    return raw as unknown as TuxCreateMatchFailure;
  }
  if (!exactKeys(raw, ["ok", "v", "matchId", "invite", "expiresAtMs"]) ||
    raw.v !== TUX_WIRE_VERSION || typeof raw.matchId !== "string" || !TUX_MATCH_ID.test(raw.matchId) ||
    typeof raw.invite !== "string" || !positiveSafeInteger(raw.expiresAtMs)) return null;
  const invite = splitTuxInvite(raw.invite);
  if (!invite || invite.matchId !== raw.matchId) return null;
  return raw as unknown as TuxCreateMatchSuccess;
}

export function splitTuxInvite(value: string): TuxInviteParts | null {
  if (typeof value !== "string") return null;
  const dot = value.indexOf(".");
  if (dot <= 0 || dot !== value.lastIndexOf(".")) return null;
  const matchId = value.slice(0, dot);
  const secret = value.slice(dot + 1);
  return TUX_MATCH_ID.test(matchId) && TUX_INVITE_SECRET.test(secret) ? { matchId, secret } : null;
}

export function decodeTuxAction(value: unknown): ArenaAction | null {
  if (!record(value) || typeof value.type !== "string") return null;
  if (value.type === "move") {
    if (!exactKeys(value, ["type", "slot"], ["target"])) return null;
    const slot = boundedInteger(value.slot, 0, 31);
    const target = optionalBoundedInteger(value.target, 0, 31);
    return slot === null || target === null
      ? null
      : { type: "move", slot, ...(target === undefined ? {} : { target }) };
  }
  if (value.type === "swap") {
    if (!exactKeys(value, ["type", "party"])) return null;
    const party = boundedInteger(value.party, 0, 31);
    return party === null ? null : { type: "swap", party };
  }
  if (value.type === "item") {
    if (!exactKeys(value, ["type", "item"], ["target"]) ||
      typeof value.item !== "string" || !ITEM_SLUG.test(value.item)) return null;
    const target = optionalBoundedInteger(value.target, 0, 31);
    return target === null
      ? null
      : { type: "item", item: value.item, ...(target === undefined ? {} : { target }) };
  }
  return value.type === "run" && exactKeys(value, ["type"]) ? { type: "run" } : null;
}

export function decodeTuxPublicObservation(value: unknown): TuxPublicObservation | null {
  if (!record(value) || !exactKeys(value, [
    "v", "side", "format", "turn", "round", "deadlineTicks", "actingParty",
    "own", "opponent", "legalActions", "result",
  ]) || value.v !== TUX_ARENA_VERSION || !arenaSide(value.side) || !arenaFormat(value.format) ||
    nonNegativeSafeInteger(value.turn) === null || nonNegativeSafeInteger(value.round) === null ||
    nonNegativeSafeInteger(value.deadlineTicks) === null ||
    !(value.actingParty === null || boundedInteger(value.actingParty, 0, 31) !== null)) return null;

  const own = decodeOwn(value.own);
  const opponent = decodeOpponent(value.opponent);
  if (!own || !opponent || !Array.isArray(value.legalActions)) return null;
  const legalActions = value.legalActions.map(decodeTuxAction);
  if (legalActions.some((action) => action === null)) return null;
  const result = value.result === null ? null : decodeArenaResult(value.result);
  if (value.result !== null && result === null) return null;
  if (value.actingParty !== null && !own.party.some((monster) => monster.party === value.actingParty)) return null;
  return value as unknown as TuxPublicObservation;
}

export function decodeTuxPublicPresentation(value: unknown): TuxPublicPresentation | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (!record(item) || typeof item.kind !== "string") return null;
    if (item.kind === "action") {
      if (!exactKeys(item, ["kind", "actor", "action"]) ||
        (item.actor !== "self" && item.actor !== "opponent") || !presentationAction(item.action)) return null;
      continue;
    }
    if (item.kind === "hp") {
      if (!exactKeys(item, ["kind", "target", "percent", "status"]) || !presentationTarget(item.target) ||
        !percent(item.percent) || !nullableBoundedString(item.status, 64)) return null;
      continue;
    }
    if (item.kind === "result") {
      if (!exactKeys(item, ["kind", "winner", "reason"]) || !relativeWinner(item.winner) ||
        typeof item.reason !== "string" || !RESULT_REASON.test(item.reason)) return null;
      continue;
    }
    return null;
  }
  return value as TuxPublicPresentation;
}

export function decodeTuxServerFrame(value: unknown): TuxServerFrame | null {
  const raw = jsonRecord(value);
  if (!raw || raw.v !== TUX_WIRE_VERSION || typeof raw.type !== "string") return null;
  if (raw.type === "welcome") {
    if (!exactKeys(raw, [
      "type", "v", "arenaV", "caps", "side", "connectionEpoch", "turnRevision",
      "deadlineAtMs", "selfSubmitted", "observation",
    ]) || raw.arenaV !== TUX_ARENA_VERSION || !arenaSide(raw.side) ||
      !positiveSafeInteger(raw.connectionEpoch) || nonNegativeSafeInteger(raw.turnRevision) === null ||
      !positiveSafeInteger(raw.deadlineAtMs) || typeof raw.selfSubmitted !== "boolean") return null;
    const caps = uint32(raw.caps);
    const observation = decodeTuxPublicObservation(raw.observation);
    if (caps === null || (caps & TUX_REQUIRED_CAPS) !== TUX_REQUIRED_CAPS || !observation ||
      observation.side !== raw.side || observation.turn !== raw.turnRevision || observation.result !== null) return null;
    return raw as unknown as TuxWelcomeFrame;
  }
  if (raw.type === "accepted") {
    return exactKeys(raw, ["type", "v", "turnRevision", "requestId", "selfSubmitted"]) &&
        nonNegativeSafeInteger(raw.turnRevision) !== null && requestId(raw.requestId) && raw.selfSubmitted === true
      ? raw as unknown as TuxAcceptedFrame
      : null;
  }
  if (raw.type === "resolved") {
    if (!exactKeys(raw, ["type", "v", "turnRevision", "deadlineAtMs", "observation", "presentation"]) ||
      nonNegativeSafeInteger(raw.turnRevision) === null || !positiveSafeInteger(raw.deadlineAtMs)) return null;
    const observation = decodeTuxPublicObservation(raw.observation);
    const presentation = decodeTuxPublicPresentation(raw.presentation);
    return observation && observation.turn === raw.turnRevision && observation.result === null && presentation
      ? raw as unknown as TuxResolvedFrame
      : null;
  }
  if (raw.type === "rejected") {
    return exactKeys(raw, ["type", "v", "turnRevision", "requestId", "reason"]) &&
        nonNegativeSafeInteger(raw.turnRevision) !== null && requestId(raw.requestId) &&
        typeof raw.reason === "string" && PROTOCOL_REASON.test(raw.reason)
      ? raw as unknown as TuxRejectedFrame
      : null;
  }
  if (raw.type === "ended") {
    if (!exactKeys(raw, ["type", "v", "turnRevision", "result", "observation"]) ||
      nonNegativeSafeInteger(raw.turnRevision) === null || !endedResult(raw.result)) return null;
    const observation = decodeTuxPublicObservation(raw.observation);
    return observation && observation.turn === raw.turnRevision && observation.result !== null
      ? raw as unknown as TuxEndedFrame
      : null;
  }
  return null;
}

/** Validate and serialize one client frame within the server's 1,024-byte cap. */
export function encodeTuxClientFrame(value: unknown): string {
  const frame = decodeTuxClientFrame(value);
  if (!frame) throw new TypeError("invalid Tux Link client frame");
  const encoded = JSON.stringify(frame);
  if (encoder.encode(encoded).byteLength > TUX_MAX_CLIENT_FRAME_BYTES) {
    throw new RangeError("Tux Link client frame exceeds 1024 bytes");
  }
  return encoded;
}

export function decodeTuxClientFrame(value: unknown): TuxClientFrame | null {
  const raw = jsonRecord(value);
  if (!raw || raw.v !== TUX_WIRE_VERSION || typeof raw.type !== "string") return null;
  if (raw.type === "hello") {
    if (!exactKeys(raw, ["type", "v", "caps", "ticket", "requestId"], ["invite"])) return null;
    const caps = uint32(raw.caps);
    if (caps === null || (caps & TUX_REQUIRED_CAPS) !== TUX_REQUIRED_CAPS ||
      !boundedUtf8String(raw.ticket, 1, 512) || !requestId(raw.requestId) ||
      !(raw.invite === undefined || (typeof raw.invite === "string" && TUX_INVITE_SECRET.test(raw.invite)))) return null;
    return raw as unknown as TuxHelloFrame;
  }
  if (raw.type === "submit") {
    if (!exactKeys(raw, ["type", "v", "turnRevision", "requestId", "action"]) ||
      nonNegativeSafeInteger(raw.turnRevision) === null || !requestId(raw.requestId)) return null;
    const action = decodeTuxAction(raw.action);
    return action ? { ...raw, action } as unknown as TuxSubmitFrame : null;
  }
  return null;
}

function decodeOwn(value: unknown): TuxPublicObservation["own"] | null {
  if (!record(value) || !exactKeys(value, ["active", "party"]) ||
    !Array.isArray(value.active) || !Array.isArray(value.party)) return null;
  const active = value.active.map((entry) => boundedInteger(entry, 0, 31));
  const party = value.party.map(decodeOwnMonster);
  if (active.some((entry) => entry === null) || party.some((entry) => entry === null)) return null;
  const partyIndexes = party.map((entry) => entry!.party);
  if (!unique(partyIndexes) || !unique(active as number[]) ||
    !(active as number[]).every((index) => partyIndexes.includes(index)) ||
    party.some((monster) => monster!.active !== (active as number[]).includes(monster!.party))) return null;
  return value as TuxPublicObservation["own"];
}

function decodeOwnMonster(value: unknown): TuxPublicOwnMonster | null {
  if (!record(value) || !exactKeys(value, [
    "party", "active", "species", "level", "hp", "status", "types", "gender", "base", "stages", "moves",
  ]) || boundedInteger(value.party, 0, 31) === null || typeof value.active !== "boolean" ||
    !species(value.species) || nonNegativeFinite(value.level) === null || !ownHp(value.hp) ||
    !nullableBoundedString(value.status, 64) || !stringArray(value.types, 64) ||
    !boundedString(value.gender, 1, 64) || !stats(value.base) || !stages(value.stages) ||
    !Array.isArray(value.moves) || !value.moves.every(ownMove)) return null;
  const slots = value.moves.map((move) => (move as { slot: number }).slot);
  return unique(slots) ? value as unknown as TuxPublicOwnMonster : null;
}

function decodeOpponent(value: unknown): TuxPublicObservation["opponent"] | null {
  if (!record(value) || !exactKeys(value, ["active"]) || !Array.isArray(value.active) ||
    !value.active.every(opponentMonster)) return null;
  const rows = value.active as unknown as TuxPublicOpponentMonster[];
  return unique(rows.map((monster) => monster.position)) && unique(rows.map((monster) => monster.publicId))
    ? value as TuxPublicObservation["opponent"]
    : null;
}

function opponentMonster(value: unknown): boolean {
  return record(value) && exactKeys(value, [
    "position", "species", "level", "hpPercent", "status", "revealedMoves", "publicId",
  ]) && boundedInteger(value.position, 0, 31) !== null && species(value.species) &&
    nonNegativeFinite(value.level) !== null && percent(value.hpPercent) &&
    nullableBoundedString(value.status, 64) && Array.isArray(value.revealedMoves) &&
    value.revealedMoves.every(revealedMove) && typeof value.publicId === "string" && TUX_PUBLIC_ID.test(value.publicId);
}

function ownMove(value: unknown): boolean {
  return record(value) && exactKeys(value, ["slot", "slug", "displayName", "cooldown"]) &&
    boundedInteger(value.slot, 0, 31) !== null && boundedString(value.slug, 1, 64) &&
    localizedName(value.displayName) && nonNegativeFinite(value.cooldown) !== null;
}

function revealedMove(value: unknown): boolean {
  return record(value) && exactKeys(value, ["slug", "displayName"]) &&
    boundedString(value.slug, 1, 64) && localizedName(value.displayName);
}

function species(value: unknown): boolean {
  return record(value) && exactKeys(value, ["slug", "displayName"]) &&
    boundedString(value.slug, 1, 64) && localizedName(value.displayName);
}

function localizedName(value: unknown): boolean {
  return record(value) && exactKeys(value, ["en_US", "zh_CN"]) &&
    boundedString(value.en_US, 1, 256) && boundedString(value.zh_CN, 1, 256);
}

function ownHp(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, ["current", "max", "percent"])) return false;
  const current = nonNegativeFinite(value.current);
  const max = positiveFinite(value.max);
  return current !== null && max !== null && current <= max && percent(value.percent);
}

const STAT_KEYS = ["armour", "dodge", "hp", "melee", "ranged", "speed"] as const;

function stats(value: unknown): boolean {
  return record(value) && exactKeys(value, STAT_KEYS) && STAT_KEYS.every((key) => finiteNumber(value[key]));
}

function stages(value: unknown): boolean {
  return record(value) && exactKeys(value, [], STAT_KEYS) && Object.values(value).every(finiteNumber);
}

function decodeArenaResult(value: unknown): TuxPublicObservation["result"] {
  if (!record(value) || !exactKeys(value, ["winner", "turns", "reason"]) ||
    !(value.winner === null || arenaSide(value.winner)) || nonNegativeSafeInteger(value.turns) === null ||
    !(["knockout", "draw", "escape", "capture", "turn-limit"] as unknown[]).includes(value.reason)) return null;
  return value as unknown as Exclude<TuxPublicObservation["result"], null>;
}

function presentationAction(value: unknown): boolean {
  if (!record(value) || typeof value.type !== "string") return false;
  if (value.type === "move") {
    return exactKeys(value, ["type"], ["move", "target"]) &&
      (value.move === undefined || boundedString(value.move, 1, 64)) &&
      (value.target === undefined || boundedInteger(value.target, 0, 31) !== null);
  }
  if (value.type === "item") {
    return exactKeys(value, ["type"], ["target"]) &&
      (value.target === undefined || boundedInteger(value.target, 0, 31) !== null);
  }
  return (value.type === "swap" || value.type === "run") && exactKeys(value, ["type"]);
}

function presentationTarget(value: unknown): boolean {
  if (!record(value) || typeof value.side !== "string") return false;
  if (value.side === "self") {
    return exactKeys(value, ["side", "party"]) && boundedInteger(value.party, 0, 31) !== null;
  }
  return value.side === "opponent" && exactKeys(value, ["side", "publicId"]) &&
    typeof value.publicId === "string" && TUX_PUBLIC_ID.test(value.publicId);
}

function endedResult(value: unknown): boolean {
  return record(value) && exactKeys(value, ["winner", "reason"]) && relativeWinner(value.winner) &&
    typeof value.reason === "string" && RESULT_REASON.test(value.reason);
}

function relativeWinner(value: unknown): boolean {
  return value === "self" || value === "opponent" || value === null;
}

function arenaSide(value: unknown): value is ArenaSide {
  return value === 0 || value === 1;
}

function arenaFormat(value: unknown): value is ArenaFormat {
  return value === "single" || value === "double";
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return record(value) ? value : null;
  try {
    const parsed: unknown = JSON.parse(value);
    return record(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return Object.keys(value).every((key) => allowed.has(key)) && required.every((key) => key in value);
}

function requestId(value: unknown): value is string {
  return typeof value === "string" && TUX_REQUEST_ID.test(value);
}

function boundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function boundedUtf8String(value: unknown, min: number, maxBytes: number): value is string {
  return typeof value === "string" && value.length >= min && encoder.encode(value).byteLength <= maxBytes;
}

function nullableBoundedString(value: unknown, max: number): boolean {
  return value === null || boundedString(value, 1, max);
}

function stringArray(value: unknown, maxItemLength: number): value is string[] {
  return Array.isArray(value) && value.every((item) => boundedString(item, 1, maxItemLength));
}

function uint32(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff
    ? value
    : null;
}

function nonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function boundedInteger(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function optionalBoundedInteger(value: unknown, min: number, max: number): number | null | undefined {
  return value === undefined ? undefined : boundedInteger(value, min, max);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeFinite(value: unknown): number | null {
  return finiteNumber(value) && value >= 0 ? value : null;
}

function positiveFinite(value: unknown): number | null {
  return finiteNumber(value) && value > 0 ? value : null;
}

function percent(value: unknown): boolean {
  return finiteNumber(value) && value >= 0 && value <= 100;
}

function unique<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}

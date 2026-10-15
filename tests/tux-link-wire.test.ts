import { describe, expect, test } from "bun:test";
import {
  TUX_CAP_PUBLIC_PRESENTATION_V1,
  decodeTuxAction,
  decodeTuxCapabilities,
  decodeTuxCreateMatchResponse,
  decodeTuxPublicObservation,
  decodeTuxPublicPresentation,
  decodeTuxServerFrame,
  encodeTuxClientFrame,
  splitTuxInvite,
  supportsTuxLinkV1,
  type TuxCreateMatchSuccess,
  type TuxPublicObservation,
  type TuxWelcomeFrame,
} from "../battle/tux-link-wire.ts";

const MATCH = "m_0123456789abcdefghijkl";
const SECRET = "ABCDEFGHJKMNPQRSTVWXYZ23456789ABCDE";

function observation(side: 0 | 1 = 0): TuxPublicObservation {
  return {
    v: 1,
    side,
    format: "single",
    turn: 7,
    round: 8,
    deadlineTicks: 1_800,
    actingParty: 0,
    own: {
      active: [0],
      party: [{
        party: 0,
        active: true,
        species: { slug: "agnite", displayName: { en_US: "Agnite", zh_CN: "火苗" } },
        level: 20,
        hp: { current: 30, max: 40, percent: 75 },
        status: null,
        types: ["fire"],
        gender: "male",
        base: { armour: 10, dodge: 11, hp: 40, melee: 12, ranged: 13, speed: 14 },
        stages: { speed: 1 },
        moves: [{
          slot: 0,
          slug: "fireball",
          displayName: { en_US: "Fire Ball", zh_CN: "火球" },
          cooldown: 0,
        }],
      }],
    },
    opponent: {
      active: [
        {
          position: 0,
          species: { slug: "rockitten", displayName: { en_US: "Rockitten", zh_CN: "岩猫" } },
          level: 20,
          hpPercent: 90,
          status: null,
          revealedMoves: [],
          publicId: "p_opponent_alpha",
        },
        {
          position: 1,
          species: { slug: "rockitten", displayName: { en_US: "Rockitten", zh_CN: "岩猫" } },
          level: 20,
          hpPercent: 80,
          status: "burned",
          revealedMoves: [{ slug: "ram", displayName: { en_US: "Ram", zh_CN: "冲撞" } }],
          publicId: "p_opponent_beta",
        },
      ],
    },
    legalActions: [{ type: "move", slot: 0 }],
    result: null,
  };
}

describe("Tux Link wire v1 capabilities and invite", () => {
  test("separates structural capability decoding from compatibility", () => {
    const current = decodeTuxCapabilities({
      service: "tux-battle",
      enabled: true,
      wireV: 1,
      arenaV: 1,
      caps: 0x8000_0000 + TUX_CAP_PUBLIC_PRESENTATION_V1,
      requiredCaps: 1,
    });
    expect(current).not.toBeNull();
    expect(supportsTuxLinkV1(current!)).toBe(true);

    const oldWire = decodeTuxCapabilities({ ...current, wireV: 0 });
    const wrongArena = decodeTuxCapabilities({ ...current, arenaV: 2 });
    expect(oldWire && supportsTuxLinkV1(oldWire)).toBe(false);
    expect(wrongArena && supportsTuxLinkV1(wrongArena)).toBe(false);
    expect(decodeTuxCapabilities({ ...current, caps: undefined })).toBeNull();
    expect(decodeTuxCapabilities({ ...current, privateState: true })).toBeNull();
    expect(decodeTuxCapabilities({ ...current, enabled: false, caps: 1, requiredCaps: 0 })).toBeNull();
  });

  test("strictly decodes create responses and splits only canonical invites", () => {
    const invite = `${MATCH}.${SECRET}`;
    const success: TuxCreateMatchSuccess = {
      ok: true,
      v: 1,
      matchId: MATCH,
      invite,
      expiresAtMs: 1_700_000_600_000,
    };
    expect(decodeTuxCreateMatchResponse(success)).toEqual(success);
    expect(splitTuxInvite(invite)).toEqual({ matchId: MATCH, secret: SECRET });
    expect(splitTuxInvite(`${invite}.extra`)).toBeNull();
    expect(decodeTuxCreateMatchResponse({ ...success, matchId: `${MATCH}x` })).toBeNull();
    expect(decodeTuxCreateMatchResponse({ ...success, ticket: "private" })).toBeNull();
    expect(decodeTuxCreateMatchResponse({ ok: false, reason: "auth" })).toEqual({ ok: false, reason: "auth" });
    expect(decodeTuxCreateMatchResponse({ ok: false, reason: "auth", detail: "private" })).toBeNull();
  });
});

describe("Tux Link wire v1 battle documents", () => {
  test("accepts duplicate species only when recipient-scoped public ids remain distinct", () => {
    const value = observation();
    expect(decodeTuxPublicObservation(value)).toEqual(value);
    const duplicateId = structuredClone(value);
    duplicateId.opponent.active[1]!.publicId = duplicateId.opponent.active[0]!.publicId;
    expect(decodeTuxPublicObservation(duplicateId)).toBeNull();
  });

  test("rejects unknown nested fields and private identity leakage", () => {
    const withUid = structuredClone(observation()) as ReturnType<typeof observation> & {
      opponent: { active: Array<Record<string, unknown>> };
    };
    withUid.opponent.active[0]!.uid = 42;
    expect(decodeTuxPublicObservation(withUid)).toBeNull();

    const withReserve = structuredClone(observation()) as ReturnType<typeof observation> & {
      opponent: Record<string, unknown>;
    };
    withReserve.opponent.reserve = [{ species: "secret" }];
    expect(decodeTuxPublicObservation(withReserve)).toBeNull();

    expect(decodeTuxPublicPresentation([{
      kind: "hp",
      target: { side: "opponent", publicId: "p_opponent_alpha", uid: 42 },
      percent: 50,
      status: null,
    }])).toBeNull();
    expect(decodeTuxPublicPresentation([{
      kind: "action",
      actor: "opponent",
      action: { type: "move", move: "ram", damage: 17 },
    }])).toBeNull();
    expect(decodeTuxPublicPresentation([{
      kind: "action",
      actor: "opponent",
      action: { type: "run", move: "private-move" },
    }])).toBeNull();
  });

  test("strictly validates all five server frame variants", () => {
    const welcome: TuxWelcomeFrame = {
      type: "welcome",
      v: 1,
      arenaV: 1,
      caps: 1,
      side: 0,
      connectionEpoch: 3,
      turnRevision: 7,
      deadlineAtMs: 1_700_000_030_000,
      selfSubmitted: false,
      observation: observation(),
    };
    expect(decodeTuxServerFrame(JSON.stringify(welcome))).toEqual(welcome);
    expect(decodeTuxServerFrame({ ...welcome, v: 0 })).toBeNull();
    expect(decodeTuxServerFrame({ ...welcome, arenaV: 2 })).toBeNull();
    expect(decodeTuxServerFrame({ ...welcome, caps: 0 })).toBeNull();
    expect(decodeTuxServerFrame({ ...welcome, uid: 42 })).toBeNull();

    expect(decodeTuxServerFrame({
      type: "accepted", v: 1, turnRevision: 7,
      requestId: "submit_request_0001", selfSubmitted: true,
    })?.type).toBe("accepted");
    expect(decodeTuxServerFrame({
      type: "rejected", v: 1, turnRevision: 7,
      requestId: "submit_request_0001", reason: "STALE",
    })?.type).toBe("rejected");

    const next = { ...structuredClone(observation()), turn: 8, round: 9 };
    expect(decodeTuxServerFrame({
      type: "resolved", v: 1, turnRevision: 8, deadlineAtMs: 1_700_000_060_000,
      observation: next,
      presentation: [
        { kind: "action", actor: "self", action: { type: "move", move: "fireball" } },
        { kind: "hp", target: { side: "opponent", publicId: "p_opponent_alpha" }, percent: 50, status: null },
      ],
    })?.type).toBe("resolved");

    const terminal = {
      ...structuredClone(next),
      result: { winner: 0, turns: 8, reason: "knockout" },
      legalActions: [],
      actingParty: null,
    };
    expect(decodeTuxServerFrame({
      type: "ended", v: 1, turnRevision: 8,
      result: { winner: "self", reason: "battle-complete" }, observation: terminal,
    })?.type).toBe("ended");
    expect(decodeTuxServerFrame({
      type: "ended", v: 1, turnRevision: 8,
      result: { winner: "self", reason: "battle-complete", replayUrl: "https://private.example" },
      observation: terminal,
    })).toBeNull();
  });

  test("rejects malformed actions and validates outbound frames", () => {
    expect(decodeTuxAction({ type: "move", slot: 0 })).toEqual({ type: "move", slot: 0 });
    expect(decodeTuxAction({ type: "swap", party: 2 })).toEqual({ type: "swap", party: 2 });
    expect(decodeTuxAction({ type: "item", item: "potion", target: 1 })).toEqual({
      type: "item", item: "potion", target: 1,
    });
    expect(decodeTuxAction({ type: "run" })).toEqual({ type: "run" });
    for (const malformed of [
      { type: "move", slot: -1 },
      { type: "move", slot: 32 },
      { type: "move", slot: 0, uid: 4 },
      { type: "swap", party: 0, target: 1 },
      { type: "item", item: "Potion!" },
      { type: "run", seed: "private" },
      { type: "dance" },
    ]) expect(decodeTuxAction(malformed)).toBeNull();

    const hello = {
      type: "hello", v: 1, caps: 1,
      ticket: "opaque-ticket", requestId: "hello_request_0001",
    };
    expect(JSON.parse(encodeTuxClientFrame(hello))).toEqual(hello);
    expect(() => encodeTuxClientFrame({ ...hello, caps: 0 })).toThrow();
    expect(() => encodeTuxClientFrame({ ...hello, side: 0 })).toThrow();
    expect(() => encodeTuxClientFrame({
      type: "submit", v: 1, turnRevision: 7,
      requestId: "submit_request_0001", action: { type: "move", slot: -1 },
    })).toThrow();
  });
});

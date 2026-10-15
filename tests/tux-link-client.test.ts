import { describe, expect, test } from "bun:test";
import type {
  PocketSocket,
  SocketCloseEvent,
  SocketError,
  SocketOptions,
  SocketReadyState,
} from "@pocketjs/framework/socket";

import type { TuxPublicObservation } from "../battle/tux-link-wire.ts";
import {
  TuxLinkClient,
  isTrustedTuxReplayUrl,
  tuxLinkReplayPageUrl,
  type TuxLinkFetch,
  type TuxLinkHttpResponse,
} from "../ui/tux-link/client.ts";
import { tuxLinkBattleViewModel } from "../ui/tux-link/presentation.ts";

const CONFIG = {
  httpBase: "https://battle.example/prefix/",
  wsBase: "wss://battle.example/prefix/",
  trustedReplayBase: "https://battle.example/prefix/tux/v1/replays/",
};
const MATCH = "m_0123456789abcdefghijkl";
const SECRET = "ABCDEFGHJKMNPQRSTVWXYZ23456789ABCDE";
const INVITE = `${MATCH}.${SECRET}`;

function observation(turn = 7, result: TuxPublicObservation["result"] = null): TuxPublicObservation {
  return {
    v: 1,
    side: 0,
    format: "single",
    turn,
    round: turn + 1,
    deadlineTicks: 1_800,
    actingParty: result ? null : 0,
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
        stages: {},
        moves: [{
          slot: 0,
          slug: "fireball",
          displayName: { en_US: "Fire Ball", zh_CN: "火球" },
          cooldown: 0,
        }],
      }],
    },
    opponent: {
      active: [{
        position: 0,
        species: { slug: "rockitten", displayName: { en_US: "Rockitten", zh_CN: "岩猫" } },
        level: 20,
        hpPercent: 90,
        status: null,
        revealedMoves: [],
        publicId: "p_opponent_alpha",
      }, {
        position: 1,
        species: { slug: "rockitten", displayName: { en_US: "Rockitten", zh_CN: "岩猫" } },
        level: 20,
        hpPercent: 80,
        status: null,
        revealedMoves: [],
        publicId: "p_opponent_beta",
      }],
    },
    legalActions: result ? [] : [{ type: "move", slot: 0 }, { type: "swap", party: 1 }],
    result,
  };
}

class MockSocket implements PocketSocket {
  readonly url: string;
  readonly protocol = "";
  readyState: SocketReadyState = "connecting";
  onOpen?: () => void;
  onMessage?: (data: string | Uint8Array) => void;
  onError?: (error: SocketError) => void;
  onClose?: (event: SocketCloseEvent) => void;
  readonly sent: string[] = [];

  constructor(url: string) {
    this.url = url;
  }

  send(data: string | Uint8Array | ArrayBuffer): boolean {
    if (this.readyState !== "open") throw new Error("not open");
    this.sent.push(typeof data === "string" ? data : "<binary>");
    return true;
  }

  close(code = 1000, reason = ""): void {
    this.readyState = "closed";
    this.onClose?.({ code, reason, clean: code === 1000 });
  }

  open(): void {
    this.readyState = "open";
    this.onOpen?.();
  }

  message(value: unknown): void {
    this.onMessage?.(JSON.stringify(value));
  }

  serverClose(code: number, reason: string): void {
    this.readyState = "closed";
    this.onClose?.({ code, reason, clean: false });
  }
}

function response(url: string, value: unknown, status = 200): TuxLinkHttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    async json<T = unknown>() { return value as T; },
  };
}

function fixture(capabilities: unknown = {
  service: "tux-battle",
  enabled: true,
  wireV: 1,
  arenaV: 1,
  caps: 1,
  requiredCaps: 1,
}) {
  const sockets: MockSocket[] = [];
  const requests: Array<{ url: string; body: unknown }> = [];
  const ids = [
    "create_request_0001",
    "hello_request_00001",
    "submit_request_0001",
    "hello_request_00002",
  ];
  let now = 1_700_000_000_000;
  const fetcher: TuxLinkFetch = async (url, options) => {
    requests.push({ url, body: options?.body ? JSON.parse(String(options.body)) : null });
    if (url.endsWith("/capabilities")) return response(url, capabilities);
    return response(url, {
      ok: true,
      v: 1,
      matchId: MATCH,
      invite: INVITE,
      expiresAtMs: now + 600_000,
    });
  };
  const consumed: number[] = [];
  const created: string[] = [];
  const client = new TuxLinkClient({
    config: CONFIG,
    fetch: fetcher,
    socketFactory: (url: string, _options?: SocketOptions) => {
      const socket = new MockSocket(url);
      sockets.push(socket);
      return socket;
    },
    now: () => now,
    requestId: () => ids.shift()!,
    onInviteConsumed: () => { consumed.push(1); },
    onInviteCreated: (match) => { created.push(match.invite); },
  });
  return {
    client,
    sockets,
    requests,
    consumed,
    created,
    advance(ms: number) { now += ms; },
  };
}

function welcome(selfSubmitted = false, connectionEpoch = 1, caps = 1) {
  return {
    type: "welcome",
    v: 1,
    arenaV: 1,
    caps,
    side: 0,
    connectionEpoch,
    turnRevision: 7,
    deadlineAtMs: 1_700_000_030_000,
    selfSubmitted,
    observation: observation(),
  };
}

describe("Tux Link client", () => {
  test("fails closed on missing or incompatible capability documents", async () => {
    const absent = new TuxLinkClient({ config: null });
    expect(await absent.probe()).toBe(false);
    expect(absent.state().capability.kind).toBe("unconfigured");

    for (const caps of [
      { service: "tux-battle", enabled: true, wireV: 0, arenaV: 1, caps: 1, requiredCaps: 1 },
      { service: "tux-battle", enabled: true, wireV: 1, arenaV: 2, caps: 1, requiredCaps: 1 },
      { service: "tux-battle", enabled: true, wireV: 1, arenaV: 1, caps: 0, requiredCaps: 0 },
      { service: "tux-battle", enabled: true, wireV: 1, arenaV: 1, caps: 1, requiredCaps: 4 },
    ]) {
      const f = fixture(caps);
      expect(await f.client.probe(), JSON.stringify(caps)).toBe(false);
      expect(f.client.state().capability.kind).toBe("unavailable");
    }
  });

  test("creates, shares, and connects without putting secrets in the URL", async () => {
    const f = fixture();
    expect(await f.client.probe()).toBe(true);
    expect(f.client.enter("opaque-ticket")).toBe(true);
    expect(await f.client.createMatch()).toBe(true);

    expect(f.requests[1]).toEqual({
      url: `${CONFIG.httpBase}tux/v1/matches`,
      body: { v: 1, ticket: "opaque-ticket", requestId: "create_request_0001" },
    });
    expect(f.created).toEqual([INVITE]);
    expect(f.sockets[0]!.url).toBe(`${CONFIG.wsBase}ws/tux/v1?match=${MATCH}`);
    expect(f.sockets[0]!.url).not.toContain(SECRET);
    expect(f.sockets[0]!.url).not.toContain("opaque-ticket");

    f.sockets[0]!.open();
    expect(JSON.parse(f.sockets[0]!.sent[0]!)).toEqual({
      type: "hello",
      v: 1,
      caps: 3,
      ticket: "opaque-ticket",
      requestId: "hello_request_00001",
    });
    expect(f.client.state().phase).toBe("waiting");
  });

  test("redeems an invite once and fences duplicate submit edges", async () => {
    const f = fixture();
    await f.client.probe();
    expect(f.client.enter("opaque-ticket", INVITE)).toBe(true);
    const socket = f.sockets[0]!;
    socket.open();
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ invite: SECRET });

    socket.message(welcome());
    expect(f.consumed).toEqual([1]);
    expect(f.client.state().phase).toBe("decision");
    expect(f.client.selectAction(1)).toBe(true);
    expect(f.client.state().actionIndex).toBe(1);
    expect(f.client.selectAction(99)).toBe(false);
    expect(f.client.submitSelected()).toBe(true);
    expect(f.client.submitSelected()).toBe(false);
    expect(socket.sent).toHaveLength(2);
    expect(f.client.state().submitPending).toBe(true);
    const submit = JSON.parse(socket.sent[1]!);

    socket.message({
      type: "accepted",
      v: 1,
      turnRevision: 7,
      requestId: submit.requestId,
      selfSubmitted: true,
    });
    expect(f.client.state()).toMatchObject({ phase: "submitted", selfSubmitted: true, submitPending: false });
  });

  test("keeps opponent-pending state byte-identical and applies sanitized resolution separately", async () => {
    const f = fixture();
    await f.client.probe();
    f.client.enter("opaque-ticket", INVITE);
    const socket = f.sockets[0]!;
    socket.open();
    socket.message(welcome());
    const before = JSON.stringify(f.client.state());

    // The server sends no frame for the opponent's private pending action.
    expect(JSON.stringify(f.client.state())).toBe(before);

    socket.message({
      type: "resolved",
      v: 1,
      turnRevision: 8,
      deadlineAtMs: 1_700_000_060_000,
      observation: observation(8),
      presentation: [{
        kind: "hp",
        target: { side: "opponent", publicId: "p_opponent_beta" },
        percent: 70,
        status: null,
      }],
    });
    expect(f.client.state()).toMatchObject({ phase: "decision", turnRevision: 8, presentationTicks: 60 });
    expect(f.client.state().presentation).toHaveLength(1);
  });

  test("reconnects with a fresh local generation and trusts the returned connection epoch", async () => {
    const f = fixture();
    await f.client.probe();
    f.client.enter("opaque-ticket", INVITE);
    const first = f.sockets[0]!;
    first.open();
    first.message(welcome(false, 3));
    expect(f.client.state().connectionEpoch).toBe(3);

    first.serverClose(1006, "network");
    expect(f.client.state().phase).toBe("reconnecting");
    f.advance(1_000);
    f.client.tick();
    const second = f.sockets[1]!;
    second.open();
    second.message(welcome(true, 4));
    expect(f.client.state()).toMatchObject({
      phase: "submitted",
      connectionEpoch: 4,
      selfSubmitted: true,
      reconnectAttempt: 0,
    });

    // Old callbacks were detached and cannot overwrite the new snapshot.
    first.message(welcome(false, 2));
    expect(f.client.state().connectionEpoch).toBe(4);
  });

  test("renders duplicate species by public ref and ends without inventing a replay link", async () => {
    const model = tuxLinkBattleViewModel(observation(), [], "en_US");
    expect(model.opponent.map((monster) => monster.key)).toEqual([
      "opponent:p_opponent_alpha",
      "opponent:p_opponent_beta",
    ]);

    const f = fixture();
    await f.client.probe();
    f.client.enter("opaque-ticket", INVITE);
    const socket = f.sockets[0]!;
    socket.open();
    socket.message(welcome());
    socket.message({
      type: "ended",
      v: 1,
      turnRevision: 8,
      result: { winner: "self", reason: "knockout" },
      observation: observation(8, { winner: 0, turns: 8, reason: "knockout" }),
    });
    expect(f.client.state()).toMatchObject({
      phase: "ended",
      result: { winner: "self", reason: "knockout" },
      replayUrl: null,
    });
  });

  test("accepts replay links only with the negotiated bit and exact trusted HTTPS prefix", async () => {
    const replayUrl = `${CONFIG.trustedReplayBase}match-1?expires=1&signature=opaque`;
    expect(isTrustedTuxReplayUrl(replayUrl, CONFIG.trustedReplayBase)).toBe(true);
    expect(isTrustedTuxReplayUrl(
      "http://127.0.0.1:8787/tux/v1/replays/match-1?exp=1&sig=opaque",
      "http://127.0.0.1:8787/tux/v1/replays/",
    )).toBe(true);
    expect(isTrustedTuxReplayUrl(
      "http://127.0.0.1:8788/tux/v1/replays/match-1?exp=1&sig=opaque",
      "http://127.0.0.1:8787/tux/v1/replays/",
    )).toBe(false);
    const pageUrl = tuxLinkReplayPageUrl(replayUrl, "https://game.example/pocket-tuxemon/index.html?old=1");
    const target = new URL(pageUrl);
    expect(target.pathname).toBe("/pocket-tuxemon/replay.html");
    expect(target.searchParams.get("battleReplay")).toBe(replayUrl);
    expect(target.searchParams.get("battleReplayExternal")).toBe("1");
    expect(target.searchParams.has("old")).toBe(false);
    for (const unsafe of [
      "http://battle.example/prefix/tux/v1/replays/match-1",
      "https://battle.example/prefix/tux/v1/replays-evil/match-1",
      "https://evil.example/prefix/tux/v1/replays/match-1",
      "https://user@battle.example/prefix/tux/v1/replays/match-1",
      "https://battle.example/prefix/tux/v1/replays/%2foutside",
      "https://battle.example/prefix/tux/v1/replays/%2Foutside",
      "https://battle.example/prefix/tux/v1/replays/%5coutside",
      "https://battle.example/prefix/tux/v1/replays/%5Coutside",
      `${replayUrl}#fragment`,
      ` ${replayUrl}`,
    ]) {
      expect(isTrustedTuxReplayUrl(unsafe, CONFIG.trustedReplayBase)).toBe(false);
    }

    const capabilities = {
      service: "tux-battle",
      enabled: true,
      wireV: 1,
      arenaV: 1,
      caps: 3,
      requiredCaps: 1,
    };
    const accepted = fixture(capabilities);
    await accepted.client.probe();
    accepted.client.enter("opaque-ticket", INVITE);
    const acceptedSocket = accepted.sockets[0]!;
    acceptedSocket.open();
    expect(JSON.parse(acceptedSocket.sent[0]!).caps).toBe(3);
    acceptedSocket.message(welcome(false, 1, 3));
    acceptedSocket.message({
      type: "ended",
      v: 1,
      turnRevision: 8,
      result: { winner: "self", reason: "knockout" },
      observation: observation(8, { winner: 0, turns: 8, reason: "knockout" }),
      replayUrl,
    });
    expect(accepted.client.state()).toMatchObject({ phase: "ended", replayUrl });

    const missingBit = fixture();
    await missingBit.client.probe();
    missingBit.client.enter("opaque-ticket", INVITE);
    const missingBitSocket = missingBit.sockets[0]!;
    missingBitSocket.open();
    missingBitSocket.message(welcome());
    missingBitSocket.message({
      type: "ended",
      v: 1,
      turnRevision: 8,
      result: { winner: "self", reason: "knockout" },
      observation: observation(8, { winner: 0, turns: 8, reason: "knockout" }),
      replayUrl,
    });
    expect(missingBit.client.state()).toMatchObject({
      phase: "error",
      replayUrl: null,
      error: "replay-capability-not-negotiated",
    });

    const overNegotiated = fixture();
    await overNegotiated.client.probe();
    overNegotiated.client.enter("opaque-ticket", INVITE);
    const overNegotiatedSocket = overNegotiated.sockets[0]!;
    overNegotiatedSocket.open();
    overNegotiatedSocket.message(welcome(false, 1, 3));
    expect(overNegotiated.client.state()).toMatchObject({
      phase: "error",
      replayUrl: null,
      error: "invalid-capability-negotiation",
    });

    const wrongPath = fixture(capabilities);
    await wrongPath.client.probe();
    wrongPath.client.enter("opaque-ticket", INVITE);
    const wrongPathSocket = wrongPath.sockets[0]!;
    wrongPathSocket.open();
    wrongPathSocket.message(welcome(false, 1, 3));
    wrongPathSocket.message({
      type: "ended",
      v: 1,
      turnRevision: 8,
      result: { winner: "self", reason: "knockout" },
      observation: observation(8, { winner: 0, turns: 8, reason: "knockout" }),
      replayUrl: "https://battle.example/prefix/tux/v1/replays-evil/match-1",
    });
    expect(wrongPath.client.state()).toMatchObject({
      phase: "error",
      replayUrl: null,
      error: "untrusted-replay-url",
    });
  });
});

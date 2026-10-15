import { describe, expect, test } from "bun:test";

import {
  createArenaBattle,
  replay,
  stateHash,
  tape,
  type BattleTape,
} from "../battle/arena.ts";
import {
  ARENA_REPLAY_MAX_BYTES,
  loadArenaReplayDocument,
  type ArenaReplayResponse,
} from "../battle/arena-replay.ts";
import {
  LINK_REPLAY_KIND,
  loadLinkReplayEnvelope,
  type LinkReplayEnvelope,
  type LinkReplayValidationOptions,
  type LinkTerminalOverride,
} from "../battle/tux-link-replay.ts";

const SEED = "0123456789abcdef".repeat(4);
const PLAYER = "https://game.example/pocket-tuxemon/replay.html";
const TRUSTED_BASE = "https://battle.example/gateway/tux/v1/replays/";
const REPLAY_URL = `${TRUSTED_BASE}match-1?expires=1700000000&signature=opaque`;
const EXPECTED = {
  engineRevision: "pocket-tuxemon/arena-engine/v1",
  dataDigest: "4".repeat(64),
} as const;
const OPTIONS: LinkReplayValidationOptions = {
  expectedIdentity: EXPECTED,
  trustedReplayBase: TRUSTED_BASE,
};

function unfinishedTape(): BattleTape {
  return tape(createArenaBattle({
    seed: SEED,
    format: "single",
    sides: [{ kind: "agent" }, { kind: "agent" }],
  }));
}

function naturallyTerminalTape(): BattleTape {
  return tape(createArenaBattle({
    seed: SEED,
    format: "single",
    sides: [
      { kind: "ai", difficulty: "beginner" },
      { kind: "ai", difficulty: "beginner" },
    ],
  }));
}

function envelope(
  recording: BattleTape,
  terminalOverride?: LinkTerminalOverride,
): LinkReplayEnvelope {
  return {
    kind: LINK_REPLAY_KIND,
    v: 1,
    ...EXPECTED,
    tape: recording,
    preTerminalHash: stateHash(replay(recording)),
    ...(terminalOverride === undefined ? {} : { terminalOverride }),
  };
}

function response(
  body: string,
  overrides: Partial<ArenaReplayResponse> = {},
): ArenaReplayResponse {
  return {
    ok: true,
    status: 200,
    url: REPLAY_URL,
    headers: { get: (name) => name.toLowerCase() === "content-type" ? "application/json" : null },
    body: new Blob([body]).stream(),
    ...overrides,
  };
}

function externalQuery(url = REPLAY_URL): string {
  return `?battleReplay=${encodeURIComponent(url)}&battleReplayExternal=1`;
}

function inlineQuery(value: unknown): string {
  const data = `data:application/json,${encodeURIComponent(JSON.stringify(value))}`;
  return `?battleReplay=${encodeURIComponent(data)}`;
}

describe("Tux Link replay document dispatch", () => {
  test("keeps kind-less raw BattleTape input backward compatible", async () => {
    const recording = naturallyTerminalTape();
    const loaded = await loadArenaReplayDocument(
      inlineQuery(recording),
      PLAYER,
      async () => { throw new Error("inline input must not fetch"); },
      OPTIONS,
    );
    expect(loaded.kind).toBe("raw");
    expect(loaded.tape).toEqual(recording);
    expect(loaded.source.kind).toBe("inline");
    expect(loaded.finalUrl).toBeNull();
  });

  test("dispatches only the exact tux-link-replay/v1 kind", async () => {
    for (const value of [
      { ...naturallyTerminalTape(), kind: "future-replay" },
      { ...naturallyTerminalTape(), kind: null },
    ]) {
      await expect(loadArenaReplayDocument(
        inlineQuery(value), PLAYER, async () => response(""), OPTIONS,
      )).rejects.toThrow("unsupported replay document kind");
    }

    const wrongVersion = { ...envelope(naturallyTerminalTape()), v: 2 };
    await expect(loadArenaReplayDocument(
      inlineQuery(wrongVersion), PLAYER, async () => response(""), OPTIONS,
    )).rejects.toThrow("kind/version");

    const missingKind = structuredClone(envelope(naturallyTerminalTape())) as unknown as Record<string, unknown>;
    delete missingKind.kind;
    await expect(loadArenaReplayDocument(
      inlineQuery(missingKind), PLAYER, async () => response(""), OPTIONS,
    )).rejects.toThrow("battle tape must contain only");
  });

  test("accepts a naturally terminal envelope without granting inline authority", async () => {
    const recording = naturallyTerminalTape();
    const loaded = await loadArenaReplayDocument(
      inlineQuery(envelope(recording)),
      PLAYER,
      async () => { throw new Error("inline input must not fetch"); },
      OPTIONS,
    );
    expect(loaded.kind).toBe(LINK_REPLAY_KIND);
    if (loaded.kind !== LINK_REPLAY_KIND) throw new Error("unexpected raw document");
    expect(loaded.tape).toEqual(recording);
    expect(loaded.terminalHash).toBe(stateHash(replay(recording)));
    expect(loaded.terminalOverride).toBeNull();
  });
});

describe("Tux Link replay envelope semantics", () => {
  test("loads a trusted terminal override, preserves final URL, and omits credentials", async () => {
    const recording = unfinishedTape();
    const value = envelope(recording, { winner: 1, reason: "forfeit", atTurn: 0 });
    const calls: Array<{ url: string; credentials: string }> = [];
    const loaded = await loadLinkReplayEnvelope(
      externalQuery(),
      PLAYER,
      async (url, init) => {
        calls.push({ url, credentials: init.credentials });
        return response(JSON.stringify(value), {
          url: `${TRUSTED_BASE}canonical/match-1?signature=redirected`,
        });
      },
      OPTIONS,
    );
    expect(calls).toEqual([{ url: REPLAY_URL, credentials: "omit" }]);
    expect(loaded.source).toEqual({ kind: "url", url: REPLAY_URL, external: true });
    expect(loaded.finalUrl).toBe(`${TRUSTED_BASE}canonical/match-1?signature=redirected`);
    expect(loaded.terminalOverride).toEqual({ winner: 1, reason: "forfeit", atTurn: 0 });
    expect(loaded.terminalHash).toBe(value.preTerminalHash);
  });

  test("requires the exact expected engine revision and data digest", async () => {
    const base = envelope(naturallyTerminalTape());
    for (const value of [
      { ...base, engineRevision: "pocket-tuxemon/arena-engine/v2" },
      { ...base, dataDigest: "5".repeat(64) },
      { ...base, dataDigest: "A".repeat(64) },
    ]) {
      await expect(loadArenaReplayDocument(
        inlineQuery(value), PLAYER, async () => response(""), OPTIONS,
      )).rejects.toThrow(/identity|dataDigest/);
    }
  });

  test("rejects identity/private fields at every strict document boundary", async () => {
    const base = envelope(naturallyTerminalTape());
    const topLevel = { ...base, githubId: "123" };
    const tapeLeak = structuredClone(base) as unknown as {
      tape: Record<string, unknown>;
    };
    tapeLeak.tape.ticket = "private";
    const overrideLeak = envelope(unfinishedTape(), { winner: null, reason: "abandoned", atTurn: 0 }) as
      LinkReplayEnvelope & { terminalOverride: Record<string, unknown> };
    overrideLeak.terminalOverride.accountId = "private";

    for (const value of [topLevel, tapeLeak, overrideLeak]) {
      await expect(loadArenaReplayDocument(
        externalQuery(), PLAYER, async () => response(JSON.stringify(value)), OPTIONS,
      )).rejects.toThrow();
    }
  });

  test("verifies pre-terminal hash, override turn, and natural-terminal exclusion", async () => {
    const unfinished = unfinishedTape();
    const wrongHash = {
      ...envelope(unfinished, { winner: null, reason: "abandoned", atTurn: 0 }),
      preTerminalHash: "0".repeat(64),
    };
    const wrongTurn = envelope(unfinished, { winner: 0, reason: "forfeit", atTurn: 1 });
    const naturalOverride = envelope(
      naturallyTerminalTape(),
      { winner: 0, reason: "forfeit", atTurn: naturallyTerminalTape().actions.length },
    );
    const missingOverride = envelope(unfinished);

    for (const [value, message] of [
      [wrongHash, "preTerminalHash"],
      [wrongTurn, "action count"],
      [naturalOverride, "naturally terminal"],
      [missingOverride, "requires terminalOverride"],
    ] as const) {
      await expect(loadArenaReplayDocument(
        externalQuery(), PLAYER, async () => response(JSON.stringify(value)), OPTIONS,
      )).rejects.toThrow(message);
    }
  });

  test("accepts only controlled winner/reason pairs", async () => {
    const recording = unfinishedTape();
    const invalid = [
      { winner: null, reason: "forfeit", atTurn: 0 },
      { winner: 0, reason: "abandoned", atTurn: 0 },
      { winner: 0, reason: "grace", atTurn: 0 },
      { winner: 2, reason: "forfeit", atTurn: 0 },
      { winner: 0, reason: "forfeit", atTurn: -1 },
    ];
    for (const terminalOverride of invalid) {
      const value = { ...envelope(recording), terminalOverride };
      await expect(loadArenaReplayDocument(
        externalQuery(), PLAYER, async () => response(JSON.stringify(value)), OPTIONS,
      )).rejects.toThrow("invalid winner/reason/turn");
    }
  });
});

describe("Tux Link replay source authority", () => {
  const authoritative = () => envelope(
    unfinishedTape(),
    { winner: null, reason: "abandoned", atTurn: 0 },
  );

  test("rejects terminal overrides from inline documents", async () => {
    await expect(loadArenaReplayDocument(
      inlineQuery(authoritative()),
      PLAYER,
      async () => { throw new Error("inline input must not fetch"); },
      OPTIONS,
    )).rejects.toThrow("trusted replay response");
  });

  test("fails closed when a redirect leaves the trusted origin or path prefix", async () => {
    for (const finalUrl of [
      "https://evil.example/gateway/tux/v1/replays/match-1",
      "https://battle.example/gateway/tux/v1/replays-evil/match-1",
      "https://battle.example/gateway/tux/v1/replays/%2foutside",
      "https://battle.example/gateway/tux/v1/replays/%2Foutside",
      "https://battle.example/gateway/tux/v1/replays/%5coutside",
      "https://battle.example/gateway/tux/v1/replays/%5Coutside",
    ]) {
      await expect(loadArenaReplayDocument(
        externalQuery(),
        PLAYER,
        async () => response(JSON.stringify(authoritative()), { url: finalUrl }),
        OPTIONS,
      )).rejects.toThrow("trusted replay response");
    }

    await expect(loadArenaReplayDocument(
      externalQuery(),
      PLAYER,
      async () => response(JSON.stringify(authoritative()), {
        url: "http://battle.example/gateway/tux/v1/replays/match-1",
      }),
      OPTIONS,
    )).rejects.toThrow("external source redirected away from HTTPS");
  });

  test("fails closed when fetch does not expose an absolute final response URL", async () => {
    for (const finalUrl of ["", "/gateway/tux/v1/replays/match-1"]) {
      await expect(loadArenaReplayDocument(
        externalQuery(),
        PLAYER,
        async () => response(JSON.stringify(authoritative()), { url: finalUrl }),
        OPTIONS,
      )).rejects.toThrow(/final URL/);
    }
  });

  test("requires JSON MIME and enforces the shared 4 MiB stream bound", async () => {
    await expect(loadArenaReplayDocument(
      externalQuery(),
      PLAYER,
      async () => response(JSON.stringify(authoritative()), {
        headers: { get: () => "text/html" },
      }),
      OPTIONS,
    )).rejects.toThrow("must be JSON");

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(ARENA_REPLAY_MAX_BYTES));
        controller.enqueue(new Uint8Array([0x20]));
        controller.close();
      },
    });
    await expect(loadArenaReplayDocument(
      externalQuery(),
      PLAYER,
      async () => response("", { body }),
      OPTIONS,
    )).rejects.toThrow(`exceeds ${ARENA_REPLAY_MAX_BYTES}`);
  });

  test("permits only the configured loopback HTTP origin and path in local development", async () => {
    const localBase = "http://127.0.0.1:8787/tux/v1/replays/";
    const localUrl = `${localBase}r_local/${"a".repeat(64)}.json?exp=1&sig=opaque`;
    const localOptions: LinkReplayValidationOptions = {
      expectedIdentity: EXPECTED,
      trustedReplayBase: localBase,
    };
    const loaded = await loadArenaReplayDocument(
      externalQuery(localUrl),
      "http://127.0.0.1:4173/replay.html",
      async (_url, init) => {
        expect(init.credentials).toBe("omit");
        return response(JSON.stringify(authoritative()), { url: localUrl });
      },
      localOptions,
    );
    expect(loaded.kind).toBe(LINK_REPLAY_KIND);

    for (const unsafe of [
      localUrl.replace("/tux/v1/replays/", "/tux/v1/replays-evil/"),
      localUrl.replace("/tux/v1/replays/", "/tux/v1/replays/%2foutside/"),
      localUrl.replace("/tux/v1/replays/", "/tux/v1/replays/%5Coutside/"),
      localUrl.replace("127.0.0.1:8787", "127.0.0.1:8788"),
      localUrl.replace("127.0.0.1", "public.example"),
    ]) {
      await expect(loadArenaReplayDocument(
        externalQuery(unsafe),
        "http://127.0.0.1:4173/replay.html",
        async () => { throw new Error("unsafe local URL must not fetch"); },
        localOptions,
      )).rejects.toThrow();
    }
  });
});

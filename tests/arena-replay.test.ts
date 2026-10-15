import { describe, expect, test } from "bun:test";

import {
  createArenaBattle,
  defaultAction,
  replay,
  stateHash,
  submit,
  tape,
  type BattleTape,
} from "../battle/arena.ts";
import {
  advanceArenaReplay,
  ARENA_REPLAY_MAX_BYTES,
  arenaReplayRuntimeState,
  loadArenaReplayDocument,
  loadArenaReplayTape,
  parseArenaReplayTape,
  prepareArenaReplay,
  resolveArenaReplaySource,
  type ArenaReplayResponse,
} from "../battle/arena-replay.ts";
import { tuxemonRuntimeBattleState } from "../battle/runtime.ts";

const SEED = "0123456789abcdef".repeat(4);
const BASE = "https://game.example/pocket-tuxemon/replay.html";
const DOCUMENT_OPTIONS = {
  expectedIdentity: {
    engineRevision: "pocket-tuxemon/arena-engine/v1",
    dataDigest: "4".repeat(64),
  },
  trustedReplayBase: "https://battle.example/tux/v1/replays/",
};

function oneTurnTape(): BattleTape {
  const battle = createArenaBattle({
    seed: SEED,
    format: "single",
    sides: [{ kind: "agent" }, { kind: "ai", difficulty: "normal" }],
  });
  const submitted = submit(battle, 0, defaultAction(battle, 0));
  if (!submitted.ok) throw new Error(submitted.error);
  return tape(submitted.battle);
}

function response(
  body: string,
  overrides: Partial<ArenaReplayResponse> = {},
): ArenaReplayResponse {
  return {
    ok: true,
    status: 200,
    url: "https://game.example/pocket-tuxemon/tape.json",
    headers: { get: (name) => name.toLowerCase() === "content-type" ? "application/json" : null },
    body: new Blob([body]).stream(),
    ...overrides,
  };
}

describe("Arena web replay input", () => {
  test("accepts bounded application/json data URLs in percent and base64 form", () => {
    const json = JSON.stringify(oneTurnTape());
    const percent = resolveArenaReplaySource(`?battleReplay=${encodeURIComponent(`data:application/json,${encodeURIComponent(json)}`)}`, BASE);
    expect(percent).toEqual({ kind: "inline", json });

    const encoded = Buffer.from(json).toString("base64");
    const base64 = resolveArenaReplaySource(
      `?battleReplay=${encodeURIComponent(`data:application/json;charset=utf-8;base64,${encoded}`)}`,
      BASE,
    );
    expect(base64).toEqual({ kind: "inline", json });
    expect(parseArenaReplayTape(base64.kind === "inline" ? base64.json : "")).toEqual(oneTurnTape());
  });

  test("allows relative same-origin JSON and requires an explicit HTTPS opt-in cross-origin", () => {
    expect(resolveArenaReplaySource("?battleReplay=tapes/match.json", BASE)).toEqual({
      kind: "url",
      url: "https://game.example/pocket-tuxemon/tapes/match.json",
      external: false,
    });
    expect(() => resolveArenaReplaySource("?battleReplay=https%3A%2F%2Fother.example%2Ftape.json", BASE))
      .toThrow("battleReplayExternal=1");
    expect(resolveArenaReplaySource(
      "?battleReplay=https%3A%2F%2Fother.example%2Ftape.json&battleReplayExternal=1",
      BASE,
    )).toEqual({ kind: "url", url: "https://other.example/tape.json", external: true });
    for (const source of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,%3Cscript%3Ealert(1)%3C/script%3E",
      "http://other.example/tape.json",
    ]) {
      expect(() => resolveArenaReplaySource(
        `?battleReplay=${encodeURIComponent(source)}&battleReplayExternal=1`,
        BASE,
      )).toThrow();
    }
  });

  test("fetches JSON with the correct credentials and rejects MIME or redirect trust changes", async () => {
    const json = JSON.stringify(oneTurnTape());
    const calls: Array<{ url: string; credentials: string }> = [];
    const loaded = await loadArenaReplayTape("?battleReplay=tape.json", BASE, async (url, init) => {
      calls.push({ url, credentials: init.credentials });
      return response(json);
    });
    expect(loaded).toEqual(oneTurnTape());
    expect(calls).toEqual([{
      url: "https://game.example/pocket-tuxemon/tape.json",
      credentials: "same-origin",
    }]);

    await expect(loadArenaReplayTape("?battleReplay=tape.json", BASE, async () => response(json, {
      url: "https://other.example/tape.json",
    }))).rejects.toThrow("redirected across origins");
    await expect(loadArenaReplayTape("?battleReplay=tape.json", BASE, async () => response(json, {
      headers: { get: () => "text/html" },
    }))).rejects.toThrow("must be JSON");
  });

  test("the document loader preserves URL source and final response metadata for raw tapes", async () => {
    const json = JSON.stringify(oneTurnTape());
    const sourceUrl = "https://other.example/tape.json";
    const finalUrl = "https://cdn.example/replays/tape.json?signature=opaque";
    const loaded = await loadArenaReplayDocument(
      `?battleReplay=${encodeURIComponent(sourceUrl)}&battleReplayExternal=1`,
      BASE,
      async (_url, init) => {
        expect(init.credentials).toBe("omit");
        return response(json, { url: finalUrl });
      },
      DOCUMENT_OPTIONS,
    );
    expect(loaded.kind).toBe("raw");
    expect(loaded.source).toEqual({ kind: "url", url: sourceUrl, external: true });
    expect(loaded.finalUrl).toBe(finalUrl);
    expect(loaded.tape).toEqual(oneTurnTape());
  });

  test("bounds a chunked response before allocating or parsing the complete body", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(ARENA_REPLAY_MAX_BYTES));
        controller.enqueue(new Uint8Array([0x20]));
        controller.close();
      },
    });
    await expect(loadArenaReplayTape("?battleReplay=tape.json", BASE, async () => response("", {
      headers: { get: (name) => name.toLowerCase() === "content-type" ? "application/json" : null },
      body,
    }))).rejects.toThrow(`exceeds ${ARENA_REPLAY_MAX_BYTES}`);
  });

  test("validates before playback and advances one simultaneous pair at a time", () => {
    const recording = oneTurnTape();
    const prepared = prepareArenaReplay(recording);
    expect(prepared.initial.turn).toBe(0);
    const advanced = advanceArenaReplay(prepared.initial, prepared.tape, 0);
    expect(advanced.turn).toBe(1);
    expect(stateHash(advanced)).toBe(stateHash(replay(recording)));
    expect(stateHash(advanced)).toBe(prepared.terminalHash);

    const runtime = arenaReplayRuntimeState(advanced);
    expect(() => tuxemonRuntimeBattleState(runtime as never)).not.toThrow();
    expect(runtime.battle.awaiting).toBeNull();
    expect(runtime.visuals.environment).toHaveProperty("background");
    expect(Object.keys(runtime.visuals.monsters).length).toBeGreaterThanOrEqual(2);
  });

  test("steps an AI-only tape from turn zero and reproduces its terminal hash", () => {
    const finished = createArenaBattle({
      seed: SEED,
      format: "single",
      sides: [
        { kind: "ai", difficulty: "beginner" },
        { kind: "ai", difficulty: "beginner" },
      ],
    });
    const recording = tape(finished);
    const prepared = prepareArenaReplay(recording);
    expect(recording.actions.length).toBeGreaterThan(0);
    expect(prepared.initial.turn).toBe(0);
    expect(prepared.initial.terminal).toBeNull();
    let stepped = prepared.initial;
    for (const index of recording.actions.keys()) {
      stepped = advanceArenaReplay(stepped, recording, index);
    }
    expect(stateHash(stepped)).toBe(stateHash(finished));
    expect(stateHash(stepped)).toBe(prepared.terminalHash);
  });

  test("never treats tape fields as code or markup", () => {
    const malicious = JSON.parse(JSON.stringify(oneTurnTape())) as Record<string, unknown>;
    malicious.script = "globalThis.pwned = true";
    expect(() => parseArenaReplayTape(JSON.stringify(malicious))).toThrow("battle tape must contain only");
  });
});

test("arena demo emits one deterministic normal-AI tape and result", () => {
  const run = () => Bun.spawnSync({
    cmd: [process.execPath, "tools/arena-demo.ts"],
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  const first = run();
  const second = run();
  expect(first.exitCode, first.stderr.toString()).toBe(0);
  expect(second.exitCode, second.stderr.toString()).toBe(0);
  expect(second.stdout.toString()).toBe(first.stdout.toString());
  const output = JSON.parse(first.stdout.toString()) as {
    tape: BattleTape;
    result: { turns: number } | null;
    stateHash: string;
  };
  expect(output.tape.config.sides[1]).toEqual({ kind: "ai", difficulty: "normal" });
  expect(output.tape.actions.length).toBeGreaterThan(0);
  expect(output.result?.turns).toBe(output.tape.actions.length);
  expect(output.stateHash).toMatch(/^[0-9a-f]{64}$/);
  expect(stateHash(replay(output.tape))).toBe(output.stateHash);
});

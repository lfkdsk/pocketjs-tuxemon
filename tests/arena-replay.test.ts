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
  arenaReplayRuntimeState,
  loadArenaReplayTape,
  parseArenaReplayTape,
  prepareArenaReplay,
  resolveArenaReplaySource,
  type ArenaReplayResponse,
} from "../battle/arena-replay.ts";
import { tuxemonRuntimeBattleState } from "../battle/runtime.ts";

const SEED = "0123456789abcdef".repeat(4);
const BASE = "https://game.example/pocket-tuxemon/replay.html";

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
    text: async () => body,
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

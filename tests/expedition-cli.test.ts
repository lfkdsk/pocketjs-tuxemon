import { describe, expect, test } from "bun:test";

import {
  isOver,
  replay,
  result,
  stateHash,
  validateBattleTape,
  validateTeam,
  type ArenaResult,
  type ArenaTeamRecord,
} from "../battle/arena.ts";

const SEED = "0123456789abcdef".repeat(4);
const ROOT = new URL("..", import.meta.url).pathname;

interface DemoOutput {
  format: string;
  expedition: {
    actions: unknown[];
    observation: { status: string; result: unknown };
    team: ArenaTeamRecord[];
  };
  arena: {
    tape: unknown;
    result: ArenaResult | null;
    stateHash: string;
  };
}

function run(seed: string) {
  return Bun.spawnSync({
    cmd: [process.execPath, "run", "expedition:demo", "--", `--seed=${seed}`],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function expectedScriptPrefix(seed: string): string {
  return `$ bun tools/expedition-demo.ts "--seed=${seed}"\n`;
}

describe("expedition demo CLI", () => {
  test("is byte-deterministic and carries its validated team into a replayable Arena battle", () => {
    const first = run(SEED);
    const second = run(SEED);
    const firstStdout = first.stdout.toString();
    const secondStdout = second.stdout.toString();
    const firstStderr = first.stderr.toString();
    const secondStderr = second.stderr.toString();

    expect(first.exitCode, firstStderr).toBe(0);
    expect(second.exitCode, secondStderr).toBe(0);
    expect(["", expectedScriptPrefix(SEED)]).toContain(firstStderr);
    expect(secondStderr).toBe(firstStderr);
    expect(firstStdout.length).toBeGreaterThan(0);
    expect(secondStdout).toBe(firstStdout);

    let output: DemoOutput | undefined;
    expect(() => { output = JSON.parse(firstStdout) as DemoOutput; }).not.toThrow();
    if (!output) return;
    expect(output.format).toBe("pocket-tuxemon/expedition-demo/v1");
    expect(output.expedition.actions.length).toBeGreaterThan(0);
    expect(output.expedition.observation).toMatchObject({
      status: "ended",
      result: { reason: expect.any(String) },
    });

    expect(validateTeam(output.expedition.team, {
      minSize: 1,
      maxSize: 5,
      levelCap: 50,
    })).toEqual({ ok: true, errors: [] });

    const checked = validateBattleTape(output.arena.tape);
    expect(checked.ok, checked.ok ? undefined : checked.error).toBe(true);
    if (!checked.ok) return;
    expect(checked.tape.config.sides[0]).toEqual({
      kind: "agent",
      team: output.expedition.team,
    });
    const replayed = replay(checked.tape);
    expect(isOver(replayed)).toBe(true);
    expect(result(replayed)).toEqual(output.arena.result);
    expect(output.arena.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stateHash(replayed)).toBe(output.arena.stateHash);
  }, 30_000);

  test("rejects an invalid seed without emitting a partial JSON document", () => {
    const invalid = "not-a-64-character-lowercase-hex-seed";
    const failed = run(invalid);
    const stderr = failed.stderr.toString();

    expect(failed.exitCode).not.toBe(0);
    expect(failed.stdout.toString()).toBe("");
    expect(stderr.startsWith(expectedScriptPrefix(invalid)) ||
      stderr.startsWith("error: expedition seed must be exactly 64 lowercase hexadecimal characters"))
      .toBe(true);
    expect(stderr).toContain("expedition seed must be exactly 64 lowercase hexadecimal characters");
  });
});

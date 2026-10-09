// tools/headless-chrome.ts must tear Chrome down on every exit path. A
// leaked browser keeps the run's process tree alive after the verifier has
// exited, so a signal that lands while Chrome is still starting up (before
// the caller holds the handle) must clean up as well as one that lands
// after the DevTools endpoint is ready. The launcher itself must bound how
// long a launch may take, retry a launch that does not come up, and report
// what Chrome printed when it gives up.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CHROME_START_BUDGET_MS,
  spawnHeadlessChrome,
  workspaceChromePids,
} from "../tools/headless-chrome.ts";

const ROOT = resolve(import.meta.dir, "..");
const CHROME = process.env.CHROME ?? Bun.which("google-chrome") ?? Bun.which("chromium");

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await Bun.sleep(50);
  }
  return check();
}

/** Run a child that starts Chrome, print `marker` at the chosen point, and
 *  SIGTERM it as soon as the marker appears. Returns the profile dir.
 *  Waiting for "ready" takes as long as the launch does, which on a cold CI
 *  runner can be most of the launcher's budget; a child that never gets
 *  there is reported with its output instead of running into the test
 *  timeout. */
async function terminateAt(marker: "spawned" | "ready"): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "headless-chrome-cleanup-"));
  const profile = join(dir, "profile");
  const script = join(dir, "child.ts");
  writeFileSync(script, `
import { spawnHeadlessChrome } from ${JSON.stringify(join(ROOT, "tools/headless-chrome.ts"))};
const pending = spawnHeadlessChrome(${JSON.stringify(CHROME)}, ${JSON.stringify(profile)});
console.log("spawned");
await pending;
console.log("ready");
await new Promise(() => {});
`);
  const started = Date.now();
  const child = Bun.spawn(["bun", script], { stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  let text = "";
  const timeout = Bun.sleep(CHROME_START_BUDGET_MS + 5_000).then(() => "timeout" as const);
  while (!text.includes(marker)) {
    const next = await Promise.race([reader.read(), timeout]);
    if (next === "timeout" || next.done) break;
    text += new TextDecoder().decode(next.value);
  }
  child.kill("SIGTERM");
  await child.exited;
  if (!text.includes(marker)) {
    throw new Error(`child never printed "${marker}" (${((Date.now() - started) / 1000).toFixed(1)} s, ` +
      `exit ${child.exitCode ?? child.signalCode})\nstdout: ${text}\nstderr: ${await stderr}`);
  }
  return profile;
}

describe.skipIf(!CHROME)("headless Chrome cleanup", () => {
  for (const marker of ["spawned", "ready"] as const) {
    test(`a SIGTERM after Chrome is ${marker} leaves no browser behind`, async () => {
      const profile = await terminateAt(marker);
      try {
        const gone = await waitFor(() => workspaceChromePids(profile).length === 0, 5000);
        expect(workspaceChromePids(profile)).toEqual([]);
        expect(gone).toBe(true);
      } finally {
        for (const pid of workspaceChromePids(profile)) {
          try { process.kill(pid, "SIGKILL"); } catch {}
        }
        rmSync(join(profile, ".."), { recursive: true, force: true });
      }
    }, CHROME_START_BUDGET_MS + 20_000);
  }
});

/** An executable stand-in for Chrome that records its pid and runs `body`
 *  with $PROFILE set to its --user-data-dir. */
function fakeChrome(dir: string, body: string): { path: string; pids: () => number[] } {
  const path = join(dir, "chrome");
  const pidFile = join(dir, "pids");
  writeFileSync(path, `#!/bin/sh
for arg in "$@"; do case "$arg" in --user-data-dir=*) PROFILE="\${arg#--user-data-dir=}";; esac; done
echo "$$" >> ${JSON.stringify(pidFile)}
${body}
`);
  chmodSync(path, 0o755);
  return { path, pids: () => readFileSync(pidFile, "utf8").trim().split("\n").map(Number) };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("headless Chrome launch", () => {
  test("a launch that never opens DevTools is killed, retried, and reported in full", async () => {
    const dir = mkdtempSync(join(tmpdir(), "headless-chrome-launch-"));
    try {
      const fake = fakeChrome(dir, `echo "dbus: Failed to connect to the bus" >&2
echo "profile $PROFILE" >&2
exec sleep 600`);
      const profile = join(dir, "profile");
      const started = Date.now();
      const error = await spawnHeadlessChrome(fake.path, profile, "800,600", { startTimeoutMs: 700, attempts: 2 })
        .then(() => null, (e: Error) => e);
      const elapsed = Date.now() - started;
      expect(error?.message).toStartWith("Chrome did not start: 2 attempt(s) failed in ");
      expect(error!.message).toMatch(new RegExp(`attempt 1 \\(--user-data-dir=${profile}\\): no DevTools endpoint after \\d+\\.\\d s; killed`));
      expect(error!.message).toMatch(new RegExp(`attempt 2 \\(--user-data-dir=${profile}/retry-2\\): no DevTools endpoint after \\d+\\.\\d s; killed`));
      expect(error!.message.split("dbus: Failed to connect to the bus")).toHaveLength(3);
      expect(error!.message).toContain(`profile ${join(profile, "retry-2")}\n`);
      expect(elapsed).toBeGreaterThanOrEqual(1_400);
      expect(elapsed).toBeLessThan(10_000);
      expect(fake.pids()).toHaveLength(2);
      for (const pid of fake.pids()) expect(alive(pid)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("a launch that exits is reported with its exit code without waiting out the budget", async () => {
    const dir = mkdtempSync(join(tmpdir(), "headless-chrome-launch-"));
    try {
      const fake = fakeChrome(dir, `echo "cannot open display" >&2
exit 3`);
      const started = Date.now();
      const error = await spawnHeadlessChrome(fake.path, join(dir, "profile"), "800,600", { startTimeoutMs: 20_000 })
        .then(() => null, (e: Error) => e);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(error?.message).toStartWith("Chrome did not start: 3 attempt(s) failed in ");
      expect(error!.message).toContain("Chrome exited (code 3, signal none) after ");
      expect(error!.message.split("cannot open display")).toHaveLength(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test.skipIf(!CHROME)("a failed first attempt is retried with a fresh profile and the browser comes up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "headless-chrome-launch-"));
    const fake = fakeChrome(dir, `case "$PROFILE" in
  */retry-2) exec ${JSON.stringify(CHROME)} "$@";;
  *) echo "first launch wedged" >&2; exec sleep 600;;
esac`);
    const profile = join(dir, "profile");
    const chrome = await spawnHeadlessChrome(fake.path, profile, "800,600", { startTimeoutMs: 5_000, attempts: 2 });
    try {
      expect(chrome.wsUrl).toStartWith("ws://127.0.0.1:");
      expect(alive(fake.pids()[0]!)).toBe(false);
      expect(workspaceChromePids(join(profile, "retry-2")).length).toBeGreaterThan(0);
    } finally {
      chrome.close();
      expect(await waitFor(() => workspaceChromePids(profile).length === 0, 5000)).toBe(true);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("headless Chrome readiness", () => {
  const PAGE = { type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/fake" };
  /** A stand-in DevTools HTTP endpoint; returns its port. */
  const servers: ReturnType<typeof Bun.serve>[] = [];
  const serve = (list: (request: Request) => Response | Promise<Response>) => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: list });
    servers.push(server);
    return server.port!;
  };
  const writePort = (port: number) => `printf '%s\\n/devtools/browser/fake\\n' ${port} > "$PROFILE/DevToolsActivePort"`;
  const dirs: string[] = [];
  const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), "headless-chrome-ready-"));
    dirs.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const server of servers) server.stop(true);
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  test("the port in DevToolsActivePort is enough, and a stale one is not trusted", async () => {
    const stale = serve(() => Response.json([{ ...PAGE, webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/stale" }]));
    const port = serve(() => Response.json([PAGE]));
    const dir = scratch();
    const profile = join(dir, "profile");
    mkdirSync(profile);
    writeFileSync(join(profile, "DevToolsActivePort"), `${stale}\n/devtools/browser/stale\n`);
    const fake = fakeChrome(dir, `sleep 0.3
${writePort(port)}
exec sleep 600`);
    const chrome = await spawnHeadlessChrome(fake.path, profile, "800,600", { startTimeoutMs: 5_000, attempts: 1 });
    expect(chrome.wsUrl).toBe(PAGE.webSocketDebuggerUrl);
    chrome.close();
  }, 20_000);

  test("an endpoint that never answers cannot hold the attempt past its deadline", async () => {
    const port = serve(() => new Promise<Response>(() => {}));
    const dir = scratch();
    const fake = fakeChrome(dir, `${writePort(port)}
exec sleep 600`);
    const started = Date.now();
    const error = await spawnHeadlessChrome(fake.path, join(dir, "profile"), "800,600", { startTimeoutMs: 800, attempts: 1 })
      .then(() => null, (e: Error) => e);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(error?.message).toMatch(/no DevTools endpoint after \d+\.\d s; killed; last DevTools probe on port \d+: /);
    expect(alive(fake.pids()[0]!)).toBe(false);
  }, 20_000);

  test("an endpoint without a page target is reported as such", async () => {
    const port = serve(() => Response.json([{ type: "service_worker", url: "chrome://x" }]));
    const dir = scratch();
    const fake = fakeChrome(dir, `${writePort(port)}
exec sleep 600`);
    const error = await spawnHeadlessChrome(fake.path, join(dir, "profile"), "800,600", { startTimeoutMs: 600, attempts: 1 })
      .then(() => null, (e: Error) => e);
    expect(error?.message).toMatch(/DevTools answered without a page target after \d+\.\d s; killed; last DevTools probe on port \d+: no page target yet/);
  }, 20_000);
});

// tools/headless-chrome.ts — shared headless-Chrome lifecycle for the web
// verifiers. The browser process tree (crashpad, renderers) and the local
// HTTP server MUST be torn down on EVERY exit path — success, assertion
// failure, thrown error, or signal — so a failed acceptance run never leaves
// Chrome processes behind (a leaked browser holds the task's process tree
// open until the fleet timeout).
//
// Chrome is launched through setsid(1) when available, so it sits in its own
// process group and one kill(-pid) takes down the whole tree; without setsid
// we walk the child chain with pgrep instead. Cleanup functions registered
// with registerCleanup() run on process exit, fatal signals, and uncaught
// errors, and are idempotent.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface HeadlessChrome {
  wsUrl: string;
  /** Kill the browser process tree. Idempotent. */
  close(): void;
}

const haveSetsid = Bun.which("setsid") !== null;

/** Recursively SIGKILL every descendant of `rootPid` (pgrep -P walk), then
 *  the root itself. */
function killProcessTree(rootPid: number): void {
  let out = "";
  try {
    out = execFileSync("pgrep", ["-P", String(rootPid)], { encoding: "utf8" });
  } catch {
    out = ""; // pgrep exits 1 when the process has no children
  }
  for (const child of out.trim().split(/\s+/)) {
    if (!child) continue;
    killProcessTree(Number(child));
  }
  try {
    process.kill(rootPid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** How long one Chrome launch may take to open its DevTools endpoint. The
 *  first launch on a fresh CI runner has been seen to take over 20 s
 *  (warm launches take well under 2 s). */
export const CHROME_START_TIMEOUT_MS = 30_000;
/** Launches tried, each with a fresh profile, before giving up. */
export const CHROME_START_ATTEMPTS = 3;
/** The longest spawnHeadlessChrome can take before it throws, including
 *  killing each failed attempt. Callers size their own timeouts from this. */
export const CHROME_START_BUDGET_MS = CHROME_START_TIMEOUT_MS * CHROME_START_ATTEMPTS + 5_000;

export interface SpawnChromeOptions {
  /** Per-attempt limit; defaults to CHROME_START_TIMEOUT_MS. */
  startTimeoutMs?: number;
  /** Number of launches; defaults to CHROME_START_ATTEMPTS. */
  attempts?: number;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** Launch headless Chrome and resolve once the DevTools endpoint is up.
 *  `profileDir` is this run's --user-data-dir (also the handle cleanup and
 *  leak checks match on).
 *
 *  Readiness is polled: Chrome writes the port it bound to into
 *  `DevToolsActivePort` in its profile, and the launch is ready once that
 *  port lists a page target. A launch that exits, or is not ready within
 *  `startTimeoutMs`, is killed and retried with a fresh profile under
 *  `profileDir` (`retry-2`, ...). When every attempt fails, the error carries
 *  each attempt's full stderr, how it ended and how long it waited. */
export async function spawnHeadlessChrome(
  chrome: string,
  profileDir: string,
  windowSize = "1200,900",
  options: SpawnChromeOptions = {},
): Promise<HeadlessChrome> {
  const startTimeoutMs = options.startTimeoutMs ?? CHROME_START_TIMEOUT_MS;
  const attempts = options.attempts ?? CHROME_START_ATTEMPTS;
  const started = Date.now();
  const reports: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const dir = attempt === 1 ? profileDir : join(profileDir, `retry-${attempt}`);
    const result = await launchOnce(chrome, dir, windowSize, startTimeoutMs);
    if ("wsUrl" in result) return result;
    reports.push(`attempt ${attempt} (--user-data-dir=${dir}): ${result.failure}\n` +
      `--- stderr ---\n${result.stderr || "(empty)"}\n--- end stderr ---`);
    if (attempt < attempts) {
      console.error(`Chrome launch attempt ${attempt} of ${attempts} failed (${result.failure}); retrying with a fresh profile`);
    }
  }
  throw new Error(`Chrome did not start: ${attempts} attempt(s) failed in ${seconds(Date.now() - started)}\n${reports.join("\n")}`);
}

async function launchOnce(
  chrome: string,
  profileDir: string,
  windowSize: string,
  startTimeoutMs: number,
): Promise<HeadlessChrome | { failure: string; stderr: string }> {
  mkdirSync(profileDir, { recursive: true });
  // A port file left by an earlier browser in a reused profile would point
  // the readiness probe at the wrong port.
  rmSync(join(profileDir, "DevToolsActivePort"), { force: true });
  const started = Date.now();
  const proc = Bun.spawn([
    ...(haveSetsid ? ["setsid"] : []),
    chrome,
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--disable-background-networking",
    `--window-size=${windowSize}`,
    "--force-device-scale-factor=1",
    "about:blank",
  ], { stdout: "ignore", stderr: "pipe" });
  const pid = proc.pid;
  let exited = false;
  void proc.exited.then(() => { exited = true; });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (haveSetsid) {
      // setsid exec'd Chrome as the leader of a fresh group; killing the
      // group takes crashpad/renderer children down in one syscall.
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // group already gone
      }
    }
    // Once Chrome has been reaped its pid may belong to someone else.
    if (!exited) killProcessTree(pid);
  };
  // Register before the first await: a signal that arrives while Chrome is
  // still starting up (before the caller holds the handle) must still tear
  // the browser down.
  registerCleanup(close);
  // Collect stderr in the background so the poll below never blocks on a
  // read; the text is kept until the browser is ready.
  let stderr = "";
  let ready = false;
  const decoder = new TextDecoder();
  const reader = proc.stderr.getReader();
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!ready) stderr += decoder.decode(value, { stream: true });
      }
      if (!ready) stderr += decoder.decode();
    } catch {
      // the pipe closes when Chrome is killed
    }
  })();
  const deadline = started + startTimeoutMs;
  let lastProbe = "";
  let answered = false;
  while (Date.now() < deadline && !exited) {
    const port = devToolsPort(profileDir, stderr);
    if (port) {
      try {
        const wsUrl = await pageTarget(port, Math.max(1, deadline - Date.now()), () => { answered = true; });
        ready = true;
        return { wsUrl, close };
      } catch (err) {
        lastProbe = `; last DevTools probe on port ${port}: ${(err as Error).message}`;
      }
    }
    await Bun.sleep(100);
  }
  const waited = Date.now() - started;
  const failure = exited
    ? `Chrome exited (code ${proc.exitCode}, signal ${proc.signalCode ?? "none"}) after ${seconds(waited)}`
    : `${answered ? "DevTools answered without a page target" : "no DevTools endpoint"} after ${seconds(waited)}; killed`;
  close();
  await proc.exited;
  // Give the drain a moment to collect what Chrome wrote before it died.
  await Bun.sleep(50);
  return { failure: failure + lastProbe, stderr };
}

/** The DevTools port Chrome has bound, or 0 while it has not. */
function devToolsPort(profileDir: string, stderr: string): number {
  try {
    const port = Number(readFileSync(join(profileDir, "DevToolsActivePort"), "utf8").split("\n")[0]);
    if (port > 0) return port;
  } catch {
    // not written yet
  }
  const match = /DevTools listening on ws:\/\/[^:/\s]+:(\d+)\//.exec(stderr);
  return match ? Number(match[1]) : 0;
}

async function pageTarget(port: number, timeoutMs: number, onAnswer: () => void): Promise<string> {
  const signal = AbortSignal.timeout(timeoutMs);
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal })).json()) as any[];
  onAnswer();
  const page = targets.find((t) => t.type === "page");
  if (!page?.webSocketDebuggerUrl) throw new Error("no page target yet");
  return page.webSocketDebuggerUrl;
}

// --- global cleanup registry -------------------------------------------------

const cleanups: (() => void)[] = [];
let registered = false;

/** Register a cleanup function to run on every exit path. Idempotent per
 *  registration; each registered function runs at most once. */
export function registerCleanup(fn: () => void): void {
  cleanups.push(fn);
  if (registered) return;
  registered = true;
  const run = () => {
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
        // cleanup must not block further cleanup
      }
    }
  };
  process.on("exit", run);
  for (const sig of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      run();
      process.exit(128);
    });
  }
  process.on("uncaughtException", (err) => {
    run();
    console.error(err);
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    run();
    console.error(err);
    process.exit(1);
  });
}

/** PIDs of live Chrome processes whose --user-data-dir points at `dir`.
 *  Matching on the workspace profile path (not the process name) means this
 *  never touches browsers another workspace or task started. */
export function workspaceChromePids(dir: string): number[] {
  let out = "";
  try {
    out = execFileSync("pgrep", ["-f", "--", `--user-data-dir=${dir}`], { encoding: "utf8" });
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
  return out.trim().split(/\s+/).filter(Boolean).map(Number);
}

// Exercise the chunked production Web build in real Chrome. The same fixed
// tapes run against local-immediate and per-chunk delayed responses; a host
// wait must freeze both the guest session and PocketJS frame counters. The
// delayed English profile then finishes the background queue and reloads to
// prove verified content-addressed chunks come from Cache Storage, even when
// the HTTP server explicitly says no-store.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { FIXED_INITIAL_CIVIL_TIME } from "../battle/time-weather.ts";
import { registerCleanup, spawnHeadlessChrome, type HeadlessChrome } from "./headless-chrome.ts";

const ROOT = resolve(import.meta.dir, "..");
const SITE = resolve(ROOT, "dist/web");
const OUT = resolve(ROOT, "dist/web-chunks-verify");
const chromeFlag = process.argv.indexOf("--chrome");
const CHROME = chromeFlag >= 0 ? process.argv[chromeFlag + 1]! :
  process.env.CHROME ?? Bun.which("google-chrome") ?? Bun.which("chromium") ?? "google-chrome";
const delayArg = process.argv.find((arg) => arg.startsWith("--delay-ms="));
const DELAY_MS = delayArg ? Number(delayArg.slice("--delay-ms=".length)) : 150;
if (!Number.isSafeInteger(DELAY_MS) || DELAY_MS < 1 || DELAY_MS > 10_000) {
  throw new Error(`verify-web-chunks: --delay-ms must be an integer in 1..10000, got ${delayArg}`);
}
if (!existsSync(join(SITE, "pocket-tuxemon", "index.html"))) {
  console.error("verify-web-chunks: no site at dist/web; run `bun run web` first");
  process.exit(2);
}
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

interface Journey {
  masks: number[];
  map: string;
  position: [number, number];
}

interface RunResult {
  label: string;
  lang: "en" | "zh";
  delayMs: number;
  stateSha256: string;
  location: [string, number, number];
  stateFrame: number;
  hostFrames: number;
  blocks: number;
  blockedChunks: string[];
  frozenTicks: number;
  veilObserved: boolean;
  storageRoundTrip: boolean;
  stats: {
    resident: string[];
    pending: string[];
    queued: string[];
    blocking: string[];
    failures: Record<string, string>;
    compressedBytes: number;
  };
  errors: string[];
}

const journeys: Record<"en" | "zh", Journey> = {
  en: JSON.parse(readFileSync(join(ROOT, "data/g6-journey.json"), "utf8")),
  zh: JSON.parse(readFileSync(join(ROOT, "data/zh-smoke-journey.json"), "utf8")),
};

let serverLabel = "idle";
let serverDelayMs = 0;
const chunkRequests = new Map<string, string[]>();
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    let path = resolve(SITE, `.${decodeURIComponent(url.pathname)}`);
    if (!path.startsWith(SITE)) return new Response("forbidden", { status: 403 });
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
    if (!existsSync(path)) return new Response("not found", { status: 404 });
    const chunk = url.pathname.includes("/chunks/") && url.pathname.endsWith(".pak.gz");
    if (chunk) {
      const requests = chunkRequests.get(serverLabel) ?? [];
      requests.push(url.pathname);
      chunkRequests.set(serverLabel, requests);
      if (serverDelayMs > 0) await Bun.sleep(serverDelayMs);
    }
    // Cache Storage, not an HTTP freshness heuristic, owns the warm-run proof.
    return new Response(Bun.file(path), { headers: { "cache-control": "no-store" } });
  },
});
registerCleanup(() => server.stop(true));

class BrowserSession {
  private ws: WebSocket;
  private nextId = 0;
  private pending = new Map<number, (message: any) => void>();
  readonly errors: string[] = [];

  private constructor(readonly chrome: HeadlessChrome, ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
      } else if (message.method === "Runtime.exceptionThrown") {
        this.errors.push(message.params.exceptionDetails?.exception?.description ?? "exception");
      } else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        this.errors.push(message.params.args.map((arg: any) => arg.value ?? arg.description).join(" "));
      }
    });
  }

  static async open(profile: string): Promise<BrowserSession> {
    const chrome = await spawnHeadlessChrome(CHROME, profile);
    registerCleanup(() => chrome.close());
    const ws = new WebSocket(chrome.wsUrl);
    await new Promise<void>((resolveOpen, reject) => {
      ws.addEventListener("open", () => resolveOpen(), { once: true });
      ws.addEventListener("error", () => reject(new Error("Chrome DevTools socket failed")), { once: true });
    });
    const session = new BrowserSession(chrome, ws);
    await session.send("Runtime.enable");
    await session.send("Page.enable");
    await session.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `globalThis.__pocketTuxemonInitialCivilTime = ${JSON.stringify(FIXED_INITIAL_CIVIL_TIME)};
globalThis.__pocketTuxemonShowTitle = false;
window.requestAnimationFrame = () => 0; window.cancelAnimationFrame = () => {};`,
    });
    return session;
  }

  close(): void {
    this.ws.close();
    this.chrome.close();
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolveSend, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, (message) => message.error
        ? reject(new Error(message.error.message))
        : resolveSend(message.result));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value as T;
  }

  async navigate(lang: "en" | "zh"): Promise<void> {
    const query = lang === "zh" ? "?lang=zh" : "";
    await this.send("Page.navigate", {
      url: `http://127.0.0.1:${server.port}/pocket-tuxemon/${query}`,
    });
    for (let attempt = 0; attempt < 6_000; attempt++) {
      const ready = await this.evaluate<boolean>(
        `!!(globalThis.__pocketPlayer && globalThis.__pocketPlayer.state === "running" && globalThis.__rpgSessionState && globalThis.__pocketPak)`,
      ).catch(() => false);
      if (ready) return;
      await Bun.sleep(10);
    }
    throw new Error(`verify-web-chunks: ${lang} page did not boot`);
  }
}

async function drive(
  browser: BrowserSession,
  label: string,
  lang: "en" | "zh",
  delayMs: number,
): Promise<RunResult> {
  await browser.navigate(lang);
  const journey = journeys[lang];
  const errorStart = browser.errors.length;
  const result = await browser.evaluate<Omit<RunResult, "label" | "lang" | "delayMs" | "errors">>(`(async () => {
    const masks = ${JSON.stringify(journey.masks)};
    const expected = ${JSON.stringify([journey.map, ...journey.position])};
    const p = globalThis.__pocketPlayer;
    const canonical = (value) => {
      if (Array.isArray(value)) return value.map(canonical);
      if (value && typeof value === "object") {
        const out = {};
        for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
        return out;
      }
      return value;
    };
    const digest = async (value) => Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical(value))))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const out = {
      stateSha256: "", location: [], stateFrame: 0, hostFrames: 0,
      blocks: 0, blockedChunks: [], frozenTicks: 0,
      veilObserved: false, storageRoundTrip: false, stats: null,
    };
    if (masks[0] !== 0) throw new Error("chunk verifier tape does not begin idle");
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const roundTripStorage = async () => {
      const bridge = globalThis.__rpgkitAutosave;
      if (!bridge) throw new Error("chunk verifier has no browser autosave bridge");
      const key = p.config.autosaveStorageKey || ("pocket-rpgkit:" + p.config.app + ":autosave:v1");
      const previous = bridge.read();
      const probe = JSON.stringify({ kind: "chunk-wait-probe", frame: globalThis.__rpgSessionState.frame });
      const wrote = bridge.write(probe);
      const readBack = bridge.read();
      if (previous === null) localStorage.removeItem(key);
      else localStorage.setItem(key, previous);
      out.storageRoundTrip = wrote && readBack === probe && bridge.read() === previous;
    };
    const step = async (mask) => {
      p.buttons = () => mask;
      for (let attempt = 0; attempt < 20; attempt++) {
        while (p.pakChunks?.blocking) await sleep(1);
        const advanced = p.step();
        if (advanced) return;
        if (!p.pakChunks?.blocking) throw new Error("chunk verifier step stopped without a blocker");
        out.blocks++;
        for (const id of p.pakChunks.stats().blocking) {
          if (!out.blockedChunks.includes(id)) out.blockedChunks.push(id);
        }
        const hostFrame = p.frames;
        const stateFrame = globalThis.__rpgSessionState.frame;
        const stateBefore = await digest(globalThis.__rpgSessionState);
        // A large synthetic wall-clock jump must not enter either clock while
        // a demand chunk owns the host veil.
        p.tick(performance.now() + 1_000);
        p.tick(performance.now() + 2_000);
        out.frozenTicks += 2;
        const stateAfter = await digest(globalThis.__rpgSessionState);
        if (p.frames !== hostFrame || globalThis.__rpgSessionState.frame !== stateFrame || stateAfter !== stateBefore) {
          throw new Error("network wait advanced a host or simulation frame");
        }
        out.veilObserved ||= p.chunkVeil === true && p.overlay.hidden === false &&
          /Loading|加载/.test(p.message.textContent || "");
        if (!out.storageRoundTrip) await roundTripStorage();
        const deadline = performance.now() + 30_000;
        while (p.pakChunks.blocking && performance.now() < deadline) await sleep(1);
        if (p.pakChunks.blocking) throw new Error("chunk verifier timed out under the network veil");
      }
      throw new Error("chunk verifier could not retry a blocked tape frame");
    };
    for (let frame = 1; frame < masks.length; frame++) await step(masks[frame]);
    const state = globalThis.__rpgSessionState;
    out.location = [state.mapId, state.move.tx, state.move.ty];
    if (out.location.join() !== expected.join()) {
      throw new Error("chunk verifier ended at " + out.location.join() + ", want " + expected.join());
    }
    out.stateSha256 = await digest(state);
    out.stateFrame = state.frame;
    out.hostFrames = p.frames;
    out.stats = p.pakChunks.stats();
    return out;
  })()`);
  return {
    label,
    lang,
    delayMs,
    ...result,
    errors: browser.errors.slice(errorStart),
  };
}

async function waitForBackground(browser: BrowserSession, label: string): Promise<RunResult["stats"]> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const stats = await browser.evaluate<RunResult["stats"]>("globalThis.__pocketPlayer.pakChunks.stats()");
    if (stats.pending.length === 0 && stats.queued.length === 0) return stats;
    await Bun.sleep(50);
  }
  throw new Error(`verify-web-chunks: ${label} background queue did not finish`);
}

async function singleRun(label: string, lang: "en" | "zh", delayMs: number): Promise<RunResult> {
  serverLabel = label;
  serverDelayMs = delayMs;
  const browser = await BrowserSession.open(join(OUT, `${label}-profile`));
  try {
    return await drive(browser, label, lang, delayMs);
  } finally {
    browser.close();
  }
}

console.log("verify-web-chunks: immediate English journey...");
const instantEn = await singleRun("instant-en", "en", 0);
console.log(`  ${instantEn.stateSha256} at ${instantEn.location.join(",")} (${instantEn.blocks} async waits)`);
console.log("verify-web-chunks: immediate Chinese journey...");
const instantZh = await singleRun("instant-zh", "zh", 0);
console.log(`  ${instantZh.stateSha256} at ${instantZh.location.join(",")} (${instantZh.blocks} async waits)`);

console.log(`verify-web-chunks: delayed English journey (${DELAY_MS} ms per chunk)...`);
serverLabel = "delayed-en";
serverDelayMs = DELAY_MS;
const delayedEnBrowser = await BrowserSession.open(join(OUT, "delayed-en-profile"));
let delayedEn: RunResult;
let delayedEnBackground: RunResult["stats"];
let warmStats: RunResult["stats"];
try {
  delayedEn = await drive(delayedEnBrowser, "delayed-en", "en", DELAY_MS);
  delayedEnBackground = await waitForBackground(delayedEnBrowser, "delayed English");
  console.log(`  ${delayedEn.stateSha256} at ${delayedEn.location.join(",")} (${delayedEn.blocks} blocked tape frames)`);
  console.log("verify-web-chunks: warm reload from verified Cache Storage...");
  serverLabel = "warm-en";
  serverDelayMs = DELAY_MS;
  await delayedEnBrowser.navigate("en");
  warmStats = await waitForBackground(delayedEnBrowser, "warm English");
} finally {
  delayedEnBrowser.close();
}

console.log(`verify-web-chunks: delayed Chinese journey (${DELAY_MS} ms per chunk)...`);
const delayedZh = await singleRun("delayed-zh", "zh", DELAY_MS);
console.log(`  ${delayedZh.stateSha256} at ${delayedZh.location.join(",")} (${delayedZh.blocks} blocked tape frames)`);

const requestLabels = ["instant-en", "instant-zh", "delayed-en", "warm-en", "delayed-zh"];
const chunkRequestSummary = Object.fromEntries(requestLabels.map((label) => {
  const paths = chunkRequests.get(label) ?? [];
  const counts = new Map<string, number>();
  for (const path of paths) counts.set(path, (counts.get(path) ?? 0) + 1);
  return [label, {
    requests: paths.length,
    unique: counts.size,
    bytes: paths.reduce((sum, path) => sum + statSync(resolve(SITE, `.${path}`)).size, 0),
    duplicates: Object.fromEntries([...counts].filter(([, count]) => count > 1)),
  }];
}));
const assertions = {
  englishStateEqual: instantEn.stateSha256 === delayedEn.stateSha256,
  chineseStateEqual: instantZh.stateSha256 === delayedZh.stateSha256,
  englishFramesEqual: instantEn.stateFrame === delayedEn.stateFrame && instantEn.hostFrames === delayedEn.hostFrames,
  chineseFramesEqual: instantZh.stateFrame === delayedZh.stateFrame && instantZh.hostFrames === delayedZh.hostFrames,
  delayedBlocksObserved: delayedEn.blocks > 0 && delayedZh.blocks > 0,
  frozenOutsideSimulation: delayedEn.frozenTicks > 0 && delayedZh.frozenTicks > 0 &&
    delayedEn.veilObserved && delayedZh.veilObserved,
  storageDuringWait: delayedEn.storageRoundTrip && delayedZh.storageRoundTrip,
  noChunkFailures: [instantEn, instantZh, delayedEn, delayedZh]
    .every((run) => run.errors.length === 0 && Object.keys(run.stats.failures).length === 0),
  backgroundComplete: delayedEnBackground.pending.length === 0 && delayedEnBackground.queued.length === 0 &&
    delayedEnBackground.resident.length === 282,
  warmCacheNoChunkRequests: (chunkRequests.get("warm-en")?.length ?? 0) === 0 &&
    warmStats.pending.length === 0 && warmStats.queued.length === 0 && warmStats.resident.length === 282,
};
const ok = Object.values(assertions).every(Boolean);
const report = {
  format: "pocket-tuxemon-web-chunk-verification/v1",
  delayMs: DELAY_MS,
  runs: { instantEn, delayedEn, instantZh, delayedZh },
  delayedEnBackground,
  warmStats,
  chunkRequestSummary,
  assertions,
  result: ok ? "PASS" : "FAIL",
};
writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
for (const [name, passed] of Object.entries(assertions)) {
  console.log(`${passed ? "ok  " : "FAIL"} ${name}`);
}
console.log(`chunk requests: ${JSON.stringify(chunkRequestSummary)}`);
console.log(ok ? "WEB CHUNKS PASS" : "WEB CHUNKS FAIL");
process.exit(ok ? 0 : 1);


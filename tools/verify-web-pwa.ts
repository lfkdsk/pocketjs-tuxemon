// Real-Chrome acceptance for the built Pocket Tuxemon PWA.
//
// This verifier deliberately works from copies of dist/web. Release A is the
// exact built site; release B is finalized from a second copy after changing
// only the PWA client source. A switchable HTTP server can therefore expose a
// B page while it still exposes A's stable service-worker URL, then expose the
// complete B release. The browser must never execute a page/worker mismatch.
//
//   bun run web && bun tools/verify-web-pwa.ts [--chrome PATH]
//
// Evidence is written to dist/web-pwa-verify. Temporary release copies and the
// Chrome profile are removed on every exit path.

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { FIXED_INITIAL_CIVIL_TIME } from "../battle/time-weather.ts";
import { decodePng } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/compiler/pak.ts";
import type { WebPakManifest } from "./web-chunks.ts";
import { WEB_CHUNK_AWARE_STEP_SOURCE } from "./web-chunk-step.ts";
import { finalizeWebPwa } from "./web-pwa.ts";
import {
  registerCleanup,
  spawnHeadlessChrome,
  type HeadlessChrome,
} from "./headless-chrome.ts";

const ROOT = resolve(import.meta.dir, "..");
const SITE = join(ROOT, "dist", "web");
const OUT = join(ROOT, "dist", "web-pwa-verify");
const GAME = "pocket-tuxemon";
const GAME_PATH = `/${GAME}/`;
const chromeFlag = process.argv.indexOf("--chrome");
const CHROME = chromeFlag >= 0 ? process.argv[chromeFlag + 1]! :
  process.env.CHROME ?? Bun.which("google-chrome") ?? Bun.which("chromium") ?? "google-chrome";
const journey = JSON.parse(readFileSync(join(ROOT, "data", "g6-journey.json"), "utf8")) as {
  masks: number[];
  checkpoints: Array<{ name: string; frame: number; map: string; position: [number, number] }>;
};
const bedroom = journey.checkpoints.find((checkpoint) => checkpoint.name === "bedroom") ?? (() => {
  throw new Error("verify-web-pwa: maintained journey has no bedroom checkpoint");
})();

type ReleaseMode = "A" | "mixed" | "B";
type JsonObject = Record<string, unknown>;

interface PwaView {
  build: string;
  workerBuild: string | null;
  language: string;
  downloading: boolean;
  status: string;
  missing: boolean;
  missingMap: string | null;
  missingEntry: string | null;
}

interface WorkerMessage extends JsonObject {
  type?: string;
  build?: string;
  language?: string;
  completed?: number;
  total?: number;
  bytes?: number;
  totalBytes?: number;
}

interface ServerCounts {
  total: number;
  index: number;
  worker: number;
  chunks: number;
  replay: number;
  network: number;
  chunkFiles: Record<string, number>;
}

interface CheckRecord {
  label: string;
  ok: boolean;
  detail?: unknown;
}

const report: {
  format: string;
  startedAt: string;
  finishedAt?: string;
  ok: boolean;
  chrome: string;
  releases?: JsonObject;
  coldOnline?: JsonObject;
  manifest?: JsonObject;
  bypass?: JsonObject;
  offline?: JsonObject;
  saveLoad?: JsonObject;
  missing?: JsonObject;
  download?: JsonObject;
  update?: JsonObject;
  browserErrors?: string[];
  server?: JsonObject;
  screenshots: string[];
  checks: CheckRecord[];
  fatal?: string;
} = {
  format: "pocket-tuxemon-web-pwa-verify/v1",
  startedAt: new Date().toISOString(),
  ok: false,
  chrome: CHROME,
  screenshots: [],
  checks: [],
};
const ownedCleanups: Array<() => void> = [];

function cleanupNow(): void {
  for (const cleanup of ownedCleanups.splice(0).reverse()) {
    try {
      cleanup();
    } catch {
      // A failed cleanup must not prevent the remaining owned resources from
      // being released or the failure report from being written.
    }
  }
}
registerCleanup(cleanupNow);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

function writeReport(): void {
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

function check(label: string, condition: unknown, detail?: unknown): asserts condition {
  const ok = Boolean(condition);
  report.checks.push({ label, ok, ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  if (!ok) throw new Error(`verify-web-pwa: ${label}`);
}

function emptyCounts(): ServerCounts {
  return { total: 0, index: 0, worker: 0, chunks: 0, replay: 0, network: 0, chunkFiles: {} };
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function rotateContentChunk(site: string, manifest: WebPakManifest): {
  id: string;
  A: { file: string; bytes: number; sha256: string };
  B: { file: string; bytes: number; sha256: string };
} {
  const index = manifest.chunks.findIndex((chunk) => chunk.id.startsWith("map:en_US:"));
  if (index < 0) throw new Error("verify-web-pwa: release fixture has no English map chunk");
  const original = manifest.chunks[index]!;
  const originalBytes = new Uint8Array(readFileSync(join(site, GAME, original.file)));
  const unpacked = gunzipSync(originalBytes);
  const repacked = gzipSync(unpacked, { level: 1 });
  if (sha256(repacked) === original.sha256) {
    // The OS byte is outside the compressed stream and payload CRC. zlib emits
    // no gzip header CRC, so changing it preserves the exact unpacked pak.
    if ((repacked[3]! & 0x02) !== 0) throw new Error("verify-web-pwa: unexpected gzip header CRC");
    repacked[9] = repacked[9]! ^ 1;
  }
  const digest = sha256(repacked);
  const file = original.file.replace(/-[0-9a-f]{64}\.pak\.gz$/, `-${digest}.pak.gz`);
  if (file === original.file) throw new Error(`verify-web-pwa: chunk is not content addressed: ${original.file}`);
  if (!Buffer.from(gunzipSync(repacked)).equals(Buffer.from(unpacked))) {
    throw new Error("verify-web-pwa: release B chunk changed unpacked content");
  }
  writeFileSync(join(site, GAME, file), repacked);
  manifest.chunks[index] = { ...original, file, bytes: repacked.byteLength, sha256: digest };
  writeFileSync(join(site, GAME, `${GAME}.pak-manifest.json`), `${JSON.stringify(manifest)}\n`);
  return {
    id: original.id,
    A: { file: original.file, bytes: original.bytes, sha256: original.sha256 },
    B: { file, bytes: repacked.byteLength, sha256: digest },
  };
}

function copyRelease(source: string, destination: string): void {
  cpSync(source, destination, { recursive: true, force: true });
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

class Browser {
  private readonly ws: WebSocket;
  private nextId = 0;
  private readonly pending = new Map<number, (message: any) => void>();
  readonly errors: string[] = [];

  private constructor(readonly chrome: HeadlessChrome, ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
      } else if (message.method === "Runtime.exceptionThrown") {
        this.errors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? "exception");
      } else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        this.errors.push(message.params.args.map((argument: any) => argument.value ?? argument.description).join(" "));
      }
    });
  }

  static async open(profile: string): Promise<Browser> {
    const chrome = await spawnHeadlessChrome(CHROME, profile, "1200,900");
    registerCleanup(() => chrome.close());
    const ws = new WebSocket(chrome.wsUrl);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      ws.addEventListener("open", () => resolveOpen(), { once: true });
      ws.addEventListener("error", () => rejectOpen(new Error("Chrome DevTools socket failed")), { once: true });
    });
    const browser = new Browser(chrome, ws);
    await browser.send("Runtime.enable");
    await browser.send("Page.enable");
    await browser.send("Network.enable");
    await browser.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `globalThis.__pocketTuxemonInitialCivilTime = ${JSON.stringify(FIXED_INITIAL_CIVIL_TIME)};
globalThis.__pocketTuxemonShowTitle = false;
window.requestAnimationFrame = () => 0;
window.cancelAnimationFrame = () => {};
globalThis.__pocketPwaVerifierMessages = [];
globalThis.__pocketPwaVerifierConnectivity = [];
if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", (event) => {
  const value = event.data;
  globalThis.__pocketPwaVerifierMessages.push(value && typeof value === "object" ? JSON.parse(JSON.stringify(value)) : value);
});
addEventListener("online", () => globalThis.__pocketPwaVerifierConnectivity.push("online"));
addEventListener("offline", () => globalThis.__pocketPwaVerifierConnectivity.push("offline"));
${WEB_CHUNK_AWARE_STEP_SOURCE}`,
    });
    return browser;
  }

  close(): void {
    this.ws.close();
    this.chrome.close();
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolveSend, rejectSend) => {
      const id = ++this.nextId;
      this.pending.set(id, (message) => message.error
        ? rejectSend(new Error(`${method}: ${message.error.message}`))
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

  async waitFor<T>(label: string, expression: string, timeoutMs = 60_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown = null;
    while (Date.now() < deadline) {
      try {
        last = await this.evaluate<T | false | null>(expression);
        if (last) return last as T;
      } catch (error) {
        last = errorText(error);
      }
      await Bun.sleep(50);
    }
    throw new Error(`verify-web-pwa: timed out waiting for ${label}; last=${JSON.stringify(last)}`);
  }

  async navigate(url: string, label: string): Promise<void> {
    await this.send("Page.navigate", { url });
    const marker = new URL(url).searchParams.get("pwa_probe");
    const markerCheck = marker === null
      ? "true"
      : `new URLSearchParams(location.search).get("pwa_probe") === ${JSON.stringify(marker)}`;
    await this.waitFor(label, `${markerCheck} && !!(globalThis.__pocketPlayer &&
      globalThis.__pocketPlayer.state === "running" && globalThis.__rpgSessionState)`);
  }

  async reload(label: string): Promise<void> {
    // A DevTools hard reload bypasses the service worker and deliberately
    // leaves navigator.serviceWorker.controller null. Exercise the same
    // normal refresh an installed/offline player uses.
    await this.send("Page.reload");
    await this.waitFor(label, `!!(globalThis.__pocketPlayer &&
      globalThis.__pocketPlayer.state === "running" && globalThis.__rpgSessionState)`);
  }

  async setOffline(offline: boolean): Promise<void> {
    await this.send("Network.emulateNetworkConditions", {
      offline,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
      connectionType: offline ? "none" : "wifi",
    });
    await this.waitFor(
      `navigator.onLine=${String(!offline)}`,
      `navigator.onLine === ${String(!offline)} && globalThis.__pocketPwaVerifierConnectivity.includes(${JSON.stringify(offline ? "offline" : "online")})`,
      10_000,
    );
  }

  async screenshot(name: string): Promise<Uint8Array> {
    const capture = await this.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    const bytes = Buffer.from(capture.data, "base64");
    writeFileSync(join(OUT, name), bytes);
    report.screenshots.push(name);
    return bytes;
  }
}

function goldBorderPixels(
  pngBytes: Uint8Array,
  geometry: { left: number; top: number; right: number; bottom: number; viewportWidth: number; viewportHeight: number },
): JsonObject {
  const png = decodePng(pngBytes);
  const scaleX = png.width / geometry.viewportWidth;
  const scaleY = png.height / geometry.viewportHeight;
  const left = Math.max(0, Math.floor(geometry.left * scaleX));
  const top = Math.max(0, Math.floor(geometry.top * scaleY));
  const right = Math.min(png.width - 1, Math.ceil(geometry.right * scaleX));
  const bottom = Math.min(png.height - 1, Math.ceil(geometry.bottom * scaleY));
  const band = Math.max(3, Math.ceil(Math.max(scaleX, scaleY) * 4));
  const gold = [0xf4, 0xc3, 0x5a];
  let candidates = 0;
  let nearGold = 0;
  let closest = Number.POSITIVE_INFINITY;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      if (x - left >= band && right - x >= band && y - top >= band && bottom - y >= band) continue;
      const offset = (y * png.width + x) * 4;
      const distance = Math.abs(png.rgba[offset]! - gold[0]!) +
        Math.abs(png.rgba[offset + 1]! - gold[1]!) +
        Math.abs(png.rgba[offset + 2]! - gold[2]!);
      candidates++;
      closest = Math.min(closest, distance);
      if (distance <= 24) nearGold++;
    }
  }
  const centerX = Math.max(0, Math.min(png.width - 1, Math.round((geometry.left + geometry.right) * scaleX / 2)));
  const topBorderY = Math.max(0, Math.min(png.height - 1, Math.round(geometry.top * scaleY + scaleY)));
  const centerOffset = (topBorderY * png.width + centerX) * 4;
  const topCenter = [png.rgba[centerOffset], png.rgba[centerOffset + 1], png.rgba[centerOffset + 2]];
  const topCenterDistance = topCenter.reduce((sum, channel, index) => sum + Math.abs(channel! - gold[index]!), 0);
  return {
    screenshot: [png.width, png.height],
    card: [left, top, right, bottom],
    candidates,
    nearGold,
    closest,
    topCenter,
    topCenterDistance,
  };
}

async function main(): Promise<void> {
  check("dist/web contains a finalized game PWA", [
    join(SITE, GAME, "index.html"),
    join(SITE, GAME, "service-worker.js"),
    join(SITE, GAME, "manifest.webmanifest"),
    join(SITE, GAME, "pwa-build.json"),
  ].every(existsSync));

  const temp = mkdtempSync(join(ROOT, "dist", ".web-pwa-verify-"));
  ownedCleanups.push(() => rmSync(temp, { recursive: true, force: true }));
  const releaseA = join(temp, "release-a");
  const releaseB = join(temp, "release-b");
  const rootB = join(temp, "root-b");
  copyRelease(SITE, releaseA);
  copyRelease(SITE, releaseB);
  mkdirSync(join(rootB, "web"), { recursive: true });
  const clientB = `${readFileSync(join(ROOT, "web", "pwa-client.js"), "utf8")}\n` +
    `globalThis.__pocketPwaVerifierRelease = "B";\n`;
  writeFileSync(join(rootB, "web", "pwa-client.js"), clientB);
  cpSync(join(ROOT, "web", "service-worker.js"), join(rootB, "web", "service-worker.js"));
  const pakManifestA = JSON.parse(readFileSync(
    join(releaseA, GAME, `${GAME}.pak-manifest.json`),
    "utf8",
  )) as WebPakManifest;
  const pakManifestB = JSON.parse(readFileSync(
    join(releaseB, GAME, `${GAME}.pak-manifest.json`),
    "utf8",
  )) as WebPakManifest;
  const rotatedChunk = rotateContentChunk(releaseB, pakManifestB);
  const receiptA = JSON.parse(readFileSync(join(releaseA, GAME, "pwa-build.json"), "utf8")) as {
    version: string;
    packages: Record<string, { chunks: number; bytes: number }>;
  };
  const builtB = finalizeWebPwa({ root: rootB, siteDir: releaseB, gameId: GAME, manifest: pakManifestB });
  const receiptB = JSON.parse(readFileSync(join(releaseB, GAME, "pwa-build.json"), "utf8")) as {
    version: string;
  };
  check("release B changes its PWA client and one content-addressed map chunk",
    builtB.version !== receiptA.version && receiptB.version === builtB.version, {
    A: receiptA.version,
    B: builtB.version,
  });
  report.releases = {
    A: receiptA.version,
    B: builtB.version,
    rotatedChunk,
    englishPackage: receiptA.packages.en,
  };

  let mode: ReleaseMode = "A";
  let chunkDelayMs = 0;
  let originAvailable = true;
  const counts: Record<ReleaseMode, ServerCounts> = {
    A: emptyCounts(),
    mixed: emptyCounts(),
    B: emptyCounts(),
  };
  let networkSerial = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const count = counts[mode];
      count.total++;
      if (!originAvailable) {
        return new Response("offline", {
          status: 503,
          headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
        });
      }
      if (url.pathname === `${GAME_PATH}network-probe`) {
        count.network++;
        return new Response(`network:${mode}:${++networkSerial}`, {
          headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
        });
      }
      if (url.pathname === GAME_PATH || url.pathname === `${GAME_PATH}index.html`) count.index++;
      if (url.pathname === `${GAME_PATH}service-worker.js`) count.worker++;
      if (url.pathname === `${GAME_PATH}replay.html`) count.replay++;
      const chunk = url.pathname.startsWith(`${GAME_PATH}chunks/`) && url.pathname.endsWith(".pak.gz");
      if (chunk) {
        count.chunks++;
        count.chunkFiles[url.pathname] = (count.chunkFiles[url.pathname] ?? 0) + 1;
        if (chunkDelayMs > 0) await Bun.sleep(chunkDelayMs);
      }
      const selected = mode === "A" || (mode === "mixed" && url.pathname === `${GAME_PATH}service-worker.js`)
        ? releaseA
        : releaseB;
      let path: string;
      try {
        path = resolve(selected, `.${decodeURIComponent(url.pathname)}`);
      } catch {
        return new Response("bad path", { status: 400 });
      }
      if (!inside(selected, path)) return new Response("forbidden", { status: 403 });
      if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
      if (!existsSync(path) || !statSync(path).isFile()) return new Response("not found", { status: 404 });
      return new Response(Bun.file(path), { headers: { "cache-control": "no-store" } });
    },
  });
  ownedCleanups.push(() => server.stop(true));
  const base = `http://127.0.0.1:${server.port}${GAME_PATH}`;
  const browser = await Browser.open(join(temp, "profile"));
  ownedCleanups.push(() => browser.close());
  const setConnectivity = async (offline: boolean): Promise<void> => {
    // Page-target network emulation does not consistently cover fetches from
    // Chrome's separate service-worker target. Fail the loopback origin too,
    // while still requiring the real browser online/offline event below.
    originAvailable = !offline;
    await browser.setOffline(offline);
  };

  const pwaState = `(() => {
    const view = globalThis.__pocketPwa?.view?.();
    return view && {
      ...view,
      controller: !!navigator.serviceWorker.controller,
      pageBuild: document.documentElement.dataset.pwaBuild || null,
      map: globalThis.__rpgSessionState?.mapId || null,
      frame: globalThis.__rpgSessionState?.frame ?? null,
    };
  })()`;
  const waitPwa = async (label: string, build: string, controlled: boolean): Promise<PwaView & JsonObject> => {
    const deadline = Date.now() + 90_000;
    let last: unknown = null;
    while (Date.now() < deadline) {
      try {
        const value = await browser.evaluate<PwaView & JsonObject | null>(pwaState);
        last = value;
        if (value && value.build === build && value.pageBuild === build &&
            value.workerBuild === build && value.controller === controlled) return value;
      } catch (error) {
        last = errorText(error);
      }
      await Bun.sleep(50);
    }
    throw new Error(`verify-web-pwa: timed out waiting for ${label}; last=${JSON.stringify(last)}`);
  };

  // A genuinely cold profile reaches the first map before the deferred PWA
  // client installs its worker. One reload then acquires worker control.
  await browser.navigate(`${base}?pwa_probe=cold`, "cold online first map");
  const coldMap = await browser.evaluate<JsonObject>(`({
    map: __rpgSessionState.mapId,
    position: [__rpgSessionState.move.tx, __rpgSessionState.move.ty],
    frame: __rpgSessionState.frame,
    controller: !!navigator.serviceWorker.controller,
  })`);
  check("cold online boot reaches the first bedroom map", coldMap.map === "spyder_bedroom", coldMap);
  const coldPwa = await waitPwa("cold PWA worker installation", receiptA.version, false);
  await browser.screenshot("cold-online.png");
  check("cold page installs A and wraps map prepares without premature control",
    coldPwa.controller === false && coldPwa.mapPrepareWrapped === true, coldPwa);

  await browser.reload("controlled A reload");
  const controlledA = await waitPwa("A service-worker control", receiptA.version, true);
  check("controlled A page, worker and map recovery are ready",
    controlledA.build === controlledA.workerBuild && controlledA.mapPrepareWrapped === true, controlledA);
  report.coldOnline = { firstMap: coldMap, firstPwa: coldPwa, controlled: controlledA };

  // Ask Chrome itself, rather than only parsing files, whether the manifest
  // attached to the controlled page is valid and installable.
  const appManifest = await browser.send("Page.getAppManifest");
  check("Chrome parses the game manifest without errors", Array.isArray(appManifest.errors) && appManifest.errors.length === 0, appManifest.errors);
  const parsedManifest = JSON.parse(appManifest.data) as {
    id?: string;
    start_url?: string;
    scope?: string;
    display?: string;
    icons?: Array<{ src?: string; sizes?: string; purpose?: string }>;
  };
  check("manifest identity and launch stay inside the game scope",
    parsedManifest.id === "./" && parsedManifest.start_url === "./" && parsedManifest.scope === "./" && parsedManifest.display === "standalone",
    parsedManifest);
  check("manifest exposes any and maskable 192/512 icons", ["192x192", "512x512"].every((size) =>
    parsedManifest.icons?.some((icon) => icon.sizes === size && icon.purpose === "any") &&
    parsedManifest.icons?.some((icon) => icon.sizes === size && icon.purpose === "maskable")), parsedManifest.icons);
  let installability = await browser.send("Page.getInstallabilityErrors");
  for (let attempt = 0; attempt < 100 && installability.installabilityErrors?.length > 0; attempt++) {
    await Bun.sleep(100);
    installability = await browser.send("Page.getInstallabilityErrors");
  }
  check("Chrome reports no installability errors", Array.isArray(installability.installabilityErrors) && installability.installabilityErrors.length === 0,
    installability.installabilityErrors);
  report.manifest = {
    url: appManifest.url,
    parsed: parsedManifest,
    errors: appManifest.errors,
    installabilityErrors: installability.installabilityErrors,
  };

  const driveBedroom = async (label: string): Promise<JsonObject> => {
    const result = await browser.evaluate<JsonObject>(`(async () => {
      const masks = ${JSON.stringify(journey.masks.slice(1, bedroom.frame + 1))};
      const p = globalThis.__pocketPlayer;
      for (const mask of masks) {
        p.buttons = () => mask;
        await globalThis.__pocketTestStep();
      }
      p.buttons = () => 0;
      const s = globalThis.__rpgSessionState;
      return { map: s.mapId, position: [s.move.tx, s.move.ty], frame: s.frame, hostFrames: p.frames };
    })()`);
    check(label, result.map === bedroom.map && (result.position as number[]).join() === bedroom.position.join(), result);
    return result;
  };
  const onlineBedroom = await driveBedroom("controlled online tape reaches the stable bedroom checkpoint");

  // These paths intentionally fall through the worker. no-store plus an
  // offline retry proves they were neither intercepted nor retained.
  const bypassOnline = await browser.evaluate<JsonObject>(`(async () => {
    const replay = new URL("replay.html?pwa-bypass=online", location.href);
    const network = new URL("network-probe?pwa-bypass=online", location.href);
    const replayResponse = await fetch(replay, { cache: "no-store" });
    const networkResponse = await fetch(network, { cache: "no-store" });
    const cached = async (url) => {
      for (const name of await caches.keys()) if (await (await caches.open(name)).match(url.href)) return true;
      return false;
    };
    return {
      replayStatus: replayResponse.status,
      replayLooksReal: /replay/i.test(await replayResponse.text()),
      networkStatus: networkResponse.status,
      networkText: await networkResponse.text(),
      replayCached: await cached(replay),
      networkCached: await cached(network),
    };
  })()`);
  check("replay and ordinary network probes bypass the worker online",
    bypassOnline.replayStatus === 200 && bypassOnline.replayLooksReal === true && bypassOnline.networkStatus === 200 &&
    typeof bypassOnline.networkText === "string" && bypassOnline.networkText.startsWith("network:A:") &&
    bypassOnline.replayCached === false && bypassOnline.networkCached === false,
    bypassOnline);

  await setConnectivity(true);
  await browser.reload("offline A reload");
  const offlinePwa = await waitPwa("offline A service-worker control", receiptA.version, true);
  const offlineBedroom = await driveBedroom("offline shell replays through the stable bedroom checkpoint");
  const continued = await browser.evaluate<JsonObject>(`(async () => {
    const p = globalThis.__pocketPlayer;
    const before = { state: __rpgSessionState.frame, host: p.frames };
    p.buttons = () => 0;
    for (let i = 0; i < 24; i++) await globalThis.__pocketTestStep();
    return { before, after: { state: __rpgSessionState.frame, host: p.frames }, map: __rpgSessionState.mapId };
  })()`);
  const beforeFrames = continued.before as { state: number; host: number };
  const afterFrames = continued.after as { state: number; host: number };
  check("offline reload continues simulation and host frames", afterFrames.state === beforeFrames.state + 24 && afterFrames.host === beforeFrames.host + 24,
    continued);
  const bypassOffline = await browser.evaluate<JsonObject>(`(async () => {
    const failed = async (path) => {
      try { return !(await fetch(path, { cache: "no-store" })).ok; } catch { return true; }
    };
    return {
      replayFailed: await failed("./replay.html?pwa-bypass=offline"),
      networkFailed: await failed("./network-probe?pwa-bypass=offline"),
    };
  })()`);
  check("replay and ordinary network probes remain unavailable offline", bypassOffline.replayFailed === true && bypassOffline.networkFailed === true,
    bypassOffline);
  report.bypass = { online: bypassOnline, offline: bypassOffline };
  report.offline = { pwa: offlinePwa, onlineBedroom, offlineBedroom, continued };

  // Use the real START and save overlays, their browser slot store, and their
  // production load callback while Network reports offline.
  const saveLoad = await browser.evaluate<JsonObject>(`(async () => {
    const p = globalThis.__pocketPlayer;
    const menu = globalThis.__pocketTuxemonSave;
    const start = globalThis.__pocketStartMenu;
    if (!menu || !start) throw new Error("PWA verifier: browser Save/START hooks unavailable");
    const START = 0x0008, UP = 0x0010, RIGHT = 0x0020, LEFT = 0x0080, DOWN = 0x0040, CIRCLE = 0x2000;
    const at = () => { const s = globalThis.__rpgSessionState; return [s.mapId, s.move.tx, s.move.ty].join(","); };
    const press = async (mask) => {
      p.buttons = () => mask; await globalThis.__pocketTestStep();
      p.buttons = () => 0; await globalThis.__pocketTestStep();
    };
    const openStartRow = async (name) => {
      if (!start.isOpen()) await press(START);
      const index = start.rows().findIndex((row) => row.id === name);
      if (index < 0) throw new Error("PWA verifier: missing START row " + name);
      for (let i = 0; i < start.rows().length && start.state().rootCursor !== index; i++) await press(DOWN);
      if (start.state().rootCursor !== index) throw new Error("PWA verifier: could not select START row " + name);
      await press(CIRCLE);
      return index;
    };
    localStorage.removeItem("pocket-tuxemon/save/slot-1");
    const saved = at();
    const saveRow = await openStartRow("save");
    const saveRoot = menu.menu().kind;
    await press(CIRCLE);
    const saveSlots = menu.menu().kind;
    await press(CIRCLE);
    const saveMessage = menu.menu();
    const stored = (localStorage.getItem("pocket-tuxemon/save/slot-1") || "").length;
    await press(CIRCLE);
    await press(START);
    if (start.isOpen()) await press(START);
    let walked = at();
    for (const mask of [RIGHT, LEFT, UP]) {
      if (walked !== saved) break;
      p.buttons = () => mask;
      for (let i = 0; i < 16; i++) await globalThis.__pocketTestStep();
      p.buttons = () => 0;
      for (let i = 0; i < 4; i++) await globalThis.__pocketTestStep();
      walked = at();
      if (!walked.startsWith("spyder_bedroom,")) throw new Error("PWA verifier: movement left the cached bedroom");
    }
    const loadRow = await openStartRow("load");
    const loadOpened = menu.menu();
    const hasAutosave = globalThis.__rpgkitAutosave?.read?.() != null;
    if (hasAutosave) await press(DOWN);
    await press(CIRCLE);
    for (let i = 0; i < 6; i++) await globalThis.__pocketTestStep();
    const loaded = at();
    p.paint();
    return {
      channel: menu.channel(), saveRow, saveRoot, saveSlots,
      saveTitle: saveMessage.kind === "message" ? saveMessage.title : null,
      stored, saved, walked, loadRow, loadOpened, hasAutosave,
      closed: menu.menu().kind, toast: menu.toast(), loaded,
    };
  })()`);
  check("browser Save writes a real manual slot while offline",
    saveLoad.channel === "browser" && saveLoad.saveRoot === "root" && saveLoad.saveSlots === "slots-save" &&
    typeof saveLoad.saveTitle === "string" && /SAVED TO SLOT 1/.test(saveLoad.saveTitle) && Number(saveLoad.stored) > 100,
    saveLoad);
  check("browser Load restores the moved world while offline",
    saveLoad.walked !== saveLoad.saved && saveLoad.loaded === saveLoad.saved && saveLoad.closed === "closed" &&
    saveLoad.toast === "Loaded slot 1",
    saveLoad);
  await browser.screenshot("offline-save-loaded.png");
  report.saveLoad = saveLoad;

  // A distant map was never demand-loaded. Its rejected chunk must become a
  // recoverable bilingual alert, not a fatal exception or a lost game state.
  const beforeMissingErrors = browser.errors.length;
  const residentBeforeMissing = await browser.evaluate<string[]>(
    `globalThis.__pocketPlayer.pakChunks.stats().resident.slice()`,
  );
  const missingTarget = journey.checkpoints.find((checkpoint) => checkpoint.frame > bedroom.frame &&
    !residentBeforeMissing.includes(`map:en_US:${checkpoint.map}`) &&
    pakManifestA.chunks.some((chunk) => chunk.id === `map:en_US:${checkpoint.map}`));
  check("maintained opening has a future map outside the resident working set", missingTarget !== undefined, {
    residentMaps: residentBeforeMissing.filter((id) => id.startsWith("map:en_US:")),
  });
  const missingChunk = pakManifestA.chunks.find((chunk) => chunk.id === `map:en_US:${missingTarget.map}`)!;
  const cacheRemoval = await browser.evaluate<JsonObject>(`(async () => {
    const cache = await caches.open("pocket-rpgkit:pak-chunks:v1");
    const url = new URL(${JSON.stringify(missingChunk.file)}, location.href).href;
    const removed = await cache.delete(url);
    return { url, removed, remains: !!(await cache.match(url)) };
  })()`);
  check("selected future map is absent from the persistent content cache",
    cacheRemoval.remains === false,
    { target: missingTarget, chunk: missingChunk.file, cacheRemoval });
  const missingAttempt = await browser.evaluate<JsonObject>(`(async () => {
    const masks = ${JSON.stringify(journey.masks.slice(bedroom.frame + 1, missingTarget.frame + 1))};
    const p = globalThis.__pocketPlayer;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const at = () => [__rpgSessionState.mapId, __rpgSessionState.move.tx, __rpgSessionState.move.ty].join(",");
    let resolvedBlocks = 0;
    for (const mask of masks) {
      const before = at();
      p.buttons = () => mask;
      p.step();
      if (!p.frameBlocked) continue;
      const deadline = performance.now() + 30000;
      while (p.frameBlocked && performance.now() < deadline) {
        while (p.pakChunks?.blocking && performance.now() < deadline) await sleep(1);
        await sleep(1);
        p.step();
        if (globalThis.__pocketPwa?.view?.().missing) {
          return { failed: true, before, after: at(), map: __rpgSessionState.mapId,
            prompt: true, resolvedBlocks, pak: p.pakChunks?.stats?.() };
        }
      }
      if (p.frameBlocked) throw new Error("PWA verifier: blocked map did not resolve or report failure");
      resolvedBlocks++;
    }
    return { failed: false, before: at(), after: at(), map: __rpgSessionState.mapId,
      resolvedBlocks, pak: p.pakChunks?.stats?.() };
  })()`);
  check("maintained journey reaches an uncached map transition offline",
    missingAttempt.failed === true && missingAttempt.prompt === true, missingAttempt);
  const beforeMissing = String(missingAttempt.before);
  const missingView = await browser.waitFor<PwaView>("offline missing-content dialog",
    `globalThis.__pocketPwa?.view?.().missing ? globalThis.__pocketPwa.view() : false`, 30_000);
  const missingEvidence = await browser.evaluate<JsonObject>(`(() => {
    const panel = document.getElementById("offline-missing");
    const card = panel.querySelector(".offline-missing-card");
    const rect = card.getBoundingClientRect();
    return {
      title: document.getElementById("offline-missing-title").textContent,
      text: document.getElementById("offline-missing-text").textContent,
      retryDisabled: document.getElementById("offline-missing-retry").disabled,
      returnText: document.getElementById("offline-missing-return").textContent,
      role: panel.getAttribute("role"),
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
        viewportWidth: innerWidth, viewportHeight: innerHeight },
      messages: globalThis.__pocketPwaVerifierMessages.filter((message) => message?.type === "OFFLINE_CHUNK_MISSING"),
      location: [__rpgSessionState.mapId, __rpgSessionState.move.tx, __rpgSessionState.move.ty].join(","),
      blocked: __pocketPlayer.frameBlocked,
    };
  })()`);
  check("uncached map shows explicit bilingual #offline-missing recovery UI",
    missingView.missing === true && missingEvidence.role === "alertdialog" &&
    typeof missingEvidence.title === "string" && missingEvidence.title.includes("Offline content unavailable") && missingEvidence.title.includes("离线内容尚未下载") &&
    typeof missingEvidence.text === "string" && missingEvidence.text.includes(missingTarget.map) &&
    missingView.missingMap === missingTarget.map && missingView.missingEntry === `maps/${missingTarget.map}.rkm` &&
    missingEvidence.retryDisabled === true && missingEvidence.location === beforeMissing &&
    String((missingAttempt.pak as { failures?: Record<string, string> })?.failures?.[`map:en_US:${missingTarget.map}`] ?? "")
      .includes(missingChunk.file),
    missingEvidence);
  const missingMessages = missingEvidence.messages as WorkerMessage[];
  check("background chunk failures do not masquerade as a map transition",
    missingMessages.length === 0, missingMessages);
  const missingPng = await browser.screenshot("offline-missing.png");
  const border = goldBorderPixels(missingPng, missingEvidence.rect as Parameters<typeof goldBorderPixels>[1]);
  check("missing-dialog screenshot contains the semantic gold card border",
    Number(border.nearGold) >= 300 && Number(border.topCenterDistance) <= 24,
    border);
  const returnTimeOrigin = await browser.evaluate<number>(`performance.timeOrigin`);
  await browser.evaluate(`document.getElementById("offline-missing-return").click()`);
  const recovered = await browser.waitFor<JsonObject>("Return to cached game recovery", `(() => {
    const view = globalThis.__pocketPwa?.view?.();
    if (performance.timeOrigin === ${returnTimeOrigin} || !view || view.missing || !view.mapPrepareWrapped ||
        globalThis.__pocketPlayer.frameBlocked || globalThis.__pocketPlayer.state !== "running") return false;
    return { view, location: [__rpgSessionState.mapId, __rpgSessionState.move.tx, __rpgSessionState.move.ty].join(","),
      frame: __rpgSessionState.frame,
      stored: (localStorage.getItem("pocket-tuxemon/save/slot-1") || "").length };
  })()`);
  const recoveredFrame = Number(recovered.frame);
  await browser.evaluate(`(async () => { __pocketPlayer.buttons = () => 0; await __pocketTestStep(); })()`);
  const afterRecoveryFrame = await browser.evaluate<number>(`__rpgSessionState.frame`);
  check("Return leaves the failed transition, reloads cached gameplay, and preserves the offline save",
    String(recovered.location).startsWith("spyder_bedroom,") && Number(recovered.stored) === Number(saveLoad.stored) &&
    afterRecoveryFrame === recoveredFrame + 1 && browser.errors.length === beforeMissingErrors,
    { beforeMissing, recovered, afterRecoveryFrame, errors: browser.errors.slice(beforeMissingErrors) });
  report.missing = { view: missingView, evidence: missingEvidence, border, recovered };

  // Start the complete English package with enough response latency to make
  // an actual transport interruption observable. The page's online listener,
  // not this verifier, must resume it after CDP reconnects the browser.
  await setConnectivity(false);
  chunkDelayMs = 20;
  const chunkRequestsBefore = counts.A.chunks;
  await browser.evaluate(`globalThis.__pocketPwa.download("en")`);
  const partial = await browser.waitFor<WorkerMessage>("partial English offline download", `(() => {
    const rows = globalThis.__pocketPwaVerifierMessages.filter((message) =>
      message?.type === "OFFLINE_PROGRESS" && message.language === "en" &&
      message.completed >= 8 && message.completed < message.total);
    return rows.at(-1) || false;
  })()`, 60_000);
  check("English package begins under release A", partial.build === receiptA.version && partial.completed! < partial.total!, partial);
  await setConnectivity(true);
  const interrupted = await browser.waitFor<WorkerMessage>("interrupted English offline download", `(() => {
    const rows = globalThis.__pocketPwaVerifierMessages.filter((message) =>
      message?.type === "OFFLINE_ERROR" && message.language === "en");
    const view = globalThis.__pocketPwa?.view?.();
    return rows.length && view && !view.downloading && /interrupted/i.test(view.status) ? rows.at(-1) : false;
  })()`, 30_000);
  check("disconnect leaves an explicitly resumable partial package",
    interrupted.build === receiptA.version && Number(interrupted.completed) >= Number(partial.completed) && Number(interrupted.completed) < Number(interrupted.total),
    interrupted);
  const cachedBeforeResume = await browser.evaluate<string[]>(`(async () => {
    const cache = await caches.open("pocket-rpgkit:pak-chunks:v1");
    return (await cache.keys()).map((request) => new URL(request.url).pathname)
      .filter((path) => path.startsWith(${JSON.stringify(`${GAME_PATH}chunks/`)})).sort();
  })()`);
  const requestsBeforeResume = Object.fromEntries(cachedBeforeResume.map((path) =>
    [path, counts.A.chunkFiles[path] ?? 0]));
  await setConnectivity(false);
  const complete = await browser.waitFor<WorkerMessage>("automatic English download resume", `(() => {
    const rows = globalThis.__pocketPwaVerifierMessages.filter((message) =>
      message?.type === "OFFLINE_COMPLETE" && message.language === "en");
    const view = globalThis.__pocketPwa?.view?.();
    return rows.length && view && !view.downloading && /Ready offline/.test(view.status) ? rows.at(-1) : false;
  })()`, 180_000);
  chunkDelayMs = 0;
  check("reconnect automatically completes the full English package",
    complete.build === receiptA.version && complete.completed === complete.total &&
    complete.total === receiptA.packages.en.chunks && complete.totalBytes === receiptA.packages.en.bytes &&
    counts.A.chunks > chunkRequestsBefore,
    { complete, chunkRequests: counts.A.chunks - chunkRequestsBefore });
  const redownloaded = cachedBeforeResume.filter((path) =>
    (counts.A.chunkFiles[path] ?? 0) !== requestsBeforeResume[path]);
  check("resume reuses every chunk already durable at interruption",
    cachedBeforeResume.length >= Number(interrupted.completed) - 1 && redownloaded.length === 0,
    { cachedBeforeResume: cachedBeforeResume.length, redownloaded });
  await browser.screenshot("offline-package-ready.png");
  report.download = {
    partial,
    interrupted,
    complete,
    cachedBeforeResume: cachedBeforeResume.length,
    redownloaded,
    chunkRequests: counts.A.chunks - chunkRequestsBefore,
  };

  // Mixed mode exposes B's page/assets while retaining A at the stable worker
  // URL. A's navigation policy must reject the B page and keep running its
  // cached A page. Once the complete B release appears, it may install in the
  // waiting slot and activate only after the visible update control is used.
  mode = "mixed";
  await browser.navigate(`${base}?pwa_probe=mixed`, "mixed-release navigation");
  const mixed = await waitPwa("atomic mixed-release fallback", receiptA.version, true);
  const mixedChunk = await browser.evaluate<JsonObject>(`(() => {
    const asset = globalThis.__pocketPlayer.pakChunks.manifest.chunks.find((chunk) =>
      chunk.id === ${JSON.stringify(rotatedChunk.id)});
    return asset ? { file: asset.file, bytes: asset.bytes, sha256: asset.sha256 } : {};
  })()`);
  check("mixed B page plus A worker executes only the matched A release",
    mixed.build === receiptA.version && mixed.workerBuild === receiptA.version && counts.mixed.index > 0 &&
    mixedChunk.file === rotatedChunk.A.file && mixedChunk.sha256 === rotatedChunk.A.sha256,
    { mixed, mixedChunk, requests: counts.mixed });
  await browser.screenshot("update-mixed-stays-a.png");

  mode = "B";
  await browser.evaluate(`navigator.serviceWorker.getRegistration().then((registration) => registration.update())`);
  const waiting = await browser.waitFor<JsonObject>("complete B worker waiting", `navigator.serviceWorker.getRegistration().then((registration) => {
    const view = globalThis.__pocketPwa?.view?.();
    if (!registration?.waiting || !view || view.build !== ${JSON.stringify(receiptA.version)} ||
        view.workerBuild !== ${JSON.stringify(receiptA.version)}) return false;
    return { waiting: registration.waiting.state, active: registration.active?.state,
      updateVisible: !document.getElementById("pwa-update").hidden, view };
  })`, 90_000);
  check("complete B waits while the controlled page remains matched A/A",
    waiting.waiting === "installed" && waiting.updateVisible === true,
    waiting);
  await browser.evaluate(`document.getElementById("pwa-update").click()`);
  const updated = await browser.waitFor<PwaView & JsonObject>("B activation and reload", `(() => {
    const view = ${pwaState};
    return view && view.build === ${JSON.stringify(builtB.version)} &&
      view.workerBuild === ${JSON.stringify(builtB.version)} &&
      view.mapPrepareWrapped === true &&
      globalThis.__pocketPwaVerifierRelease === "B" &&
      globalThis.__pocketPlayer?.state === "running" && globalThis.__rpgSessionState ? view : false;
  })()`, 90_000);
  const cacheKeys = await browser.evaluate<string[]>(`caches.keys()`);
  const shellCacheFor = (version: string): string | undefined => cacheKeys.find((name) =>
    name.startsWith("pocket-tuxemon:shell:v1:") && name.endsWith(`:${version}`));
  const updatedChunk = await browser.evaluate<JsonObject>(`(async () => {
    const asset = globalThis.__pocketPlayer.pakChunks.manifest.chunks.find((chunk) =>
      chunk.id === ${JSON.stringify(rotatedChunk.id)});
    if (!asset) return {};
    const url = new URL(asset.file, location.href);
    const response = await fetch(url);
    const bytes = await response.arrayBuffer();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
      byte.toString(16).padStart(2, "0")).join("");
    const cache = await caches.open("pocket-rpgkit:pak-chunks:v1");
    return { file: asset.file, expectedBytes: asset.bytes, bytes: bytes.byteLength,
      expectedSha256: asset.sha256, sha256: digest, cached: !!(await cache.match(url.href)),
      stored: (localStorage.getItem("pocket-tuxemon/save/slot-1") || "").length };
  })()`);
  check("activation converges atomically on matched B page and worker",
    updated.build === builtB.version && updated.workerBuild === builtB.version &&
    updated.map === "spyder_bedroom" &&
    shellCacheFor(builtB.version) !== undefined && shellCacheFor(receiptA.version) === undefined,
    { updated, cacheKeys });
  check("release B uses and verifies its rotated content chunk, never A's filename",
    updatedChunk.file === rotatedChunk.B.file && updatedChunk.file !== rotatedChunk.A.file &&
    updatedChunk.bytes === rotatedChunk.B.bytes && updatedChunk.expectedBytes === rotatedChunk.B.bytes &&
    updatedChunk.sha256 === rotatedChunk.B.sha256 && updatedChunk.expectedSha256 === rotatedChunk.B.sha256 &&
    updatedChunk.cached === true && Number(updatedChunk.stored) === Number(saveLoad.stored) &&
    counts.B.chunkFiles[`${GAME_PATH}${rotatedChunk.B.file}`] > 0,
    { updatedChunk, requests: counts.B.chunkFiles });
  await browser.screenshot("update-complete-b.png");
  report.update = { mixed, mixedChunk, waiting, updated, updatedChunk, cacheKeys };

  check("acceptance run has no uncaught page exception or console error", browser.errors.length === 0, browser.errors);
  report.browserErrors = browser.errors;
  report.server = { counts, finalMode: mode };
  report.ok = true;
}

try {
  await main();
} catch (error) {
  report.fatal = errorText(error);
  console.error(report.fatal);
  process.exitCode = 1;
} finally {
  cleanupNow();
  writeReport();
}

if (report.ok) {
  console.log(`verify-web-pwa: ${report.checks.length} checks passed; evidence in ${OUT}`);
}

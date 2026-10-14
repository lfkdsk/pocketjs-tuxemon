// Measure the exact pak entries read by the production Web bundle at three
// startup milestones. The server injects one observation call into the built
// pak reader in memory; it never changes the published bundle. Exhaustive
// background fetching is disabled after boot so the network snapshots contain
// only startup residency, demand loads and bounded working-set prefetch.

import { gunzipSync } from "node:zlib";
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
import { registerCleanup, spawnHeadlessChrome } from "./headless-chrome.ts";
import { WEB_CHUNK_AWARE_STEP_SOURCE } from "./web-chunk-step.ts";

const ROOT = resolve(import.meta.dir, "..");
const SITE = resolve(ROOT, "dist/web");
const APP = join(SITE, "pocket-tuxemon");
const OUT = resolve(ROOT, "reports/web-pak-milestones.json");
const BUNDLE = join(APP, "pocket-tuxemon.js");
const MANIFEST_PATH = join(APP, "pocket-tuxemon.pak-manifest.json");
const JOURNEY_PATH = join(ROOT, "data/g6-journey.json");
const chromeFlag = process.argv.indexOf("--chrome");
const CHROME = chromeFlag >= 0 ? process.argv[chromeFlag + 1]! :
  process.env.CHROME ?? Bun.which("google-chrome") ?? Bun.which("chromium") ?? "google-chrome";

if (![BUNDLE, MANIFEST_PATH, JOURNEY_PATH].every(existsSync)) {
  throw new Error("measure-web-pak-reads: run `bun run web` first");
}

interface ManifestAsset {
  file: string;
  bytes: number;
  unpackedBytes: number;
}

interface ManifestChunk extends ManifestAsset {
  id: string;
  entries: string[];
}

interface Manifest {
  startup: ManifestAsset;
  chunks: ManifestChunk[];
}

interface ReadCount {
  calls: number;
}

interface BrowserSnapshot {
  reads: Record<string, ReadCount>;
  requestedChunks: string[];
  pak: {
    startupBytes: number;
    resident: string[];
    pending: string[];
    queued: string[];
    blocking: string[];
    failures: Record<string, string>;
    compressedBytes: number;
  };
  state: {
    frame: number;
    mapId: string;
    position: [number, number];
    scene: string | null;
    title: string;
  };
}

interface PakDirectoryEntry {
  bytes: number;
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
const journey = JSON.parse(readFileSync(JOURNEY_PATH, "utf8")) as { masks: number[] };

function instrumentBundle(source: string): string {
  const marker = source.indexOf('"pak: missing key "');
  if (marker < 0) throw new Error("measure-web-pak-reads: pak reader marker disappeared");
  const functionStart = source.lastIndexOf("function ", marker);
  if (functionStart < 0) throw new Error("measure-web-pak-reads: pak reader function disappeared");
  const signature = source.slice(functionStart).match(
    /^function\s+[A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)=0,([A-Za-z_$][\w$]*)\)\{/,
  );
  if (!signature) throw new Error("measure-web-pak-reads: pak reader signature changed");
  const insertAt = functionStart + signature[0].length;
  const [key, start, end] = signature.slice(1);
  const observation = `globalThis.__webPakRead?.(${key},${start},${end});`;
  return source.slice(0, insertAt) + observation + source.slice(insertAt);
}

function parsePak(bytes: Uint8Array): Map<string, PakDirectoryEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 32 || view.getUint32(0, true) !== 0x4b504344 || view.getUint16(4, true) !== 1) {
    throw new Error("measure-web-pak-reads: invalid pak");
  }
  const count = view.getUint32(8, true);
  const directory = view.getUint32(12, true);
  const names = view.getUint32(16, true);
  const decoder = new TextDecoder();
  const entries = new Map<string, PakDirectoryEntry>();
  for (let index = 0; index < count; index++) {
    const row = directory + index * 24;
    const length = view.getUint32(row + 8, true);
    const nameStart = names + view.getUint32(row + 12, true);
    const nameLength = view.getUint16(row + 16, true);
    entries.set(decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)), { bytes: length });
  }
  return entries;
}

const startupDirectory = parsePak(gunzipSync(readFileSync(join(APP, manifest.startup.file))));
const ownerByEntry = new Map<string, ManifestChunk>();
for (const chunk of manifest.chunks) {
  for (const entry of chunk.entries) ownerByEntry.set(entry, chunk);
}
const parsedChunks = new Map<string, Map<string, PakDirectoryEntry>>();
function entryBytes(key: string): number {
  const startup = startupDirectory.get(key);
  if (startup) return startup.bytes;
  const owner = ownerByEntry.get(key);
  if (!owner) throw new Error(`measure-web-pak-reads: no owner for ${key}`);
  let directory = parsedChunks.get(owner.id);
  if (!directory) {
    directory = parsePak(gunzipSync(readFileSync(join(APP, owner.file))));
    parsedChunks.set(owner.id, directory);
  }
  const entry = directory.get(key);
  if (!entry) throw new Error(`measure-web-pak-reads: ${owner.id} does not contain ${key}`);
  return entry.bytes;
}

const instrumentedBundle = instrumentBundle(readFileSync(BUNDLE, "utf8"));
const requestedChunks: string[] = [];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    let path = resolve(SITE, `.${decodeURIComponent(url.pathname)}`);
    if (!path.startsWith(SITE)) return new Response("forbidden", { status: 403 });
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
    if (path === BUNDLE) return new Response(instrumentedBundle, {
      headers: { "content-type": "text/javascript; charset=utf-8" },
    });
    if (!existsSync(path)) return new Response("not found", { status: 404 });
    if (url.pathname.includes("/chunks/") && url.pathname.endsWith(".pak.gz")) {
      requestedChunks.push(url.pathname);
    }
    return new Response(Bun.file(path), { headers: { "cache-control": "no-store" } });
  },
});
registerCleanup(() => server.stop(true));

const profile = resolve(ROOT, "dist/web-pak-milestones-profile");
rmSync(profile, { recursive: true, force: true });
const chrome = await spawnHeadlessChrome(CHROME, profile);
registerCleanup(() => chrome.close());
const ws = new WebSocket(chrome.wsUrl);
await new Promise<void>((resolveOpen, reject) => {
  ws.addEventListener("open", () => resolveOpen(), { once: true });
  ws.addEventListener("error", () => reject(new Error("Chrome DevTools socket failed")), { once: true });
});

let nextId = 0;
const pending = new Map<number, (message: any) => void>();
const errors: string[] = [];
ws.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id !== undefined) {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  } else if (message.method === "Runtime.exceptionThrown") {
    errors.push(message.params.exceptionDetails?.exception?.description ?? "exception");
  } else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    errors.push(message.params.args.map((arg: any) => arg.value ?? arg.description).join(" "));
  }
});
const send = (method: string, params: Record<string, unknown> = {}): Promise<any> =>
  new Promise((resolveSend, rejectSend) => {
    const id = ++nextId;
    pending.set(id, (message) => message.error
      ? rejectSend(new Error(message.error.message))
      : resolveSend(message.result));
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async <T>(expression: string): Promise<T> => {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value as T;
};

await send("Runtime.enable");
await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `globalThis.__pocketTuxemonInitialCivilTime = ${JSON.stringify(FIXED_INITIAL_CIVIL_TIME)};
globalThis.__pocketTuxemonShowTitle = true;
globalThis.__webPakReads = Object.create(null);
globalThis.__webPakRead = (key) => {
  const row = globalThis.__webPakReads[key] || (globalThis.__webPakReads[key] = { calls: 0 });
  row.calls++;
};
window.requestAnimationFrame = () => 0; window.cancelAnimationFrame = () => {};
${WEB_CHUNK_AWARE_STEP_SOURCE}`,
});
await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/pocket-tuxemon/` });
for (let attempt = 0; attempt < 600; attempt++) {
  const ready = await evaluate<boolean>(`!!(globalThis.__pocketPlayer &&
    globalThis.__pocketPlayer.state === "running" &&
    globalThis.__rpgSessionState &&
    globalThis.__pocketTitleBattle?.state().screen === "title" &&
    globalThis.__pocketTitleBattle.titleRows().includes("newGame"))`).catch(() => false);
  if (ready) break;
  if (attempt === 599) throw new Error("measure-web-pak-reads: title did not boot");
  await Bun.sleep(10);
}

// The host scheduled exhaustive background work after its first paint. Replace
// only that throughput method before its one-second grace period expires; map
// working-set prefetch and demand promotion remain the production paths.
await evaluate(`(() => {
  const chunks = globalThis.__pocketPlayer.pakChunks;
  if (!chunks) throw new Error("missing Web chunk loader");
  chunks.startBackground = () => {};
})()`);

const snapshot = async (): Promise<BrowserSnapshot> => evaluate(`(() => {
  const state = globalThis.__rpgSessionState;
  return {
    reads: globalThis.__webPakReads,
    requestedChunks: ${JSON.stringify(requestedChunks)},
    pak: globalThis.__pocketPlayer.pakChunks.stats(),
    state: {
      frame: state.frame,
      mapId: state.mapId,
      position: [state.move.tx, state.move.ty],
      scene: state.scene?.kind ?? null,
      title: globalThis.__pocketTitleBattle.state().screen,
    },
  };
})()`);

const title = await snapshot();
const entered = await evaluate<boolean>(`(async () => {
  const title = globalThis.__pocketTitleBattle;
  const index = title.titleRows().indexOf("newGame");
  if (index < 0) return false;
  title.selectTitle(index);
  const p = globalThis.__pocketPlayer;
  p.buttons = () => 0;
  await globalThis.__pocketTestStep();
  await globalThis.__pocketTestStep();
  return title.state().screen === "closed" &&
    globalThis.__rpgSessionState.mapId === "spyder_bedroom" &&
    globalThis.__rpgSessionState.frame === 1;
})()`);
if (!entered) throw new Error("measure-web-pak-reads: New Game did not reach the first playable map");
const firstMap = await snapshot();

const battleFrame = await evaluate<number>(`(async () => {
  const masks = ${JSON.stringify(journey.masks)};
  const p = globalThis.__pocketPlayer;
  for (let frame = 1; frame < masks.length; frame++) {
    p.buttons = () => masks[frame];
    await globalThis.__pocketTestStep();
    const scene = globalThis.__rpgSessionState.scene;
    const state = scene?.state;
    const presenting = !!(state?.battle && Array.isArray(state.battle.events) &&
      state.eventCursor !== undefined && state.eventCursor < state.battle.events.length &&
      state.battle.events[state.eventCursor] != null);
    if (scene?.kind === "battle" && state?.menuMode === "root" &&
        state?.battle?.awaiting && !presenting) return frame;
  }
  return -1;
})()`);
if (battleFrame < 0) throw new Error("measure-web-pak-reads: opening tape did not reach an interactive battle menu");
const firstBattle = await snapshot();

function summarize(current: BrowserSnapshot, previous?: BrowserSnapshot) {
  const previousKeys = new Set(Object.keys(previous?.reads ?? {}));
  const rows = Object.entries(current.reads)
    .map(([key, value]) => ({ key, bytes: entryBytes(key), calls: value.calls }))
    .sort((left, right) => left.key.localeCompare(right.key));
  const added = rows.filter((row) => !previousKeys.has(row.key));
  const contentFiles = current.requestedChunks.map((path) => join(SITE, path));
  return {
    state: current.state,
    uniqueEntries: rows.length,
    uniquePayloadBytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    calls: rows.reduce((sum, row) => sum + row.calls, 0),
    addedEntries: added.length,
    addedPayloadBytes: added.reduce((sum, row) => sum + row.bytes, 0),
    requestedContentFiles: current.requestedChunks,
    requestedContentBytes: contentFiles.reduce((sum, path) => sum + statSync(path).size, 0),
    residentChunkIds: current.pak.resident,
    loaderCompressedBytes: current.pak.compressedBytes,
    entries: rows,
    added,
  };
}

const report = {
  format: "pocket-tuxemon-web-pak-milestones/v1",
  method: "production bundle with an in-memory pakGet observation; exhaustive background queue disabled",
  startup: manifest.startup,
  battleTapeFrame: battleFrame,
  milestones: {
    titleInteractive: summarize(title),
    firstMapInteractive: summarize(firstMap, title),
    firstBattleInteractive: summarize(firstBattle, firstMap),
  },
  consoleErrors: errors,
  result: errors.length === 0 ? "PASS" : "FAIL",
};
mkdirSync(resolve(ROOT, "reports"), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  battleTapeFrame: battleFrame,
  title: report.milestones.titleInteractive,
  firstMap: report.milestones.firstMapInteractive,
  firstBattle: report.milestones.firstBattleInteractive,
  consoleErrors: errors,
  result: report.result,
}, (key, value) => key === "entries" || key === "added" ? undefined : value, 2));
process.exit(report.result === "PASS" ? 0 : 1);

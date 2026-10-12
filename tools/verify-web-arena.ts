// Browser acceptance for the separately bundled Arena replay page.
//
// Run `bun run web` first. Pass --update only when intentionally reviewing
// and replacing the committed battle-frame goldens.

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

import {
  createArenaBattle,
  defaultAction,
  isOver,
  submit,
  tape,
  type BattleTape,
} from "../battle/arena.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tools/png.ts";
import { registerCleanup, spawnHeadlessChrome } from "./headless-chrome.ts";

const ROOT = resolve(import.meta.dir, "..");
const SITE = join(ROOT, "dist", "web");
const OUT = join(ROOT, "dist", "web-arena");
const GOLDENS = join(ROOT, "tests", "goldens", "arena-replay");
const UPDATE = process.argv.includes("--update");
const chromeFlag = process.argv.indexOf("--chrome");
const CHROME = chromeFlag >= 0 ? process.argv[chromeFlag + 1]! :
  process.env.CHROME ?? Bun.which("google-chrome") ?? Bun.which("chromium") ?? "google-chrome";
const GAME = "pocket-tuxemon";

if (!existsSync(join(SITE, GAME, "replay.html"))) {
  console.error("verify-web-arena: no replay page in dist/web; run `bun run web` first");
  process.exit(2);
}
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(GOLDENS, { recursive: true });

function recording(): BattleTape {
  let battle = createArenaBattle({
    seed: "0123456789abcdef".repeat(4),
    format: "single",
    sides: [{ kind: "agent" }, { kind: "ai", difficulty: "normal" }],
  });
  while (!isOver(battle)) {
    const answer = submit(battle, 0, defaultAction(battle, 0));
    if (!answer.ok) throw new Error(`verify-web-arena: fixture action rejected: ${answer.error}`);
    battle = answer.battle;
  }
  const result = tape(battle);
  if (result.actions.length < 4) throw new Error("verify-web-arena: fixture tape is too short");
  return result;
}

const ARENA_TAPE = recording();
const ARENA_JSON = JSON.stringify(ARENA_TAPE);
const MALICIOUS_JSON = JSON.stringify({
  ...ARENA_TAPE,
  script: "globalThis.__arenaReplayExecuted = true",
});

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === `/${GAME}/arena-tape.json`) {
      return new Response(ARENA_JSON, { headers: { "content-type": "application/json" } });
    }
    let path = resolve(SITE, `.${decodeURIComponent(url.pathname)}`);
    if (!path.startsWith(SITE)) return new Response("forbidden", { status: 403 });
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
    return existsSync(path) ? new Response(Bun.file(path)) : new Response("not found", { status: 404 });
  },
});
registerCleanup(() => server.stop(true));

const chrome = await spawnHeadlessChrome(CHROME, join(OUT, "profile"), "1280,900");
registerCleanup(() => chrome.close());
const ws = new WebSocket(chrome.wsUrl);
await new Promise<void>((resolveOpen) => ws.addEventListener("open", () => resolveOpen(), { once: true }));
registerCleanup(() => ws.close());

let sequence = 0;
const pending = new Map<number, (message: any) => void>();
const errors: string[] = [];
const requests: string[] = [];
ws.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id !== undefined) {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  } else if (message.method === "Runtime.exceptionThrown") {
    errors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? "exception");
  } else if (message.method === "Runtime.consoleAPICalled" && ["error", "assert"].includes(message.params.type)) {
    errors.push(message.params.args.map((arg: any) => arg.value ?? arg.description).join(" "));
  } else if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
    errors.push(message.params.entry.text);
  } else if (message.method === "Network.loadingFailed" && !message.params.canceled) {
    errors.push(`request failed: ${message.params.errorText}`);
  } else if (message.method === "Network.requestWillBeSent") {
    requests.push(message.params.request.url);
  }
});

const send = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<any>((resolveMessage, reject) => {
    const id = ++sequence;
    pending.set(id, (message) => message.error
      ? reject(new Error(message.error.message))
      : resolveMessage(message.result));
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async <T = any>(expression: string): Promise<T> => {
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
await send("Log.enable");
await send("Network.enable");
await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.requestAnimationFrame = () => 0;
    window.cancelAnimationFrame = () => {};
    globalThis.__arenaReplayExecuted = false;
  `,
});

const base = `http://127.0.0.1:${server.port}/${GAME}/`;
const waitFor = async (label: string, expression: string, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression).catch(() => false)) return;
    await evaluate(`globalThis.__pocketPlayer && globalThis.__pocketPlayer.step()`).catch(() => {});
    await Bun.sleep(50);
  }
  throw new Error(`verify-web-arena: timeout waiting for ${label}`);
};
const stepFrames = async (count: number): Promise<void> => {
  await evaluate(`(() => { const p = globalThis.__pocketPlayer; for (let i = 0; i < ${count}; i++) p.step(); })()`);
};
const inlineSource = (json: string): string =>
  encodeURIComponent(`data:application/json,${encodeURIComponent(json)}`);

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function bootReplay(query: string): Promise<void> {
  await send("Page.navigate", { url: `${base}replay.html?${query}` });
  await waitFor(
    "validated replay",
    `!!(globalThis.__pocketPlayer && globalThis.__pocketPlayer.state === "running" && ` +
      `globalThis.__pocketArenaReplay && globalThis.__pocketArenaReplay.state().status === "ready")`,
  );
  await evaluate(`globalThis.__pocketArenaReplay.pause()`);
  await evaluate(`globalThis.__pocketPlayer.paint()`);
}

// The ordinary player must not request, import, or configure replay assets.
const requestStart = requests.length;
await send("Page.navigate", { url: base });
await waitFor("ordinary player", `!!(globalThis.__pocketPlayer && globalThis.__pocketPlayer.state === "running")`);
await stepFrames(5);
const ordinaryRequests = requests.slice(requestStart);
check(
  "ordinary player does not request replay assets",
  !ordinaryRequests.some((url) => /battle-replay\.(?:js|pak)(?:$|\?)/.test(url)),
  ordinaryRequests.filter((url) => url.includes("battle-replay")).join(", ") || "no replay requests",
);
const normalConfig = JSON.parse(readFileSync(join(SITE, GAME, "index.html"), "utf8")
  .match(/<script type="application\/json" id="pocket-game">(.*?)<\/script>/s)![1]!) as Record<string, unknown>;
check(
  "ordinary player keeps the production bundle and pak",
  normalConfig.bundle === "pocket-tuxemon.js" && normalConfig.pak === "pocket-tuxemon.pak",
  `${String(normalConfig.bundle)} / ${String(normalConfig.pak)}`,
);

// Same-origin loading and every playback control.
await bootReplay(`lang=en&battleReplay=${encodeURIComponent("arena-tape.json")}`);
const english = await evaluate<{
  title: string;
  play: string;
  step: string;
  speed: string;
  lang: string;
  total: number;
}>(`({
  title: document.getElementById("arena-replay-title")?.textContent,
  play: document.getElementById("arena-replay-play")?.textContent,
  step: document.getElementById("arena-replay-step")?.textContent,
  speed: document.getElementById("arena-replay-speed-label")?.textContent,
  lang: document.documentElement.lang,
  total: globalThis.__pocketArenaReplay.state().total,
})`);
check(
  "English replay controls are visible",
  english.title === "Battle replay" && english.play === "Play" && english.step === "Step" &&
    english.speed === "Speed" && english.lang === "en" && english.total === ARENA_TAPE.actions.length,
  JSON.stringify(english),
);

const pausedBefore = await evaluate<number>(`globalThis.__pocketArenaReplay.state().turn`);
await stepFrames(120);
const pausedAfter = await evaluate<number>(`globalThis.__pocketArenaReplay.state().turn`);
check("Pause stops automatic advancement", pausedAfter === pausedBefore, `${pausedBefore} -> ${pausedAfter}`);
await evaluate(`document.getElementById("arena-replay-step").click()`);
const steppedTurn = await evaluate<number>(`globalThis.__pocketArenaReplay.state().turn`);
check("Step advances exactly one simultaneous pair", steppedTurn === pausedBefore + 1, `${pausedBefore} -> ${steppedTurn}`);

for (const [speed, before, boundary] of [[1, 59, 60], [2, 29, 30], [4, 14, 15]] as const) {
  await evaluate(`globalThis.__pocketArenaReplay.restart(); document.getElementById("arena-replay-speed-${speed}").click(); document.getElementById("arena-replay-play").click()`);
  await stepFrames(before);
  const early = await evaluate<number>(`globalThis.__pocketArenaReplay.state().turn`);
  await stepFrames(boundary - before);
  const reached = await evaluate<number>(`globalThis.__pocketArenaReplay.state().turn`);
  check(`${speed}x waits ${boundary} host frames per pair`, early === 0 && reached === 1, `${early} -> ${reached}`);
  await evaluate(`globalThis.__pocketArenaReplay.pause()`);
}

await evaluate(`globalThis.__pocketArenaReplay.restart(); document.getElementById("arena-replay-speed-4").click(); document.getElementById("arena-replay-play").click()`);
await stepFrames(ARENA_TAPE.actions.length * 15 + 2);
const complete = await evaluate<{ turn: number; total: number; playing: boolean; status: string }>(`({
  ...globalThis.__pocketArenaReplay.state(),
  status: document.getElementById("arena-replay-status")?.textContent,
})`);
check(
  "automatic playback reaches the validated terminal boundary",
  complete.turn === complete.total && !complete.playing && complete.status === "Replay complete",
  JSON.stringify(complete),
);

// Inline data input takes the same validation path.
await bootReplay(`lang=en&battleReplay=${inlineSource(ARENA_JSON)}`);
check(
  "application/json data URL loads in the real page",
  await evaluate(`globalThis.__pocketArenaReplay.state().total === ${ARENA_TAPE.actions.length}`),
);

// Chinese host controls and battle catalog are selected before the first paint.
await bootReplay(`lang=zh&battleReplay=${encodeURIComponent("arena-tape.json")}`);
const chinese = await evaluate<{ title: string; play: string; step: string; speed: string; lang: string; controls: string | null }>(`({
  title: document.getElementById("arena-replay-title")?.textContent,
  play: document.getElementById("arena-replay-play")?.textContent,
  step: document.getElementById("arena-replay-step")?.textContent,
  speed: document.getElementById("arena-replay-speed-label")?.textContent,
  lang: document.documentElement.lang,
  controls: document.querySelector(".arena-replay-row")?.getAttribute("aria-label"),
})`);
check(
  "Chinese replay controls and metadata are visible",
  chinese.title === "对战回放" && chinese.play === "播放" && chinese.step === "前进一步" &&
    chinese.speed === "速度" && chinese.lang === "zh-CN" && chinese.controls === "对战回放控制",
  JSON.stringify(chinese),
);

// Script-looking fields are schema errors and are never evaluated.
await send("Page.navigate", {
  url: `${base}replay.html?lang=en&battleReplay=${inlineSource(MALICIOUS_JSON)}`,
});
await waitFor(
  "visible malicious-tape error",
  `!!(globalThis.__pocketArenaReplay && globalThis.__pocketArenaReplay.state().status === "error")`,
);
const malicious = await evaluate<{ executed: boolean; status: string; message: string }>(`({
  executed: globalThis.__arenaReplayExecuted,
  status: globalThis.__pocketArenaReplay.state().status,
  message: document.getElementById("arena-replay-status")?.textContent,
})`);
check(
  "malicious tape fields are rejected without evaluation",
  malicious.executed === false && malicious.status === "error" && malicious.message.startsWith("Could not load tape"),
  JSON.stringify(malicious),
);

// Capture a reviewed battle boundary at both supported raster sizes.
await bootReplay(`lang=en&battleReplay=${encodeURIComponent("arena-tape.json")}`);
const initialHash = await evaluate<string>(`(() => {
  const bytes = new Uint8Array(globalThis.__pocketPlayer.wasm.render());
  let h = 0x811c9dc5;
  for (const byte of bytes) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
})()`);
await evaluate(`document.getElementById("arena-replay-step").click(); globalThis.__pocketPlayer.paint()`);
const capture = await evaluate<{
  logical: string;
  physical: string;
  logicalHash: string;
  physicalSize: [number, number];
}>(`(() => {
  const p = globalThis.__pocketPlayer;
  const toBase64 = (bytes) => {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x4000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x4000));
    }
    return btoa(binary);
  };
  const fnv = (bytes) => {
    let h = 0x811c9dc5;
    for (const byte of bytes) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
    return h.toString(16).padStart(8, "0");
  };
  const logical = new Uint8Array(p.wasm.render());
  const physical = new Uint8Array(p.wasm.renderScaled(2));
  return {
    logical: toBase64(logical),
    physical: toBase64(physical),
    logicalHash: fnv(logical),
    physicalSize: [p.width * 2, p.height * 2],
  };
})()`);
const logical = new Uint8Array(Buffer.from(capture.logical, "base64"));
const physical = new Uint8Array(Buffer.from(capture.physical, "base64"));
check("one replay pair visibly changes the production scene", capture.logicalHash !== initialHash, `${initialHash} -> ${capture.logicalHash}`);
check(
  "captures have the supported 480x272 and 960x544 dimensions",
  logical.length === 480 * 272 * 4 && physical.length === 960 * 544 * 4 &&
    capture.physicalSize[0] === 960 && capture.physicalSize[1] === 544,
  `${logical.length} / ${physical.length} bytes`,
);

function countPixels(
  rgba: Uint8Array,
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  predicate: (red: number, green: number, blue: number) => boolean,
): number {
  let count = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const offset = (y * width + x) * 4;
    if (predicate(rgba[offset]!, rgba[offset + 1]!, rgba[offset + 2]!)) count++;
  }
  return count;
}

const paper = countPixels(logical, 480, 32, 7, 208, 19, (r, g, b) => r > 180 && g > 170 && b > 140);
const hp = countPixels(logical, 480, 64, 24, 204, 32, (r, g, b) =>
  (g > 150 && r < 130 && b < 150) || (r > 190 && g > 60 && g < 230 && b < 130)
);
const palette = new Set<number>();
for (let offset = 0; offset < logical.length; offset += 4) {
  palette.add((logical[offset]! << 16) | (logical[offset + 1]! << 8) | logical[offset + 2]!);
}
check("semantic battle HUD paper is visible", paper > 500, `${paper} paper pixels`);
check("semantic enemy HP fill is visible", hp > 40, `${hp} HP pixels`);
check("battle art has a nontrivial palette", palette.size > 48, `${palette.size} colors`);

function nearest3x(source: Uint8Array, width: number, height: number): Uint8Array {
  const target = new Uint8Array(width * 3 * height * 3 * 4);
  const targetWidth = width * 3;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sourceOffset = (y * width + x) * 4;
    for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
      const targetOffset = ((y * 3 + dy) * targetWidth + x * 3 + dx) * 4;
      target.set(source.subarray(sourceOffset, sourceOffset + 4), targetOffset);
    }
  }
  return target;
}

const images = new Map<string, Buffer>([
  ["battle.480x272.png", encodePNG(logical, 480, 272)],
  ["battle.480x272.3x.png", encodePNG(nearest3x(logical, 480, 272), 1440, 816)],
  ["battle.960x544.png", encodePNG(physical, 960, 544)],
  ["battle.960x544.3x.png", encodePNG(nearest3x(physical, 960, 544), 2880, 1632)],
]);
for (const [name, png] of images) {
  const output = join(OUT, name);
  const golden = join(GOLDENS, name);
  writeFileSync(output, png);
  if (UPDATE) writeFileSync(golden, png);
  const matches = existsSync(golden) && readFileSync(golden).equals(png);
  check(`golden ${name}`, matches, `${createHash("sha256").update(png).digest("hex").slice(0, 16)}`);
}

await Bun.sleep(200);
ws.close();
chrome.close();
server.stop(true);

if (errors.length > 0) {
  for (const error of errors) console.error("browser:", error);
  failures += errors.length;
}
console.log(failures === 0
  ? `WEB ARENA PASS (${ARENA_TAPE.actions.length} pairs, 4 screenshots)`
  : `WEB ARENA FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);

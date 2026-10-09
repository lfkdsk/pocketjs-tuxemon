// tools/verify-web-demo.ts — drive the built web site's demo controls in
// headless Chrome and prove every acceptance behavior:
//
//   1. HTML chapter buttons (>=3, including the final Kernel chapter)
//      jump the running game in place — no page reload — and highlight.
//   2. Deep links ?chapter=, ?map=&x=&y=, ?autoplay=&speed=2 each apply.
//   3. An invalid chapter id is a visible error, not a crash or a reload.
//   4. Autoplay from a chapter for 600 source frames reaches the same state
//      as a reducer-level suffix replay (the verify:chapters contract).
//   5. The same in Chinese (?lang=zh): three chapter buttons restore the
//      Chinese saves, and 600 frames of Autoplay from each of those chapters
//      reach the Chinese reducer state, which is the English chapter's
//      state once the words are set aside (tools/zh-demo-reference.ts).
//   6. English Autoplay from the three chapters before Candy Town
//      (route-3-north, flower-city, captain-returns) reaches the next
//      chapter node past the Nimrod dialog, matching a reducer replay of
//      the English demo tape state for state.
//
//   bun run web && bun tools/verify-web-demo.ts [--chrome PATH]
//
// Screenshots for every check land in dist/web-demo/ and are meant to be
// opened and looked at, not just hash-pinned.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FIXED_INITIAL_CIVIL_TIME } from "../battle/time-weather.ts";
import { createTuxemonSessionOptions } from "../battle/game.ts";
import { decodeEnvelopeText, canonicalJson } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import { restoreSessionSnapshot } from "../vendor/pocket-rpgkit/src/engine/save-restore.ts";
import {
  createSession,
  stepSession,
  type Session,
  type SessionInput,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { WorldTraversalMode } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { chapterWorldTraversal } from "./bake-chapters.ts";
import { chapterReference, liveStateDigests } from "./zh-demo-reference.ts";
import { readInlineProject } from "./generated-project.ts";
import { journeyWorldTraversal } from "./gb6-journey.ts";
import { productionPaginator } from "./zh-tape.ts";
import { registerCleanup, spawnHeadlessChrome } from "./headless-chrome.ts";

const ROOT = resolve(import.meta.dir, "..");
const SITE = resolve(ROOT, "dist/web");
const OUT = resolve(ROOT, "dist/web-demo");
const chromeFlag = process.argv.indexOf("--chrome");
const CHROME = chromeFlag >= 0 ? process.argv[chromeFlag + 1]! :
  process.env.CHROME ?? Bun.which("google-chrome") ?? Bun.which("chromium") ?? "google-chrome";
if (!existsSync(join(SITE, "pocket-tuxemon", "index.html"))) {
  console.error("verify-web-demo: no site at dist/web; run `bun run web` first");
  process.exit(2);
}
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

// --- Node-side reference: replay a chapter's suffix through the reducer ---


function input(mask: number, previous: number): SessionInput {
  const pressed = mask & ~previous;
  return {
    buttons: mask,
    confirmEdge: Boolean(pressed & 0x2000),
    cancelEdge: Boolean(pressed & 0x4000),
    upEdge: Boolean(pressed & 0x0010),
    downEdge: Boolean(pressed & 0x0040),
    leftEdge: Boolean(pressed & 0x0080),
    rightEdge: Boolean(pressed & 0x0020),
  };
}

interface ChapterRef {
  id: string;
  map: string;
  frame: number;
  timelineFrame: number;
  held: number;
  suffixFrames: number;
}

function loadChapters(): {
  chapters: ChapterRef[];
  combined: number[];
  worldTraversal: WorldTraversalMode;
} {
  const file = JSON.parse(readFileSync(join(ROOT, "data/chapters.json"), "utf8"));
  const gb6 = JSON.parse(readFileSync(join(ROOT, "data/gb6-mainline-journey.json"), "utf8"));
  const j1 = JSON.parse(readFileSync(join(ROOT, "data/j1-captainreturns-journey.json"), "utf8"));
  const j2 = JSON.parse(readFileSync(join(ROOT, "data/j2-hospitalcure-journey.json"), "utf8"));
  const j3 = JSON.parse(readFileSync(join(ROOT, "data/j3-omnichannelradioannounce-journey.json"), "utf8"));
  const j4 = JSON.parse(readFileSync(join(ROOT, "data/j4-kernelquestdone-journey.json"), "utf8"));
  const worldTraversal = chapterWorldTraversal(file, "web demo chapters");
  if (worldTraversal !== "seamless-v1") {
    throw new Error(`verify-web-demo: chapters use ${worldTraversal}; expected seamless-v1`);
  }
  for (const [label, journey] of [
    ["GB6", gb6], ["J1", j1], ["J2", j2], ["J3", j3], ["J4", j4],
  ] as const) {
    const actual = journeyWorldTraversal(journey, `${label} journey`);
    if (actual !== worldTraversal) {
      throw new Error(`verify-web-demo: ${label} traversal ${actual} != chapters ${worldTraversal}`);
    }
  }
  return {
    chapters: file.chapters.map((c: any) => ({
      id: c.id, map: c.map, frame: c.frame, timelineFrame: c.timelineFrame,
      held: c.held, suffixFrames: c.suffixFrames,
    })),
    combined: [...gb6.masks, ...j1.masks, ...j2.masks, ...j3.masks, ...j4.masks],
    worldTraversal,
  };
}

/** Restore a chapter and fold `frames` suffix masks through the pure reducer,
 *  the same contract verify:chapters proves end to end. The session uses the
 *  production dialog paginator because the built game's GameView creates its
 *  session with one too: a message that pages differently under the
 *  production font would otherwise let a page-turn confirm land on the wrong
 *  owner in the headless fold. */
function expectedChapterState(chapterId: string, frames: number): { mapId: string; frame: number; hash: string } {
  const { chapters, combined, worldTraversal } = loadChapters();
  const chapter = chapters.find((c) => c.id === chapterId)!;
  const file = JSON.parse(readFileSync(join(ROOT, "data/chapters.json"), "utf8"));
  const record = file.chapters.find((c: any) => c.id === chapterId)!;
  const project = readInlineProject(ROOT);
  if ((project.worldTraversal ?? "legacy-transfer") !== worldTraversal) {
    throw new Error(`verify-web-demo: project traversal ${project.worldTraversal ?? "legacy-transfer"} != chapters ${worldTraversal}`);
  }
  const session: Session = createSession(
    project,
    60,
    createTuxemonSessionOptions(project, worldTraversal, { paginateText: productionPaginator(ROOT) }),
  );
  const snapshot = decodeEnvelopeText(record.snapshot);
  let state: SessionState = restoreSessionSnapshot(session, snapshot);
  state = { ...state, frame: chapter.timelineFrame };
  let prev = chapter.held >>> 0;
  for (let f = chapter.frame; f < chapter.frame + frames; f++) {
    const mask = combined[f]!;
    state = stepSession(session, state, input(mask, prev));
    prev = mask;
  }
  return { mapId: state.mapId, frame: state.frame, hash: sha256(canonicalJson(state)) };
}

/** The English demo tape: the canonical tape with the recorded insertions
 *  (tools/transcribe-en-demo-tape.ts) interleaved, plus the canonical->demo
 *  frame map. */
function loadDemoTape(): { demoMasks: number[]; demoFrame: (canonicalFrame: number) => number } {
  const enDemo = JSON.parse(readFileSync(join(ROOT, "data/en-demo-journey.json"), "utf8")) as {
    insertions: { afterFrame: number; masks: number[] }[];
  };
  const { combined } = loadChapters();
  const byFrame = new Map<number, number[]>();
  for (const ins of enDemo.insertions) byFrame.set(ins.afterFrame, ins.masks);
  const demoMasks: number[] = [];
  for (let f = 0; f < combined.length; f++) {
    demoMasks.push(combined[f]!);
    const extra = byFrame.get(f);
    if (extra) demoMasks.push(...extra);
  }
  const demoFrame = (canonicalFrame: number): number => {
    let offset = 0;
    for (const ins of enDemo.insertions) if (ins.afterFrame < canonicalFrame) offset += ins.masks.length;
    return canonicalFrame + offset;
  };
  return { demoMasks, demoFrame };
}

/** Restore a chapter save and fold the English demo tape through to the next
 *  chapter node, the exact path the built game's Autoplay takes. Used to prove
 *  the demo tape (which inserts frames at the two Nimrod paged windows)
 *  reaches the canonical chapter state. The session carries the production
 *  dialog paginator, matching GameView, so the inserted page-turn confirms
 *  are spent on the dialog in the headless fold exactly as in the browser. */
function expectedDemoChapterState(fromId: string, toId: string): { mapId: string; frame: number; hash: string } {
  const { chapters, worldTraversal } = loadChapters();
  const from = chapters.find((c) => c.id === fromId)!;
  const to = chapters.find((c) => c.id === toId)!;
  const file = JSON.parse(readFileSync(join(ROOT, "data/chapters.json"), "utf8"));
  const record = file.chapters.find((c: any) => c.id === fromId)!;
  const project = readInlineProject(ROOT);
  if ((project.worldTraversal ?? "legacy-transfer") !== worldTraversal) {
    throw new Error(`verify-web-demo: project traversal ${project.worldTraversal ?? "legacy-transfer"} != chapters ${worldTraversal}`);
  }
  const session: Session = createSession(
    project,
    60,
    createTuxemonSessionOptions(project, worldTraversal, { paginateText: productionPaginator(ROOT) }),
  );
  const { demoMasks, demoFrame } = loadDemoTape();
  const snapshot = decodeEnvelopeText(record.snapshot);
  let state: SessionState = restoreSessionSnapshot(session, snapshot);
  state = { ...state, frame: from.timelineFrame };
  let prev = from.held >>> 0;
  for (let f = demoFrame(from.frame); f < demoFrame(to.frame); f++) {
    const mask = demoMasks[f]!;
    state = stepSession(session, state, input(mask, prev));
    prev = mask;
  }
  return { mapId: state.mapId, frame: state.frame, hash: sha256(canonicalJson(state)) };
}

// --- Chrome harness (mirrors verify-web-journey.ts) ------------------------

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    let path = resolve(SITE, `.${decodeURIComponent(url.pathname)}`);
    if (!path.startsWith(SITE)) return new Response("forbidden", { status: 403 });
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
    return existsSync(path) ? new Response(Bun.file(path)) : new Response("not found", { status: 404 });
  },
});

// The browser and the server are torn down on every exit path (pass, fail,
// throw, signal) via the shared cleanup registry in headless-chrome.ts.
registerCleanup(() => server.stop(true));
const chrome = await spawnHeadlessChrome(CHROME, join(OUT, "profile"));
registerCleanup(() => chrome.close());
const wsUrl = chrome.wsUrl;

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map<number, (m: any) => void>();
const errors: string[] = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id !== undefined) pending.get(m.id)?.(m), pending.delete(m.id);
  else if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? "exception");
  else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a: any) => a.value ?? a.description).join(" "));
});
const send = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<any>((resolve, reject) => {
    const i = ++id;
    pending.set(i, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (expression: string) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

await send("Runtime.enable");
await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `globalThis.__pocketTuxemonInitialCivilTime = ${JSON.stringify(FIXED_INITIAL_CIVIL_TIME)};
window.requestAnimationFrame = () => 0; window.cancelAnimationFrame = () => {};`,
});

const base = `http://127.0.0.1:${server.port}/pocket-tuxemon/`;
// The rAF loop is frozen, so the canvas keeps whatever paint() last drew;
// step() advances the world without drawing. Paint before every capture or
// the screenshot shows an earlier scene.
const paint = () => evaluate(`globalThis.__pocketPlayer && globalThis.__pocketPlayer.paint()`);
const shot = async (name: string) => {
  await paint();
  const png = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(png.data, "base64"));
};
const waitFor = async (label: string, expression: string, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await evaluate(expression).catch(() => false);
    if (ok) return;
    // The rAF loop is frozen, so advance the host one frame per poll: a
    // queued chapter jump/warp applies on the next host frame.
    await evaluate(`globalThis.__pocketPlayer && globalThis.__pocketPlayer.step()`).catch(() => {});
    await Bun.sleep(50);
  }
  throw new Error(`timeout waiting for ${label}`);
};
const boot = async (query = "") => {
  await send("Page.navigate", { url: base + query });
  await waitFor("boot", `!!(globalThis.__pocketPlayer && globalThis.__pocketPlayer.state === "running" && globalThis.__rpgkitDemo && globalThis.__rpgSessionState)`);
  // Let the fresh world settle a few frames.
  for (let i = 0; i < 10; i++) await evaluate(`globalThis.__pocketPlayer.step()`);
};
const stateOf = () => `({ map: __rpgSessionState.mapId, x: __rpgSessionState.move.tx, y: __rpgSessionState.move.ty, frame: __rpgSessionState.frame })`;

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// The autoplay-consistency chapter and segment length.
const AUTO_CHAPTER = "starter";
const AUTO_FRAMES = 600;
const expected = expectedChapterState(AUTO_CHAPTER, AUTO_FRAMES);
console.log(`reference: ${AUTO_CHAPTER} +${AUTO_FRAMES} -> ${expected.mapId}@${expected.frame} hash ${expected.hash.slice(0, 12)}`);

// --- 1. HTML chapter buttons jump in place with highlight ------------------

// Painted game-canvas pixels: a hash, the share of the bedroom's lit pixels
// that are unchanged, and how much of the lit canvas uses the bedroom's
// floor/wall palette. Black is left out: small interiors on either side are
// framed by the same black margin. Read from the 2D canvas after paint().
type CanvasProbe = { hash: string; sameAsBedroom: number; bedroomPalette: number; colors: number };
const keepBedroom = () => evaluate(`(() => {
  globalThis.__pocketPlayer.paint();
  const c = document.getElementById("screen");
  const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  const counts = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const rgb = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    if (rgb !== 0) counts.set(rgb, (counts.get(rgb) || 0) + 1);
  }
  // The bedroom's eight most common lit colours: its floor, walls and rug.
  const palette = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([rgb]) => rgb);
  globalThis.__bedroomCanvas = { data: new Uint8ClampedArray(data), palette };
  return palette.length;
})()`);
const probeCanvas = (): Promise<CanvasProbe> => evaluate(`(() => {
  globalThis.__pocketPlayer.paint();
  const c = document.getElementById("screen");
  const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  const ref = globalThis.__bedroomCanvas;
  const palette = new Set(ref.palette);
  let hash = 0x811c9dc5, same = 0, refLit = 0, inPalette = 0, lit = 0;
  const colors = new Set();
  for (let i = 0; i < data.length; i += 4) {
    for (let k = 0; k < 4; k++) hash = Math.imul(hash ^ data[i + k], 0x01000193) >>> 0;
    const rgb = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    const refRgb = (ref.data[i] << 16) | (ref.data[i + 1] << 8) | ref.data[i + 2];
    if (refRgb !== 0) {
      refLit++;
      if (rgb === refRgb) same++;
    }
    if (rgb !== 0) {
      lit++;
      if (palette.has(rgb)) inPalette++;
    }
    colors.add(rgb);
  }
  return {
    hash: hash.toString(16).padStart(8, "0"),
    sameAsBedroom: same / Math.max(1, refLit),
    bedroomPalette: inPalette / Math.max(1, lit),
    colors: colors.size,
  };
})()`);
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

await boot();
await evaluate(`globalThis.__demoSentinel = { player: globalThis.__pocketPlayer, loads: 0 }`);
{
  const s = await evaluate(stateOf());
  check("boot starts in the bedroom", s.map === "spyder_bedroom", `${s.map}@${s.x},${s.y}`);
  await keepBedroom();
  const self = await probeCanvas();
  check("bedroom canvas reference", self.sameAsBedroom === 1 && self.bedroomPalette > 0.5 && self.colors > 8,
    `${self.hash}, ${self.colors} colours, palette ${pct(self.bedroomPalette)}`);
}
const chapterCanvases = new Map<string, CanvasProbe>();
const chapterClicks: [string, string][] = [
  ["paper-town", "spyder_paper_town"],
  ["starter", "spyder_paper_town"],
  ["hospital-cure", "spyder_candy_hospital3"],
  ["radio-broadcast", "spyder_radiotower"],
  ["data-center", "spyder_datacenter"],
  ["kernel-defeated", "spyder_datacenter"],
];
for (const [chapterId, wantMap] of chapterClicks) {
  const before = await evaluate(`globalThis.__rpgSessionState.frame`);
  const hostBefore = await evaluate(`globalThis.__pocketPlayer.frames`);
  await evaluate(`document.querySelector('[data-demo-chapter="${chapterId}"]').click()`);
  await waitFor(`chapter ${chapterId}`, `__rpgSessionState.mapId === ${JSON.stringify(wantMap)} &&
    document.querySelector('[data-demo-chapter="${chapterId}"]').getAttribute("aria-current") === "true"`);
  for (let i = 0; i < 5; i++) await evaluate(`globalThis.__pocketPlayer.step()`);
  const after = await evaluate(stateOf());
  const noReload = await evaluate(`globalThis.__demoSentinel && globalThis.__demoSentinel.player === globalThis.__pocketPlayer`);
  const onlyOne = await evaluate(`[...document.querySelectorAll('[data-demo-chapter][aria-current="true"]')].length === 1`);
  check(`chapter button ${chapterId}`, after.map === wantMap && noReload === true && onlyOne === true,
    `${after.map}@${after.x},${after.y} frame ${after.frame} (was ${before}), noReload=${noReload}`);
  // The capture must show the jumped-to scene: host frames ran after the
  // jump, and the painted canvas has left the bedroom behind.
  const hostAfter = await evaluate(`globalThis.__pocketPlayer.frames`);
  const canvas = await probeCanvas();
  const repeats = [...chapterCanvases.entries()].find(([, seen]) => seen.hash === canvas.hash);
  check(`chapter ${chapterId} canvas is the new scene`,
    hostAfter > hostBefore && canvas.sameAsBedroom < 0.2 && canvas.bedroomPalette < 0.2 && !repeats,
    `host frames ${hostBefore} -> ${hostAfter}, ${canvas.hash}, same-as-bedroom ${pct(canvas.sameAsBedroom)}, ` +
      `bedroom palette ${pct(canvas.bedroomPalette)}${repeats ? `, same canvas as ${repeats[0]}` : ""}`);
  chapterCanvases.set(chapterId, canvas);
  await shot(`chapter-${chapterId}`);
}

{
  const story = await evaluate(`({
    announce: __rpgSessionState.sw.variables["v.omnichannelradioannounce"] || 0,
    kernel: __rpgSessionState.sw.variables["v.kernelquest"] || 0,
    screens: [1,2,3,4,5,6,7].map((n) => __rpgSessionState.sw.variables["v.datascreen" + n] || 0),
    billie: __rpgSessionState.sw.variables["v.datacenterbillie"] || 0,
    beaverbrookWon: __rpgSessionState.sw.switches["bo.spyder_omnichannel_beaverbrook.won"] === true
  })`);
  check("kernel-defeated chapter carries the complete mainline story state",
    story.announce === 1 && story.kernel === 1 && story.screens.every((value: number) => value === 1)
      && story.billie === 1 && story.beaverbrookWon === true,
    `announce=${story.announce} kernel=${story.kernel} screens=${story.screens.join("")}`
      + ` Billie=${story.billie} Beaverbrook=${story.beaverbrookWon}`);
}

// --- 2. Deep links ----------------------------------------------------------

// ?chapter=
await boot(`?chapter=route-1`);
{
  const s = await evaluate(stateOf());
  const cur = await evaluate(`globalThis.__rpgkitDemo.current()`);
  check("deep link ?chapter=route-1", s.map === "spyder_route1" && cur.chapter === "route-1",
    `${s.map}@${s.x},${s.y} chapter=${cur.chapter}`);
  await shot("deeplink-chapter");
}

// ?map=&x=&y=
await boot(`?map=spyder_cotton_town&x=16&y=17`);
{
  const s = await evaluate(stateOf());
  check("deep link ?map=spyder_cotton_town&x=16&y=17", s.map === "spyder_cotton_town" && s.x === 16 && s.y === 17,
    `${s.map}@${s.x},${s.y}`);
  await shot("deeplink-warp");
}

// ?autoplay=&speed=2
await boot(`?autoplay=starter&speed=2`);
{
  const cur = await evaluate(`globalThis.__rpgkitDemo.current()`);
  const speedPressed = await evaluate(`document.querySelector('[data-demo-speed="2"]').getAttribute("aria-pressed")`);
  check("deep link ?autoplay=starter&speed=2", cur.autoplay === true && cur.speed === 2 && cur.chapter === "starter" && speedPressed === "true",
    `autoplay=${cur.autoplay} speed=${cur.speed} chapter=${cur.chapter} aria-pressed=${speedPressed}`);
  await shot("deeplink-autoplay");
}

// --- 3. Invalid chapter id is a visible error --------------------------------

await boot(`?chapter=not-a-real-chapter`);
{
  const s = await evaluate(stateOf());
  // The demo menu renders inside the canvas (not the DOM), so the BAD DEMO
  // LINK text is confirmed by the screenshot below. While the error menu is
  // open the world folds zero reducer frames, which is detectable: stepping
  // the host must not advance the global frame.
  const beforeFrame = await evaluate(`globalThis.__rpgSessionState.frame`);
  for (let i = 0; i < 30; i++) await evaluate(`globalThis.__pocketPlayer.step()`);
  const afterFrame = await evaluate(`globalThis.__rpgSessionState.frame`);
  const s2 = await evaluate(stateOf());
  check("invalid ?chapter= opens the error menu (zero frames fold)", afterFrame === beforeFrame,
    `frame ${beforeFrame} -> ${afterFrame}`);
  check("invalid chapter leaves the fresh world untouched", s2.map === "spyder_bedroom" && s2.x === 4 && s2.y === 4,
    `${s2.map}@${s2.x},${s2.y}`);
  await shot("invalid-chapter");
}

// --- 4. Autoplay consistency with a reducer suffix replay --------------------

await boot(`?autoplay=${AUTO_CHAPTER}&speed=1`);
{
  const target = expected.frame;
  // Step host frames until the reducer has folded AUTO_FRAMES source frames.
  // Pacing holds mean this can take more host frames than source frames.
  let stepped = 0;
  while (stepped < 6000) {
    await evaluate(`globalThis.__pocketPlayer.step()`);
    stepped++;
    const f = await evaluate(`globalThis.__rpgSessionState.frame`);
    if (f >= target) break;
  }
  const s = await evaluate(stateOf());
  const browserHash = await evaluate(`(async () => {
    const canonical = (v) => {
      if (Array.isArray(v)) return v.map(canonical);
      if (v !== null && typeof v === "object") {
        const out = {};
        for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
        return out;
      }
      return v;
    };
    const bytes = new TextEncoder().encode(JSON.stringify(canonical(globalThis.__rpgSessionState)));
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
  })()`);
  check(`autoplay ${AUTO_CHAPTER} +${AUTO_FRAMES} state`, s.frame >= target && s.map === expected.mapId,
    `${s.map}@${s.x},${s.y} frame ${s.frame} (want >= ${target}, ${expected.mapId})`);
  check(`autoplay ${AUTO_CHAPTER} state hash matches reducer replay`, browserHash === expected.hash,
    `browser ${browserHash.slice(0, 12)} vs reducer ${expected.hash.slice(0, 12)}`);
  await shot("autoplay-consistency");
}

// --- 4b. English Autoplay from the three chapters before Candy Town reaches
// the next chapter node past the Nimrod dialog. The canonical tape was
// recorded without the paginator, so the two Nimrod corner windows take two
// pages in the built game; the demo tape (data/en-demo-journey.json) inserts
// the page-turn confirms. The reducer reference folds the demo tape from the
// chapter save to the next chapter, and the browser must match it state for
// state. These three segments cover both Nimrod windows. ---

const EN_DEMO_CHAPTERS: [string, string, string][] = [
  ["route-3-north", "flower-city", "spyder_flower_city"],
  ["flower-city", "captain-returns", "spyder_mansion"],
  ["captain-returns", "candy-town", "spyder_candy_town"],
];
for (const [fromId, toId, wantMap] of EN_DEMO_CHAPTERS) {
  const expected = expectedDemoChapterState(fromId, toId);
  console.log(`reference: ${fromId} -> ${toId} -> ${expected.mapId}@${expected.frame} hash ${expected.hash.slice(0, 12)}`);
  await boot(`?autoplay=${fromId}&speed=1`);
  let stepped = 0;
  while (stepped < 120000) {
    await evaluate(`globalThis.__pocketPlayer.step()`);
    stepped++;
    const f = await evaluate(`globalThis.__rpgSessionState.frame`);
    if (f >= expected.frame) break;
  }
  const s = await evaluate(stateOf());
  const browserHash = await evaluate(`(async () => {
    const canonical = (v) => {
      if (Array.isArray(v)) return v.map(canonical);
      if (v !== null && typeof v === "object") {
        const out = {};
        for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
        return out;
      }
      return v;
    };
    const bytes = new TextEncoder().encode(JSON.stringify(canonical(globalThis.__rpgSessionState)));
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
  })()`);
  check(`en autoplay ${fromId} -> ${toId} reaches ${wantMap}`, s.frame >= expected.frame && s.map === wantMap,
    `${s.map}@${s.x},${s.y} frame ${s.frame} (want >= ${expected.frame}, ${wantMap})`);
  check(`en autoplay ${fromId} -> ${toId} state hash matches the demo tape replay`, browserHash === expected.hash,
    `browser ${browserHash.slice(0, 12)} vs reducer ${expected.hash.slice(0, 12)}`);
  await shot(`en-autoplay-${fromId}`);
}

// --- 5. Chinese chapters and Autoplay ---------------------------------------

const ZH_CHAPTERS: [string, string][] = [
  ["before-billie", "spyder_paper_town"],
  ["captain-returns", "spyder_mansion"],
  ["kernel-briefing", "spyder_cotton_town"],
];
const liveState = async (): Promise<SessionState> =>
  JSON.parse(await evaluate(`JSON.stringify(globalThis.__rpgSessionState)`)) as SessionState;
const CJK = /[\u4e00-\u9fff]/;
const LATIN_WORD = /[A-Za-z]{3,}/;

await boot("?lang=zh");
{
  // The bedroom's opening question is open on boot: Chinese words only.
  const lines: string[] = await evaluate(`(__rpgSessionState.interp.modal && __rpgSessionState.interp.modal.lines) || []`);
  check("zh boot shows the Chinese opening question", lines.some((line) => CJK.test(line)) && !lines.some((line) => LATIN_WORD.test(line)),
    lines.join(" / "));
  const titles: string[] = await evaluate(`[...document.querySelectorAll('[data-demo-chapter]')].map((a) => a.getAttribute("data-demo-chapter"))`);
  check("zh page lists the chapter buttons", ZH_CHAPTERS.every(([id]) => titles.includes(id)), `${titles.length} buttons`);
}
for (const [chapterId, wantMap] of ZH_CHAPTERS) {
  const reference = chapterReference(chapterId, 0);
  await evaluate(`document.querySelector('[data-demo-chapter="${chapterId}"]').click()`);
  await waitFor(`zh chapter ${chapterId}`, `__rpgSessionState.mapId === ${JSON.stringify(wantMap)} &&
    __rpgSessionState.frame === ${reference.frame}`);
  const digests = liveStateDigests(await liveState());
  const noReload = await evaluate(`globalThis.__demoSentinel === undefined || globalThis.__demoSentinel.player === globalThis.__pocketPlayer`);
  check(`zh chapter button ${chapterId} restores the Chinese save`,
    digests.stateSha256 === reference.zhStateSha256 && digests.neutralSha256 === reference.englishNeutralSha256 && noReload === true,
    `${digests.summary.map}@${digests.summary.position} frame ${digests.summary.frame}`);
  await shot(`zh-chapter-${chapterId}`);
}

let zhDialogShot = false;
let zhBattleShot = false;
for (const [chapterId] of ZH_CHAPTERS) {
  const reference = chapterReference(chapterId, AUTO_FRAMES);
  await boot(`?lang=zh&autoplay=${chapterId}&speed=1`);
  let stepped = 0;
  while (stepped < AUTO_FRAMES * 20) {
    await evaluate(`globalThis.__pocketPlayer.step()`);
    stepped++;
    const probe = await evaluate(`({ frame: __rpgSessionState.frame,
      text: !!(__rpgSessionState.interp.modal && __rpgSessionState.interp.modal.kind === "text"),
      battle: !!(__rpgSessionState.scene && __rpgSessionState.scene.kind === "battle") })`);
    // A dialog page shown for a while (typed out) and a battle's first
    // seconds make the language screenshots.
    if (!zhDialogShot && probe.text && stepped % 90 === 0) {
      await shot("zh-autoplay-dialog");
      zhDialogShot = true;
    }
    if (!zhBattleShot && probe.battle && stepped % 240 === 0) {
      await shot("zh-autoplay-battle");
      zhBattleShot = true;
    }
    if (probe.frame >= reference.frame) break;
  }
  const digests = liveStateDigests(await liveState());
  check(`zh autoplay ${chapterId} +${AUTO_FRAMES} reaches the Chinese reducer state`,
    digests.stateSha256 === reference.zhStateSha256,
    `${digests.summary.map}@${digests.summary.position} frame ${digests.summary.frame} (want ${reference.frame})`);
  check(`zh autoplay ${chapterId} +${AUTO_FRAMES} has the English chapter's language-neutral state`,
    digests.neutralSha256 === reference.englishNeutralSha256,
    `party ${digests.summary.party.join(" ")}, gold ${digests.summary.gold}`);
}
check("zh autoplay showed a dialog page and a battle", zhDialogShot && zhBattleShot,
  `dialog=${zhDialogShot} battle=${zhBattleShot}`);

console.log(`console errors: ${errors.length}${errors.length ? "\n  " + errors.slice(0, 5).join("\n  ") : ""}`);
check("no console errors", errors.length === 0);
console.log(failures === 0 ? "WEB DEMO PASS" : `WEB DEMO FAIL (${failures})`);
ws.close();
chrome.close();
server.stop(true);
process.exit(failures === 0 ? 0 : 1);

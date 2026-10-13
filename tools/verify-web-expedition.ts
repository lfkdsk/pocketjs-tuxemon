// Browser acceptance for the separately bundled expedition replay page.
//
// Run `bun run web` first. Pass --update only after visually reviewing and
// intentionally replacing the committed expedition-frame goldens.

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
  appendExpeditionJournal,
  startExpeditionJournal,
  validateExpeditionJournal,
  type ExpeditionJournal,
} from "../battle/expedition-journal.ts";
import {
  applyExpeditionAction,
  createExpedition,
  legalExpeditionActions,
  observeExpedition,
  type Expedition,
  type ExpeditionAction,
  type ExpeditionObservation,
} from "../battle/expedition.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tools/png.ts";
import { registerCleanup, spawnHeadlessChrome } from "./headless-chrome.ts";

const ROOT = resolve(import.meta.dir, "..");
const SITE = join(ROOT, "dist", "web");
const OUT = join(ROOT, "dist", "web-expedition");
const GOLDENS = join(ROOT, "tests", "goldens", "expedition-replay");
const UPDATE = process.argv.includes("--update");
const chromeFlag = process.argv.indexOf("--chrome");
const CHROME = chromeFlag >= 0 ? process.argv[chromeFlag + 1]! :
  process.env.CHROME ?? Bun.which("google-chrome") ?? Bun.which("chromium") ?? "google-chrome";
const GAME = "pocket-tuxemon";
const SEED = "0123456789abcdef".repeat(4);

if (!existsSync(join(SITE, GAME, "expedition-replay.html"))) {
  console.error("verify-web-expedition: no expedition replay page in dist/web; run `bun run web` first");
  process.exit(2);
}
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(GOLDENS, { recursive: true });

function apply(expedition: Expedition, action: ExpeditionAction): Expedition {
  const result = applyExpeditionAction(expedition, action);
  if (!result.ok) throw new Error(`verify-web-expedition: fixture action rejected: ${result.error}`);
  return result.expedition;
}

function publicJournal(expedition: Expedition): ExpeditionJournal {
  return startExpeditionJournal({
    cycle: expedition.rules.cycle,
    stepBudget: expedition.rules.stepBudget,
    levelCap: expedition.rules.levelCap,
    startingArea: expedition.area,
  }, observeExpedition(expedition));
}

function realJournal(): ExpeditionJournal {
  let expedition = createExpedition({
    seed: SEED,
    rules: {
      cycle: "ranked",
      stepBudget: 16,
      startingArea: "spyder_route1",
      starter: { species: "rockitten", level: 50 },
    },
  });
  let journal = publicJournal(expedition);
  let bought = false;
  let battles = 0;
  let catches = 0;
  let usedItem = false;
  let healed = false;

  while (!expedition.ended) {
    const legal = legalExpeditionActions(expedition);
    let action: ExpeditionAction | undefined;
    if (expedition.encounter) {
      if (battles === 0) {
        action = legal.find((candidate) => candidate.type === "battle" && candidate.mode === "auto");
        battles++;
      } else {
        action = legal.find((candidate) => candidate.type === "catch");
        if (action) catches++;
        else action = legal.find((candidate) => candidate.type === "flee");
      }
    } else {
      if (!bought) {
        action = legal.find((candidate) => candidate.type === "shop");
        bought = action !== undefined;
      }
      if (!action && !usedItem) {
        action = legal.find((candidate) => candidate.type === "useItem");
        usedItem = action !== undefined;
      }
      if (!action && !healed) {
        action = legal.find((candidate) => candidate.type === "heal");
        healed = action !== undefined;
      }
      if (!action && expedition.area === "spyder_route1") {
        action = legal.find((candidate) => candidate.type === "travel" && candidate.area === "spyder_citypark");
      }
      if (!action) action = legal.find((candidate) => candidate.type === "explore");
      if (!action) action = legal.find((candidate) => candidate.type === "travel");
    }
    action ??= legal.find((candidate) => candidate.type !== "end");
    if (!action) throw new Error("verify-web-expedition: fixture has no non-terminal action");
    expedition = apply(expedition, action);
    journal = appendExpeditionJournal(journal, action, observeExpedition(expedition));
  }
  if (battles === 0 || catches === 0) {
    throw new Error("verify-web-expedition: fixture did not cover battle and capture actions");
  }
  return journal;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function visualEdgeJournal(reason: "budget" | "defeated"): ExpeditionJournal {
  const expedition = createExpedition({
    seed: reason === "budget" ? "1".padStart(64, "0") : "2".padStart(64, "0"),
    rules: { cycle: "ranked", stepBudget: 1, starter: { species: "rockitten", level: 50 } },
  });
  const initial = clone(observeExpedition(expedition));
  const longEnglish = "Rockitten the Very Brave Partner";
  const longChinese = "特别勇敢的洛基猫远征伙伴";
  initial.team = Array.from({ length: 5 }, (_, slot) => ({
    ...clone(initial.team[0]!),
    slot,
    species: { slug: "rockitten", en_US: longEnglish, zh_CN: longChinese },
  }));
  initial.backpack = [];
  const journal = startExpeditionJournal({
    cycle: initial.cycle,
    stepBudget: 1,
    levelCap: expedition.rules.levelCap,
    startingArea: initial.area.id,
  }, initial);
  const observation: ExpeditionObservation = {
    ...clone(initial),
    status: "ended",
    remainingSteps: 0,
    nextAction: initial.nextAction + 1,
    result: { reason },
    team: initial.team.map((member) => reason === "defeated"
      ? { ...member, hp: { ...member.hp, current: 0 } }
      : member),
    lastTransition: reason === "budget" ? {
      type: "capture",
      item: { slug: "tuxeball", en_US: "Tuxeball", zh_CN: "企鹅球" },
      species: { slug: "rockitten", en_US: longEnglish, zh_CN: longChinese },
      success: false,
      shakes: 3,
      consumed: false,
    } : null,
  };
  const action: ExpeditionAction = reason === "budget"
    ? { type: "catch", item: "tuxeball", sequence: initial.nextAction }
    : { type: "end", sequence: initial.nextAction };
  return appendExpeditionJournal(journal, action, observation);
}

const MAIN_JOURNAL = realJournal();
const MAIN_CHECKED = validateExpeditionJournal(MAIN_JOURNAL);
if (!MAIN_CHECKED.ok) throw new Error(`verify-web-expedition: invalid fixture: ${MAIN_CHECKED.error}`);
const MAIN_TERMINAL = MAIN_CHECKED.journal.entries.at(-1)!.observation;
const MAIN_JSON = JSON.stringify(MAIN_JOURNAL);
const BUDGET_JOURNAL = visualEdgeJournal("budget");
const BUDGET_JSON = JSON.stringify(BUDGET_JOURNAL);
const DEFEAT_JOURNAL = visualEdgeJournal("defeated");
const DEFEAT_JSON = JSON.stringify(DEFEAT_JOURNAL);
const INLINE_JSON = JSON.stringify(publicJournal(createExpedition({
  seed: "3".padStart(64, "0"),
  rules: { cycle: "ranked", stepBudget: 1 },
})));
const MALICIOUS_JSON = JSON.stringify({
  ...JSON.parse(INLINE_JSON),
  script: "globalThis.__expeditionReplayExecuted = true",
});

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    const fixtures: Record<string, string> = {
      [`/${GAME}/expedition-journal.json`]: MAIN_JSON,
      [`/${GAME}/edge-budget.json`]: BUDGET_JSON,
      [`/${GAME}/edge-defeat.json`]: DEFEAT_JSON,
    };
    if (fixtures[url.pathname]) {
      return new Response(fixtures[url.pathname], { headers: { "content-type": "application/json" } });
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
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
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
    globalThis.__expeditionReplayExecuted = false;
  `,
});

const base = `http://127.0.0.1:${server.port}/${GAME}/`;
const waitFor = async (label: string, expression: string, timeoutMs = 90_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression).catch(() => false)) return;
    await evaluate(`globalThis.__pocketPlayer && globalThis.__pocketPlayer.step()`).catch(() => {});
    await Bun.sleep(50);
  }
  const diagnostic = await evaluate(`({
    readyState: document.readyState,
    player: globalThis.__pocketPlayer?.state,
    replay: globalThis.__pocketExpeditionReplay?.state?.(),
    body: document.body?.innerText?.slice(0, 500),
  })`).catch(() => null);
  throw new Error(`verify-web-expedition: timeout waiting for ${label}: ${JSON.stringify(diagnostic)}; ${errors.join(" | ")}`);
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

async function bootReplay(path: string, language = "en"): Promise<void> {
  await send("Page.navigate", {
    url: `${base}expedition-replay.html?lang=${language}&expeditionReplay=${encodeURIComponent(path)}`,
  });
  await waitFor(
    "validated expedition replay",
    `!!(globalThis.__pocketPlayer && globalThis.__pocketPlayer.state === "running" && ` +
      `globalThis.__pocketExpeditionReplay && globalThis.__pocketExpeditionReplay.state().status === "ready")`,
  );
  await evaluate(`globalThis.__pocketExpeditionReplay.pause(); globalThis.__pocketPlayer.paint()`);
}

// Ordinary startup keeps its production bundle/pak and never asks for the
// opt-in expedition replay assets.
const requestStart = requests.length;
await send("Page.navigate", { url: base });
await waitFor("ordinary player", `!!(globalThis.__pocketPlayer && globalThis.__pocketPlayer.state === "running")`);
await stepFrames(5);
const ordinaryRequests = requests.slice(requestStart);
check(
  "ordinary player does not request expedition replay assets",
  !ordinaryRequests.some((url) => /expedition-replay\.(?:js|pak)(?:$|\?)/.test(url)),
  ordinaryRequests.filter((url) => url.includes("expedition-replay")).join(", ") || "no replay requests",
);
const normalConfig = JSON.parse(readFileSync(join(SITE, GAME, "index.html"), "utf8")
  .match(/<script type="application\/json" id="pocket-game">(.*?)<\/script>/s)![1]!) as Record<string, unknown>;
check(
  "ordinary player keeps the production bundle and pak",
  normalConfig.bundle === "pocket-tuxemon.js" && normalConfig.pak === "pocket-tuxemon.pak",
  `${String(normalConfig.bundle)} / ${String(normalConfig.pak)}`,
);

await bootReplay("expedition-journal.json");
const english = await evaluate<any>(`({
  title: document.getElementById("expedition-replay-title")?.textContent,
  play: document.getElementById("expedition-replay-play")?.textContent,
  step: document.getElementById("expedition-replay-step")?.textContent,
  speed: document.getElementById("expedition-replay-speed-label")?.textContent,
  timeline: document.getElementById("expedition-replay-timeline-label")?.textContent,
  lang: document.documentElement.lang,
  entries: globalThis.__pocketExpeditionReplay.state().entries,
})`);
check(
  "English controls and timeline are visible",
  english.title === "Expedition replay" && english.play === "Play" && english.step === "Step" &&
    english.speed === "Speed" && english.timeline === "Timeline" && english.lang === "en" &&
    english.entries === MAIN_JOURNAL.entries.length,
  JSON.stringify(english),
);

const pausedBefore = await evaluate<number>(`globalThis.__pocketExpeditionReplay.state().frame`);
await stepFrames(120);
const pausedAfter = await evaluate<number>(`globalThis.__pocketExpeditionReplay.state().frame`);
check("Pause stops automatic advancement", pausedAfter === pausedBefore, `${pausedBefore} -> ${pausedAfter}`);
await evaluate(`document.getElementById("expedition-replay-step").click()`);
const stepped = await evaluate<number>(`globalThis.__pocketExpeditionReplay.state().frame`);
check("Step advances one visual frame", stepped === pausedBefore + 1, `${pausedBefore} -> ${stepped}`);

for (const [speed, before, boundary] of [[1, 59, 60], [2, 29, 30], [4, 14, 15]] as const) {
  await evaluate(`globalThis.__pocketExpeditionReplay.restart(); document.getElementById("expedition-replay-speed-${speed}").click(); document.getElementById("expedition-replay-play").click()`);
  await stepFrames(before);
  const early = await evaluate<number>(`globalThis.__pocketExpeditionReplay.state().frame`);
  await stepFrames(boundary - before);
  const reached = await evaluate<number>(`globalThis.__pocketExpeditionReplay.state().frame`);
  check(`${speed}x waits ${boundary} host frames per visual frame`, early === 0 && reached === 1, `${early} -> ${reached}`);
  await evaluate(`globalThis.__pocketExpeditionReplay.pause()`);
}

await evaluate(`(() => {
  const replay = globalThis.__pocketExpeditionReplay;
  replay.restart();
  while (replay.state().frame < replay.state().total) replay.step();
  globalThis.__pocketPlayer.paint();
})()`);
const terminal = await evaluate<any>(`({
  state: globalThis.__pocketExpeditionReplay.state(),
  observation: globalThis.__pocketExpeditionReplay.observation(),
  status: document.getElementById("expedition-replay-status")?.textContent,
})`);
check(
  "stepping reaches the journal's exact terminal observation",
  terminal.state.frame === terminal.state.total && !terminal.state.playing &&
    terminal.status === "Replay complete" &&
    JSON.stringify(terminal.observation) === JSON.stringify(MAIN_TERMINAL),
  `${terminal.state.frame}/${terminal.state.total}, ${terminal.observation?.result?.reason}`,
);

// Timeline seek is bounded and updates both the visual cursor and observation.
await evaluate(`(() => {
  const slider = document.getElementById("expedition-replay-timeline");
  slider.value = "1";
  slider.oninput();
})()`);
check(
  "timeline seeks to a selected visual frame",
  await evaluate(`globalThis.__pocketExpeditionReplay.state().frame === 1 && document.getElementById("expedition-replay-timeline").value === "1"`),
);

// Inline data uses the same strict parser.
await send("Page.navigate", {
  url: `${base}expedition-replay.html?lang=en&expeditionReplay=${inlineSource(INLINE_JSON)}`,
});
await waitFor("inline expedition replay", `globalThis.__pocketExpeditionReplay?.state().status === "ready"`);
check("application/json data URL loads", await evaluate(`globalThis.__pocketExpeditionReplay.state().entries === 0`));

await bootReplay("expedition-journal.json", "zh");
const chinese = await evaluate<any>(`({
  title: document.getElementById("expedition-replay-title")?.textContent,
  play: document.getElementById("expedition-replay-play")?.textContent,
  step: document.getElementById("expedition-replay-step")?.textContent,
  speed: document.getElementById("expedition-replay-speed-label")?.textContent,
  timeline: document.getElementById("expedition-replay-timeline-label")?.textContent,
  lang: document.documentElement.lang,
})`);
check(
  "Chinese controls and timeline are visible",
  chinese.title === "远征回放" && chinese.play === "播放" && chinese.step === "前进一步" &&
    chinese.speed === "速度" && chinese.timeline === "时间轴" && chinese.lang === "zh-CN",
  JSON.stringify(chinese),
);

await send("Page.navigate", {
  url: `${base}expedition-replay.html?lang=en&expeditionReplay=${inlineSource(MALICIOUS_JSON)}`,
});
await waitFor("visible malicious-journal error", `globalThis.__pocketExpeditionReplay?.state().status === "error"`);
const malicious = await evaluate<any>(`({
  executed: globalThis.__expeditionReplayExecuted,
  status: globalThis.__pocketExpeditionReplay.state().status,
  message: document.getElementById("expedition-replay-status")?.textContent,
})`);
check(
  "malicious journal fields are rejected without evaluation",
  malicious.executed === false && malicious.status === "error" &&
    malicious.message.startsWith("Could not load journal"),
  JSON.stringify(malicious),
);

// Visual edge fixture: long names, a full team, empty backpack, capture card,
// and a budget terminal must coexist within 480x272.
await bootReplay("edge-budget.json");
await evaluate(`globalThis.__pocketExpeditionReplay.seek(globalThis.__pocketExpeditionReplay.state().total); globalThis.__pocketPlayer.paint()`);
const budgetState = await evaluate<any>(`({
  state: globalThis.__pocketExpeditionReplay.state(),
  observation: globalThis.__pocketExpeditionReplay.observation(),
})`);
check(
  "long-name/full-party/empty-backpack budget frame is reachable",
  budgetState.observation.team.length === 5 && budgetState.observation.backpack.length === 0 &&
    budgetState.observation.result?.reason === "budget",
  JSON.stringify({ team: budgetState.observation.team.length, backpack: budgetState.observation.backpack.length,
    reason: budgetState.observation.result?.reason }),
);

const capture = await evaluate<any>(`(() => {
  const p = globalThis.__pocketPlayer;
  const toBase64 = (bytes) => {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x4000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x4000));
    }
    return btoa(binary);
  };
  const logical = new Uint8Array(p.wasm.render());
  const physical = new Uint8Array(p.wasm.renderScaled(2));
  return { logical: toBase64(logical), physical: toBase64(physical), physicalSize: [p.width * 2, p.height * 2] };
})()`);
const logical = new Uint8Array(Buffer.from(capture.logical, "base64"));
const physical = new Uint8Array(Buffer.from(capture.physical, "base64"));
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

const partyHp = countPixels(logical, 480, 360, 45, 442, 230, (r, g, b) => g > 150 && r < 150 && b < 150);
const route = countPixels(logical, 480, 8, 28, 156, 154, (r, g, b) => g > 130 && b > 100 && r < 150);
const accent = countPixels(logical, 480, 0, 0, 480, 272, (r, g, b) => r > 200 && g > 130 && g < 220 && b < 120);
const palette = new Set<number>();
for (let offset = 0; offset < logical.length; offset += 4) {
  palette.add((logical[offset]! << 16) | (logical[offset + 1]! << 8) | logical[offset + 2]!);
}
check("all five party HP bars are visible", partyHp > 180, `${partyHp} HP pixels`);
check("route nodes and connections are visible", route > 80, `${route} route pixels`);
check("terminal/capture/timeline accents are visible", accent > 80, `${accent} accent pixels`);
check("monster art and UI have a nontrivial palette", palette.size > 48, `${palette.size} colors`);

await bootReplay("edge-defeat.json");
await evaluate(`globalThis.__pocketExpeditionReplay.seek(globalThis.__pocketExpeditionReplay.state().total); globalThis.__pocketPlayer.paint()`);
const defeated = await evaluate<any>(`globalThis.__pocketExpeditionReplay.observation()`);
check(
  "defeat terminal frame is reachable without overflow",
  defeated.result?.reason === "defeated" && defeated.team.length === 5 &&
    defeated.team.every((member: any) => member.hp.current === 0),
  JSON.stringify({ reason: defeated.result?.reason, team: defeated.team.length }),
);

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
  ["expedition.480x272.png", encodePNG(logical, 480, 272)],
  ["expedition.480x272.3x.png", encodePNG(nearest3x(logical, 480, 272), 1440, 816)],
  ["expedition.960x544.png", encodePNG(physical, 960, 544)],
  ["expedition.960x544.3x.png", encodePNG(nearest3x(physical, 960, 544), 2880, 1632)],
]);
for (const [name, png] of images) {
  const output = join(OUT, name);
  const golden = join(GOLDENS, name);
  writeFileSync(output, png);
  if (UPDATE) writeFileSync(golden, png);
  const matches = existsSync(golden) && readFileSync(golden).equals(png);
  check(`golden ${name}`, matches, createHash("sha256").update(png).digest("hex").slice(0, 16));
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
  ? `WEB EXPEDITION PASS (${MAIN_JOURNAL.entries.length} entries, 4 screenshots)`
  : `WEB EXPEDITION FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);

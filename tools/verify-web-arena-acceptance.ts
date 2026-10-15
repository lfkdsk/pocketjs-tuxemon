#!/usr/bin/env bun
// Focused browser acceptance for replay-state hashing and Link terminal-result
// authority. Run `bun run web` first so this exercises the production replay
// dispatcher, immutable player bundle, controller, and battle scene.

import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import battleDbJson from "../data/battle-db.json";
import fixtureJson from "../tests/fixtures/arena-server-determinism.json";
import {
  createArenaBattle,
  defaultAction,
  isOver,
  observe,
  replay,
  result,
  stateHash,
  submit,
  tape,
  type ArenaAction,
  type ArenaBattle,
  type ArenaConfig,
  type BattleTape,
} from "../battle/arena.ts";
import {
  SERVER_DATA_DIGEST,
  SERVER_ENGINE_REVISION,
} from "../battle/server-runtime.ts";
import { registerCleanup, spawnHeadlessChrome } from "./headless-chrome.ts";

const ROOT = resolve(import.meta.dir, "..");
const SITE = join(ROOT, "dist", "web");
const GAME = "pocket-tuxemon";
const DISPATCHER = join(SITE, GAME, "replay.html");
const chromeFlag = process.argv.indexOf("--chrome");
const CHROME = chromeFlag >= 0 ? process.argv[chromeFlag + 1]!
  : process.env.CHROME ?? Bun.which("google-chrome") ?? Bun.which("chromium") ?? "google-chrome";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`verify-web-arena-acceptance: ${message}`);
}

function embeddedJson(path: string, id: string): Record<string, unknown> {
  const text = readFileSync(path, "utf8");
  const match = text.match(new RegExp(
    `<script type="application/json" id="${id}">(.*?)<\\/script>`,
    "s",
  ));
  assert(match?.[1], `${path} has no ${id} configuration`);
  return JSON.parse(match[1]) as Record<string, unknown>;
}

assert(existsSync(DISPATCHER), "no replay dispatcher in dist/web; run `bun run web` first");
const routing = embeddedJson(DISPATCHER, "replay-routing");
const current = routing.current as Record<string, unknown> | undefined;
assert(current && typeof current.artifactId === "string", "dispatcher has no current replay artifact");
const PLAYER = join(SITE, GAME, "replays", current.artifactId, "replay.html");
assert(existsSync(PLAYER), `immutable replay player ${current.artifactId} is missing`);

type Technique = {
  power: number;
  accuracy: number;
  effects: Array<{ type: string }>;
};
const techniques = battleDbJson.techniques as Record<string, Technique>;
const directDamage = new Set(["damage", "life_swap", "multiattack", "prop_damage", "sacrifice", "splash"]);

function actionEqual(left: ArenaAction, right: ArenaAction): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Pick an explicit, useful legal move instead of the reducer's first-action
 * deadline fallback. The first window deliberately chooses a different legal
 * move so the human and default-action fixtures cannot silently collapse into
 * the same tape. */
function humanAction(battle: ArenaBattle): ArenaAction {
  const view = observe(battle, 0);
  const fallback = defaultAction(battle, 0);
  const actor = view.actingParty === null ? undefined : view.own.party[view.actingParty];
  const ranked = view.legalActions
    .filter((action): action is Extract<ArenaAction, { type: "move" }> => action.type === "move")
    .map((action) => {
      const slug = actor?.moves.find((move) => move.slot === action.slot)?.slug;
      const technique = slug ? techniques[slug] : undefined;
      const direct = technique?.effects.some((effect) => directDamage.has(effect.type)) ?? false;
      const score = (direct ? 1_000_000 : 0) + Math.max(0, technique?.power ?? 0) *
        Math.max(0, Math.min(1, technique?.accuracy ?? 0));
      return { action, score };
    })
    .sort((left, right) => right.score - left.score || right.action.slot - left.action.slot);
  if (battle.turn === 0) {
    const alternate = ranked.find(({ action }) => !actionEqual(action, fallback));
    if (alternate) return alternate.action;
  }
  return ranked[0]?.action ?? fallback;
}

function completedTape(kind: "human" | "default"): BattleTape {
  let battle = createArenaBattle({
    seed: "0123456789abcdef".repeat(4),
    format: "single",
    sides: [{ kind: "agent" }, { kind: "ai", difficulty: "normal" }],
  });
  let departedFromDefault = false;
  while (!isOver(battle)) {
    const fallback = defaultAction(battle, 0);
    const action = kind === "human" ? humanAction(battle) : fallback;
    departedFromDefault ||= !actionEqual(action, fallback);
    const submitted = submit(battle, 0, action);
    assert(submitted.ok, `${kind} fixture action was rejected`);
    battle = submitted.battle;
  }
  assert(result(battle)?.reason !== "turn-limit", `${kind} fixture unexpectedly reached the turn limit`);
  if (kind === "human") assert(departedFromDefault, "human fixture never differed from defaultAction");
  return tape(battle);
}

type DeterminismCase = {
  config: ArenaConfig;
  actions: BattleTape["actions"];
  stateHashes: string[];
  result: { reason: string; turns: number };
  coverage: { naturalTurnLimit: boolean };
};
const turnLimitCase = (fixtureJson.cases as unknown as DeterminismCase[])
  .find((entry) => entry.coverage.naturalTurnLimit);
assert(turnLimitCase, "determinism fixture has no natural turn-limit case");
const { seed: turnLimitSeed, ...turnLimitConfig } = turnLimitCase.config;
const TURN_LIMIT_TAPE: BattleTape = {
  v: 1,
  seed: turnLimitSeed,
  config: turnLimitConfig,
  actions: turnLimitCase.actions,
};
assert(turnLimitCase.result.reason === "turn-limit" && turnLimitCase.result.turns === 2_048,
  "natural turn-limit fixture does not end at 2,048 pairs");
assert(stateHash(replay(TURN_LIMIT_TAPE)) === turnLimitCase.stateHashes.at(-1),
  "natural turn-limit fixture hash drifted");

const HUMAN_TAPE = completedTape("human");
const DEFAULT_TAPE = completedTape("default");
assert(JSON.stringify(HUMAN_TAPE.actions) !== JSON.stringify(DEFAULT_TAPE.actions),
  "human and default-action fixtures produced the same action history");

const prefixLength = Math.min(2, HUMAN_TAPE.actions.length - 1);
assert(prefixLength > 0, "human fixture is too short for a nonzero unfinished prefix");
const PREFIX_TAPE: BattleTape = {
  ...HUMAN_TAPE,
  actions: HUMAN_TAPE.actions.slice(0, prefixLength),
};
assert(result(replay(PREFIX_TAPE)) === null, "terminal override prefix is already naturally terminal");
const PREFIX_HASH = stateHash(replay(PREFIX_TAPE));

function envelope(reason: "forfeit" | "abandoned"): string {
  return JSON.stringify({
    kind: "tux-link-replay",
    v: 1,
    engineRevision: SERVER_ENGINE_REVISION,
    dataDigest: SERVER_DATA_DIGEST,
    tape: PREFIX_TAPE,
    preTerminalHash: PREFIX_HASH,
    terminalOverride: reason === "forfeit"
      ? { winner: 0, reason, atTurn: prefixLength }
      : { winner: null, reason, atTurn: prefixLength },
  });
}

const documents = new Map<string, string>([
  [`/${GAME}/human.json`, JSON.stringify(HUMAN_TAPE)],
  [`/${GAME}/default-action.json`, JSON.stringify(DEFAULT_TAPE)],
  [`/${GAME}/turn-limit.json`, JSON.stringify(TURN_LIMIT_TAPE)],
  ["/tux/v1/replays/forfeit.json", envelope("forfeit")],
  ["/tux/v1/replays/abandoned.json", envelope("abandoned")],
  ["/untrusted/forfeit.json", envelope("forfeit")],
  ["/untrusted/abandoned.json", envelope("abandoned")],
]);

function playerHtml(text: string, requestUrl: string): string {
  const trustedReplayBase = `${new URL(requestUrl).origin}/tux/v1/replays/`;
  const pattern = /"trustedReplayBase":(?:null|"(?:\\.|[^"\\])*")/g;
  assert(pattern.test(text), "replay HTML has no embedded trustedReplayBase");
  pattern.lastIndex = 0;
  return text.replace(pattern, `"trustedReplayBase":${JSON.stringify(trustedReplayBase)}`);
}

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    const document = documents.get(url.pathname);
    if (document !== undefined) {
      return new Response(document, { headers: { "content-type": "application/json" } });
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      return new Response("bad path", { status: 400 });
    }
    let path = resolve(SITE, `.${decoded}`);
    if (path !== SITE && !path.startsWith(`${SITE}/`)) return new Response("forbidden", { status: 403 });
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
    if (!existsSync(path)) return new Response("not found", { status: 404 });
    if (path.endsWith("/replay.html")) {
      return new Response(playerHtml(readFileSync(path, "utf8"), request.url), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response(Bun.file(path));
  },
});
registerCleanup(() => server.stop(true));

const chromeProfile = join(ROOT, "dist", "web-arena-acceptance-profile");
rmSync(chromeProfile, { recursive: true, force: true });
registerCleanup(() => rmSync(chromeProfile, { recursive: true, force: true }));
const chrome = await spawnHeadlessChrome(CHROME, chromeProfile, "960,720");
registerCleanup(() => chrome.close());
const cdp = new WebSocket(chrome.wsUrl);
await new Promise<void>((resolveOpen) => cdp.addEventListener("open", () => resolveOpen(), { once: true }));
registerCleanup(() => cdp.close());

let sequence = 0;
const pending = new Map<number, (message: any) => void>();
const browserErrors: string[] = [];
cdp.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id !== undefined) {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  } else if (message.method === "Runtime.exceptionThrown") {
    browserErrors.push(message.params.exceptionDetails?.exception?.description ??
      message.params.exceptionDetails?.text ?? "exception");
  } else if (message.method === "Runtime.consoleAPICalled" && ["error", "assert"].includes(message.params.type)) {
    browserErrors.push(message.params.args.map((arg: any) => arg.value ?? arg.description).join(" "));
  } else if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
    browserErrors.push(message.params.entry.text);
  }
});

const send = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<any>((resolveMessage, reject) => {
    const id = ++sequence;
    pending.set(id, (message) => message.error
      ? reject(new Error(message.error.message))
      : resolveMessage(message.result));
    cdp.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async <T = any>(expression: string): Promise<T> => {
  const evaluated = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluated.exceptionDetails) {
    throw new Error(evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text);
  }
  return evaluated.result.value as T;
};

await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `window.requestAnimationFrame = () => 0; window.cancelAnimationFrame = () => {};`,
});

const base = `http://127.0.0.1:${server.port}/${GAME}/`;
const waitFor = async (label: string, expression: string, timeoutMs = 30_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression).catch(() => false)) return;
    await evaluate(`globalThis.__pocketPlayer?.step()`).catch(() => {});
    await Bun.sleep(25);
  }
  throw new Error(`verify-web-arena-acceptance: timeout waiting for ${label}`);
};

type ReplayState = {
  status: "loading" | "ready" | "error";
  turn: number;
  total: number;
  playing: boolean;
  settledHash: string | null;
  terminalHash: string | null;
  authoritativeResult: string | null;
  error: string | null;
  statusText: string;
};

async function snapshot(): Promise<ReplayState> {
  return evaluate<ReplayState>(`({
    ...globalThis.__pocketArenaReplay.state(),
    statusText: document.getElementById("arena-replay-status")?.textContent || "",
  })`);
}

function replayQuery(path: string): string {
  return `lang=en&battleReplay=${encodeURIComponent(path)}`;
}

function routedReplaySource(path: string): string {
  return path.slice(0, 5).toLowerCase() === "data:" ? path : new URL(path, base).href;
}

async function boot(path: string, timeoutMs = 30_000): Promise<ReplayState> {
  await send("Page.navigate", { url: `${base}replay.html?${replayQuery(path)}` });
  await waitFor("validated replay", `location.pathname.includes("/replays/") &&
    new URLSearchParams(location.search).get("battleReplay") === ${JSON.stringify(routedReplaySource(path))} &&
    globalThis.__pocketPlayer?.state === "running" &&
    globalThis.__pocketArenaReplay?.state().status === "ready"`, timeoutMs);
  await evaluate(`globalThis.__pocketArenaReplay.pause(); globalThis.__pocketArenaReplay.restart()`);
  return snapshot();
}

async function finish(): Promise<ReplayState> {
  for (let guard = 0; guard < 32; guard++) {
    const before = await snapshot();
    if (before.turn === before.total) return before;
    await evaluate(`(() => {
      const replay = globalThis.__pocketArenaReplay;
      const state = replay.state();
      const count = Math.min(128, state.total - state.turn);
      for (let index = 0; index < count; index++) replay.step();
      globalThis.__pocketPlayer.step();
    })()`);
  }
  throw new Error("verify-web-arena-acceptance: replay did not finish within 32 batches");
}

async function expectComplete(
  label: string,
  path: string,
  recording: BattleTape,
  authoritativeResult: string | null = null,
): Promise<void> {
  const expectedHash = stateHash(replay(recording));
  const initial = await boot(path, recording.actions.length >= 2_048 ? 180_000 : 30_000);
  assert(initial.turn === 0, `${label} did not restart at turn zero`);
  assert(initial.terminalHash === expectedHash, `${label} precomputed terminal hash differs from the tape`);
  assert(initial.settledHash === null, `${label} exposed an actual settled hash before completion`);
  assert(initial.authoritativeResult === null, `${label} exposed an authoritative result before completion`);

  const complete = await finish();
  assert(complete.turn === complete.total && !complete.playing, `${label} did not stop at its tape boundary`);
  assert(complete.terminalHash === expectedHash, `${label} expected terminal hash changed during playback`);
  assert(complete.settledHash === expectedHash, `${label} actual stepped state hash differs from its terminal hash`);
  assert(complete.authoritativeResult === authoritativeResult,
    `${label} authoritative result mismatch: ${complete.authoritativeResult}`);
  assert(complete.statusText === (authoritativeResult ?? "Replay complete"),
    `${label} visible completion text mismatch: ${complete.statusText}`);
  console.log(`ok   ${label} (${recording.actions.length} pairs)`);
}

async function expectUntrustedOverride(label: string, path: string): Promise<void> {
  const errorStart = browserErrors.length;
  await send("Page.navigate", { url: `${base}replay.html?${replayQuery(path)}` });
  await waitFor("untrusted replay rejection", `location.pathname.includes("/replays/") &&
    new URLSearchParams(location.search).get("battleReplay") === ${JSON.stringify(routedReplaySource(path))} &&
    globalThis.__pocketArenaReplay?.state().status === "error"`);
  const rejected = await snapshot();
  assert(rejected.turn === 0 && rejected.settledHash === null && rejected.terminalHash === null,
    `${label} published replay state after trust rejection`);
  assert(rejected.authoritativeResult === null && !rejected.statusText.includes("Authoritative result:"),
    `${label} displayed an untrusted authoritative result`);
  assert(rejected.statusText.startsWith("Could not load tape:"), `${label} did not fail closed visibly`);
  await Bun.sleep(50);
  const observed = browserErrors.splice(errorStart);
  const unexpected = observed.filter((message) => !message.includes("battle replay document rejected"));
  browserErrors.push(...unexpected);
  console.log(`ok   ${label} rejected without authoritative display`);
}

await expectComplete("human-completed replay", `/${GAME}/human.json`, HUMAN_TAPE);
await expectComplete("deadline default-action replay", `/${GAME}/default-action.json`, DEFAULT_TAPE);
await expectComplete("natural 2048-pair turn-limit replay", `/${GAME}/turn-limit.json`, TURN_LIMIT_TAPE);
await expectComplete(
  "trusted nonzero-prefix forfeit replay",
  "/tux/v1/replays/forfeit.json",
  PREFIX_TAPE,
  "Authoritative result: Side 1 wins by forfeit.",
);
await expectComplete(
  "trusted nonzero-prefix abandoned replay",
  "/tux/v1/replays/abandoned.json",
  PREFIX_TAPE,
  "Authoritative result: match abandoned.",
);
await expectUntrustedOverride("untrusted forfeit replay", "/untrusted/forfeit.json");
await expectUntrustedOverride("untrusted abandoned replay", "/untrusted/abandoned.json");

assert(browserErrors.length === 0, `unexpected browser errors: ${browserErrors.join(" | ")}`);
cdp.close();
chrome.close();
server.stop(true);
console.log("verify-web-arena-acceptance: PASS");

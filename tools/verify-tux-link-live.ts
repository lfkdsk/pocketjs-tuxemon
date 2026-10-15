#!/usr/bin/env bun
// Real-stack browser acceptance for Tux Link. Unlike verify-tux-link-web.ts,
// this script owns only the static site and two isolated Chrome profiles; all
// capability, OAuth-ticket, match, WebSocket, replay and R2 traffic goes to an
// externally started production gateway + Battle Worker stack.

import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import battleDbJson from "../data/battle-db.json";
import { ARENA_MAX_TURNS } from "../battle/arena.ts";
import { TUX_LINK_TICKET_KEY } from "../ui/tux-link/auth-store.ts";
import { registerCleanup, spawnHeadlessChrome } from "./headless-chrome.ts";
import {
  WEB_CHUNK_AWARE_STEP_EXPRESSION,
  WEB_CHUNK_AWARE_STEP_SOURCE,
} from "./web-chunk-step.ts";

const ROOT = resolve(import.meta.dir, "..");
const GAME = "pocket-tuxemon";

function argument(name: string, fallback?: string): string {
  const equals = process.argv.find((value) => value.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`verify-tux-link-live: ${name} is required`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`verify-tux-link-live: ${message}`);
}

const SITE = resolve(argument("--site-dir", join(ROOT, "dist", "web")));
const OUT = resolve(argument("--out", join(ROOT, "dist", "tux-link-live")));
const STATIC_PORT = Number(argument("--static-port"));
const GATEWAY = new URL(argument("--gateway-url"));
const chromeFlag = process.argv.indexOf("--chrome");
const CHROME = chromeFlag >= 0 ? process.argv[chromeFlag + 1]!
  : process.env.CHROME ?? Bun.which("google-chrome") ?? Bun.which("chromium") ?? "google-chrome";

assert(GATEWAY.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(GATEWAY.hostname),
  "gateway must be an explicit loopback HTTP URL");
assert(Number.isSafeInteger(STATIC_PORT) && STATIC_PORT > 0 && STATIC_PORT <= 65_535,
  "static port is invalid");
assert(existsSync(join(SITE, GAME, "index.html")), "site directory has no built game");

const SITE_ORIGIN = `http://127.0.0.1:${STATIC_PORT}`;
const GAME_URL = `${SITE_ORIGIN}/${GAME}/`;
const OAUTH = {
  creator: "gho_fixture_creator",
  joiner: "gho_fixture_guest",
} as const;
const missingStaticPaths = new Map<string, number>();

function staticResponse(pathname: string): Response {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return new Response("bad path", { status: 400 });
  }
  let path = resolve(SITE, `.${decoded}`);
  if (path !== SITE && !path.startsWith(`${SITE}/`)) return new Response("forbidden", { status: 403 });
  if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
  if (existsSync(path)) return new Response(Bun.file(path));
  missingStaticPaths.set(decoded, (missingStaticPaths.get(decoded) ?? 0) + 1);
  return new Response("not found", { status: 404 });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: STATIC_PORT,
  fetch: (request) => staticResponse(new URL(request.url).pathname),
});
registerCleanup(() => server.stop(true));

interface LinkHookState {
  lang: "en_US" | "zh_CN";
  layer: "base" | "mode" | "link";
  available: boolean;
  auth: string;
  phase: string;
  connectionEpoch: number | null;
  turnRevision: number | null;
  actionIndex: number;
  selfSubmitted: boolean;
  legalActions: Array<{ type: string; slot?: number }>;
  actingMoves: Array<{ slot: number; slug: string }>;
  replayAvailable: boolean;
}

const TECHNIQUES = battleDbJson.techniques as Record<string, {
  power: number;
  accuracy: number;
  effects: Array<{ type: string }>;
}>;
const DIRECT_DAMAGE_EFFECTS = new Set([
  "damage", "life_swap", "multiattack", "prop_damage", "sacrifice", "splash",
]);

interface NetworkReceipt {
  url: string;
  status: number;
  headers: Record<string, string>;
}

class BrowserDriver {
  private sequence = 0;
  private readonly pending = new Map<number, (message: any) => void>();
  readonly errors: string[] = [];
  readonly responses: NetworkReceipt[] = [];

  private constructor(
    readonly label: "creator" | "joiner",
    readonly profile: string,
    private readonly chrome: Awaited<ReturnType<typeof spawnHeadlessChrome>>,
    private readonly cdp: WebSocket,
  ) {
    cdp.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
      } else if (message.method === "Runtime.exceptionThrown") {
        this.errors.push(message.params.exceptionDetails?.exception?.description
          ?? message.params.exceptionDetails?.text ?? "exception");
      } else if (message.method === "Runtime.consoleAPICalled" &&
        ["error", "assert"].includes(message.params.type)) {
        this.errors.push(message.params.args.map((arg: any) => arg.value ?? arg.description).join(" "));
      } else if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
        this.errors.push(message.params.entry.text);
      } else if (message.method === "Network.responseReceived" &&
        String(message.params.response.url).startsWith(GATEWAY.origin)) {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(message.params.response.headers ?? {})) {
          headers[name.toLowerCase()] = String(value);
        }
        this.responses.push({
          url: message.params.response.url,
          status: message.params.response.status,
          headers,
        });
      }
    });
  }

  static async launch(label: "creator" | "joiner", profile: string): Promise<BrowserDriver> {
    const chrome = await spawnHeadlessChrome(CHROME, profile, "1200,900");
    const cdp = new WebSocket(chrome.wsUrl);
    await new Promise<void>((resolveOpen) => cdp.addEventListener("open", () => resolveOpen(), { once: true }));
    const driver = new BrowserDriver(label, profile, chrome, cdp);
    await driver.send("Runtime.enable");
    await driver.send("Log.enable");
    await driver.send("Page.enable");
    await driver.send("Network.enable");
    await driver.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        window.requestAnimationFrame = () => 0;
        window.cancelAnimationFrame = () => {};
        const NativeWebSocket = window.WebSocket;
        window.WebSocket = class TuxLinkAcceptanceWebSocket extends NativeWebSocket {
          constructor(...args) {
            super(...args);
            globalThis.__tuxLinkLiveSocket = this;
          }
        };
        ${WEB_CHUNK_AWARE_STEP_SOURCE}
      `,
    });
    registerCleanup(() => driver.close());
    return driver;
  }

  close(): void {
    this.cdp.close();
    this.chrome.close();
  }

  private send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolveMessage, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, (message) => message.error
        ? reject(new Error(`${this.label}: ${message.error.message}`))
        : resolveMessage(message.result));
      this.cdp.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T = any>(expression: string): Promise<T> {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`${this.label}: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result.value as T;
  }

  async navigate(url: string): Promise<void> {
    const loaded = new Promise<void>((resolveLoad) => {
      const listener = (event: MessageEvent) => {
        const message = JSON.parse(String(event.data));
        if (message.method !== "Page.loadEventFired") return;
        this.cdp.removeEventListener("message", listener);
        resolveLoad();
      };
      this.cdp.addEventListener("message", listener);
    });
    await this.send("Page.navigate", { url });
    await loaded;
  }

  async reload(): Promise<void> {
    const url = await this.evaluate<string>("location.href");
    await this.navigate(url);
  }

  async step(count = 1): Promise<void> {
    await this.evaluate(`(async () => {
      for (let i = 0; i < ${count}; i++) await (${WEB_CHUNK_AWARE_STEP_EXPRESSION});
    })()`);
  }

  async waitFor(label: string, expression: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.evaluate<boolean>(expression).catch(() => false)) return;
      await this.step().catch(() => {});
      await Bun.sleep(20);
    }
    const detail = await this.evaluate(`({
      href: location.href,
      player: globalThis.__pocketPlayer?.state,
      link: globalThis.__pocketTuxLink?.state?.(),
      replay: globalThis.__pocketArenaReplay?.state?.(),
    })`).catch(() => null);
    throw new Error(`${this.label}: timeout waiting for ${label}: ${JSON.stringify(detail)}; ${this.errors.join(" | ")}`);
  }

  async hook(): Promise<LinkHookState> {
    return this.evaluate("globalThis.__pocketTuxLink.state()");
  }

  async pressKey(code: string, key: string, windowsVirtualKeyCode: number): Promise<void> {
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", code, key, windowsVirtualKeyCode });
    await this.step();
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", code, key, windowsVirtualKeyCode });
    await this.step();
  }

  async disconnectSocket(): Promise<void> {
    const closed = await this.evaluate<boolean>(`(() => {
      const socket = globalThis.__tuxLinkLiveSocket;
      if (!(socket instanceof WebSocket) || socket.readyState > WebSocket.OPEN) return false;
      socket.close(4000, "acceptance reconnect");
      return true;
    })()`);
    assert(closed, `${this.label} had no live WebSocket to disconnect`);
  }

  async screenshot(path: string): Promise<void> {
    const result = await this.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    await Bun.write(path, Buffer.from(result.data, "base64"));
  }

  async canvasStats(): Promise<{ width: number; height: number; unique: number }> {
    return this.evaluate(`(() => {
      globalThis.__pocketPlayer.paint();
      const canvas = document.getElementById("screen");
      const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      const colors = new Set();
      for (let y = 0; y < canvas.height; y += 16) for (let x = 0; x < canvas.width; x += 16) {
        const offset = (y * canvas.width + x) * 4;
        colors.add([data[offset], data[offset + 1], data[offset + 2], data[offset + 3]].join(","));
      }
      return { width: canvas.width, height: canvas.height, unique: colors.size };
    })()`);
  }
}

async function exchangeTicket(
  driver: BrowserDriver,
  oauthToken: string,
  lang: "en" | "zh",
  fragment = "",
): Promise<{ status: number; type: string; finalOrigin: string }> {
  await driver.navigate(`${GAME_URL}?lang=${lang}${fragment}`);
  await driver.waitFor("initial Link capability", `globalThis.__pocketPlayer?.state === "running" &&
    globalThis.__pocketTuxLink?.state().available === true`);
  const receipt = await driver.evaluate<{
    status: number;
    type: string;
    finalOrigin: string;
    storedOauth: boolean;
  }>(`(async () => {
    const oauthToken = ${JSON.stringify(oauthToken)};
    const response = await fetch(${JSON.stringify(new URL("tux/v1/oauth-ticket", GATEWAY).href)}, {
      method: "POST",
      credentials: "omit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ v: 1, oauthToken }),
    });
    const value = await response.json();
    if (!response.ok || value?.ok !== true || typeof value.ticket !== "string") {
      throw new Error("OAuth exchange failed: " + response.status);
    }
    localStorage.setItem(${JSON.stringify(TUX_LINK_TICKET_KEY)}, JSON.stringify({ ticket: value.ticket }));
    const storedOauth = [...Object.values(localStorage), ...Object.values(sessionStorage)]
      .some((item) => String(item).includes(oauthToken));
    return { status: response.status, type: response.type, finalOrigin: new URL(response.url).origin, storedOauth };
  })()`);
  assert(!receipt.storedOauth, `${driver.label} OAuth credential reached browser storage`);
  await driver.reload();
  await driver.waitFor("persisted Link ticket", `globalThis.__pocketPlayer?.state === "running" &&
    globalThis.__pocketTuxLink?.state().available === true &&
    globalThis.__pocketTuxLink?.state().auth === "ready"`);
  return { status: receipt.status, type: receipt.type, finalOrigin: receipt.finalOrigin };
}

async function openLink(driver: BrowserDriver): Promise<void> {
  await driver.evaluate(`(() => {
    if (globalThis.__tuxLinkLiveInviteBridgeInstalled) return;
    const pageEvent = globalThis.__pocketAuthEvent;
    globalThis.__pocketAuthEvent = (event) => {
      // Capture the one-time secret only inside this isolated profile, while
      // preserving the production page bridge (including invite cleanup).
      if (event?.type === "invite" && typeof event.token === "string") {
        globalThis.__tuxLinkLiveInvite = event.token;
      } else if (event?.type === "inviteEnd" || event?.type === "inviteConsumed") {
        delete globalThis.__tuxLinkLiveInvite;
      }
      pageEvent?.(event);
    };
    globalThis.__tuxLinkLiveInviteBridgeInstalled = true;
  })()`);
  await driver.evaluate("globalThis.__pocketPlayer.focus()");
  await driver.step(3);
  const battleIndex = await driver.evaluate<number>(`globalThis.__pocketTitleBattle.titleRows().indexOf("battle")`);
  for (let guard = 0; guard < 8; guard++) {
    const selected = await driver.evaluate<number>("globalThis.__pocketTitleBattle.state().titleIndex");
    if (selected === battleIndex) break;
    await driver.pressKey("ArrowDown", "ArrowDown", 40);
  }
  await driver.pressKey("Enter", "Enter", 13);
  await driver.waitFor("Battle mode submenu", `globalThis.__pocketTuxLink.state().layer === "mode"`);
  await driver.pressKey("ArrowDown", "ArrowDown", 40);
  await driver.pressKey("Enter", "Enter", 13);
  await driver.waitFor("Link screen", `globalThis.__pocketTuxLink.state().layer === "link"`);
}

function bestActionIndex(state: LinkHookState): number {
  let best = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < state.legalActions.length; index++) {
    const action = state.legalActions[index]!;
    if (action.type !== "move" || action.slot === undefined) continue;
    const slug = state.actingMoves.find((move) => move.slot === action.slot)?.slug;
    const technique = slug ? TECHNIQUES[slug] : undefined;
    if (!technique) continue;
    const direct = technique.effects.some((effect) => DIRECT_DAMAGE_EFFECTS.has(effect.type));
    const score = (direct ? 1_000_000 : 0) + Math.max(0, technique.power) *
      Math.max(0, Math.min(1, technique.accuracy));
    if (score > bestScore) {
      best = index;
      bestScore = score;
    }
  }
  return best < 0 ? 0 : best;
}

async function submitBestAction(driver: BrowserDriver): Promise<void> {
  const initial = await driver.hook();
  const selected = bestActionIndex(initial);
  for (let guard = 0; guard < 128 && (await driver.hook()).actionIndex > 0; guard++) {
    await driver.pressKey("ArrowUp", "ArrowUp", 38);
  }
  for (let index = 0; index < selected; index++) {
    await driver.pressKey("ArrowDown", "ArrowDown", 40);
  }
  const before = await driver.hook();
  assert(before.actionIndex === selected, `${driver.label} could not select the strongest legal action`);
  await driver.pressKey("Enter", "Enter", 13);
  await driver.waitFor("submitted action", `(() => {
    const state = globalThis.__pocketTuxLink.state();
    return state.phase === "submitted" || state.phase === "ended" ||
      (state.turnRevision !== null && state.turnRevision > ${before.turnRevision ?? -1});
  })()`);
}

async function playReplay(driver: BrowserDriver): Promise<{
  terminalHash: string;
  envelopeHash: string;
  total: number;
  responseStatus: number;
  responseType: string;
  responseOrigin: string;
  responsePathTrusted: boolean;
  mime: string;
}> {
  await driver.pressKey("Enter", "Enter", 13);
  await driver.waitFor("immutable replay route", `location.pathname.includes("/replays/") &&
    location.pathname.endsWith("/replay.html")`, 60_000);
  await driver.waitFor("replay document", `globalThis.__pocketPlayer?.state === "running" &&
    globalThis.__pocketArenaReplay?.state().status === "ready"`, 60_000);
  const source = await driver.evaluate<{
    envelopeHash: string;
    responseStatus: number;
    responseType: string;
    responseOrigin: string;
    responsePathTrusted: boolean;
    mime: string;
  }>(`(async () => {
    const source = new URLSearchParams(location.search).get("battleReplay");
    const response = await fetch(source, { credentials: "omit" });
    const value = await response.json();
    const final = new URL(response.url);
    const trusted = new URL(${JSON.stringify(new URL("tux/v1/replays/", GATEWAY).href)});
    return {
      envelopeHash: value.preTerminalHash,
      responseStatus: response.status,
      responseType: response.type,
      responseOrigin: final.origin,
      responsePathTrusted: final.origin === trusted.origin && final.pathname.startsWith(trusted.pathname),
      mime: (response.headers.get("content-type") || "").split(";", 1)[0],
    };
  })()`);
  const total = await driver.evaluate<number>("globalThis.__pocketArenaReplay.state().total");
  await driver.evaluate(`(() => {
    const replay = globalThis.__pocketArenaReplay;
    replay.restart();
    for (let turn = 0; turn < ${total}; turn++) replay.step();
  })()`);
  await driver.step(3);
  const state = await driver.evaluate<{ turn: number; terminalHash: string | null }>(
    "globalThis.__pocketArenaReplay.state()",
  );
  assert(state.turn === total && typeof state.terminalHash === "string", `${driver.label} replay did not finish`);
  return { ...source, terminalHash: state.terminalHash, total };
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const profile of ["creator-profile", "joiner-profile"]) {
  registerCleanup(() => rmSync(join(OUT, profile), { recursive: true, force: true }));
}

const creator = await BrowserDriver.launch("creator", join(OUT, "creator-profile"));
const joiner = await BrowserDriver.launch("joiner", join(OUT, "joiner-profile"));

const creatorExchange = await exchangeTicket(creator, OAUTH.creator, "en");
await openLink(creator);
await creator.pressKey("Enter", "Enter", 13);
await creator.waitFor("created invitation", `globalThis.__pocketTuxLink.state().phase === "waiting" &&
  typeof globalThis.__tuxLinkLiveInvite === "string"`);
const invitationUrl = await creator.evaluate<string>(`(() => {
  const url = new URL(location.href);
  url.hash = "invite=" + encodeURIComponent(globalThis.__tuxLinkLiveInvite);
  delete globalThis.__tuxLinkLiveInvite;
  return url.href;
})()`);
const inviteFragment = new URL(invitationUrl).hash;
assert(inviteFragment.startsWith("#invite=") && new URL(invitationUrl).origin === SITE_ORIGIN &&
  !invitationUrl.startsWith(GATEWAY.origin),
  "invitation was not confined to the game-page fragment");

const joinerExchange = await exchangeTicket(joiner, OAUTH.joiner, "zh", inviteFragment);
await openLink(joiner);
await Promise.all([
  creator.waitFor("creator first decision", `globalThis.__pocketTuxLink.state().phase === "decision"`),
  joiner.waitFor("joiner first decision", `globalThis.__pocketTuxLink.state().phase === "decision"`),
]);
const consumed = await joiner.evaluate(`({ hash: location.hash, invite: globalThis.__pocketInvite,
  stored: sessionStorage.getItem("pocket-rpgkit:invite") })`);
assert(consumed.hash === "" && consumed.invite === undefined && consumed.stored === null,
  "invitation was not consumed and cleared");

await submitBestAction(creator);
await creator.disconnectSocket();
await creator.waitFor("offline reconnect state", `globalThis.__pocketTuxLink.state().phase === "reconnecting"`);
await creator.waitFor("restored pending action", `globalThis.__pocketTuxLink.state().connectionEpoch === 2 &&
  globalThis.__pocketTuxLink.state().phase === "submitted" &&
  globalThis.__pocketTuxLink.state().turnRevision === 0`, 60_000);
await submitBestAction(joiner);
await Promise.all([
  creator.waitFor("first resolved turn", `globalThis.__pocketTuxLink.state().turnRevision === 1`),
  joiner.waitFor("first resolved turn", `globalThis.__pocketTuxLink.state().turnRevision === 1`),
]);

let turn = 1;
for (; turn < ARENA_MAX_TURNS; turn++) {
  const states = await Promise.all([creator.hook(), joiner.hook()]);
  if (states.every((state) => state.phase === "ended")) break;
  assert(states.every((state) => state.phase === "decision" && state.turnRevision === turn),
    `clients diverged before turn ${turn}: ${JSON.stringify(states)}`);
  await submitBestAction(creator);
  await submitBestAction(joiner);
  await Promise.all([
    creator.waitFor(`creator turn ${turn + 1}`, `(() => {
      const state = globalThis.__pocketTuxLink.state();
      return state.phase === "ended" || state.turnRevision === ${turn + 1};
    })()`),
    joiner.waitFor(`joiner turn ${turn + 1}`, `(() => {
      const state = globalThis.__pocketTuxLink.state();
      return state.phase === "ended" || state.turnRevision === ${turn + 1};
    })()`),
  ]);
}

const terminal = await Promise.all([creator.hook(), joiner.hook()]);
assert(terminal.every((state) => state.phase === "ended" && state.replayAvailable),
  `terminal replay link missing: ${JSON.stringify(terminal)}`);
assert(terminal[0]!.turnRevision === terminal[1]!.turnRevision, "terminal revisions differ");

const resultPixels = await creator.canvasStats();
assert(resultPixels.width === 960 && resultPixels.height === 544 && resultPixels.unique >= 20,
  `terminal frame lacks visual detail: ${JSON.stringify(resultPixels)}`);
await creator.screenshot(join(OUT, "link-result.png"));

const [creatorReplay, joinerReplay] = await Promise.all([
  playReplay(creator),
  playReplay(joiner),
]);
for (const replay of [creatorReplay, joinerReplay]) {
  assert(replay.terminalHash === replay.envelopeHash, "immutable player hash differs from envelope boundary");
  assert(replay.responseStatus === 200 && replay.responseType === "cors" &&
    replay.responseOrigin === GATEWAY.origin && replay.responsePathTrusted && replay.mime === "application/json",
  `replay transport failed closed contract: ${JSON.stringify(replay)}`);
}
assert(creatorReplay.terminalHash === joinerReplay.terminalHash && creatorReplay.total === joinerReplay.total,
  "two browsers replayed to different terminal states");

const replayPixels = await creator.canvasStats();
assert(replayPixels.width === 960 && replayPixels.height === 544 && replayPixels.unique >= 20,
  `replay frame lacks visual detail: ${JSON.stringify(replayPixels)}`);
await creator.screenshot(join(OUT, "replay-terminal.png"));

const replayNetwork = creator.responses.find((response) =>
  new URL(response.url).pathname.startsWith("/tux/v1/replays/") && response.status === 200
);
assert(replayNetwork?.headers["access-control-allow-origin"] === SITE_ORIGIN,
  `replay response CORS was not exact: ${JSON.stringify(replayNetwork?.headers)}`);
assert(creator.errors.length === 0 && joiner.errors.length === 0,
  `browser errors: ${[...creator.errors, ...joiner.errors].join(" | ")}; missing static: ` +
  JSON.stringify(Object.fromEntries(missingStaticPaths)));

const receipt = {
  topology: "gateway-service-binding-battle-r2-two-browser",
  browsers: 2,
  oauth: {
    creator: creatorExchange,
    joiner: joinerExchange,
    credentials: "omit",
    credentialStored: false,
  },
  match: {
    reconnectEpoch: 2,
    terminalTurn: terminal[0]!.turnRevision,
    replayAvailable: true,
  },
  replay: {
    terminalHash: creatorReplay.terminalHash,
    turns: creatorReplay.total,
    responseStatus: creatorReplay.responseStatus,
    responseType: creatorReplay.responseType,
    responseOrigin: creatorReplay.responseOrigin,
    responsePathTrusted: creatorReplay.responsePathTrusted,
    mime: creatorReplay.mime,
    corsOrigin: replayNetwork.headers["access-control-allow-origin"],
  },
  pixels: { result: resultPixels, replay: replayPixels },
  screenshots: ["link-result.png", "replay-terminal.png"],
};
await Bun.write(join(OUT, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);

console.log("verify-tux-link-live: PASS");
console.log(JSON.stringify(receipt, null, 2));

creator.close();
joiner.close();
server.stop(true);

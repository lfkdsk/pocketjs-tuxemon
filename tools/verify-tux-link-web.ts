#!/usr/bin/env bun
// Real-browser acceptance for the Web-only Tux Link client. Two isolated
// Chrome profiles join one deterministic, in-process Wire-v1 match. The
// service is a strict client fixture, not a substitute for the deployment
// acceptance against the separately versioned Battle service.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";

import {
  TUX_ARENA_VERSION,
  TUX_REQUIRED_CAPS,
  TUX_SUPPORTED_CAPS,
  TUX_WIRE_VERSION,
  decodeTuxClientFrame,
  type TuxClientFrame,
  type TuxPublicObservation,
  type TuxPublicPresentation,
} from "../battle/tux-link-wire.ts";
import { TUX_LINK_TICKET_KEY } from "../ui/tux-link/auth-store.ts";
import { decodePng } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/compiler/pak.ts";
import { registerCleanup, spawnHeadlessChrome } from "./headless-chrome.ts";
import {
  WEB_CHUNK_AWARE_STEP_EXPRESSION,
  WEB_CHUNK_AWARE_STEP_SOURCE,
} from "./web-chunk-step.ts";

const ROOT = resolve(import.meta.dir, "..");
const SITE = join(ROOT, "dist", "web");
const GAME = "pocket-tuxemon";
const OUT = join(ROOT, "dist", "tux-link-web");
const GOLDENS = join(ROOT, "tests", "goldens", "tux-link");
const PORT = 49_190;
const BASE = `http://127.0.0.1:${PORT}`;
const TRUSTED_REPLAY_BASE = `${BASE}/tux/v1/replays/`;
const UPDATE = process.argv.includes("--update");
const BUILD = process.argv.includes("--build");
const chromeFlag = process.argv.indexOf("--chrome");
const CHROME = chromeFlag >= 0 ? process.argv[chromeFlag + 1]!
  : process.env.CHROME ?? Bun.which("google-chrome") ?? Bun.which("chromium") ?? "google-chrome";

const MATCH = "match_0000000000000001";
const SECRET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const INVITE = `${MATCH}.${SECRET}`;
const TICKETS = ["browser-ticket-creator", "browser-ticket-joiner"] as const;
const DEADLINES = [4_102_444_830_000, 4_102_444_860_000] as const;
const EXPIRES_AT_MS = 4_102_444_800_000;
const REPLAY_URL = `${TRUSTED_REPLAY_BASE}${MATCH}?expires=4102444800&signature=opaque`;

if (BUILD) {
  const build = Bun.spawn([process.execPath, join(ROOT, "tools", "web.ts")], {
    cwd: ROOT,
    env: {
      ...process.env,
      TUX_BATTLE_BASE_URL: BASE,
      TUX_GITHUB_CLIENT_ID: "pocket_tuxemon_link_verifier",
      TUX_GITHUB_AUTH_WORKER: "https://auth.example.invalid/tux",
    },
    stdio: ["inherit", "inherit", "inherit"],
  });
  const exitCode = await build.exited;
  if (exitCode !== 0) process.exit(exitCode);
}

if (!existsSync(join(SITE, GAME, "index.html"))) {
  console.error("verify-tux-link-web: no Web site at dist/web; build it with the loopback Link URL first");
  process.exit(2);
}

type Side = 0 | 1;
type SocketData = { id: number; side: Side | null };
interface BrowserSocket {
  readonly data: SocketData;
  send(data: string): number;
  close(code?: number, reason?: string): void;
}
interface UpgradeServer {
  upgrade(request: Request, options: { data: SocketData }): boolean;
}

const NAME = { en_US: "Dupmon", zh_CN: "重复兽" } as const;
const SPECIES = { slug: "dupmon", displayName: NAME } as const;
const STATS = { armour: 10, dodge: 10, hp: 20, melee: 10, ranged: 10, speed: 10 } as const;

function ownMonster(party: number, active: boolean) {
  return {
    party,
    active,
    species: SPECIES,
    level: 20,
    hp: { current: 20, max: 20, percent: 100 },
    status: null,
    types: ["normal"],
    gender: "neuter",
    base: STATS,
    stages: {},
    moves: [{
      slot: 0,
      slug: "tap",
      displayName: { en_US: "Tap", zh_CN: "轻拍" },
      cooldown: 0,
    }],
  };
}

function observation(
  side: Side,
  turn: number,
  ownActive: number,
  opponentPublicId: string,
  result: TuxPublicObservation["result"] = null,
): TuxPublicObservation {
  return {
    v: 1,
    side,
    format: "single",
    turn,
    round: turn + 1,
    deadlineTicks: 1_800,
    actingParty: result ? null : ownActive,
    own: {
      active: [ownActive],
      party: [0, 1, 2].map((party) => ownMonster(party, party === ownActive)),
    },
    opponent: {
      active: [{
        position: 0,
        species: SPECIES,
        level: 20,
        hpPercent: turn === 0 ? 100 : turn === 1 ? 62 : 0,
        status: null,
        revealedMoves: [],
        publicId: opponentPublicId,
      }],
    },
    legalActions: result ? [] : [
      { type: "move", slot: 0 },
      { type: "swap", party: (ownActive + 1) % 3 },
    ],
    result,
  };
}

function observationFor(side: Side, turn: number, terminal = false): TuxPublicObservation {
  const result = terminal
    ? { winner: 0 as const, turns: 2, reason: "knockout" as const }
    : null;
  if (side === 0) {
    return observation(0, turn, 0, turn === 0 ? "p_Asees_B0" : "p_Asees_B1", result);
  }
  return observation(1, turn, turn === 0 ? 0 : 1, "p_Bsees_A0", result);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`verify-tux-link-web: ${message}`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

class MockWireService {
  readonly requests: string[] = [];
  readonly clientFrames: Array<{ side: Side; frame: TuxClientFrame }> = [];
  readonly serverFrames: Array<{ side: Side; frame: Record<string, unknown> }> = [];
  readonly epochs: [number, number] = [0, 0];
  readonly sockets: Array<BrowserSocket | null> = [null, null];
  readonly welcomed: [boolean, boolean] = [false, false];
  readonly pending = new Map<Side, Extract<TuxClientFrame, { type: "submit" }>>();
  nextSocketId = 1;
  turn = 0;

  constructor(readonly replayCapability: boolean) {
    const advertised = this.advertisedCaps();
    assert((advertised & TUX_REQUIRED_CAPS) === TUX_REQUIRED_CAPS,
      `mock capability bits ${advertised} omit required client bits ${TUX_REQUIRED_CAPS}`);
  }

  private advertisedCaps(): number {
    return this.replayCapability ? TUX_SUPPORTED_CAPS : TUX_REQUIRED_CAPS;
  }

  async response(request: Request, server: UpgradeServer): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname === "/tux/v1/capabilities") {
      this.requests.push(`${request.method} ${url.pathname}`);
      return Response.json({
        service: "tux-battle",
        enabled: true,
        wireV: TUX_WIRE_VERSION,
        arenaV: TUX_ARENA_VERSION,
        caps: this.advertisedCaps(),
        requiredCaps: TUX_REQUIRED_CAPS,
      });
    }
    if (url.pathname === "/tux/v1/matches") {
      this.requests.push(`${request.method} ${url.pathname}`);
      if (request.method !== "POST") return new Response("method", { status: 405 });
      const value = await request.json() as Record<string, unknown>;
      assert(value.v === 1 && value.ticket === TICKETS[0] && typeof value.requestId === "string",
        `invalid create request ${JSON.stringify(value)}`);
      return Response.json({ ok: true, v: 1, matchId: MATCH, invite: INVITE, expiresAtMs: EXPIRES_AT_MS });
    }
    if (url.pathname === "/ws/tux/v1") {
      this.requests.push(`WS ${url.pathname}${url.search}`);
      if (url.searchParams.get("match") !== MATCH || url.searchParams.size !== 1) {
        return new Response("match", { status: 400 });
      }
      const upgraded = server.upgrade(request, {
        data: { id: this.nextSocketId++, side: null },
      });
      return upgraded ? undefined : new Response("upgrade", { status: 500 });
    }
    return this.staticResponse(url.pathname);
  }

  private staticResponse(pathname: string): Response {
    let path = resolve(SITE, `.${decodeURIComponent(pathname)}`);
    if (!path.startsWith(SITE)) return new Response("forbidden", { status: 403 });
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
    return existsSync(path) ? new Response(Bun.file(path)) : new Response("not found", { status: 404 });
  }

  message(ws: BrowserSocket, data: string | Buffer): void {
    if (typeof data !== "string") {
      ws.close(1008, "protocol");
      return;
    }
    const frame = decodeTuxClientFrame(data);
    if (!frame) {
      ws.close(1008, "protocol");
      return;
    }
    if (frame.type === "hello") {
      const side = TICKETS.indexOf(frame.ticket as typeof TICKETS[number]);
      if ((side !== 0 && side !== 1) || (side === 1 && this.epochs[1] === 0 && frame.invite !== SECRET) ||
        (side === 0 && frame.invite !== undefined)) {
        ws.close(1008, "auth");
        return;
      }
      ws.data.side = side;
      this.epochs[side]++;
      this.sockets[side] = ws;
      this.clientFrames.push({ side, frame });
      if (this.sockets[0] && this.sockets[1]) {
        for (const recipient of [0, 1] as const) {
          if (!this.welcomed[recipient] || recipient === side) this.welcome(recipient);
        }
      }
      return;
    }
    const side = ws.data.side;
    if (side === null || frame.turnRevision !== this.turn) {
      ws.close(1008, "protocol");
      return;
    }
    this.clientFrames.push({ side, frame });
    if (this.pending.has(side)) {
      this.send(side, {
        type: "rejected",
        v: 1,
        turnRevision: this.turn,
        requestId: frame.requestId,
        reason: "ALREADY_SUBMITTED",
      });
      return;
    }
    this.pending.set(side, frame);
  }

  close(ws: BrowserSocket): void {
    const side = ws.data.side;
    if (side !== null && this.sockets[side] === ws) this.sockets[side] = null;
  }

  private welcome(side: Side): void {
    this.welcomed[side] = true;
    this.send(side, {
      type: "welcome",
      v: TUX_WIRE_VERSION,
      arenaV: TUX_ARENA_VERSION,
      caps: this.advertisedCaps(),
      side,
      connectionEpoch: this.epochs[side],
      turnRevision: this.turn,
      deadlineAtMs: DEADLINES[Math.min(this.turn, 1)]!,
      selfSubmitted: this.pending.has(side),
      observation: observationFor(side, this.turn),
    });
  }

  accept(side: Side): void {
    const submission = this.pending.get(side);
    assert(submission, `cannot accept side ${side} without a pending action`);
    this.send(side, {
      type: "accepted",
      v: 1,
      turnRevision: this.turn,
      requestId: submission.requestId,
      selfSubmitted: true,
    });
  }

  resolve(): void {
    assert(this.pending.size === 2, `cannot resolve ${this.pending.size} submitted sides`);
    this.turn++;
    if (this.turn === 1) {
      for (const side of [0, 1] as const) {
        const presentation: TuxPublicPresentation = [
          { kind: "action", actor: side === 0 ? "self" : "opponent", action: { type: "move", move: "tap" } },
          { kind: "action", actor: side === 0 ? "opponent" : "self", action: { type: "swap" } },
        ];
        this.send(side, {
          type: "resolved",
          v: 1,
          turnRevision: 1,
          deadlineAtMs: DEADLINES[1],
          observation: observationFor(side, 1),
          presentation,
        });
      }
    } else {
      assert(this.turn === 2, `unexpected terminal turn ${this.turn}`);
      for (const side of [0, 1] as const) {
        this.send(side, {
          type: "ended",
          v: TUX_WIRE_VERSION,
          turnRevision: 2,
          result: { winner: side === 0 ? "self" : "opponent", reason: "knockout" },
          observation: observationFor(side, 2, true),
          ...(this.replayCapability ? { replayUrl: REPLAY_URL } : {}),
        });
      }
    }
    this.pending.clear();
  }

  disconnect(side: Side): void {
    const socket = this.sockets[side];
    assert(socket, `side ${side} has no socket to disconnect`);
    socket.close(1012, "network");
  }

  sentCount(side: Side): number {
    return this.serverFrames.filter((entry) => entry.side === side).length;
  }

  submitCount(side: Side, turn: number): number {
    return this.clientFrames.filter((entry) => entry.side === side && entry.frame.type === "submit" &&
      entry.frame.turnRevision === turn).length;
  }

  private send(side: Side, frame: Record<string, unknown>): void {
    const socket = this.sockets[side];
    assert(socket, `side ${side} has no live socket`);
    this.serverFrames.push({ side, frame });
    socket.send(JSON.stringify(frame));
  }
}

let service = new MockWireService(false);
const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1",
  port: PORT,
  fetch: (request, server) => service.response(request, server),
  websocket: {
    message: (ws, data) => service.message(ws, data),
    close: (ws) => service.close(ws),
  },
});
registerCleanup(() => server.stop(true));

interface HookState {
  lang: "en_US" | "zh_CN";
  layer: "base" | "mode" | "link";
  available: boolean;
  auth: string;
  phase: string;
  connectionEpoch: number | null;
  turnRevision: number | null;
  deadlineAtMs: number | null;
  actionIndex: number;
  selfSubmitted: boolean;
  legalActions: TuxPublicObservation["legalActions"];
  actingMoves: Array<{ slot: number; slug: string }>;
  opponentRefs: string[];
  replayUrl: string | null;
  replayAvailable: boolean;
  opponentSpecies: string[];
}

class BrowserDriver {
  private sequence = 0;
  private readonly pending = new Map<number, (message: any) => void>();
  readonly errors: string[] = [];
  readonly profile: string;
  private constructor(
    readonly label: string,
    profile: string,
    private readonly chrome: Awaited<ReturnType<typeof spawnHeadlessChrome>>,
    private readonly cdp: WebSocket,
  ) {
    this.profile = profile;
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
      }
    });
  }

  static async launch(label: string, profile: string, windowSize: string): Promise<BrowserDriver> {
    const chrome = await spawnHeadlessChrome(CHROME, profile, windowSize);
    const cdp = new WebSocket(chrome.wsUrl);
    await new Promise<void>((resolveOpen) => cdp.addEventListener("open", () => resolveOpen(), { once: true }));
    const driver = new BrowserDriver(label, profile, chrome, cdp);
    await driver.send("Runtime.enable");
    await driver.send("Log.enable");
    await driver.send("Page.enable");
    await driver.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        window.requestAnimationFrame = () => 0;
        window.cancelAnimationFrame = () => {};
        globalThis.__tuxLinkGamepads = [];
        Object.defineProperty(Navigator.prototype, "getGamepads", {
          configurable: true,
          value() { return globalThis.__tuxLinkGamepads; },
        });
        if (location.origin === ${JSON.stringify(BASE)}) {
          localStorage.setItem(${JSON.stringify(TUX_LINK_TICKET_KEY)}, ${JSON.stringify(JSON.stringify({ ticket: TICKETS[label === "creator" ? 0 : 1] }))});
        }
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

  async configureDevice(width: number, height: number, mobile: boolean, deviceScaleFactor = 1): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor,
      mobile,
    });
    await this.send("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: 5 });
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
      player: globalThis.__pocketPlayer?.state,
      link: globalThis.__pocketTuxLink?.state?.(),
      title: globalThis.__pocketTitleBattle?.state?.(),
      chunks: globalThis.__pocketPlayer?.pakChunks?.stats?.(),
    })`).catch(() => null);
    throw new Error(`${this.label}: timeout waiting for ${label}: ${JSON.stringify(detail)}; ${this.errors.join(" | ")}`);
  }

  async hook(): Promise<HookState> {
    return this.evaluate(`globalThis.__pocketTuxLink.state()`);
  }

  async pressKey(code: string, key: string, windowsVirtualKeyCode: number): Promise<{ heldMask: number; sourceCount: number }> {
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", code, key, windowsVirtualKeyCode });
    const pressed = await this.evaluate(`({
      heldMask: globalThis.__pocketPlayer.buttons(),
      sourceCount: globalThis.__pocketPlayer.keys.size,
    })`);
    await this.step();
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", code, key, windowsVirtualKeyCode });
    await this.step();
    return pressed;
  }

  private async elementCenter(selector: string): Promise<{ x: number; y: number }> {
    return this.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error(${JSON.stringify(`missing touch control ${selector}`)});
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
  }

  async pressTouch(button: string): Promise<{ heldMask: number; sourceCount: number }> {
    const point = await this.elementCenter(`[data-button="${button}"]`);
    await this.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ ...point, id: 1 }],
    });
    const pressed = await this.evaluate(`({
      heldMask: globalThis.__pocketPlayer.buttons(),
      sourceCount: globalThis.__pocketPlayer.pad.size,
    })`);
    await this.step();
    await this.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await this.step();
    return pressed;
  }

  async connectGamepad(): Promise<void> {
    await this.evaluate(`(() => {
      const make = (pressed = []) => ({
        index: 0,
        connected: true,
        mapping: "standard",
        axes: [0, 0],
        buttons: Array.from({ length: 18 }, (_, index) => ({
          pressed: pressed.includes(index),
          touched: false,
          value: pressed.includes(index) ? 1 : 0,
        })),
      });
      globalThis.__tuxLinkMakePad = make;
      const pad = make();
      globalThis.__tuxLinkGamepads[0] = pad;
      const event = new Event("gamepadconnected");
      Object.defineProperty(event, "gamepad", { value: pad });
      dispatchEvent(event);
    })()`);
  }

  async pressGamepad(index: number): Promise<number> {
    const held = await this.evaluate<number>(`(() => {
      globalThis.__tuxLinkGamepads[0] = globalThis.__tuxLinkMakePad([${index}]);
      return globalThis.__pocketPlayer.buttons();
    })()`);
    await this.step();
    await this.evaluate(`globalThis.__tuxLinkGamepads[0] = globalThis.__tuxLinkMakePad([])`);
    await this.step();
    return held;
  }

  async canvasPng(width: number, height: number): Promise<Uint8Array> {
    await this.evaluate(`globalThis.__pocketPlayer.paint()`);
    const encoded = await this.evaluate<string>(`(() => {
      const source = document.getElementById("screen");
      const canvas = document.createElement("canvas");
      canvas.width = ${width};
      canvas.height = ${height};
      const context = canvas.getContext("2d");
      context.imageSmoothingEnabled = false;
      context.drawImage(source, 0, 0, ${width}, ${height});
      return canvas.toDataURL("image/png").split(",")[1];
    })()`);
    return Uint8Array.from(Buffer.from(encoded, "base64"));
  }

  async semanticPixels(): Promise<{
    width: number;
    height: number;
    unique: number;
    selected: number[];
    unselected: number[];
    panel: number[];
    backdrop: number[];
  }> {
    return this.evaluate(`(() => {
      globalThis.__pocketPlayer.paint();
      const canvas = document.getElementById("screen");
      const context = canvas.getContext("2d");
      const density = canvas.width / 480;
      const mean = (x, y, w, h) => {
        const data = context.getImageData(x * density, y * density, w * density, h * density).data;
        const sum = [0, 0, 0, 0];
        for (let i = 0; i < data.length; i += 4) {
          sum[0] += data[i]; sum[1] += data[i + 1]; sum[2] += data[i + 2]; sum[3] += data[i + 3];
        }
        const count = data.length / 4;
        return sum.map((value) => Math.round(value / count));
      };
      const all = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const colors = new Set();
      for (let y = 0; y < canvas.height; y += 16) for (let x = 0; x < canvas.width; x += 16) {
        const offset = (y * canvas.width + x) * 4;
        colors.add([all[offset], all[offset + 1], all[offset + 2], all[offset + 3]].join(","));
      }
      return {
        width: canvas.width,
        height: canvas.height,
        unique: colors.size,
        selected: mean(249, 69, 7, 20),
        unselected: mean(249, 100, 7, 20),
        panel: mean(20, 52, 12, 20),
        backdrop: mean(2, 52, 12, 20),
      };
    })()`);
  }

  async resultSemanticPixels(): Promise<{
    width: number;
    height: number;
    unique: number;
    button: number[];
    border: number[];
    panel: number[];
    backdrop: number[];
  }> {
    return this.evaluate(`(() => {
      globalThis.__pocketPlayer.paint();
      const canvas = document.getElementById("screen");
      const context = canvas.getContext("2d");
      const density = canvas.width / 480;
      const mean = (x, y, w, h) => {
        const data = context.getImageData(x * density, y * density, w * density, h * density).data;
        const sum = [0, 0, 0, 0];
        for (let i = 0; i < data.length; i += 4) {
          sum[0] += data[i]; sum[1] += data[i + 1]; sum[2] += data[i + 2]; sum[3] += data[i + 3];
        }
        const count = data.length / 4;
        return sum.map((value) => Math.round(value / count));
      };
      const all = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const colors = new Set();
      for (let y = 0; y < canvas.height; y += 16) for (let x = 0; x < canvas.width; x += 16) {
        const offset = (y * canvas.width + x) * 4;
        colors.add([all[offset], all[offset + 1], all[offset + 2], all[offset + 3]].join(","));
      }
      return {
        width: canvas.width,
        height: canvas.height,
        unique: colors.size,
        button: mean(145, 171, 8, 20),
        border: mean(136, 164, 2, 36),
        panel: mean(86, 67, 8, 20),
        backdrop: mean(2, 52, 12, 20),
      };
    })()`);
  }
}

function colorDistance(left: number[], right: number[]): number {
  return Math.abs(left[0]! - right[0]!) + Math.abs(left[1]! - right[1]!) + Math.abs(left[2]! - right[2]!);
}

async function waitForService(label: string, predicate: () => boolean, drivers: BrowserDriver[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    for (const driver of drivers) await driver.step().catch(() => {});
    await Bun.sleep(20);
  }
  throw new Error(`verify-tux-link-web: timeout waiting for service ${label}`);
}

async function openBattleByKeyboard(driver: BrowserDriver): Promise<void> {
  const battleIndex = await driver.evaluate<number>(`globalThis.__pocketTitleBattle.titleRows().indexOf("battle")`);
  for (let guard = 0; guard < 8; guard++) {
    const selected = await driver.evaluate<number>(`globalThis.__pocketTitleBattle.state().titleIndex`);
    if (selected === battleIndex) break;
    await driver.pressKey("ArrowDown", "ArrowDown", 40);
  }
  await driver.pressKey("Enter", "Enter", 13);
  await driver.waitFor("Battle mode submenu", `globalThis.__pocketTuxLink.state().layer === "mode"`);
  await driver.pressKey("ArrowDown", "ArrowDown", 40);
  await driver.pressKey("Enter", "Enter", 13);
  await driver.waitFor("Link screen", `globalThis.__pocketTuxLink.state().layer === "link"`);
}

async function openBattleByTouch(driver: BrowserDriver): Promise<void> {
  const battleIndex = await driver.evaluate<number>(`globalThis.__pocketTitleBattle.titleRows().indexOf("battle")`);
  for (let guard = 0; guard < 8; guard++) {
    const selected = await driver.evaluate<number>(`globalThis.__pocketTitleBattle.state().titleIndex`);
    if (selected === battleIndex) break;
    await driver.pressTouch("DOWN");
  }
  await driver.pressTouch("CIRCLE");
  await driver.waitFor("Battle mode submenu", `globalThis.__pocketTuxLink.state().layer === "mode"`);
  await driver.pressTouch("DOWN");
  await driver.pressTouch("CIRCLE");
  await driver.waitFor("Link screen", `globalThis.__pocketTuxLink.state().layer === "link"`);
}

async function recordGolden(name: string, bytes: Uint8Array): Promise<{ path: string; sha256: string }> {
  const golden = join(GOLDENS, name);
  const actual = join(OUT, name);
  await Bun.write(actual, bytes);
  if (UPDATE) await Bun.write(golden, bytes);
  assert(existsSync(golden), `missing ${golden}; rerun with --update after visual review`);
  // Compare decoded pixels, not PNG bytes: the browser's PNG encoder is not
  // part of the contract and differs between Chrome builds.
  const got = decodePng(bytes);
  const want = decodePng(new Uint8Array(readFileSync(golden)));
  assert(got.width === want.width && got.height === want.height,
    `${name} is ${got.width}x${got.height}, golden is ${want.width}x${want.height}`);
  let differing = 0;
  for (let i = 0; i < got.rgba.length; i += 4) {
    if (got.rgba[i] !== want.rgba[i] || got.rgba[i + 1] !== want.rgba[i + 1] ||
      got.rgba[i + 2] !== want.rgba[i + 2] || got.rgba[i + 3] !== want.rgba[i + 3]) differing += 1;
  }
  assert(differing === 0,
    `${name} differs from its reviewed golden in ${differing} of ${got.width * got.height} pixels (actual saved at ${actual})`);
  return { path: golden, sha256: sha256(got.rgba) };
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(GOLDENS, { recursive: true });
registerCleanup(() => rmSync(join(OUT, "creator-profile"), { recursive: true, force: true }));
registerCleanup(() => rmSync(join(OUT, "joiner-profile"), { recursive: true, force: true }));

const creator = await BrowserDriver.launch("creator", join(OUT, "creator-profile"), "1200,900");
const joiner = await BrowserDriver.launch("joiner", join(OUT, "joiner-profile"), "480,800");
await creator.configureDevice(1200, 900, false);
await joiner.configureDevice(480, 800, true, 3);

const gameUrl = `${BASE}/${GAME}/`;
await creator.navigate(`${gameUrl}?lang=en`);
await creator.waitFor("English Web Link capability", `globalThis.__pocketPlayer?.state === "running" &&
  globalThis.__pocketTuxLink?.state().available === true`);
await creator.evaluate(`globalThis.__pocketPlayer.focus()`);
await creator.step(5);
const rootRows = await creator.evaluate<string[]>(`globalThis.__pocketTitleBattle.titleRows()`);
assert(rootRows.length <= 7 && !rootRows.some((row) => /link/i.test(row)),
  `portable title root changed: ${rootRows.join(",")}`);
await openBattleByKeyboard(creator);
await creator.pressKey("Enter", "Enter", 13);
await creator.waitFor("creator invitation", `globalThis.__pocketTuxLink.state().phase === "waiting" &&
  document.getElementById("auth-invite")?.value.includes("#invite=")`);

const invitationUrl = await creator.evaluate<string>(`document.getElementById("auth-invite").value`);
assert(invitationUrl === `${gameUrl}?lang=en#invite=${encodeURIComponent(INVITE)}`,
  `unexpected share URL ${invitationUrl}`);
assert(!service.requests.some((request) => request.includes(SECRET) || request.includes(TICKETS[0])),
  `secret escaped into request URL: ${service.requests.join(" | ")}`);

await joiner.navigate(`${gameUrl}?lang=zh#invite=${encodeURIComponent(INVITE)}`);
await joiner.waitFor("Chinese Web Link capability", `globalThis.__pocketPlayer?.state === "running" &&
  globalThis.__pocketTuxLink?.state().available === true`);
await joiner.evaluate(`globalThis.__pocketPlayer.focus()`);
await joiner.step(5);
await openBattleByTouch(joiner);
await Promise.all([
  creator.waitFor("creator first decision", `globalThis.__pocketTuxLink.state().phase === "decision"`),
  joiner.waitFor("joiner first decision", `globalThis.__pocketTuxLink.state().phase === "decision"`),
]);

const inviteReceipt = await joiner.evaluate(`({
  hash: location.hash,
  exposed: globalThis.__pocketInvite,
  stored: sessionStorage.getItem("pocket-rpgkit:invite"),
})`);
assert(inviteReceipt.hash === "" && inviteReceipt.exposed === undefined && inviteReceipt.stored === null,
  `invite was not consumed once: ${JSON.stringify(inviteReceipt)}`);

const firstCreator = await creator.hook();
const firstJoiner = await joiner.hook();
assert(firstCreator.lang === "en_US" && firstJoiner.lang === "zh_CN", "browser languages did not reach the Link UI");
assert(firstCreator.connectionEpoch === 1 && firstJoiner.connectionEpoch === 1 &&
  firstCreator.turnRevision === 0 && firstJoiner.turnRevision === 0, "initial epochs/revisions are not 1/0");
assert(firstCreator.opponentSpecies[0] === "dupmon" && firstCreator.opponentRefs[0] === "p_Asees_B0",
  `creator initial public identity is ${JSON.stringify(firstCreator)}`);

const joinerBeforePending = JSON.stringify(firstJoiner);
const joinerFramesBeforePending = service.sentCount(1);
const keyboardFirst = await creator.pressKey("Enter", "Enter", 13);
await creator.pressKey("Enter", "Enter", 13);
await waitForService("one creator submit", () => service.submitCount(0, 0) === 1, [creator, joiner]);
assert(keyboardFirst.heldMask === 0x2000 && keyboardFirst.sourceCount === 1,
  `keyboard Enter missed BTN aggregation: ${JSON.stringify(keyboardFirst)}`);
assert(service.submitCount(0, 0) === 1, "double confirm emitted more than one submit");
assert(service.sentCount(1) === joinerFramesBeforePending && JSON.stringify(await joiner.hook()) === joinerBeforePending,
  "opponent-pending action changed the other browser's public frame");
const joinerFramesAfterPending = service.sentCount(1);
service.accept(0);
await creator.waitFor("accepted creator action", `globalThis.__pocketTuxLink.state().phase === "submitted"`);

service.disconnect(0);
await creator.waitFor("creator reconnecting", `globalThis.__pocketTuxLink.state().phase === "reconnecting"`);
await Bun.sleep(1_100);
await creator.waitFor("creator connection epoch 2", `globalThis.__pocketTuxLink.state().connectionEpoch === 2 &&
  globalThis.__pocketTuxLink.state().phase === "submitted"`);
const reconnected = await creator.hook();
assert(reconnected.turnRevision === 0 && reconnected.selfSubmitted &&
  reconnected.opponentRefs[0] === "p_Asees_B0" && reconnected.deadlineAtMs === DEADLINES[0],
  `reconnect did not restore authoritative pending state: ${JSON.stringify(reconnected)}`);
assert(service.sentCount(1) === joinerFramesBeforePending, "creator reconnect leaked a frame to the opponent");

const touchDown = await joiner.pressTouch("DOWN");
const touchConfirm = await joiner.pressTouch("CIRCLE");
await waitForService("joiner swap", () => service.submitCount(1, 0) === 1, [creator, joiner]);
assert(touchDown.heldMask === 0x0040 && touchDown.sourceCount === 1 &&
  touchConfirm.heldMask === 0x2000 && touchConfirm.sourceCount === 1,
  `phone virtual controls missed BTN aggregation: ${JSON.stringify({ touchDown, touchConfirm })}`);
service.resolve();
await Promise.all([
  creator.waitFor("creator second decision", `globalThis.__pocketTuxLink.state().turnRevision === 1 &&
    globalThis.__pocketTuxLink.state().phase === "decision"`),
  joiner.waitFor("joiner second decision", `globalThis.__pocketTuxLink.state().turnRevision === 1 &&
    globalThis.__pocketTuxLink.state().phase === "decision"`),
]);

const secondCreator = await creator.hook();
const secondJoiner = await joiner.hook();
assert(secondCreator.opponentSpecies[0] === "dupmon" && secondCreator.opponentRefs[0] === "p_Asees_B1" &&
    String(firstCreator.opponentRefs[0]) !== String(secondCreator.opponentRefs[0]),
  `same-species swap did not follow recipient public refs: ${JSON.stringify({ firstCreator, secondCreator })}`);
assert(secondJoiner.opponentSpecies[0] === "dupmon" && secondJoiner.opponentRefs[0] === "p_Bsees_A0",
  `joiner public ref was not stable: ${JSON.stringify(secondJoiner)}`);

const pixels = await creator.semanticPixels();
assert(pixels.width === 960 && pixels.height === 544 && pixels.unique >= 20,
  `decision frame is missing visual detail: ${JSON.stringify(pixels)}`);
assert(colorDistance(pixels.selected, pixels.unselected) >= 20 && colorDistance(pixels.panel, pixels.backdrop) >= 20,
  `decision frame semantic regions are not distinct: ${JSON.stringify(pixels)}`);

const decisionGoldens = [
  await recordGolden("desktop-en-decision-960x544.png", await creator.canvasPng(960, 544)),
  await recordGolden("phone-zh-decision-480x272.png", await joiner.canvasPng(480, 272)),
];

await creator.connectGamepad();
const gamepadDown = await creator.pressGamepad(13);
const gamepadConfirm = await creator.pressGamepad(0);
await waitForService("gamepad creator submit", () => service.submitCount(0, 1) === 1, [creator, joiner]);
assert((gamepadDown & 0x0040) !== 0 && (gamepadConfirm & 0x2000) !== 0 &&
  (await creator.hook()).actionIndex === 1,
  `physical Gamepad path missed selection/confirm: ${gamepadDown.toString(16)}/${gamepadConfirm.toString(16)}`);
service.accept(0);
await creator.waitFor("second creator acceptance", `globalThis.__pocketTuxLink.state().phase === "submitted"`);
await joiner.pressTouch("CIRCLE");
await waitForService("terminal joiner submit", () => service.submitCount(1, 1) === 1, [creator, joiner]);
service.resolve();
await Promise.all([
  creator.waitFor("creator result", `globalThis.__pocketTuxLink.state().phase === "ended"`),
  joiner.waitFor("joiner result", `globalThis.__pocketTuxLink.state().phase === "ended"`),
]);

const terminalCreator = await creator.hook();
const terminalJoiner = await joiner.hook();
assert(terminalCreator.turnRevision === 2 && terminalJoiner.turnRevision === 2,
  `terminal revisions differ: ${JSON.stringify({ terminalCreator, terminalJoiner })}`);
assert(terminalCreator.replayUrl === null && terminalJoiner.replayUrl === null &&
  !terminalCreator.replayAvailable && !terminalJoiner.replayAvailable,
  `unnegotiated replay became available: ${JSON.stringify({ terminalCreator, terminalJoiner })}`);

const resultGoldens = [
  await recordGolden("desktop-en-result-960x544.png", await creator.canvasPng(960, 544)),
  await recordGolden("phone-zh-result-480x272.png", await joiner.canvasPng(480, 272)),
];
const noReplayService = {
  capabilities: service.requests.filter((request) => request === "GET /tux/v1/capabilities").length,
  creates: service.requests.filter((request) => request === "POST /tux/v1/matches").length,
  sockets: service.requests.filter((request) => request.startsWith("WS ")).length,
  connectionEpochs: [...service.epochs],
  submits: [service.submitCount(0, 0), service.submitCount(1, 0), service.submitCount(0, 1), service.submitCount(1, 1)],
};

// Run a second match in the same two browser profiles with optional replay
// support negotiated at both the capability probe and welcome frame. The
// first match above remains the bit-0-only compatibility path.
await Promise.all([creator.navigate("about:blank"), joiner.navigate("about:blank")]);
await waitForService("first match sockets to close", () => service.sockets.every((socket) => socket === null), []);
service = new MockWireService(true);

await creator.navigate(`${gameUrl}?lang=en`);
await creator.waitFor("replay-capable English Web Link", `globalThis.__pocketPlayer?.state === "running" &&
  globalThis.__pocketTuxLink?.state().available === true`);
await creator.evaluate(`globalThis.__pocketPlayer.focus()`);
await creator.step(5);
await openBattleByKeyboard(creator);
await creator.pressKey("Enter", "Enter", 13);
await creator.waitFor("replay-capable creator invitation", `globalThis.__pocketTuxLink.state().phase === "waiting" &&
  document.getElementById("auth-invite")?.value.includes("#invite=")`);

await joiner.navigate(`${gameUrl}?lang=zh#invite=${encodeURIComponent(INVITE)}`);
await joiner.waitFor("replay-capable Chinese Web Link", `globalThis.__pocketPlayer?.state === "running" &&
  globalThis.__pocketTuxLink?.state().available === true`);
await joiner.evaluate(`globalThis.__pocketPlayer.focus()`);
await joiner.step(5);
await openBattleByTouch(joiner);
await Promise.all([
  creator.waitFor("replay match first creator decision", `globalThis.__pocketTuxLink.state().phase === "decision"`),
  joiner.waitFor("replay match first joiner decision", `globalThis.__pocketTuxLink.state().phase === "decision"`),
]);

await creator.pressKey("Enter", "Enter", 13);
await joiner.pressTouch("CIRCLE");
await waitForService("replay match first submissions", () => service.pending.size === 2, [creator, joiner]);
service.resolve();
await Promise.all([
  creator.waitFor("replay match second creator decision", `globalThis.__pocketTuxLink.state().turnRevision === 1 &&
    globalThis.__pocketTuxLink.state().phase === "decision"`),
  joiner.waitFor("replay match second joiner decision", `globalThis.__pocketTuxLink.state().turnRevision === 1 &&
    globalThis.__pocketTuxLink.state().phase === "decision"`),
]);

await creator.pressKey("Enter", "Enter", 13);
await joiner.pressTouch("CIRCLE");
await waitForService("replay match terminal submissions", () => service.pending.size === 2, [creator, joiner]);
service.resolve();
await Promise.all([
  creator.waitFor("trusted creator replay result", `globalThis.__pocketTuxLink.state().phase === "ended" &&
    globalThis.__pocketTuxLink.state().replayAvailable === true`),
  joiner.waitFor("trusted joiner replay result", `globalThis.__pocketTuxLink.state().phase === "ended" &&
    globalThis.__pocketTuxLink.state().replayAvailable === true`),
]);

const replayCreator = await creator.hook();
const replayJoiner = await joiner.hook();
assert(replayCreator.replayUrl === REPLAY_URL && replayJoiner.replayUrl === REPLAY_URL,
  `negotiated replay URL differs: ${JSON.stringify({ replayCreator, replayJoiner })}`);
assert([replayCreator.replayUrl, replayJoiner.replayUrl].every((url) =>
  url !== null && url.startsWith(TRUSTED_REPLAY_BASE)),
  `negotiated replay left trusted prefix ${TRUSTED_REPLAY_BASE}`);

const replayPixels = await creator.resultSemanticPixels();
assert(replayPixels.width === 960 && replayPixels.height === 544 && replayPixels.unique >= 12,
  `trusted replay result is missing visual detail: ${JSON.stringify(replayPixels)}`);
assert(colorDistance(replayPixels.button, replayPixels.border) >= 20 &&
  colorDistance(replayPixels.panel, replayPixels.backdrop) >= 15,
  `trusted replay result semantic regions are not distinct: ${JSON.stringify(replayPixels)}`);

const replayGoldens = [
  await recordGolden("desktop-en-result-replay-960x544.png", await creator.canvasPng(960, 544)),
  await recordGolden("phone-zh-result-replay-480x272.png", await joiner.canvasPng(480, 272)),
];
assert(creator.errors.length === 0 && joiner.errors.length === 0,
  `browser errors: ${[...creator.errors, ...joiner.errors].join(" | ")}`);

const replayService = {
  capabilities: service.requests.filter((request) => request === "GET /tux/v1/capabilities").length,
  creates: service.requests.filter((request) => request === "POST /tux/v1/matches").length,
  sockets: service.requests.filter((request) => request.startsWith("WS ")).length,
  connectionEpochs: [...service.epochs],
  submits: [service.submitCount(0, 0), service.submitCount(1, 0), service.submitCount(0, 1), service.submitCount(1, 1)],
};

const receipt = {
  service: noReplayService,
  replayService,
  inputs: {
    keyboard: keyboardFirst,
    touch: { down: touchDown, confirm: touchConfirm },
    gamepad: { downMask: gamepadDown, confirmMask: gamepadConfirm },
  },
  publicIdentity: {
    species: firstCreator.opponentSpecies[0],
    creatorRefs: [firstCreator.opponentRefs[0], secondCreator.opponentRefs[0]],
    joinerRef: secondJoiner.opponentRefs[0],
  },
  pendingSecrecy: {
    opponentServerFrames: `${joinerFramesBeforePending}->${joinerFramesAfterPending}`,
    unchangedBeforeResolution: true,
  },
  replay: {
    unnegotiated: [terminalCreator.replayUrl, terminalJoiner.replayUrl],
    negotiated: [replayCreator.replayUrl, replayJoiner.replayUrl],
    trustedPrefix: TRUSTED_REPLAY_BASE,
    pixels: replayPixels,
  },
  pixels,
  screenshots: [...decisionGoldens, ...resultGoldens, ...replayGoldens],
};
await Bun.write(join(OUT, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);

console.log("verify-tux-link-web: PASS");
console.log(JSON.stringify(receipt, null, 2));

creator.close();
joiner.close();
server.stop(true);

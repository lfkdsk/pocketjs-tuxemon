#!/usr/bin/env bun
// Real-Chrome mobile frame benchmark. `--full` covers the seven maintained
// gameplay/UI scenes at portrait + landscape DPR 3 and Chrome 4x + 6x CPU
// throttles for at least sixty seconds per sample. `--gate` is the shorter,
// repeatable local regression guard: three alternating ABBA/BAAB windows on
// the landscape 6x city-walk cell, with absolute and paired-noise limits.
//
// Sites are immutable, pre-built directories so import/build work can never
// enter a timed window:
//
//   MOBILE_WEB_BASELINE_SITE=/path/to/main-web \
//   MOBILE_WEB_CANDIDATE_SITE=dist/web \
//   bun run bench:web:mobile --gate
//
// The Link scene additionally needs builds produced with
// TUX_BATTLE_BASE_URL=http://127.0.0.1:49190 and the two *_LINK_SITE vars.

import { cpus, loadavg } from "node:os";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";

import {
  TUX_ARENA_VERSION,
  TUX_REQUIRED_CAPS,
  TUX_WIRE_VERSION,
} from "../battle/tux-link-wire.ts";
import { FIXED_INITIAL_CIVIL_TIME } from "../battle/time-weather.ts";
import { TUX_LINK_TICKET_KEY } from "../ui/tux-link/auth-store.ts";
import { registerCleanup, spawnHeadlessChrome } from "./headless-chrome.ts";
import {
  alternatingWindows,
  evaluateFrameGate,
  median,
  medianDistribution,
  splitProfileHotspots,
  summarizeFrames,
  type BenchVariant,
  type CpuProfile,
  type Distribution,
  type FrameSampleSummary,
  type ProfileHotspot,
} from "./mobile-web-bench-lib.ts";

const ROOT = resolve(import.meta.dir, "..");
const PORT = 49_190;
const BASE = `http://127.0.0.1:${PORT}`;
const PROFILE_ROOT = resolve(process.env.MOBILE_WEB_PROFILE_ROOT ?? "/var/tmp/fleet/mobile-web-frame-profiles");
const CHROME = process.env.CHROME ?? Bun.which("google-chrome") ?? Bun.which("chromium") ?? "google-chrome";
const MATCH = "match_mobile_web_perf_0001";
const SECRET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const INVITE = `${MATCH}.${SECRET}`;
const TICKET = "mobile-web-frame-ticket";

type BenchMode = "gate" | "full" | "profile";
type SiteKind = "game" | "link";

interface Viewport {
  id: "portrait" | "landscape";
  width: number;
  height: number;
  dpr: 3;
}

interface Scenario {
  id: string;
  site: SiteKind;
  query: string;
  ready: string;
  prepare?: (driver: ChromeDriver) => Promise<void>;
  validate?: (measurement: PageMeasurement) => string[];
}

interface BenchConfig {
  mode: BenchMode;
  durationMs: number;
  warmupMs: number;
  windows: number;
  scenarios: Scenario[];
  viewports: Viewport[];
  throttles: number[];
  profile: boolean;
  syntheticWorkMs: number;
}

interface PageMeasurement {
  work: number[];
  raf: number[];
  longTasks: number[];
  semantic: {
    maps: string[];
    scenes: string[];
    linkPhases: string[];
    presentedFrames: number;
    reducerSteps: number;
    movedFrames: number;
    battleFrames: number;
    textFrames: number;
    overlayFrames: number;
    start: number;
    end: number;
  };
  endState: {
    map: string | null;
    frame: number | null;
    scene: string | null;
    link: string | null;
    playerFrames: number | null;
  };
}

interface SampleResult {
  cell: string;
  scenario: string;
  viewport: Viewport["id"];
  throttle: number;
  window: number;
  slot: number;
  order: string;
  variant: BenchVariant;
  durationMs: number;
  loadBefore: number;
  loadAfter: number;
  summary: FrameSampleSummary;
  semantic: PageMeasurement["semantic"];
  endState: PageMeasurement["endState"];
  consoleErrors: string[];
  profile?: {
    js: ProfileHotspot[];
    wasm: ProfileHotspot[];
  };
}

interface AggregateCell {
  scenario: string;
  viewport: Viewport["id"];
  throttle: number;
  baseline: {
    samples: number;
    work: Distribution;
    raf: Distribution;
    longTasks: { count: number; totalMs: number; maxMs: number };
  };
  candidate: {
    samples: number;
    work: Distribution;
    raf: Distribution;
    longTasks: { count: number; totalMs: number; maxMs: number };
  };
  gate: ReturnType<typeof evaluateFrameGate>;
}

const VIEWPORTS: readonly Viewport[] = [
  { id: "portrait", width: 390, height: 844, dpr: 3 },
  { id: "landscape", width: 844, height: 390, dpr: 3 },
];

const genericReady = `!!(globalThis.__pocketPlayer &&
  globalThis.__pocketPlayer.state === "running" &&
  globalThis.__rpgSessionState &&
  globalThis.__pocketPlayer.frameBlocked !== true &&
  globalThis.__pocketPlayer.chunkVeil !== true)`;

const SCENARIOS: readonly Scenario[] = [
  {
    id: "city-walk",
    site: "game",
    query: "?lang=en&map=spyder_cotton_town&x=10&y=30",
    ready: `${genericReady} && globalThis.__rpgSessionState.mapId === "spyder_cotton_town"`,
    async prepare(driver) {
      await driver.evaluate(`(() => {
        const p = globalThis.__pocketPlayer;
        const endpoints = [
          { x: 15, y: 30, mask: 0x0080 },
          { x: 10, y: 30, mask: 0x0020 },
        ];
        let target = 0;
        p.keys.set("__mobile_web_walk", endpoints[target].mask);
        globalThis.__mobileWebScenarioTimer = setInterval(() => {
          const state = globalThis.__rpgSessionState;
          const endpoint = endpoints[target];
          if (!state?.move?.moving && state?.move?.tx === endpoint.x && state?.move?.ty === endpoint.y) {
            target = (target + 1) % endpoints.length;
          }
          p.keys.set("__mobile_web_walk", endpoints[target].mask);
        }, 16);
      })()`);
    },
    validate(measurement) {
      const failures: string[] = [];
      if (measurement.semantic.maps.length !== 1 || measurement.semantic.maps[0] !== "spyder_cotton_town") {
        failures.push(`left Cotton Town (${measurement.semantic.maps.join(", ") || "no map samples"})`);
      }
      if (measurement.semantic.movedFrames === 0) failures.push("recorded no player movement");
      if (measurement.semantic.textFrames !== 0) failures.push(`${measurement.semantic.textFrames} text frames`);
      if (measurement.semantic.battleFrames !== 0) failures.push(`${measurement.semantic.battleFrames} battle frames`);
      if (measurement.semantic.overlayFrames !== 0) failures.push(`${measurement.semantic.overlayFrames} overlay frames`);
      if (measurement.endState.map !== "spyder_cotton_town") {
        failures.push(`ended on ${measurement.endState.map ?? "no map"}`);
      }
      return failures;
    },
  },
  {
    id: "map-switch",
    site: "game",
    query: "?lang=en&chapter=route-1",
    ready: `${genericReady} && globalThis.__rpgkitDemo?.current().chapter === "route-1"`,
    async prepare(driver) {
      await driver.evaluate(`(() => {
        const chapters = ["cotton-town", "route-1"];
        let index = 0;
        globalThis.__mobileWebScenarioTimer = setInterval(() => {
          index = (index + 1) % chapters.length;
          try { globalThis.__rpgkitDemo.jump(chapters[index]); } catch (_) {}
        }, 4_000);
      })()`);
    },
  },
  {
    id: "wild-encounter",
    site: "game",
    query: "?lang=en&autoplay=route-1&speed=1",
    ready: `${genericReady} && globalThis.__rpgkitDemo?.current().autoplay === true`,
  },
  {
    id: "battle-turn",
    site: "game",
    query: "?lang=en&autoplay=before-billie&speed=1",
    ready: `${genericReady} && globalThis.__rpgSessionState.scene?.kind === "battle"`,
  },
  {
    id: "menus",
    site: "game",
    query: "?lang=en&chapter=starter",
    ready: `${genericReady} && !!globalThis.__pocketBagMenu && !!globalThis.__pocketTuxepedia && !!globalThis.__pocketStartMenu`,
    async prepare(driver) {
      await driver.evaluate(`(() => {
        const hooks = [globalThis.__pocketStartMenu, globalThis.__pocketBagMenu, globalThis.__pocketTuxepedia];
        let index = 0;
        const show = () => {
          for (const hook of hooks) hook?.close?.();
          hooks[index]?.open?.();
        };
        show();
        globalThis.__mobileWebScenarioTimer = setInterval(() => {
          index = (index + 1) % hooks.length;
          show();
        }, 4_000);
      })()`);
    },
  },
  {
    id: "dialogue",
    site: "game",
    query: "?lang=en&autoplay=paper-town&speed=1",
    ready: `${genericReady} && globalThis.__rpgkitDemo?.current().autoplay === true`,
  },
  {
    id: "web-link",
    site: "link",
    query: "?lang=en",
    ready: `${genericReady} && globalThis.__pocketTuxLink?.state().available === true`,
    async prepare(driver) {
      await driver.evaluate(`(() => {
        const title = globalThis.__pocketTitleBattle;
        const index = title.titleRows().indexOf("battle");
        if (index < 0) throw new Error("mobile Web bench: Battle title row missing");
        title.selectTitle(index);
      })()`);
      await driver.waitFor("Link mode submenu", `globalThis.__pocketTuxLink.state().layer === "mode"`);
      await driver.pressMask(0x0040);
      await driver.pressMask(0x2000);
      await driver.waitFor("Link screen", `globalThis.__pocketTuxLink.state().layer === "link"`);
      await driver.pressMask(0x2000);
      await driver.waitFor("mock Link invitation", `globalThis.__pocketTuxLink.state().phase === "waiting"`);
    },
  },
];

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`);
  return parsed;
}

function listEnv(name: string): string[] | null {
  const value = process.env[name];
  return value ? value.split(",").map((part) => part.trim()).filter(Boolean) : null;
}

function modeFromArgs(): BenchMode {
  const selected = (["gate", "full", "profile"] as const).filter((mode) => process.argv.includes(`--${mode}`));
  if (selected.length > 1) throw new Error("choose only one of --gate, --full, --profile");
  return selected[0] ?? "gate";
}

function configFromEnv(): BenchConfig {
  const mode = modeFromArgs();
  const scenarioIds = listEnv("MOBILE_WEB_SCENARIOS") ?? (mode === "gate" ? ["city-walk"] : SCENARIOS.map((scene) => scene.id));
  const scenarios = scenarioIds.map((id) => {
    const scene = SCENARIOS.find((candidate) => candidate.id === id);
    if (!scene) throw new Error(`unknown mobile Web scene ${JSON.stringify(id)}`);
    return scene;
  });
  const viewportIds = listEnv("MOBILE_WEB_VIEWPORTS") ?? (mode === "full" ? ["portrait", "landscape"] : ["landscape"]);
  const viewports = viewportIds.map((id) => {
    const viewport = VIEWPORTS.find((candidate) => candidate.id === id);
    if (!viewport) throw new Error(`unknown mobile viewport ${JSON.stringify(id)}`);
    return viewport;
  });
  const throttles = (listEnv("MOBILE_WEB_THROTTLES") ?? (mode === "full" ? ["4", "6"] : ["6"]))
    .map(Number);
  if (throttles.some((rate) => rate !== 4 && rate !== 6)) throw new Error("mobile throttles must be 4 or 6");
  const durationMs = numberEnv("MOBILE_WEB_DURATION_MS", mode === "full" ? 60_000 : 15_000);
  if (mode === "full" && durationMs < 60_000 && process.env.MOBILE_WEB_ALLOW_SHORT !== "1") {
    throw new Error("--full requires MOBILE_WEB_DURATION_MS >= 60000 (set MOBILE_WEB_ALLOW_SHORT=1 only for harness smoke tests)");
  }
  return {
    mode,
    durationMs,
    warmupMs: numberEnv("MOBILE_WEB_WARMUP_MS", 3_000),
    windows: Math.max(1, Math.floor(numberEnv("MOBILE_WEB_WINDOWS", mode === "gate" ? 3 : 1))),
    scenarios,
    viewports,
    throttles,
    profile: mode === "profile",
    syntheticWorkMs: numberEnv("MOBILE_WEB_SYNTHETIC_WORK_MS", 0),
  };
}

function requiredSite(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`${name} is required`);
  const root = resolve(value);
  if (!existsSync(join(root, "pocket-tuxemon", "index.html"))) {
    throw new Error(`${name} has no pocket-tuxemon/index.html: ${root}`);
  }
  return root;
}

class ChromeDriver {
  private sequence = 0;
  private readonly pending = new Map<number, (message: any) => void>();
  readonly errors: string[] = [];

  private constructor(
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
      }
    });
  }

  static async launch(profile: string, viewport: Viewport, throttle: number, showTitle: boolean): Promise<ChromeDriver> {
    const chrome = await spawnHeadlessChrome(CHROME, profile, `${viewport.width},${viewport.height}`);
    const cdp = new WebSocket(chrome.wsUrl);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      cdp.addEventListener("open", () => resolveOpen(), { once: true });
      cdp.addEventListener("error", () => rejectOpen(new Error("Chrome DevTools socket failed")), { once: true });
    });
    const driver = new ChromeDriver(chrome, cdp);
    registerCleanup(() => driver.close());
    await driver.send("Runtime.enable");
    await driver.send("Log.enable");
    await driver.send("Page.enable");
    await driver.send("Network.enable");
    await driver.send("Network.setCacheDisabled", { cacheDisabled: true });
    await driver.send("Network.setBypassServiceWorker", { bypass: true });
    await driver.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.dpr,
      mobile: true,
    });
    await driver.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await driver.send("Emulation.setCPUThrottlingRate", { rate: throttle });
    await driver.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        globalThis.__pocketTuxemonInitialCivilTime = ${JSON.stringify(FIXED_INITIAL_CIVIL_TIME)};
        globalThis.__pocketTuxemonShowTitle = ${showTitle};
        try {
          localStorage.setItem(${JSON.stringify(TUX_LINK_TICKET_KEY)}, ${JSON.stringify(JSON.stringify({ ticket: TICKET }))});
        } catch (_) {}
      `,
    });
    return driver;
  }

  close(): void {
    try { this.cdp.close(); } catch {}
    this.chrome.close();
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolveMessage, rejectMessage) => {
      const id = ++this.sequence;
      this.pending.set(id, (message) => message.error
        ? rejectMessage(new Error(`${method}: ${message.error.message}`))
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
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value as T;
  }

  async navigate(url: string): Promise<void> {
    await this.send("Page.navigate", { url });
    await this.waitFor("document load", `document.readyState === "complete"`, 45_000);
  }

  async waitFor(label: string, expression: string, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.evaluate<boolean>(expression).catch(() => false)) return;
      await Bun.sleep(100);
    }
    const detail = await this.evaluate(`({
      ready: document.readyState,
      player: globalThis.__pocketPlayer?.state,
      blocked: globalThis.__pocketPlayer?.frameBlocked,
      veil: globalThis.__pocketPlayer?.chunkVeil,
      map: globalThis.__rpgSessionState?.mapId,
      scene: globalThis.__rpgSessionState?.scene?.kind,
      title: globalThis.__pocketTitleBattle?.state?.(),
      link: globalThis.__pocketTuxLink?.state?.(),
    })`).catch(() => null);
    throw new Error(`timeout waiting for ${label}: ${JSON.stringify(detail)}; ${this.errors.join(" | ")}`);
  }

  async pressMask(mask: number): Promise<void> {
    await this.evaluate(`globalThis.__pocketPlayer.keys.set("__mobile_web_press", ${mask})`);
    await Bun.sleep(180);
    await this.evaluate(`globalThis.__pocketPlayer.keys.delete("__mobile_web_press")`);
    await Bun.sleep(180);
  }
}

function instrumentationSource(syntheticWorkMs: number): string {
  return `(() => {
    const p = globalThis.__pocketPlayer;
    if (!p || p.__mobileWebBenchWrapped) throw new Error("mobile Web bench: player missing or already wrapped");
    p.__mobileWebBenchWrapped = true;
    const bench = globalThis.__mobileWebFrameBench = {
      active: false,
      work: [],
      raf: [],
      longTasks: [],
      pendingWork: 0,
      lastRaf: 0,
      maps: new Set(),
      scenes: new Set(),
      linkPhases: new Set(),
      presentedFrames: 0,
      reducerSteps: 0,
      movedFrames: 0,
      battleFrames: 0,
      textFrames: 0,
      overlayFrames: 0,
      lastPosition: "",
      start: 0,
      end: 0,
    };
    const sampleSemantic = () => {
      const state = globalThis.__rpgSessionState;
      if (!state) return;
      bench.maps.add(state.mapId);
      bench.scenes.add(state.scene?.kind ?? "world");
      const position = state.mapId + ":" + state.move?.tx + ":" + state.move?.ty;
      if (bench.lastPosition && position !== bench.lastPosition) bench.movedFrames++;
      bench.lastPosition = position;
      if (state.scene?.kind === "battle") bench.battleFrames++;
      if (state.interp?.modal?.kind === "text") bench.textFrames++;
      const open = [globalThis.__pocketStartMenu, globalThis.__pocketBagMenu, globalThis.__pocketTuxepedia]
        .some((hook) => hook?.isOpen?.());
      if (open) bench.overlayFrames++;
      const phase = globalThis.__pocketTuxLink?.state?.().phase;
      if (phase) bench.linkPhases.add(phase);
    };
    const originalStep = p.step;
    p.step = function(...args) {
      const started = performance.now();
      try { return originalStep.apply(this, args); }
      finally {
        if (bench.active) {
          bench.pendingWork += performance.now() - started;
          bench.reducerSteps++;
        }
      }
    };
    const originalPaint = p.paint;
    p.paint = function(...args) {
      const started = performance.now();
      const result = originalPaint.apply(this, args);
      if (${syntheticWorkMs} > 0) {
        const until = performance.now() + ${syntheticWorkMs};
        while (performance.now() < until) {}
      }
      if (bench.active) {
        bench.work.push(bench.pendingWork + performance.now() - started);
        bench.pendingWork = 0;
        bench.presentedFrames++;
        sampleSemantic();
      }
      return result;
    };
    const observeRaf = (now) => {
      if (bench.active) {
        if (bench.lastRaf > 0) bench.raf.push(now - bench.lastRaf);
        bench.lastRaf = now;
      }
      requestAnimationFrame(observeRaf);
    };
    requestAnimationFrame(observeRaf);
    if (typeof PerformanceObserver !== "undefined" &&
        PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
      new PerformanceObserver((list) => {
        if (!bench.active) return;
        for (const entry of list.getEntries()) bench.longTasks.push(entry.duration);
      }).observe({ type: "longtask", buffered: false });
    }
    bench.startMeasurement = () => {
      bench.work.length = 0;
      bench.raf.length = 0;
      bench.longTasks.length = 0;
      bench.pendingWork = 0;
      bench.lastRaf = 0;
      bench.maps.clear(); bench.scenes.clear(); bench.linkPhases.clear();
      bench.presentedFrames = 0; bench.reducerSteps = 0; bench.movedFrames = 0;
      bench.battleFrames = 0; bench.textFrames = 0; bench.overlayFrames = 0;
      bench.lastPosition = "";
      bench.start = performance.now();
      bench.end = 0;
      bench.active = true;
    };
    bench.stopMeasurement = () => {
      bench.active = false;
      bench.end = performance.now();
      const state = globalThis.__rpgSessionState;
      return {
        work: bench.work,
        raf: bench.raf,
        longTasks: bench.longTasks,
        semantic: {
          maps: [...bench.maps], scenes: [...bench.scenes], linkPhases: [...bench.linkPhases],
          presentedFrames: bench.presentedFrames, reducerSteps: bench.reducerSteps,
          movedFrames: bench.movedFrames, battleFrames: bench.battleFrames,
          textFrames: bench.textFrames, overlayFrames: bench.overlayFrames,
          start: bench.start, end: bench.end,
        },
        endState: {
          map: state?.mapId ?? null, frame: state?.frame ?? null,
          scene: state?.scene?.kind ?? null,
          link: globalThis.__pocketTuxLink?.state?.().phase ?? null,
          playerFrames: p.frames ?? null,
        },
      };
    };
  })()`;
}

function serveStatic(root: string, relativePath: string): Response {
  let path = resolve(root, `.${decodeURIComponent(relativePath)}`);
  if (path !== root && !path.startsWith(root + sep)) return new Response("forbidden", { status: 403 });
  if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
  return existsSync(path) ? new Response(Bun.file(path)) : new Response("not found", { status: 404 });
}

function startServer(sites: Record<string, string>) {
  const prefixes = Object.keys(sites).sort((left, right) => right.length - left.length);
  const sockets = new Set<any>();
  const server = Bun.serve<{ id: number }>({
    hostname: "127.0.0.1",
    port: PORT,
    async fetch(request, bunServer) {
      const url = new URL(request.url);
      if (url.pathname === "/tux/v1/capabilities") {
        return Response.json({
          service: "tux-battle",
          enabled: true,
          wireV: TUX_WIRE_VERSION,
          arenaV: TUX_ARENA_VERSION,
          caps: TUX_REQUIRED_CAPS,
          requiredCaps: TUX_REQUIRED_CAPS,
        });
      }
      if (url.pathname === "/tux/v1/matches") {
        if (request.method !== "POST") return new Response("method", { status: 405 });
        await request.json();
        return Response.json({ ok: true, v: 1, matchId: MATCH, invite: INVITE, expiresAtMs: 4_102_444_800_000 });
      }
      if (url.pathname === "/ws/tux/v1") {
        return bunServer.upgrade(request, { data: { id: sockets.size + 1 } })
          ? undefined
          : new Response("upgrade", { status: 500 });
      }
      for (const prefix of prefixes) {
        if (url.pathname === `/${prefix}` || url.pathname.startsWith(`/${prefix}/`)) {
          const relative = url.pathname.slice(prefix.length + 1) || "/";
          return serveStatic(sites[prefix]!, relative);
        }
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(socket) { sockets.add(socket); },
      message(_socket, _message) {},
      close(socket) { sockets.delete(socket); },
    },
  });
  registerCleanup(() => {
    for (const socket of sockets) socket.close(1001, "benchmark complete");
    server.stop(true);
  });
  return server;
}

function scenarioUrl(variant: BenchVariant, scenario: Scenario): string {
  const prefix = scenario.site === "link" ? `${variant}-link` : variant;
  return `${BASE}/${prefix}/pocket-tuxemon/${scenario.query}`;
}

async function runSample(
  config: BenchConfig,
  scenario: Scenario,
  viewport: Viewport,
  throttle: number,
  variant: BenchVariant,
  window: number,
  slot: number,
  order: string,
): Promise<SampleResult> {
  const slug = `${scenario.id}-${viewport.id}-${throttle}x-w${window + 1}-s${slot + 1}-${variant}`;
  const profileDir = join(PROFILE_ROOT, slug);
  rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });
  const loadBefore = loadavg()[0];
  const driver = await ChromeDriver.launch(profileDir, viewport, throttle, scenario.site === "link");
  let rawProfile: CpuProfile | undefined;
  try {
    await driver.navigate(scenarioUrl(variant, scenario));
    await driver.waitFor(`${scenario.id} ready`, scenario.ready, scenario.id === "battle-turn" ? 120_000 : 60_000);
    if (scenario.prepare) await scenario.prepare(driver);
    await driver.evaluate(instrumentationSource(config.syntheticWorkMs));
    await Bun.sleep(config.warmupMs);
    if (config.profile) {
      await driver.send("Profiler.enable");
      await driver.send("Profiler.setSamplingInterval", { interval: 1_000 });
      await driver.send("Profiler.start");
    }
    await driver.evaluate(`globalThis.__mobileWebFrameBench.startMeasurement()`);
    await Bun.sleep(config.durationMs);
    if (config.profile) rawProfile = (await driver.send("Profiler.stop")).profile as CpuProfile;
    const measurement = await driver.evaluate<PageMeasurement>(`globalThis.__mobileWebFrameBench.stopMeasurement()`);
    const consoleErrors = [...driver.errors];
    if (consoleErrors.length > 0) throw new Error(`${slug}: browser errors: ${consoleErrors.join(" | ")}`);
    const semanticFailures = scenario.validate?.(measurement) ?? [];
    if (semanticFailures.length > 0) {
      throw new Error(`${slug}: scenario semantics failed: ${semanticFailures.join("; ")}`);
    }
    if (measurement.work.length < 30) {
      throw new Error(`${slug}: only ${measurement.work.length} presented frames in ${config.durationMs} ms`);
    }
    const summary = summarizeFrames(measurement.work, measurement.raf, measurement.longTasks);
    const result: SampleResult = {
      cell: `${scenario.id}/${viewport.id}/${throttle}x`,
      scenario: scenario.id,
      viewport: viewport.id,
      throttle,
      window,
      slot,
      order,
      variant,
      durationMs: measurement.semantic.end - measurement.semantic.start,
      loadBefore,
      loadAfter: loadavg()[0],
      summary,
      semantic: measurement.semantic,
      endState: measurement.endState,
      consoleErrors,
      ...(rawProfile ? { profile: splitProfileHotspots(rawProfile) } : {}),
    };
    console.log(
      `MOBILE_FRAME cell=${result.cell} window=${window + 1} slot=${slot + 1} order=${order} ` +
      `variant=${variant} work_p50=${summary.work.p50.toFixed(3)} work_p95=${summary.work.p95.toFixed(3)} ` +
      `work_p99=${summary.work.p99.toFixed(3)} over16.7=${(summary.work.over16_7 * 100).toFixed(2)}% ` +
      `over33=${(summary.work.over33 * 100).toFixed(2)}% raf_p95=${summary.raf.p95.toFixed(3)} ` +
      `long_tasks=${summary.longTasks.count} frames=${summary.work.count}`,
    );
    return result;
  } finally {
    driver.close();
    rmSync(profileDir, { recursive: true, force: true });
  }
}

function aggregateVariant(samples: readonly SampleResult[]) {
  const long = (field: keyof FrameSampleSummary["longTasks"]) => median(samples.map((sample) => sample.summary.longTasks[field]));
  return {
    samples: samples.length,
    work: medianDistribution(samples.map((sample) => sample.summary.work)),
    raf: medianDistribution(samples.map((sample) => sample.summary.raf)),
    longTasks: {
      count: Math.round(long("count")),
      totalMs: long("totalMs"),
      maxMs: long("maxMs"),
    },
  };
}

function aggregateCells(samples: readonly SampleResult[]): AggregateCell[] {
  const cells = new Map<string, SampleResult[]>();
  for (const sample of samples) {
    const values = cells.get(sample.cell) ?? [];
    values.push(sample);
    cells.set(sample.cell, values);
  }
  return [...cells.entries()].map(([, values]) => {
    const baseline = aggregateVariant(values.filter((sample) => sample.variant === "baseline"));
    const candidate = aggregateVariant(values.filter((sample) => sample.variant === "candidate"));
    return {
      scenario: values[0]!.scenario,
      viewport: values[0]!.viewport,
      throttle: values[0]!.throttle,
      baseline,
      candidate,
      gate: evaluateFrameGate({ throttle: values[0]!.throttle, baseline: baseline.work, candidate: candidate.work }),
    };
  });
}

async function main(): Promise<void> {
  const config = configFromEnv();
  const baselineSite = requiredSite("MOBILE_WEB_BASELINE_SITE", config.mode === "profile" ? process.env.MOBILE_WEB_CANDIDATE_SITE : undefined);
  const candidateSite = requiredSite("MOBILE_WEB_CANDIDATE_SITE");
  const needsLink = config.scenarios.some((scenario) => scenario.site === "link");
  const baselineLinkSite = needsLink ? requiredSite("MOBILE_WEB_BASELINE_LINK_SITE") : baselineSite;
  const candidateLinkSite = needsLink ? requiredSite("MOBILE_WEB_CANDIDATE_LINK_SITE") : candidateSite;
  rmSync(PROFILE_ROOT, { recursive: true, force: true });
  mkdirSync(PROFILE_ROOT, { recursive: true });
  registerCleanup(() => rmSync(PROFILE_ROOT, { recursive: true, force: true }));
  const server = startServer({
    baseline: baselineSite,
    candidate: candidateSite,
    "baseline-link": baselineLinkSite,
    "candidate-link": candidateLinkSite,
  });
  const versionDriver = await ChromeDriver.launch(join(PROFILE_ROOT, "version"), VIEWPORTS[0]!, 4, false);
  const chromeVersion = await versionDriver.send("Browser.getVersion");
  versionDriver.close();
  rmSync(join(PROFILE_ROOT, "version"), { recursive: true, force: true });

  console.log(`mobile Web frames: mode=${config.mode}, Chrome=${chromeVersion.product}, host_cpus=${cpus().length}, ` +
    `duration=${config.durationMs}ms, warmup=${config.warmupMs}ms, windows=${config.windows}`);
  const samples: SampleResult[] = [];
  for (const scenario of config.scenarios) {
    for (const viewport of config.viewports) {
      for (const throttle of config.throttles) {
        if (config.profile) {
          samples.push(await runSample(config, scenario, viewport, throttle, "candidate", 0, 0, "P"));
          continue;
        }
        const windows = alternatingWindows(config.windows);
        for (let window = 0; window < windows.length; window++) {
          const order = windows[window]!;
          for (let slot = 0; slot < order.length; slot++) {
            samples.push(await runSample(
              config, scenario, viewport, throttle, order[slot]!, window, slot, order.map((value) => value[0]!.toUpperCase()).join(""),
            ));
          }
        }
      }
    }
  }

  const cells = config.profile ? [] : aggregateCells(samples);
  const failures = cells.filter((cell) => !cell.gate.pass).map((cell) => ({
    cell: `${cell.scenario}/${cell.viewport}/${cell.throttle}x`,
    reasons: cell.gate.reasons,
  }));
  const output = resolve(process.env.MOBILE_WEB_OUTPUT ?? join(ROOT, "dist", "mobile-web-frames.json"));
  mkdirSync(resolve(output, ".."), { recursive: true });
  const receipt = {
    format: "pocket-tuxemon/mobile-web-frames/v1",
    generatedAt: new Date().toISOString(),
    chrome: chromeVersion,
    host: { cpus: cpus().length, load: loadavg() },
    config: {
      mode: config.mode,
      durationMs: config.durationMs,
      warmupMs: config.warmupMs,
      windows: config.windows,
      scenarios: config.scenarios.map((scenario) => scenario.id),
      viewports: config.viewports,
      throttles: config.throttles,
      order: config.profile ? "candidate profile" : "alternating ABBA/BAAB",
      syntheticWorkMs: config.syntheticWorkMs,
    },
    samples,
    cells,
    profiles: samples.filter((sample) => sample.profile).map((sample) => ({
      cell: sample.cell,
      js: sample.profile!.js,
      wasm: sample.profile!.wasm,
    })),
    failures,
  };
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`mobile Web frame receipt: ${output}`);
  for (const cell of cells) {
    console.log(
      `MOBILE_FRAME_SUMMARY cell=${cell.scenario}/${cell.viewport}/${cell.throttle}x ` +
      `baseline=${cell.baseline.work.p50.toFixed(3)}/${cell.baseline.work.p95.toFixed(3)}/${cell.baseline.work.p99.toFixed(3)} ` +
      `candidate=${cell.candidate.work.p50.toFixed(3)}/${cell.candidate.work.p95.toFixed(3)}/${cell.candidate.work.p99.toFixed(3)} ` +
      `over16.7=${(cell.candidate.work.over16_7 * 100).toFixed(2)}% over33=${(cell.candidate.work.over33 * 100).toFixed(2)}% ` +
      `${cell.gate.pass ? "PASS" : "FAIL"}`,
    );
  }
  server.stop(true);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`MOBILE_FRAME_FAIL ${failure.cell}: ${failure.reasons.join("; ")}`);
    process.exitCode = 1;
  }
}

await main();

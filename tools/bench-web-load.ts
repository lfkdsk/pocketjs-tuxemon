// Real-browser cold-start comparison for the monolithic and chunked Web
// builds. Each cell gets a fresh Chrome profile. Network and CPU throttling
// are installed before navigation, and the page reports milestones through a
// DevTools binding at the exact painted frame where they become interactive.

import {
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { registerCleanup, spawnHeadlessChrome } from "./headless-chrome.ts";

type Variant = "baseline" | "candidate";

interface NetworkProfile {
  id: string;
  downBytesPerSecond: number;
  latencyMs: number;
}

interface RequestSnapshot {
  url: string;
  encodedBytes: number;
  finished: boolean;
  status: number | null;
  fromDiskCache: boolean;
  fromServiceWorker: boolean;
}

interface Milestone {
  name: "title-interactive" | "first-map-interactive";
  pageMs: number;
  playerFrames: number;
  mapId: string | null;
  titleScreen: string | null;
  transferredBytes: number;
  requests: RequestSnapshot[];
}

interface Measurement {
  variant: Variant;
  profile: NetworkProfile;
  cpuThrottle: number;
  title: Milestone;
  firstMap: Milestone;
  processWallMs: number;
  navigation: Record<string, number>;
  resources: Array<{
    name: string;
    transferSize: number;
    encodedBodySize: number;
    duration: number;
  }>;
  final: {
    playerState: string | null;
    playerFrames: number;
    mapId: string | null;
    titleScreen: string | null;
    frameBlocked: boolean;
    chunkVeil: boolean;
    pak: unknown;
  };
  consoleErrors: string[];
}

const PROFILES: readonly NetworkProfile[] = [
  {
    id: "10mbps-40ms",
    downBytesPerSecond: 10_000_000 / 8,
    latencyMs: 40,
  },
  {
    id: "1.6mbps-150ms",
    downBytesPerSecond: 1_600_000 / 8,
    latencyMs: 150,
  },
];

function requiredSite(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  const site = resolve(value);
  if (!existsSync(join(site, "pocket-tuxemon", "index.html"))) {
    throw new Error(`${name} has no pocket-tuxemon/index.html: ${site}`);
  }
  return site;
}

function selectedProfiles(): readonly NetworkProfile[] {
  const requested = process.env.WEB_LOAD_PROFILE;
  if (!requested) return PROFILES;
  const profile = PROFILES.find((candidate) => candidate.id === requested);
  if (!profile) {
    throw new Error(`WEB_LOAD_PROFILE must be one of ${PROFILES.map((p) => p.id).join(", ")}`);
  }
  return [profile];
}

function selectedVariants(): readonly Variant[] {
  const value = process.env.WEB_LOAD_VARIANTS ?? "candidate,baseline";
  const variants = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (variants.length === 0 || variants.some((part) => part !== "baseline" && part !== "candidate")) {
    throw new Error("WEB_LOAD_VARIANTS must be a comma-separated list of baseline,candidate");
  }
  return variants as Variant[];
}

function pageProbe(token: string): string {
  return `
    globalThis.__pocketTuxemonShowTitle = true;
    globalThis.__webLoadProbe = {
      token: ${JSON.stringify(token)},
      started: performance.now(),
      title: 0,
      firstMap: 0,
      titleFrames: -1,
    };
    (() => {
      const probe = globalThis.__webLoadProbe;
      const emit = (name) => globalThis.__webLoadMark(JSON.stringify({
        token: probe.token,
        name,
        pageMs: performance.now() - probe.started,
        playerFrames: globalThis.__pocketPlayer?.frames ?? -1,
        mapId: globalThis.__rpgSessionState?.mapId ?? null,
        titleScreen: globalThis.__pocketTitleBattle?.state().screen ?? null,
      }));
      const afterTwoPaints = (fn) => requestAnimationFrame(() => requestAnimationFrame(fn));
      const titleReady = () => {
        const player = globalThis.__pocketPlayer;
        const title = globalThis.__pocketTitleBattle;
        const rows = title?.titleRows?.() ?? [];
        return player?.state === "running"
          && title?.state().screen === "title"
          && rows.includes("newGame")
          && !!globalThis.__rpgSessionState;
      };
      const mapReady = () => {
        const player = globalThis.__pocketPlayer;
        return player?.state === "running"
          && globalThis.__pocketTitleBattle?.state().screen === "closed"
          && globalThis.__rpgSessionState?.mapId === "spyder_bedroom"
          && player.frameBlocked !== true
          && player.chunkVeil !== true
          && player.frames > probe.titleFrames;
      };
      const waitForMap = () => {
        if (!mapReady()) {
          requestAnimationFrame(waitForMap);
          return;
        }
        afterTwoPaints(() => {
          if (!mapReady() || probe.firstMap) return requestAnimationFrame(waitForMap);
          probe.firstMap = performance.now();
          emit("first-map-interactive");
        });
      };
      const waitForTitle = () => {
        if (!titleReady()) {
          requestAnimationFrame(waitForTitle);
          return;
        }
        afterTwoPaints(() => {
          if (!titleReady() || probe.title) return requestAnimationFrame(waitForTitle);
          probe.title = performance.now();
          probe.titleFrames = globalThis.__pocketPlayer.frames;
          emit("title-interactive");
          const title = globalThis.__pocketTitleBattle;
          title.selectTitle(title.titleRows().indexOf("newGame"));
          title.act("confirm");
          requestAnimationFrame(waitForMap);
        });
      };
      requestAnimationFrame(waitForTitle);
    })();
  `;
}

async function measure(
  chromePath: string,
  profileDir: string,
  url: string,
  variant: Variant,
  profile: NetworkProfile,
  cpuThrottle: number,
  timeoutMs: number,
): Promise<Measurement> {
  const processStarted = performance.now();
  const chrome = await spawnHeadlessChrome(chromePath, profileDir, "960,544");
  const ws = new WebSocket(chrome.wsUrl);
  try {
    await new Promise<void>((resolveOpen, reject) => {
      ws.addEventListener("open", () => resolveOpen(), { once: true });
      ws.addEventListener("error", () => reject(new Error("Chrome DevTools socket failed")), {
        once: true,
      });
    });

    let commandId = 0;
    const pending = new Map<number, {
      resolve(value: any): void;
      reject(error: Error): void;
    }>();
    const requests = new Map<string, RequestSnapshot>();
    const milestones = new Map<string, Milestone>();
    const consoleErrors: string[] = [];
    const token = `${variant}-${profile.id}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let resolveMap!: () => void;
    const mapReached = new Promise<void>((resolveReached) => { resolveMap = resolveReached; });

    const requestSnapshot = (): RequestSnapshot[] => [...requests.values()]
      .filter((request) => request.encodedBytes > 0)
      .map((request) => ({ ...request }))
      .sort((a, b) => a.url.localeCompare(b.url));
    const transferredBytes = (): number => [...requests.values()]
      .reduce((sum, request) => sum + request.encodedBytes, 0);

    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
        return;
      }
      if (message.method === "Network.requestWillBeSent") {
        requests.set(message.params.requestId, {
          url: message.params.request.url,
          encodedBytes: 0,
          finished: false,
          status: null,
          fromDiskCache: false,
          fromServiceWorker: false,
        });
      } else if (message.method === "Network.dataReceived") {
        const request = requests.get(message.params.requestId);
        if (request) request.encodedBytes += Number(message.params.encodedDataLength ?? 0);
      } else if (message.method === "Network.responseReceived") {
        const request = requests.get(message.params.requestId);
        if (request) {
          request.status = Number(message.params.response.status);
          request.fromDiskCache = message.params.response.fromDiskCache === true;
          request.fromServiceWorker = message.params.response.fromServiceWorker === true;
        }
      } else if (message.method === "Network.loadingFinished") {
        const request = requests.get(message.params.requestId);
        if (request) {
          request.finished = true;
          request.encodedBytes = Math.max(
            request.encodedBytes,
            Number(message.params.encodedDataLength ?? 0),
          );
        }
      } else if (message.method === "Runtime.bindingCalled" && message.params.name === "__webLoadMark") {
        const payload = JSON.parse(message.params.payload);
        if (payload.token !== token || milestones.has(payload.name)) return;
        const milestone: Milestone = {
          name: payload.name,
          pageMs: Number(payload.pageMs),
          playerFrames: Number(payload.playerFrames),
          mapId: payload.mapId ?? null,
          titleScreen: payload.titleScreen ?? null,
          transferredBytes: transferredBytes(),
          requests: requestSnapshot(),
        };
        milestones.set(payload.name, milestone);
        if (payload.name === "first-map-interactive") resolveMap();
      } else if (message.method === "Runtime.exceptionThrown") {
        consoleErrors.push(message.params.exceptionDetails?.exception?.description
          ?? message.params.exceptionDetails?.text
          ?? "uncaught page exception");
      } else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        consoleErrors.push(message.params.args.map((arg: any) => arg.value ?? arg.description ?? "").join(" "));
      }
    });

    const send = (method: string, params: Record<string, unknown> = {}): Promise<any> =>
      new Promise((resolveCommand, rejectCommand) => {
        const id = ++commandId;
        pending.set(id, {
          resolve: resolveCommand,
          reject: (error) => rejectCommand(new Error(`${method}: ${error.message}`)),
        });
        ws.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression: string): Promise<any> => {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      }
      return result.result.value;
    };

    await send("Runtime.enable");
    await send("Page.enable");
    await send("Network.enable");
    await send("Runtime.addBinding", { name: "__webLoadMark" });
    await send("Network.setCacheDisabled", { cacheDisabled: true });
    await send("Network.emulateNetworkConditions", {
      offline: false,
      latency: profile.latencyMs,
      downloadThroughput: profile.downBytesPerSecond,
      uploadThroughput: profile.downBytesPerSecond,
      connectionType: "cellular4g",
    });
    await send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });
    await send("Page.addScriptToEvaluateOnNewDocument", { source: pageProbe(token) });
    await send("Page.navigate", { url });

    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      mapReached,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `${variant} ${profile.id} did not reach the first map within ${timeoutMs} ms`,
        )), timeoutMs);
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });

    const title = milestones.get("title-interactive");
    const firstMap = milestones.get("first-map-interactive");
    if (!title || !firstMap) throw new Error(`${variant} ${profile.id}: missing milestone`);
    const page = await evaluate(`(() => {
      const navigation = performance.getEntriesByType("navigation")[0];
      return {
        navigation: navigation ? {
          responseEnd: navigation.responseEnd,
          domContentLoadedEventEnd: navigation.domContentLoadedEventEnd,
          loadEventEnd: navigation.loadEventEnd,
          transferSize: navigation.transferSize,
          encodedBodySize: navigation.encodedBodySize,
        } : {},
        resources: performance.getEntriesByType("resource").map((entry) => ({
          name: entry.name,
          transferSize: entry.transferSize,
          encodedBodySize: entry.encodedBodySize,
          duration: entry.duration,
        })),
        final: {
          playerState: globalThis.__pocketPlayer?.state ?? null,
          playerFrames: globalThis.__pocketPlayer?.frames ?? -1,
          mapId: globalThis.__rpgSessionState?.mapId ?? null,
          titleScreen: globalThis.__pocketTitleBattle?.state().screen ?? null,
          frameBlocked: globalThis.__pocketPlayer?.frameBlocked === true,
          chunkVeil: globalThis.__pocketPlayer?.chunkVeil === true,
          pak: globalThis.__pocketPak?.stats?.() ?? null,
        },
      };
    })()`);
    if (title.titleScreen !== "title") {
      throw new Error(`${variant} ${profile.id}: title milestone was ${title.titleScreen ?? "missing"}`);
    }
    if (firstMap.titleScreen !== "closed" || firstMap.mapId !== "spyder_bedroom") {
      throw new Error(
        `${variant} ${profile.id}: first map was ${firstMap.titleScreen ?? "missing"} ${firstMap.mapId ?? "missing"}`,
      );
    }
    return {
      variant,
      profile,
      cpuThrottle,
      title,
      firstMap,
      processWallMs: performance.now() - processStarted,
      navigation: page.navigation,
      resources: page.resources,
      final: page.final,
      consoleErrors,
    };
  } finally {
    ws.close();
    chrome.close();
  }
}

function relativeRequest(url: string): string {
  const parsed = new URL(url);
  return parsed.pathname + parsed.search;
}

function compact(result: Measurement): object {
  return {
    variant: result.variant,
    profile: result.profile.id,
    titleMs: Math.round(result.title.pageMs),
    firstMapMs: Math.round(result.firstMap.pageMs),
    titleBytes: result.title.transferredBytes,
    firstMapBytes: result.firstMap.transferredBytes,
    titleRequests: result.title.requests.map((request) => relativeRequest(request.url)),
    firstMapRequests: result.firstMap.requests.map((request) => relativeRequest(request.url)),
  };
}

async function main(): Promise<void> {
  const sites: Record<Variant, string> = {
    baseline: requiredSite("WEB_LOAD_BASELINE_SITE"),
    candidate: requiredSite("WEB_LOAD_CANDIDATE_SITE"),
  };
  const chromePath = process.env.CHROME
    ?? Bun.which("google-chrome")
    ?? Bun.which("chromium")
    ?? "google-chrome";
  const cpuThrottle = Number(process.env.WEB_LOAD_CPU_THROTTLE ?? "4");
  const timeoutMs = Number(process.env.WEB_LOAD_TIMEOUT_MS ?? "900000");
  const output = resolve(process.env.WEB_LOAD_OUTPUT ?? "reports/web-load-benchmark.json");
  if (!(cpuThrottle >= 1)) throw new Error("WEB_LOAD_CPU_THROTTLE must be at least 1");
  if (!(timeoutMs > 0)) throw new Error("WEB_LOAD_TIMEOUT_MS must be positive");
  mkdirSync(dirname(output), { recursive: true });
  const profilesDir = resolve(process.env.WEB_LOAD_PROFILE_DIR ?? "dist/web-load-profiles");
  rmSync(profilesDir, { recursive: true, force: true });
  mkdirSync(profilesDir, { recursive: true });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const [, rawVariant, ...parts] = decodeURIComponent(url.pathname).split("/");
      if (rawVariant !== "baseline" && rawVariant !== "candidate") {
        return new Response("not found", { status: 404 });
      }
      const root = sites[rawVariant];
      let path = resolve(root, `.${sep}${parts.join(sep)}`);
      if (!path.startsWith(root + sep)) return new Response("forbidden", { status: 403 });
      if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
      if (!existsSync(path)) return new Response("not found", { status: 404 });
      const file = Bun.file(path);
      return new Response(file, {
        headers: {
          "cache-control": "no-store",
          "content-type": file.type || "application/octet-stream",
        },
      });
    },
  });
  registerCleanup(() => server.stop(true));

  const results: Measurement[] = [];
  try {
    for (const profile of selectedProfiles()) {
      for (const variant of selectedVariants()) {
        const profileDir = join(profilesDir, `${profile.id}-${variant}`);
        const url = `http://127.0.0.1:${server.port}/${variant}/pocket-tuxemon/?lang=en_US&web_load=${Date.now()}`;
        console.log(
          `WEB_LOAD begin variant=${variant} profile=${profile.id} cpu=${cpuThrottle}x `
          + `down=${profile.downBytesPerSecond}Bps latency=${profile.latencyMs}ms`,
        );
        const result = await measure(
          chromePath,
          profileDir,
          url,
          variant,
          profile,
          cpuThrottle,
          timeoutMs,
        );
        results.push(result);
        console.log(`WEB_LOAD ${JSON.stringify(compact(result))}`);
        writeFileSync(output, `${JSON.stringify({
          format: "pocket-tuxemon/web-load-benchmark/v1",
          cpuThrottle,
          chromePath,
          results,
        }, null, 2)}\n`);
        rmSync(profileDir, { recursive: true, force: true });
      }
    }
  } finally {
    server.stop(true);
    rmSync(profilesDir, { recursive: true, force: true });
  }

  const comparisons = selectedProfiles().map((profile) => {
    const baseline = results.find((result) => result.profile.id === profile.id && result.variant === "baseline");
    const candidate = results.find((result) => result.profile.id === profile.id && result.variant === "candidate");
    if (!baseline || !candidate) return null;
    return {
      profile: profile.id,
      titleSpeedup: baseline.title.pageMs / candidate.title.pageMs,
      firstMapSpeedup: baseline.firstMap.pageMs / candidate.firstMap.pageMs,
      titleByteReduction: 1 - candidate.title.transferredBytes / baseline.title.transferredBytes,
      firstMapByteReduction: 1 - candidate.firstMap.transferredBytes / baseline.firstMap.transferredBytes,
    };
  }).filter(Boolean);
  writeFileSync(output, `${JSON.stringify({
    format: "pocket-tuxemon/web-load-benchmark/v1",
    measuredAt: new Date().toISOString(),
    cpuThrottle,
    chromePath,
    sites,
    results,
    comparisons,
  }, null, 2)}\n`);
  console.log(`WEB_LOAD_OUTPUT ${output}`);
}

if (import.meta.main) await main();

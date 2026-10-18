import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  finalizeWebPwa,
  offlinePackages,
  pwaReleaseVersion,
  renderGameManifest,
} from "../tools/web-pwa.ts";
import type { WebPakManifest } from "../tools/web-chunks.ts";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function asset(fileStem: string, body: string) {
  const digest = sha256(body);
  return {
    file: `chunks/${fileStem}-${digest}.pak.gz`,
    encoding: "gzip" as const,
    bytes: Buffer.byteLength(body),
    unpackedBytes: Buffer.byteLength(body) + 3,
    sha256: digest,
  };
}

function fixtureManifest(): WebPakManifest {
  return {
    version: 1,
    format: "pocket-pak-chunks/v1",
    startup: asset("startup", "boot"),
    chunks: [
      { ...asset("locale-en", "en"), id: "locale:en_US", entries: [], background: false, requires: [] },
      { ...asset("locale-zh", "zh"), id: "locale:zh_CN", entries: [], background: false, requires: [] },
      { ...asset("map-en", "en-map"), id: "map:en_US:bedroom", entries: [], background: false, requires: [] },
      { ...asset("map-zh", "zh-map"), id: "map:zh_CN:bedroom", entries: [], background: false, requires: [] },
      { ...asset("visual", "tiles"), id: "visual:bedroom", entries: [], background: true, requires: [] },
      { ...asset("audio", "music"), id: "audio:home", entries: [], background: true, requires: [] },
    ],
  };
}

function makeFixture(clientSuffix = ""): {
  temp: string;
  root: string;
  siteDir: string;
  gameDir: string;
  manifest: WebPakManifest;
} {
  const temp = mkdtempSync(join(process.cwd(), ".web-pwa-test-"));
  const root = join(temp, "project");
  const siteDir = join(temp, "site");
  const gameDir = join(siteDir, "pocket-tuxemon");
  mkdirSync(join(root, "web"), { recursive: true });
  mkdirSync(gameDir, { recursive: true });
  const templateRoot = join(import.meta.dir, "..", "web");
  const manifest = fixtureManifest();
  writeFileSync(join(root, "web", "pwa-client.js"), readFileSync(join(templateRoot, "pwa-client.js"), "utf8") + clientSuffix);
  writeFileSync(join(root, "web", "service-worker.js"), readFileSync(join(templateRoot, "service-worker.js"), "utf8"));
  writeFileSync(join(siteDir, "player.js"), 'const worklet = "audio-worklet.js";');
  writeFileSync(join(siteDir, "pocketjs.wasm"), "wasm");
  writeFileSync(join(siteDir, "site.css"), "body{color:white}");
  writeFileSync(join(siteDir, "icon-192.png"), "icon 192");
  writeFileSync(join(siteDir, "icon-512.png"), "icon 512");
  writeFileSync(join(siteDir, "apple-touch-icon.png"), "apple icon");
  writeFileSync(join(gameDir, "audio-worklet.js"), "processor");
  writeFileSync(join(gameDir, "pocket-tuxemon.js"), "game");
  mkdirSync(join(gameDir, "chunks"), { recursive: true });
  const chunkBodies = ["boot", "en", "zh", "en-map", "zh-map", "tiles", "music"];
  for (const [entry, body] of [manifest.startup, ...manifest.chunks].map((entry, index) =>
    [entry, chunkBodies[index]!] as const)) {
    writeFileSync(join(gameDir, entry.file), body);
  }
  writeFileSync(join(gameDir, "pocket-tuxemon.pak-manifest.json"), `${JSON.stringify(manifest)}\n`);
  writeFileSync(join(gameDir, "replay.html"), "replay stays byte-identical");
  writeFileSync(join(gameDir, "index.html"), `<!doctype html>
<html lang="en" data-page-lang="pending"><head>
<link rel="stylesheet" href="../site.css">
<link rel="manifest" href="../manifest.webmanifest">
<link rel="apple-touch-icon" href="../apple-touch-icon.png">
</head><body><section class="info">Info</section>
<script type="application/json" id="pocket-game">{"bundle":"pocket-tuxemon.js","wasm":"../pocketjs.wasm","pakManifest":"pocket-tuxemon.pak-manifest.json"}</script>
<script type="module" src="../player.js"></script></body></html>`);
  return { temp, root, siteDir, gameDir, manifest };
}

const requestUrl = (request: unknown): string => {
  if (typeof request === "string") return request;
  if (request instanceof URL) return request.href;
  return String((request as { url?: string }).url ?? request);
};

class MemoryCache {
  private readonly entries = new Map<string, Response>();

  async match(request: unknown): Promise<Response | undefined> {
    return this.entries.get(requestUrl(request))?.clone();
  }

  async put(request: unknown, response: Response): Promise<void> {
    this.entries.set(requestUrl(request), response.clone());
  }

  async delete(request: unknown): Promise<boolean> {
    return this.entries.delete(requestUrl(request));
  }

  async keys(): Promise<Array<{ url: string }>> {
    return [...this.entries.keys()].map((url) => ({ url }));
  }
}

class MemoryCacheStorage {
  private readonly stores = new Map<string, MemoryCache>();

  async open(name: string): Promise<MemoryCache> {
    let cache = this.stores.get(name);
    if (!cache) {
      cache = new MemoryCache();
      this.stores.set(name, cache);
    }
    return cache;
  }

  async keys(): Promise<string[]> {
    return [...this.stores.keys()];
  }

  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }
}

class RouteFetch {
  routes = new Map<string, Uint8Array>();
  readonly calls: string[] = [];
  offline = false;

  async fetch(request: unknown, init?: { signal?: AbortSignal }): Promise<Response> {
    const url = requestUrl(request);
    this.calls.push(url);
    if (this.offline) throw new TypeError("fixture network offline");
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const body = this.routes.get(url);
    return body
      ? new Response(Buffer.from(body), { status: 200 })
      : new Response("fixture not found", { status: 404 });
  }
}

function releaseRoutes(
  fixture: ReturnType<typeof makeFixture>,
  build: ReturnType<typeof finalizeWebPwa>,
  scope: string,
): Map<string, Uint8Array> {
  const routes = new Map<string, Uint8Array>();
  for (const asset of build.shell) {
    routes.set(new URL(asset.url, scope).href, new Uint8Array(readFileSync(join(fixture.gameDir, asset.url))));
  }
  for (const asset of fixture.manifest.chunks) {
    routes.set(new URL(asset.file, scope).href, new Uint8Array(readFileSync(join(fixture.gameDir, asset.file))));
  }
  return routes;
}

class ServiceWorkerHarness {
  private readonly listeners = new Map<string, Array<(event: any) => void>>();
  readonly registration = { scope: "", updates: 0, update: async () => { this.registration.updates++; } };
  skipWaitingCalls = 0;

  constructor(
    source: string,
    scope: string,
    readonly caches: MemoryCacheStorage,
    readonly network: RouteFetch,
  ) {
    this.registration.scope = scope;
    const self = {
      registration: this.registration,
      addEventListener: (type: string, listener: (event: any) => void) => {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      },
      skipWaiting: async () => { this.skipWaitingCalls++; },
    };
    runInNewContext(source, {
      AbortController,
      DOMException,
      Response,
      URL,
      caches,
      console,
      crypto: globalThis.crypto,
      fetch: network.fetch.bind(network),
      self,
    });
  }

  private async dispatchExtendable(type: string, event: Record<string, unknown> = {}): Promise<void> {
    const pending: Promise<unknown>[] = [];
    const extendable = {
      ...event,
      waitUntil(value: Promise<unknown>) {
        pending.push(Promise.resolve(value));
      },
    };
    for (const listener of this.listeners.get(type) ?? []) listener(extendable);
    await Promise.all(pending);
  }

  install(): Promise<void> {
    return this.dispatchExtendable("install");
  }

  activate(): Promise<void> {
    return this.dispatchExtendable("activate");
  }

  async message(data: unknown, source: { postMessage(message: unknown): void } | null = null): Promise<void> {
    await this.dispatchExtendable("message", { data, source });
    await Promise.resolve();
  }

  async fetch(request: { url: string; method: string; mode?: string }): Promise<Response | undefined> {
    let response: Promise<Response> | undefined;
    const event = {
      request,
      respondWith(value: Promise<Response> | Response) {
        response = Promise.resolve(value);
      },
    };
    for (const listener of this.listeners.get("fetch") ?? []) listener(event);
    return response ? await response : undefined;
  }
}

class FakeTarget {
  private readonly listeners = new Map<string, Array<(event: any) => void>>();

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string, event: Record<string, unknown> = {}): void {
    const value = { preventDefault() {}, ...event, target: this, currentTarget: this };
    for (const listener of this.listeners.get(type) ?? []) listener(value);
  }
}

class FakeElement extends FakeTarget {
  className = "";
  disabled = false;
  hidden = false;
  id = "";
  innerHTML = "";
  lang = "en";
  textContent = "";
  value = "";
  private readonly attributes = new Map<string, string>();

  append(): void {}
  before(): void {}
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
}

async function runPwaClient(options: { pak?: boolean } = {}): Promise<{
  sandbox: Record<string, any>;
  elements: Record<string, FakeElement>;
  serviceWorker: FakeTarget;
  window: FakeTarget;
  posted: any[];
  timers: Array<{ id: number; callback: () => void; delay: number; cancelled: boolean; ran: boolean }>;
  runAllTimers(): void;
}> {
  const ids = [
    "pocket-pwa",
    "offline-language",
    "offline-download",
    "offline-status",
    "pwa-install",
    "pwa-update",
    "offline-missing",
    "offline-missing-text",
    "offline-missing-retry",
    "offline-missing-return",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, Object.assign(new FakeElement(), { id })])) as Record<string, FakeElement>;
  elements["pocket-pwa"]!.textContent = JSON.stringify({ build: "fixture-build" });
  const documentElement = new FakeElement();
  documentElement.lang = "en";
  documentElement.setAttribute("data-page-lang", "en");
  const info = new FakeElement();
  const main = new FakeElement();
  const document = {
    body: new FakeElement(),
    head: new FakeElement(),
    documentElement,
    createElement: () => new FakeElement(),
    getElementById: (id: string) => elements[id] ?? null,
    querySelector: (selector: string) => selector === "section.info" ? info : selector === "main" ? main : null,
  };
  const posted: any[] = [];
  const target = { postMessage: (message: unknown) => posted.push(message) };
  const registration = Object.assign(new FakeTarget(), { active: target, waiting: null });
  const serviceWorker = Object.assign(new FakeTarget(), {
    controller: target,
    ready: Promise.resolve(registration),
    register: async () => registration,
  });
  const window = new FakeTarget();
  const timers: Array<{ id: number; callback: () => void; delay: number; cancelled: boolean; ran: boolean }> = [];
  let nextTimer = 0;
  const setTimeout = (callback: () => void, delay = 0) => {
    const timer = { id: ++nextTimer, callback, delay, cancelled: false, ran: false };
    timers.push(timer);
    return timer.id;
  };
  const clearTimeout = (id: number) => {
    const timer = timers.find((entry) => entry.id === id);
    if (timer) timer.cancelled = true;
  };
  const stored = new Map<string, string>();
  const sandbox: Record<string, any> = {
    URL,
    clearTimeout,
    console,
    document,
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    },
    location: { href: "https://example.test/pocket-tuxemon/", reload() {}, replace() {} },
    navigator: { onLine: true, serviceWorker },
    setTimeout,
    window,
  };
  if (options.pak !== false) sandbox.__pocketPak = { prepare: async () => {} };
  runInNewContext(readFileSync(join(import.meta.dir, "..", "web", "pwa-client.js"), "utf8"), sandbox);
  await Promise.resolve();
  await Promise.resolve();
  return {
    sandbox,
    elements,
    serviceWorker,
    window,
    posted,
    timers,
    runAllTimers() {
      for (let guard = 0; guard < 1000; guard++) {
        const timer = timers.find((entry) => !entry.cancelled && !entry.ran);
        if (!timer) return;
        timer.ran = true;
        timer.callback();
      }
      throw new Error("PWA client fixture did not drain its timer queue");
    },
  };
}

describe("Web PWA finalizer", () => {
  test("language routing participates in the release identity", () => {
    const seed = {
      page: "page",
      worker: "worker",
      assets: [],
      installAssets: [],
      languages: { en: "en_US" },
    };
    expect(pwaReleaseVersion(seed)).not.toBe(pwaReleaseVersion({
      ...seed,
      languages: { en: "en_GB" },
    }));
  });

  test("selects one locale and its maps while sharing all language-neutral chunks", () => {
    const manifest = fixtureManifest();
    const packages = offlinePackages(manifest);
    expect(Object.keys(packages)).toEqual(["en", "zh", "de", "fr", "es", "it", "pt-br"]);
    expect(packages.en!.chunks).toBe(5);
    expect(packages.en!.bytes).toBe(
      manifest.startup.bytes +
      manifest.chunks.filter((chunk) => ["locale:en_US", "map:en_US:bedroom", "visual:bedroom", "audio:home"].includes(chunk.id))
        .reduce((sum, chunk) => sum + chunk.bytes, 0),
    );
    expect(packages.zh!.chunks).toBe(5);
    expect(packages.de!.chunks).toBe(3);
  });

  test("writes an installable, content-addressed and replay-isolated game shell deterministically", () => {
    const fixture = makeFixture();
    try {
      const options = { root: fixture.root, siteDir: fixture.siteDir, gameId: "pocket-tuxemon", manifest: fixture.manifest };
      const first = finalizeWebPwa(options);
      const firstHtml = readFileSync(join(fixture.gameDir, "index.html"), "utf8");
      const firstWorker = readFileSync(first.serviceWorkerPath, "utf8");
      const firstReceipt = readFileSync(first.receiptPath, "utf8");
      const second = finalizeWebPwa(options);

      expect(second).toEqual(first);
      expect(readFileSync(join(fixture.gameDir, "index.html"), "utf8")).toBe(firstHtml);
      expect(readFileSync(second.serviceWorkerPath, "utf8")).toBe(firstWorker);
      expect(readFileSync(second.receiptPath, "utf8")).toBe(firstReceipt);
      expect(first.version).toMatch(/^[0-9a-f]{64}$/);
      expect(firstHtml).toContain(`data-pwa-build="${first.version}"`);
      expect(firstHtml).toContain(`"pwaBuild":"${first.version}"`);
      expect(firstHtml).toContain('href="manifest.webmanifest"');
      expect(firstHtml).toContain('import("./pwa-client.');
      expect(firstHtml).not.toContain('class="offline-controls"');
      expect(firstHtml).not.toContain('src="../player.js"');
      expect(firstHtml).toMatch(/src="player\.[0-9a-f]{64}\.js"/);
      expect(firstHtml).toMatch(/"wasm":"pocketjs\.[0-9a-f]{64}\.wasm"/);
      expect(firstHtml).toMatch(/href="site\.[0-9a-f]{64}\.css"/);
      expect(readFileSync(join(fixture.gameDir, "replay.html"), "utf8")).toBe("replay stays byte-identical");

      const client = first.shell.find((entry) => entry.url.startsWith("pwa-client."))!;
      expect(existsSync(join(fixture.gameDir, client.url))).toBeTrue();
      expect(existsSync(join(fixture.root, "web", client.url))).toBeFalse();
      for (const shell of first.shell) {
        expect(shell.url.startsWith("../")).toBeFalse();
        const path = join(fixture.gameDir, shell.url);
        if (shell.url === fixture.manifest.startup.file) continue;
        expect(existsSync(path)).toBeTrue();
        expect(readFileSync(path).byteLength).toBe(shell.bytes);
      }

      expect(firstWorker).not.toContain("__POCKET_TUXEMON_PWA_BUILD__");
      expect(firstWorker).toContain(`"version":"${first.version}"`);

      const manifest = JSON.parse(renderGameManifest()) as Record<string, unknown>;
      expect(manifest).toMatchObject({ id: "./", start_url: "./", scope: "./", display: "standalone" });
      expect(manifest.icons).toHaveLength(4);
    } finally {
      rmSync(fixture.temp, { recursive: true, force: true });
    }
  });

  test("changes the release when only PWA client behavior changes", () => {
    const firstFixture = makeFixture("\n// client A\n");
    const secondFixture = makeFixture("\n// client B\n");
    try {
      const first = finalizeWebPwa({
        root: firstFixture.root,
        siteDir: firstFixture.siteDir,
        gameId: "pocket-tuxemon",
        manifest: firstFixture.manifest,
      });
      const second = finalizeWebPwa({
        root: secondFixture.root,
        siteDir: secondFixture.siteDir,
        gameId: "pocket-tuxemon",
        manifest: secondFixture.manifest,
      });
      expect(second.version).not.toBe(first.version);
    } finally {
      rmSync(firstFixture.temp, { recursive: true, force: true });
      rmSync(secondFixture.temp, { recursive: true, force: true });
    }
  });
});

describe("Web PWA runtime behavior", () => {
  test("executes shell, manifest and content cache policies", async () => {
    const fixture = makeFixture();
    try {
      const build = finalizeWebPwa({
        root: fixture.root,
        siteDir: fixture.siteDir,
        gameId: "pocket-tuxemon",
        manifest: fixture.manifest,
      });
      const scope = "https://example.test/pocket-tuxemon/";
      const caches = new MemoryCacheStorage();
      const network = new RouteFetch();
      network.routes = releaseRoutes(fixture, build, scope);
      const worker = new ServiceWorkerHarness(
        readFileSync(build.serviceWorkerPath, "utf8"),
        scope,
        caches,
        network,
      );

      await worker.install();
      const shellCache = (await caches.keys()).find((name) => name.endsWith(`:${build.version}`));
      expect(shellCache).toBeDefined();
      expect((await (await caches.open(shellCache!)).keys()).length).toBe(build.shell.length);

      network.calls.length = 0;
      const client = build.shell.find((asset) => asset.url.startsWith("pwa-client."))!;
      const cachedShell = await worker.fetch({ url: new URL(client.url, scope).href, method: "GET", mode: "cors" });
      expect(await cachedShell!.text()).toBe(readFileSync(join(fixture.gameDir, client.url), "utf8"));
      expect(network.calls).toEqual([]);

      const manifestAsset = build.shell.find((asset) => asset.url.startsWith("pocket-tuxemon.pak-manifest."))!;
      const manifestUrl = new URL(manifestAsset.url, scope).href;
      const onlineManifest = await worker.fetch({ url: manifestUrl, method: "GET", mode: "cors" });
      const manifestText = await onlineManifest!.text();
      expect(network.calls).toEqual([manifestUrl]);
      network.offline = true;
      const offlineManifest = await worker.fetch({ url: manifestUrl, method: "GET", mode: "cors" });
      expect(await offlineManifest!.text()).toBe(manifestText);
      expect(network.calls).toEqual([manifestUrl, manifestUrl]);

      network.offline = false;
      const content = fixture.manifest.chunks.find((asset) => asset.id === "visual:bedroom")!;
      const contentUrl = new URL(content.file, scope).href;
      const firstContent = await worker.fetch({ url: contentUrl, method: "GET", mode: "cors" });
      expect(await firstContent!.text()).toBe("tiles");
      expect(await (await caches.open("pocket-rpgkit:pak-chunks:v1")).match(contentUrl)).toBeDefined();
      const callsAfterContent = network.calls.length;
      network.offline = true;
      const cachedContent = await worker.fetch({ url: contentUrl, method: "GET", mode: "cors" });
      expect(await cachedContent!.text()).toBe("tiles");
      expect(network.calls.length).toBe(callsAfterContent);

      const absentUrl = new URL(`chunks/absent-${sha256("absent")}.pak.gz`, scope).href;
      const absent = await worker.fetch({ url: absentUrl, method: "GET", mode: "cors" });
      expect(absent!.status).toBe(503);
      expect(absent!.headers.get("x-pocket-offline")).toBe("missing");
      const replay = await worker.fetch({ url: new URL("replay.html", scope).href, method: "GET", mode: "cors" });
      expect(replay).toBeUndefined();
    } finally {
      rmSync(fixture.temp, { recursive: true, force: true });
    }
  });

  test("keeps releases atomic and deletes only stale same-scope shell caches", async () => {
    const fixtureA = makeFixture("\n// release A\n");
    const fixtureB = makeFixture("\n// release B\n");
    try {
      const buildA = finalizeWebPwa({
        root: fixtureA.root,
        siteDir: fixtureA.siteDir,
        gameId: "pocket-tuxemon",
        manifest: fixtureA.manifest,
      });
      const buildB = finalizeWebPwa({
        root: fixtureB.root,
        siteDir: fixtureB.siteDir,
        gameId: "pocket-tuxemon",
        manifest: fixtureB.manifest,
      });
      expect(buildB.version).not.toBe(buildA.version);
      const scope = "https://example.test/pocket-tuxemon/";
      const caches = new MemoryCacheStorage();
      const network = new RouteFetch();
      network.routes = releaseRoutes(fixtureA, buildA, scope);
      const workerA = new ServiceWorkerHarness(readFileSync(buildA.serviceWorkerPath, "utf8"), scope, caches, network);
      await workerA.install();

      const shared = await caches.open("pocket-rpgkit:pak-chunks:v1");
      const sharedUrl = new URL(`chunks/shared-${sha256("shared")}.pak.gz`, scope).href;
      await shared.put(sharedUrl, new Response("shared"));
      const otherScopeCache = "pocket-tuxemon:shell:v1:%2Fother-game%2F:old";
      await caches.open(otherScopeCache);

      network.routes = releaseRoutes(fixtureB, buildB, scope);
      const mixed = await workerA.fetch({ url: scope, method: "GET", mode: "navigate" });
      const mixedHtml = await mixed!.text();
      expect(mixedHtml).toContain(`data-pwa-build="${buildA.version}"`);
      expect(mixedHtml).not.toContain(`data-pwa-build="${buildB.version}"`);

      const workerB = new ServiceWorkerHarness(readFileSync(buildB.serviceWorkerPath, "utf8"), scope, caches, network);
      await workerB.install();
      let cacheNames = await caches.keys();
      expect(cacheNames.some((name) => name.endsWith(`:${buildA.version}`))).toBeTrue();
      expect(cacheNames.some((name) => name.endsWith(`:${buildB.version}`))).toBeTrue();

      await workerB.message({ type: "ACTIVATE_UPDATE" });
      expect(workerB.skipWaitingCalls).toBe(1);
      await workerB.activate();
      cacheNames = await caches.keys();
      expect(cacheNames.some((name) => name.endsWith(`:${buildA.version}`))).toBeFalse();
      expect(cacheNames.some((name) => name.endsWith(`:${buildB.version}`))).toBeTrue();
      expect(cacheNames).toContain(otherScopeCache);
      expect(await shared.match(sharedUrl)).toBeDefined();
    } finally {
      rmSync(fixtureA.temp, { recursive: true, force: true });
      rmSync(fixtureB.temp, { recursive: true, force: true });
    }
  });

  test("counts a chunk cached after the initial scan exactly once", async () => {
    const fixture = makeFixture();
    try {
      const build = finalizeWebPwa({
        root: fixture.root,
        siteDir: fixture.siteDir,
        gameId: "pocket-tuxemon",
        manifest: fixture.manifest,
      });
      const scope = "https://example.test/pocket-tuxemon/";
      const caches = new MemoryCacheStorage();
      const network = new RouteFetch();
      network.routes = releaseRoutes(fixture, build, scope);
      const worker = new ServiceWorkerHarness(readFileSync(build.serviceWorkerPath, "utf8"), scope, caches, network);
      await worker.install();

      const racedChunk = fixture.manifest.chunks.find((chunk) => chunk.id === "locale:en_US")!;
      const racedUrl = new URL(racedChunk.file, scope).href;
      const racedBody = network.routes.get(racedUrl)!;
      const content = await caches.open("pocket-rpgkit:pak-chunks:v1");
      const messages: any[] = [];
      let injected = false;
      await worker.message(
        { type: "OFFLINE_DOWNLOAD", language: "en" },
        { postMessage: (message: any) => {
          messages.push(message);
          if (!injected && message.type === "OFFLINE_PROGRESS" && message.completed === 1) {
            injected = true;
            void content.put(racedUrl, new Response(Buffer.from(racedBody)));
          }
        } },
      );

      const progress = messages.filter((message) => message.type === "OFFLINE_PROGRESS");
      const complete = messages.find((message) => message.type === "OFFLINE_COMPLETE");
      expect(injected).toBeTrue();
      expect(network.calls.filter((url) => url === racedUrl)).toHaveLength(0);
      expect(progress.at(-1)).toMatchObject({ completed: 5, total: 5 });
      expect(complete).toMatchObject({ completed: 5, total: 5 });
      expect(messages.some((message) => message.type === "OFFLINE_ERROR")).toBeFalse();
    } finally {
      rmSync(fixture.temp, { recursive: true, force: true });
    }
  });

  test("reports an error instead of completion when a verified chunk disappears", async () => {
    const fixture = makeFixture();
    try {
      const build = finalizeWebPwa({
        root: fixture.root,
        siteDir: fixture.siteDir,
        gameId: "pocket-tuxemon",
        manifest: fixture.manifest,
      });
      const scope = "https://example.test/pocket-tuxemon/";
      const caches = new MemoryCacheStorage();
      const network = new RouteFetch();
      network.routes = releaseRoutes(fixture, build, scope);
      const worker = new ServiceWorkerHarness(readFileSync(build.serviceWorkerPath, "utf8"), scope, caches, network);
      await worker.install();

      const disappearingChunk = fixture.manifest.chunks.find((chunk) => chunk.id === "locale:en_US")!;
      const disappearingUrl = new URL(disappearingChunk.file, scope).href;
      const content = await caches.open("pocket-rpgkit:pak-chunks:v1");
      await content.put(disappearingUrl, new Response(Buffer.from(network.routes.get(disappearingUrl)!)));
      const messages: any[] = [];
      let removed = false;
      await worker.message(
        { type: "OFFLINE_DOWNLOAD", language: "en" },
        { postMessage: (message: any) => {
          messages.push(message);
          if (!removed && message.type === "OFFLINE_PROGRESS" && message.completed === message.total) {
            removed = true;
            void content.delete(disappearingUrl);
          }
        } },
      );

      expect(removed).toBeTrue();
      expect(await content.match(disappearingUrl)).toBeUndefined();
      expect(messages.some((message) => message.type === "OFFLINE_COMPLETE")).toBeFalse();
      expect(messages.find((message) => message.type === "OFFLINE_ERROR")).toMatchObject({
        completed: 4,
        total: 5,
      });
    } finally {
      rmSync(fixture.temp, { recursive: true, force: true });
    }
  });

  test("tracks the in-flight language across selector changes and terminal messages", async () => {
    const client = await runPwaClient();
    client.posted.length = 0;
    await client.sandbox.__pocketPwa.download("de");
    expect(client.posted).toEqual([{ type: "OFFLINE_DOWNLOAD", language: "de" }]);
    client.serviceWorker.dispatch("message", {
      data: { type: "OFFLINE_PROGRESS", language: "de", completed: 8, total: 20, bytes: 1024, totalBytes: 4096 },
    });
    expect(client.sandbox.__pocketPwa.view()).toMatchObject({
      language: "de",
      activeLanguage: "de",
      resumeLanguage: "de",
      downloading: true,
    });

    client.elements["offline-language"]!.value = "zh";
    client.elements["offline-language"]!.dispatch("change");
    const switchStatus = client.elements["offline-status"]!.textContent;
    expect(switchStatus).toContain("German");
    expect(switchStatus).toContain("Chinese");
    expect(switchStatus).toContain("德语");
    expect(switchStatus).toContain("中文");
    expect(client.posted).toHaveLength(1);

    client.serviceWorker.dispatch("message", {
      data: { type: "OFFLINE_STATUS", language: "zh", completed: 1, total: 20, totalBytes: 4096, complete: false },
    });
    expect(client.elements["offline-status"]!.textContent).toBe(switchStatus);
    client.serviceWorker.dispatch("message", {
      data: { type: "OFFLINE_COMPLETE", language: "de", completed: 20, total: 20, totalBytes: 4096 },
    });
    expect(client.sandbox.__pocketPwa.view()).toMatchObject({
      language: "zh",
      activeLanguage: null,
      resumeLanguage: null,
      downloading: false,
    });
    expect(client.elements["offline-download"]!.textContent).toBe("Download or resume / 下载或继续");
    expect(client.elements["offline-download"]!.getAttribute("aria-pressed")).toBe("false");
    expect(client.elements["offline-status"]!.textContent).toContain("German is ready offline");
    expect(client.elements["offline-status"]!.textContent).toContain("德语已可离线游玩");

    client.elements["offline-download"]!.dispatch("click");
    await Promise.resolve();
    await Promise.resolve();
    expect(client.posted.at(-1)).toEqual({ type: "OFFLINE_DOWNLOAD", language: "zh" });
    client.serviceWorker.dispatch("message", {
      data: { type: "OFFLINE_PAUSED", language: "zh", completed: 2, total: 20 },
    });
    expect(client.sandbox.__pocketPwa.view().downloading).toBeFalse();

    await client.sandbox.__pocketPwa.download("de");
    client.elements["offline-language"]!.value = "zh";
    client.elements["offline-language"]!.dispatch("change");
    client.serviceWorker.dispatch("message", { data: { type: "OFFLINE_ERROR", language: "de" } });
    expect(client.sandbox.__pocketPwa.view()).toMatchObject({
      activeLanguage: null,
      resumeLanguage: "de",
      downloading: false,
    });
    client.window.dispatch("online");
    await Promise.resolve();
    await Promise.resolve();
    expect(client.posted.at(-1)).toEqual({ type: "OFFLINE_DOWNLOAD", language: "de" });
    expect(client.sandbox.__pocketPwa.view()).toMatchObject({ activeLanguage: "de", downloading: true });
  });

  test("bounds and backs off map-recovery polling", async () => {
    const client = await runPwaClient({ pak: false });
    client.runAllTimers();
    const scheduled = client.timers.filter((timer) => !timer.cancelled);
    expect(scheduled).toHaveLength(64);
    expect(scheduled.slice(0, 7).map((timer) => timer.delay)).toEqual([25, 50, 100, 200, 400, 800, 1000]);
    expect(scheduled.at(-1)?.delay).toBe(1000);
    expect(client.sandbox.__pocketPwa.view()).toMatchObject({
      mapPreparePolls: 64,
      mapPrepareRecoveryState: "unavailable",
      mapPrepareWrapped: false,
    });
    expect(client.elements["offline-status"]!.textContent).toBe("Offline map recovery unavailable / 离线地图恢复暂不可用");

    const cancelled = await runPwaClient({ pak: false });
    cancelled.window.dispatch("pagehide");
    cancelled.runAllTimers();
    expect(cancelled.sandbox.__pocketPwa.view().mapPrepareRecoveryState).toBe("cancelled");
    expect(cancelled.timers.filter((timer) => timer.ran)).toHaveLength(0);
  });
});

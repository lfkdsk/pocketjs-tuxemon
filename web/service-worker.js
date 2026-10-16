// Generated with one release descriptor by tools/web-pwa.ts. This source file
// remains readable so the cache policy can be audited without opening output.

const BUILD = __POCKET_TUXEMON_PWA_BUILD__;
const scopeUrl = new URL(self.registration.scope);
const scopePath = scopeUrl.pathname.endsWith("/") ? scopeUrl.pathname : `${scopeUrl.pathname}/`;
const SHELL_PREFIX = `pocket-tuxemon:shell:v1:${encodeURIComponent(scopePath)}:`;
const SHELL_CACHE = SHELL_PREFIX + BUILD.version;
const CONTENT_CACHE = "pocket-rpgkit:pak-chunks:v1";
const shellByUrl = new Map(BUILD.shell.map((asset) => [new URL(asset.url, scopeUrl).href, asset]));
const indexUrl = new URL("index.html", scopeUrl).href;
const manifestUrl = new URL(BUILD.contentManifest, scopeUrl).href;
const webManifestUrl = new URL("manifest.webmanifest", scopeUrl).href;
const DOWNLOAD_CONCURRENCY = 4;
let activeDownload = null;

const hex = (bytes) => Array.from(new Uint8Array(bytes), (byte) =>
  byte.toString(16).padStart(2, "0")).join("");

async function verifiedResponse(asset, response) {
  if (!response || !response.ok) throw new Error(`${asset.url || asset.file} returned ${response?.status || 0}`);
  const bytes = await response.clone().arrayBuffer();
  if (bytes.byteLength !== asset.bytes) {
    throw new Error(`${asset.url || asset.file} has ${bytes.byteLength} bytes, expected ${asset.bytes}`);
  }
  const actual = hex(await crypto.subtle.digest("SHA-256", bytes));
  if (actual !== asset.sha256) throw new Error(`${asset.url || asset.file} failed SHA-256 verification`);
  return response;
}

async function fetchVerified(asset, signal) {
  const url = new URL(asset.url || asset.file, scopeUrl);
  return verifiedResponse(asset, await fetch(url.href, {
    cache: "reload",
    credentials: "same-origin",
    signal,
  }));
}

async function installShell() {
  const cache = await caches.open(SHELL_CACHE);
  for (const asset of BUILD.shell) {
    const response = await fetchVerified(asset);
    if (asset.url === "index.html") {
      const html = await response.clone().text();
      if (!html.includes(`data-pwa-build="${BUILD.version}"`)) {
        throw new Error("Pocket Tuxemon PWA: shell page release marker mismatch");
      }
    }
    await cache.put(new URL(asset.url, scopeUrl).href, response);
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(installShell());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(SHELL_PREFIX) && name !== SHELL_CACHE) await caches.delete(name);
    }
  })());
});

function isGameNavigation(request, url) {
  return request.mode === "navigate" && (url.pathname === scopePath || url.pathname === `${scopePath}index.html`);
}

function isReplayRequest(url) {
  if (!url.pathname.startsWith(scopePath)) return false;
  const relative = url.pathname.slice(scopePath.length);
  return relative === "replay.html" || relative === "expedition-replay.html" ||
    relative.startsWith("replays/") || /^(?:battle|expedition)-replay\.(?:js|pak)$/.test(relative);
}

async function currentPage(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) {
      const asset = shellByUrl.get(indexUrl);
      const verified = asset ? await verifiedResponse(asset, response) : response;
      const html = await verified.clone().text();
      if (html.includes(`data-pwa-build="${BUILD.version}"`)) {
        await cache.put(indexUrl, verified.clone());
        return verified;
      }
      // A newer page must never execute under this release's stable URLs.
      void self.registration.update();
    }
  } catch {
    // The installed page below is the offline and transient-network fallback.
  }
  const cached = await cache.match(indexUrl);
  if (cached) return cached;
  return new Response("Pocket Tuxemon is not available offline yet.", {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

async function shellAsset(request, asset) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request.url);
  if (cached) return cached;
  const response = await fetchVerified(asset);
  await cache.put(request.url, response.clone());
  return response;
}

async function contentAsset(request) {
  const cache = await caches.open(CONTENT_CACHE);
  const cached = await cache.match(request.url);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (!response.ok) return response;
    const match = /-([0-9a-f]{64})\.pak\.gz$/.exec(new URL(request.url).pathname);
    if (!match) return response;
    const bytes = await response.clone().arrayBuffer();
    const actual = hex(await crypto.subtle.digest("SHA-256", bytes));
    if (actual !== match[1]) return new Response("content hash mismatch", { status: 502 });
    await cache.put(request.url, response.clone());
    return response;
  } catch {
    return new Response("offline content not downloaded", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "x-pocket-offline": "missing" },
    });
  }
}

async function networkFirstManifest(request) {
  const asset = shellByUrl.get(request.url);
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = asset
      ? await verifiedResponse(asset, await fetch(request))
      : await fetch(request);
    if (response.ok) await cache.put(request.url, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request.url);
    if (cached) return cached;
    throw new Error("Pocket Tuxemon content manifest is unavailable offline");
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== scopeUrl.origin || isReplayRequest(url)) return;
  if (isGameNavigation(request, url)) {
    event.respondWith(currentPage(request));
    return;
  }
  if (url.href === manifestUrl || url.href === webManifestUrl) {
    event.respondWith(networkFirstManifest(request));
    return;
  }
  const shell = shellByUrl.get(url.href);
  if (shell) {
    event.respondWith(shellAsset(request, shell));
    return;
  }
  if (url.pathname.startsWith(`${scopePath}chunks/`) && /-[0-9a-f]{64}\.pak\.gz$/.test(url.pathname)) {
    event.respondWith(contentAsset(request));
  }
});

function chunksForLanguage(manifest, language) {
  const tag = BUILD.languages[language];
  if (!tag) throw new Error(`unknown offline language ${language}`);
  return manifest.chunks.filter((chunk) => {
    if (chunk.id.startsWith("map:")) return chunk.id.startsWith(`map:${tag}:`);
    if (chunk.id.startsWith("locale:")) return chunk.id === `locale:${tag}`;
    return true;
  });
}

async function manifestFromShell() {
  const cache = await caches.open(SHELL_CACHE);
  const response = await cache.match(manifestUrl);
  if (!response) throw new Error("offline manifest is not installed");
  return response.json();
}

async function notify(source, message) {
  if (source && "postMessage" in source) source.postMessage({ ...message, build: BUILD.version });
}

async function cachedContentProgress(language) {
  const manifest = await manifestFromShell();
  const chunks = chunksForLanguage(manifest, language);
  const cache = await caches.open(CONTENT_CACHE);
  let completed = 1;
  let bytes = manifest.startup.bytes;
  for (const chunk of chunks) {
    if (await cache.match(new URL(chunk.file, manifestUrl).href)) {
      completed++;
      bytes += chunk.bytes;
    }
  }
  return {
    chunks,
    completed,
    bytes,
    total: chunks.length + 1,
    totalBytes: manifest.startup.bytes + chunks.reduce((sum, chunk) => sum + chunk.bytes, 0),
  };
}

async function downloadLanguage(language, source) {
  const controller = new AbortController();
  const token = { controller, language };
  activeDownload?.controller.abort();
  activeDownload = token;
  let progress = null;
  try {
    progress = await cachedContentProgress(language);
    const cache = await caches.open(CONTENT_CACHE);
    await notify(source, { type: "OFFLINE_PROGRESS", language, ...progress, chunks: undefined });
    let cursor = 0;
    const downloadNext = async () => {
      while (cursor < progress.chunks.length) {
        if (activeDownload !== token) throw new DOMException("download paused", "AbortError");
        const chunk = progress.chunks[cursor++];
        const url = new URL(chunk.file, manifestUrl).href;
        const cached = await cache.match(url);
        if (cached) {
          try {
            await verifiedResponse(chunk, cached);
            continue;
          } catch {
            await cache.delete(url);
            progress.completed--;
            progress.bytes -= chunk.bytes;
          }
        }
        const response = await fetchVerified({ ...chunk, url }, controller.signal);
        await cache.put(url, response);
        const stored = await cache.match(url);
        if (!stored) throw new Error(`browser did not retain ${chunk.file}`);
        progress.completed++;
        progress.bytes += chunk.bytes;
        await notify(source, { type: "OFFLINE_PROGRESS", language, ...progress, chunks: undefined });
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(DOWNLOAD_CONCURRENCY, progress.chunks.length) },
      () => downloadNext(),
    ));
    await notify(source, { type: "OFFLINE_COMPLETE", language, ...progress, chunks: undefined });
  } catch (error) {
    controller.abort();
    const paused = error?.name === "AbortError" || activeDownload !== token;
    await notify(source, {
      type: paused ? "OFFLINE_PAUSED" : "OFFLINE_ERROR",
      language,
      ...(progress ?? {}),
      chunks: undefined,
      error: paused ? undefined : String(error?.message || error),
    });
  } finally {
    if (activeDownload === token) activeDownload = null;
  }
}

self.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || typeof message !== "object") return;
  if (message.type === "ACTIVATE_UPDATE") {
    void self.skipWaiting();
    return;
  }
  if (message.type === "OFFLINE_PAUSE") {
    activeDownload?.controller.abort();
    return;
  }
  if (message.type === "OFFLINE_STATUS") {
    event.waitUntil(cachedContentProgress(message.language).then((progress) =>
      notify(event.source, {
        type: "OFFLINE_STATUS",
        language: message.language,
        ...progress,
        chunks: undefined,
        complete: progress.completed === progress.total,
      })).catch((error) => notify(event.source, {
        type: "OFFLINE_ERROR",
        language: message.language,
        error: String(error?.message || error),
      })));
    return;
  }
  if (message.type === "OFFLINE_DOWNLOAD") {
    event.waitUntil(downloadLanguage(message.language, event.source));
  }
});

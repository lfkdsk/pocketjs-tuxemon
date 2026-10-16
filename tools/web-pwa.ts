// Finalize the ordinary Web player as an atomic, path-scoped offline PWA.
// Replay pages keep the kit's original stable assets and never register this
// worker; only the game page points at the content-hashed shell copies.

import { createHash } from "node:crypto";
import {
  copyFileSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { WebPakManifest } from "./web-chunks.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const PWA_MARKER_START = "<!-- pocket-tuxemon-pwa:start -->";
const PWA_MARKER_END = "<!-- pocket-tuxemon-pwa:end -->";
const SERVICE_WORKER_TOKEN = "__POCKET_TUXEMON_PWA_BUILD__";
const VERSION_PLACEHOLDER = "0".repeat(64);
const PWA_FORMAT = "pocket-tuxemon-pwa/v1";

export const PWA_LANGUAGES = [
  { code: "en", tag: "en_US", label: "English", labelZh: "英语" },
  { code: "zh", tag: "zh_CN", label: "Chinese", labelZh: "中文" },
  { code: "de", tag: "de_DE", label: "German", labelZh: "德语" },
  { code: "fr", tag: "fr_FR", label: "French", labelZh: "法语" },
  { code: "es", tag: "es_ES", label: "Spanish", labelZh: "西班牙语" },
  { code: "it", tag: "it_IT", label: "Italian", labelZh: "意大利语" },
  { code: "pt-br", tag: "pt_BR", label: "Portuguese (Brazil)", labelZh: "巴西葡萄牙语" },
] as const;

export interface OfflinePackageSummary {
  code: string;
  tag: string;
  label: string;
  labelZh: string;
  chunks: number;
  bytes: number;
}

export interface PwaShellAsset {
  url: string;
  bytes: number;
  sha256: string;
}

export interface WebPwaBuildResult {
  version: string;
  serviceWorkerPath: string;
  manifestPath: string;
  receiptPath: string;
  packages: Record<string, OfflinePackageSummary>;
  shell: PwaShellAsset[];
}

export interface FinalizeWebPwaOptions {
  root: string;
  siteDir: string;
  gameId: string;
  manifest: WebPakManifest;
}

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

export function pwaReleaseVersion(seed: {
  page: string;
  worker: string;
  assets: readonly PwaShellAsset[];
  installAssets: readonly PwaShellAsset[];
  languages: Readonly<Record<string, string>>;
}): string {
  return sha256(JSON.stringify({ format: PWA_FORMAT, ...seed }));
}

function assertAsset(asset: { file: string; bytes: number; sha256: string }): void {
  if (!SHA256.test(asset.sha256) || !asset.file.includes(asset.sha256) || asset.bytes < 1) {
    throw new Error(`web PWA: invalid content-addressed asset ${asset.file}`);
  }
}

export function offlinePackages(manifest: WebPakManifest): Record<string, OfflinePackageSummary> {
  assertAsset(manifest.startup);
  const result: Record<string, OfflinePackageSummary> = {};
  for (const language of PWA_LANGUAGES) {
    const selected = manifest.chunks.filter((chunk) => {
      assertAsset(chunk);
      if (chunk.id.startsWith("map:")) return chunk.id.startsWith(`map:${language.tag}:`);
      if (chunk.id.startsWith("locale:")) return chunk.id === `locale:${language.tag}`;
      return true;
    });
    result[language.code] = {
      ...language,
      chunks: selected.length + 1,
      bytes: manifest.startup.bytes + selected.reduce((sum, chunk) => sum + chunk.bytes, 0),
    };
  }
  return result;
}

export function renderGameManifest(): string {
  return `${JSON.stringify({
    id: "./",
    name: "Pocket Tuxemon",
    short_name: "Tuxemon",
    description: "Tuxemon's world in Pocket RPG Kit, playable online or offline.",
    start_url: "./",
    scope: "./",
    display: "standalone",
    orientation: "landscape",
    background_color: "#0d0f14",
    theme_color: "#0d0f14",
    icons: [
      { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  }, null, 2)}\n`;
}

function contentName(path: string, bytes: Uint8Array): string {
  const extension = extname(path);
  const stem = basename(path, extension);
  return `${stem}.${sha256(bytes)}${extension}`;
}

function writeContentCopy(
  sourcePath: string,
  outputDir = dirname(sourcePath),
  bytes = new Uint8Array(readFileSync(sourcePath)),
): { name: string; asset: PwaShellAsset } {
  const name = contentName(sourcePath, bytes);
  writeFileSync(join(outputDir, name), bytes);
  return {
    name,
    asset: { url: name, bytes: bytes.byteLength, sha256: sha256(bytes) },
  };
}

function replaceExactly(html: string, pattern: RegExp, replacement: string, label: string): string {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matches = [...html.matchAll(new RegExp(pattern.source, flags))];
  if (matches.length !== 1) throw new Error(`web PWA: expected one ${label}, found ${matches.length}`);
  return html.replace(pattern, replacement);
}

function pwaMarkup(version: string, clientName: string): string {
  const config = JSON.stringify({ build: version }).replace(/</g, "\\u003c");
  return `${PWA_MARKER_START}
<script type="application/json" id="pocket-pwa">${config}</script>
<script id="pocket-pwa-loader">(function(){
  var loaded=false;
  function load(){if(loaded)return;loaded=true;import("./${clientName}");}
  function waitForFirstMap(){
    var player=globalThis.__pocketPlayer;
    var title=globalThis.__pocketTitleBattle;
    if(player&&player.state==="running"&&globalThis.__rpgSessionState&&(!title||title.state().screen==="closed")){
      setTimeout(load,1500);
    }else setTimeout(waitForFirstMap,50);
  }
  if("serviceWorker" in navigator&&navigator.serviceWorker.controller)load();
  else addEventListener("load",waitForFirstMap,{once:true});
})();</script>
${PWA_MARKER_END}`;
}

export function finalizeWebPwa(options: FinalizeWebPwaOptions): WebPwaBuildResult {
  const gameDir = join(options.siteDir, options.gameId);
  const gameBundlePath = join(gameDir, `${options.gameId}.js`);
  const playerPath = join(options.siteDir, "player.js");
  const wasmPath = join(options.siteDir, "pocketjs.wasm");
  const cssPath = join(options.siteDir, "site.css");
  const audioPath = join(gameDir, "audio-worklet.js");
  const contentManifestPath = join(gameDir, `${options.gameId}.pak-manifest.json`);
  const clientPath = join(options.root, "web", "pwa-client.js");
  const workerTemplatePath = join(options.root, "web", "service-worker.js");

  const audio = writeContentCopy(audioPath, gameDir);
  const playerOriginal = readFileSync(playerPath, "utf8");
  const audioReferences = playerOriginal.match(/audio-worklet(?:\.[0-9a-f]{64})?\.js/g) ?? [];
  if (audioReferences.length < 1) throw new Error("web PWA: player has no audio-worklet reference");
  const playerBytes = new TextEncoder().encode(
    playerOriginal.replace(/audio-worklet(?:\.[0-9a-f]{64})?\.js/g, audio.name),
  );
  // Keep every ordinary-game shell response beneath the game scope. A
  // path-scoped worker cannot intercept the shared site-root player, Wasm or
  // stylesheet on an offline reload; replay pages continue using those
  // original root files and remain outside this PWA.
  const player = writeContentCopy(playerPath, gameDir, playerBytes);
  const game = writeContentCopy(gameBundlePath, gameDir);
  const wasm = writeContentCopy(wasmPath, gameDir);
  const css = writeContentCopy(cssPath, gameDir);
  const contentManifest = writeContentCopy(contentManifestPath, gameDir);
  const client = writeContentCopy(clientPath, gameDir);

  const packages = offlinePackages(options.manifest);
  const gameManifest = renderGameManifest();
  const gameManifestPath = join(gameDir, "manifest.webmanifest");
  writeFileSync(gameManifestPath, gameManifest);
  copyFileSync(join(options.siteDir, "icon-192.png"), join(gameDir, "icon-192.png"));
  copyFileSync(join(options.siteDir, "icon-512.png"), join(gameDir, "icon-512.png"));
  copyFileSync(join(options.siteDir, "apple-touch-icon.png"), join(gameDir, "apple-touch-icon.png"));

  const installAssetNames = [
    "manifest.webmanifest",
    "icon-192.png",
    "icon-512.png",
    "apple-touch-icon.png",
  ] as const;
  const installAssets = installAssetNames.map((name) => {
    const bytes = new Uint8Array(readFileSync(join(gameDir, name)));
    return { url: name, bytes: bytes.byteLength, sha256: sha256(bytes) };
  });
  const workerTemplate = readFileSync(workerTemplatePath, "utf8");
  const tokens = workerTemplate.split(SERVICE_WORKER_TOKEN).length - 1;
  if (tokens !== 1) throw new Error(`web PWA: service worker template has ${tokens} build tokens`);

  let html = readFileSync(join(gameDir, "index.html"), "utf8");
  html = html.replace(new RegExp(`${PWA_MARKER_START}[\\s\\S]*?${PWA_MARKER_END}\\n?`, "g"), "");
  html = html.replace(/\sdata-pwa-build="[0-9a-f]{64}"/, "");
  html = replaceExactly(
    html,
    /<html([^>]*)>/,
    `<html data-pwa-build="${VERSION_PLACEHOLDER}"$1>`,
    "document element",
  );
  const configPattern = /(<script type="application\/json" id="pocket-game">)(.*?)(<\/script>)/s;
  const configMatch = html.match(configPattern);
  if (!configMatch) throw new Error("web PWA: player page has no pocket-game config");
  const playerConfig = JSON.parse(configMatch[2]!) as Record<string, unknown>;
  playerConfig.bundle = game.name;
  playerConfig.wasm = wasm.name;
  playerConfig.pakManifest = contentManifest.name;
  playerConfig.pwaBuild = VERSION_PLACEHOLDER;
  html = html.replace(configPattern, `$1${JSON.stringify(playerConfig).replace(/</g, "\\u003c")}$3`);
  html = replaceExactly(html, /href="(?:\.\.\/)?site(?:\.[0-9a-f]{64})?\.css"/, `href="${css.name}"`, "site stylesheet");
  html = replaceExactly(html, /src="(?:\.\.\/)?player(?:\.[0-9a-f]{64})?\.js"/, `src="${player.name}"`, "player script");
  html = replaceExactly(html, /href="(?:\.\.\/)?manifest\.webmanifest"/, 'href="manifest.webmanifest"', "manifest link");
  html = replaceExactly(html, /href="(?:\.\.\/)?apple-touch-icon\.png"/, 'href="apple-touch-icon.png"', "Apple icon link");
  html = replaceExactly(
    html,
    /<section class="info">/,
    `${pwaMarkup(VERSION_PLACEHOLDER, client.name)}\n<section class="info">`,
    "player info section",
  );
  const versionSeed = {
    page: sha256(html),
    worker: sha256(workerTemplate),
    assets: [player.asset, game.asset, wasm.asset, css.asset, audio.asset, contentManifest.asset, client.asset],
    installAssets,
    languages: Object.fromEntries(PWA_LANGUAGES.map(({ code, tag }) => [code, tag])),
  };
  const version = pwaReleaseVersion(versionSeed);
  const placeholders = html.split(VERSION_PLACEHOLDER).length - 1;
  if (placeholders !== 3) {
    throw new Error(`web PWA: expected three page version placeholders, found ${placeholders}`);
  }
  html = html.replaceAll(VERSION_PLACEHOLDER, version);
  writeFileSync(join(gameDir, "index.html"), html);

  const shell: PwaShellAsset[] = [
    { ...game.asset, url: game.name },
    { ...audio.asset, url: audio.name },
    { ...contentManifest.asset, url: contentManifest.name },
    { ...client.asset, url: client.name },
    { ...player.asset, url: player.name },
    { ...wasm.asset, url: wasm.name },
    { ...css.asset, url: css.name },
  ];
  shell.push(...installAssets);
  const htmlBytes = new Uint8Array(readFileSync(join(gameDir, "index.html")));
  shell.unshift({ url: "index.html", bytes: htmlBytes.byteLength, sha256: sha256(htmlBytes) });
  const startup = options.manifest.startup;
  shell.push({ url: startup.file, bytes: startup.bytes, sha256: startup.sha256 });

  const workerConfig = {
    version,
    shell,
    contentManifest: contentManifest.name,
    languages: versionSeed.languages,
  };
  const serviceWorkerPath = join(gameDir, "service-worker.js");
  writeFileSync(serviceWorkerPath, workerTemplate.replace(SERVICE_WORKER_TOKEN, JSON.stringify(workerConfig)));

  const receipt = {
    format: PWA_FORMAT,
    version,
    scope: "./",
    startUrl: "./",
    display: "standalone",
    shell,
    packages,
    cachePolicy: {
      shell: "versioned-precache-cache-first",
      page: "network-first-same-version-offline-fallback",
      manifest: "network-first-offline-fallback",
      chunks: "content-addressed-cache-first",
      replayAndNetwork: "bypass",
    },
  };
  const receiptPath = join(gameDir, "pwa-build.json");
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  return {
    version,
    serviceWorkerPath,
    manifestPath: gameManifestPath,
    receiptPath,
    packages,
    shell,
  };
}

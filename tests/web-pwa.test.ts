import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
  writeFileSync(join(gameDir, "pocket-tuxemon.pak-manifest.json"), '{"fixture":true}\n');
  writeFileSync(join(gameDir, "replay.html"), "replay stays byte-identical");
  writeFileSync(join(gameDir, "index.html"), `<!doctype html>
<html lang="en" data-page-lang="pending"><head>
<link rel="stylesheet" href="../site.css">
<link rel="manifest" href="../manifest.webmanifest">
<link rel="apple-touch-icon" href="../apple-touch-icon.png">
</head><body><section class="info">Info</section>
<script type="application/json" id="pocket-game">{"bundle":"pocket-tuxemon.js","wasm":"../pocketjs.wasm","pakManifest":"pocket-tuxemon.pak-manifest.json"}</script>
<script type="module" src="../player.js"></script></body></html>`);
  return { temp, root, siteDir, gameDir, manifest: fixtureManifest() };
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
      expect(firstWorker).toContain('message.type === "ACTIVATE_UPDATE"');
      expect(firstWorker).toContain("url.origin !== scopeUrl.origin || isReplayRequest(url)");
      expect(firstWorker).toContain("encodeURIComponent(scopePath)");
      expect(firstWorker).toContain("await verifiedResponse(asset, response)");
      expect(firstWorker).toContain("return await verifiedResponse(asset, cached)");
      expect(firstWorker).toContain("await content.delete(url.href)");
      expect(firstWorker).not.toContain("OFFLINE_CHUNK_MISSING");
      expect(() => new Function(firstWorker)).not.toThrow();

      const clientSource = readFileSync(join(fixture.gameDir, client.url), "utf8");
      expect(clientSource).toContain("__pocketPwaMapPrepare");
      expect(clientSource).toContain("installMapPrepareRecovery");

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

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { tuxLinkWebEntrySource } from "../tools/tux-link-web-entry.ts";

const ROOT = resolve(import.meta.dir, "..");

describe("Tux Link build isolation", () => {
  test("portable and Web manifests have distinct entry and capability contracts", () => {
    const portable = JSON.parse(readFileSync(resolve(ROOT, "pocket.json"), "utf8"));
    const web = JSON.parse(readFileSync(resolve(ROOT, "pocket.web.json"), "utf8"));

    expect(portable.app.entry).toBe("main.tsx");
    expect(portable.engine.capabilities.requires).toEqual([
      "text.glyphs.baked",
      "input.buttons",
    ]);
    expect(JSON.stringify(portable)).not.toContain("net.http");
    expect(JSON.stringify(portable)).not.toContain("net.socket");
    expect(JSON.stringify(portable)).not.toContain("Link Battle");
    expect(JSON.stringify(portable)).not.toContain("auth");

    expect(web.app.entry).toBe("web-main.generated.tsx");
    expect(web.engine.capabilities.requires).toContain("net.http");
    expect(web.engine.capabilities.requires).toContain("net.socket");

    const site = readFileSync(resolve(ROOT, "web.json"), "utf8");
    expect(site).not.toContain("TUX_GITHUB");
    expect(JSON.parse(site).games["pocket-tuxemon"].auth).toBeUndefined();
  });

  test("generated Web entry changes only the composition import and build prelude", () => {
    const portable = readFileSync(resolve(ROOT, "main.tsx"), "utf8");
    const config = {
      httpBase: "https://battle.example/prefix/",
      wsBase: "wss://battle.example/prefix/",
      trustedReplayBase: "https://battle.example/prefix/tux/v1/replays/",
    };
    const generated = tuxLinkWebEntrySource(portable, config);
    const body = generated.slice(generated.indexOf("\n\n") + 2);

    expect(body).toBe(portable.replace(
      'from "./ui/title-battle.tsx";',
      'from "./ui/tux-link/title-battle-web.tsx";',
    ));
    expect(generated).toContain(JSON.stringify(config));
    expect(generated).not.toContain('from "./ui/title-battle.tsx";');
  });

  test("missing service configuration is embedded as null, never a default address", () => {
    const portable = readFileSync(resolve(ROOT, "main.tsx"), "utf8");
    const generated = tuxLinkWebEntrySource(portable, null);
    expect(generated).toContain("globalThis.__pocketTuxLinkBuildConfig = null;");
    expect(generated).not.toMatch(/https?:\/\//);
  });

  test("replay artifacts are built only after ordinary bundle bytes are frozen and checked", () => {
    const source = readFileSync(resolve(ROOT, "tools/web.ts"), "utf8");
    const snapshot = source.indexOf("const ordinaryBundleBytes");
    const replayBuild = source.indexOf('join(root, "battle-replay.tsx")');
    const unchangedCheck = source.indexOf("ordinaryBundleBytes.equals");
    expect(snapshot).toBeGreaterThan(-1);
    expect(replayBuild).toBeGreaterThan(snapshot);
    expect(unchangedCheck).toBeGreaterThan(replayBuild);
    expect(source).toContain('join(gameDir, "replays", currentReplayRelease.artifactId)');
    expect(source).toContain("tuxLinkReplayDispatcherHtml");
    expect(source).toContain('replayConfig.wasm = "../../../pocketjs.wasm"');
    expect(source).toContain(".replaceAll('src=\"../', 'src=\"../../../')");

    const replayEntry = readFileSync(resolve(ROOT, "battle-replay.tsx"), "utf8");
    expect(replayEntry).toContain("loadArenaReplayDocument");
    expect(replayEntry).toContain("SERVER_ENGINE_REVISION");
    expect(replayEntry).toContain("SERVER_DATA_DIGEST");
    expect(replayEntry).toContain("arena-replay-authoritative-result");
  });
});

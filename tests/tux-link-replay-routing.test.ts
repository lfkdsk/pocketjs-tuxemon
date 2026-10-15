import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  SERVER_DATA_DIGEST,
  SERVER_ENGINE_REVISION,
} from "../battle/server-runtime.ts";
import {
  parseReplayReleaseManifest,
  replayArtifactPageUrl,
  requireReplayRelease,
  selectReplayRelease,
  tuxLinkReplayDispatcherHtml,
  type ReplayRelease,
} from "../tools/tux-link-replay-routing.ts";

const ROOT = resolve(import.meta.dir, "..");
const releases = parseReplayReleaseManifest(JSON.parse(
  readFileSync(resolve(ROOT, "replay-releases.json"), "utf8"),
));
const current = requireReplayRelease(releases, {
  engineRevision: SERVER_ENGINE_REVISION,
  dataDigest: SERVER_DATA_DIGEST,
});

describe("immutable Tux Link replay routing", () => {
  test("pins the current exact identity to one safe checked-in artifact id", () => {
    expect(current).toEqual({
      engineRevision: SERVER_ENGINE_REVISION,
      dataDigest: SERVER_DATA_DIGEST,
      artifactId: `arena-engine-v1-${SERVER_DATA_DIGEST}`,
    });
    expect(current.artifactId).toMatch(/^[a-z0-9][a-z0-9._-]+$/);
    expect(() => parseReplayReleaseManifest({
      v: 1,
      releases: [{ ...current, artifactId: "../../latest" }],
    })).toThrow("manifest is invalid");
    expect(() => parseReplayReleaseManifest({
      v: 1,
      releases: [current, { ...current }],
    })).toThrow("duplicate");
  });

  test("keeps raw tapes on current while exact envelope identities use only the allowlist", () => {
    expect(selectReplayRelease({ v: 1, seed: "raw" }, releases, current)).toEqual({
      ok: true,
      release: current,
      raw: true,
    });
    expect(selectReplayRelease({
      kind: "tux-link-replay",
      v: 1,
      engineRevision: current.engineRevision,
      dataDigest: current.dataDigest,
    }, releases, current)).toEqual({ ok: true, release: current, raw: false });

    const historical: ReplayRelease = {
      engineRevision: "pocket-tuxemon/arena-engine/v0",
      dataDigest: "1".repeat(64),
      artifactId: `arena-engine-v0-${"1".repeat(64)}`,
    };
    expect(selectReplayRelease({
      kind: "tux-link-replay",
      v: 1,
      engineRevision: historical.engineRevision,
      dataDigest: historical.dataDigest,
    }, [...releases, historical], current)).toEqual({ ok: true, release: historical, raw: false });
  });

  test("fails closed for unknown identity and never derives a path from envelope fields", () => {
    const injected = {
      kind: "tux-link-replay",
      v: 1,
      engineRevision: "../../attacker",
      dataDigest: "f".repeat(64),
    };
    expect(selectReplayRelease(injected, releases, current)).toEqual({
      ok: false,
      reason: "player-unavailable",
    });
    expect(selectReplayRelease({ ...injected, kind: "future-replay" }, releases, current)).toEqual({
      ok: false,
      reason: "invalid-document",
    });

    const routed = new URL(replayArtifactPageUrl(
      "https://game.example/pocket-tuxemon/replay.html",
      "?battleReplay=https%3A%2F%2Fbattle.example%2Freplay&battleReplayExternal=1",
      current,
    ));
    expect(routed.pathname).toBe(`/pocket-tuxemon/replays/${current.artifactId}/replay.html`);
    expect(routed.searchParams.get("battleReplay")).toBe("https://battle.example/replay");
    expect(routed.pathname).not.toContain("attacker");
  });

  test("emits a bounded bilingual flat dispatcher with only manifest artifacts", () => {
    const html = tuxLinkReplayDispatcherHtml(releases, current, 4 * 1024 * 1024);
    expect(html).toContain("Battle replay / 对战回放");
    expect(html).toContain("No immutable player is available");
    expect(html).toContain("此回放版本没有可用的固定播放器");
    expect(html).toContain(current.artifactId);
    expect(html).toContain("credentials: external ? \"omit\" : \"same-origin\"");
    expect(html).toContain("length > cfg.maxBytes");
    expect(html).toContain('new URL("replays/" + release.artifactId');
    expect(html).not.toContain("value.engineRevision + \"/replay.html\"");
    const runtime = html.match(/<script>\n([\s\S]*?)\n  <\/script>/)?.[1];
    expect(runtime).toBeDefined();
    expect(() => new Function(runtime!)).not.toThrow();
  });
});

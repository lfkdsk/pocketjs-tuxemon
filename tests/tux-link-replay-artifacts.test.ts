import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  REPLAY_RELEASE_ARTIFACT_NAMES,
  lockReplayReleaseArtifacts,
  materializeHistoricalReplayReleases,
} from "../tools/tux-link-replay-artifacts.ts";
import {
  parseReplayReleaseManifest,
  requireReplayRelease,
  selectReplayRelease,
  tuxLinkReplayDispatcherHtml,
  type ReplayRelease,
  type ReplayReleaseArtifacts,
} from "../tools/tux-link-replay-routing.ts";

const ROOT = resolve(import.meta.dir, "..");
const SCRATCH = join(ROOT, "dist");
const OLD_DIGEST = "1".repeat(64);
const CURRENT_DIGEST = "2".repeat(64);
const OLD_ID = `arena-engine-v0-${OLD_DIGEST}`;
const CURRENT_ID = `arena-engine-v1-${CURRENT_DIGEST}`;
const VALUES = {
  "replay.html": Buffer.from("<!doctype html><title>old replay</title>\n"),
  "battle-replay.js": Buffer.from("export const revision = 'old';\n"),
  "battle-replay.pak": Buffer.from([0x50, 0x41, 0x4b, 0x00, 0x01]),
  "audio-worklet.js": Buffer.from("registerProcessor?.('old', class {});\n"),
} as const;

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function artifactLocks(): ReplayReleaseArtifacts {
  return Object.fromEntries(REPLAY_RELEASE_ARTIFACT_NAMES.map((name) => [name, {
    url: `https://releases.example/replay-v0/${name}`,
    bytes: VALUES[name].byteLength,
    sha256: sha256(VALUES[name]),
  }])) as ReplayReleaseArtifacts;
}

function manifest(oldArtifacts: ReplayReleaseArtifacts | null = artifactLocks()): unknown {
  return {
    v: 1,
    releases: [
      {
        engineRevision: "pocket-tuxemon/arena-engine/v0",
        dataDigest: OLD_DIGEST,
        artifactId: OLD_ID,
        ...(oldArtifacts ? { artifacts: oldArtifacts } : {}),
      },
      {
        engineRevision: "pocket-tuxemon/arena-engine/v1",
        dataDigest: CURRENT_DIGEST,
        artifactId: CURRENT_ID,
      },
    ],
  };
}

function response(value: Uint8Array, finalUrl: string): Response {
  const body = new Response(Uint8Array.from(value).buffer).body;
  return {
    ok: true,
    status: 200,
    url: finalUrl,
    headers: new Headers({ "content-length": String(value.byteLength) }),
    body,
  } as Response;
}

describe("immutable historical Tux Link replay artifacts", () => {
  test("materializes a locked old player while the new identity remains locally built", async () => {
    const outDir = mkdtempSync(join(SCRATCH, "tux-link-history-"));
    cleanup.push(outDir);
    const releases = parseReplayReleaseManifest(manifest());
    const current = requireReplayRelease(releases, {
      engineRevision: "pocket-tuxemon/arena-engine/v1",
      dataDigest: CURRENT_DIGEST,
    });
    const fetched: string[] = [];
    await materializeHistoricalReplayReleases({
      releases,
      current,
      outDir,
      fetcher: async (url, init) => {
        expect(init.credentials).toBe("omit");
        expect(init.redirect).toBe("follow");
        fetched.push(url);
        const name = url.slice(url.lastIndexOf("/") + 1) as keyof typeof VALUES;
        return response(VALUES[name], `https://objects.example/immutable/${name}`);
      },
    });

    expect(fetched).toHaveLength(REPLAY_RELEASE_ARTIFACT_NAMES.length);
    for (const name of REPLAY_RELEASE_ARTIFACT_NAMES) {
      expect(readFileSync(join(outDir, OLD_ID, name))).toEqual(VALUES[name]);
    }
    expect(readdirSync(outDir)).toEqual([OLD_ID]);

    // A second build verifies and reuses exact local bytes without network.
    await materializeHistoricalReplayReleases({
      releases,
      current,
      outDir,
      fetcher: async () => { throw new Error("network must not be used"); },
    });

    const selected = selectReplayRelease({
      kind: "tux-link-replay",
      v: 1,
      engineRevision: "pocket-tuxemon/arena-engine/v0",
      dataDigest: OLD_DIGEST,
    }, releases, current);
    expect(selected).toMatchObject({ ok: true, release: { artifactId: OLD_ID }, raw: false });
  });

  test("fails closed on missing locks, tampered cache bytes, and corrupt downloads", async () => {
    const missingDir = mkdtempSync(join(SCRATCH, "tux-link-missing-"));
    cleanup.push(missingDir);
    const missing = parseReplayReleaseManifest(manifest(null));
    const missingCurrent = missing[1]!;
    await expect(materializeHistoricalReplayReleases({
      releases: missing,
      current: missingCurrent,
      outDir: missingDir,
      fetcher: async () => { throw new Error("unreachable"); },
    })).rejects.toThrow("has no published immutable artifact lock");

    const tamperedDir = mkdtempSync(join(SCRATCH, "tux-link-tampered-"));
    cleanup.push(tamperedDir);
    const releases = parseReplayReleaseManifest(manifest());
    const current = releases[1]!;
    await materializeHistoricalReplayReleases({
      releases,
      current,
      outDir: tamperedDir,
      fetcher: async (url) => {
        const name = url.slice(url.lastIndexOf("/") + 1) as keyof typeof VALUES;
        return response(VALUES[name], `https://objects.example/immutable/${name}`);
      },
    });
    writeFileSync(join(tamperedDir, OLD_ID, "battle-replay.js"), "tampered");
    let retryFetches = 0;
    await expect(materializeHistoricalReplayReleases({
      releases,
      current,
      outDir: tamperedDir,
      fetcher: async () => {
        retryFetches++;
        throw new Error("must not overwrite a corrupt cache");
      },
    })).rejects.toThrow("does not match its immutable lock");
    expect(retryFetches).toBe(0);

    const corruptDir = mkdtempSync(join(SCRATCH, "tux-link-corrupt-"));
    cleanup.push(corruptDir);
    await expect(materializeHistoricalReplayReleases({
      releases,
      current,
      outDir: corruptDir,
      fetcher: async (url) => {
        const name = url.slice(url.lastIndexOf("/") + 1) as keyof typeof VALUES;
        const wrong = Buffer.alloc(VALUES[name].byteLength, 0x78);
        return response(wrong, `https://objects.example/immutable/${name}`);
      },
    })).rejects.toThrow("body does not match its immutable lock");
    const oldDir = join(corruptDir, OLD_ID);
    expect(readdirSync(oldDir).some((name) => name.includes(".partial-"))).toBe(false);
    expect(readdirSync(oldDir)).toEqual([]);
  });

  test("strictly validates HTTPS asset locks and never embeds them in the dispatcher route", () => {
    const releases = parseReplayReleaseManifest(manifest());
    const html = tuxLinkReplayDispatcherHtml(releases, releases[1]!, 4 * 1024 * 1024);
    expect(html).not.toContain("releases.example");
    expect(html).not.toContain(releases[0]!.artifacts!["replay.html"].sha256);
    const insecure = artifactLocks();
    insecure["replay.html"].url = "http://releases.example/replay-v0/replay.html";
    expect(() => parseReplayReleaseManifest(manifest(insecure))).toThrow("manifest is invalid");

    const oversized = artifactLocks();
    oversized["battle-replay.pak"].bytes = 256 * 1024 * 1024 + 1;
    expect(() => parseReplayReleaseManifest(manifest(oversized))).toThrow("manifest is invalid");

    const extra = artifactLocks() as ReplayReleaseArtifacts & { unexpected?: ReplayRelease["artifacts"] };
    extra.unexpected = artifactLocks();
    expect(() => parseReplayReleaseManifest(manifest(extra))).toThrow("manifest is invalid");
  });

  test("creates deterministic size and SHA-256 locks for uploaded release assets", async () => {
    const directory = mkdtempSync(join(SCRATCH, "tux-link-lock-"));
    cleanup.push(directory);
    for (const name of REPLAY_RELEASE_ARTIFACT_NAMES) writeFileSync(join(directory, name), VALUES[name]);
    const locked = await lockReplayReleaseArtifacts(
      directory,
      "https://github.com/example/project/releases/download/replay-v0/",
    );
    for (const name of REPLAY_RELEASE_ARTIFACT_NAMES) {
      expect(locked[name]).toEqual({
        url: `https://github.com/example/project/releases/download/replay-v0/${name}`,
        bytes: VALUES[name].byteLength,
        sha256: sha256(VALUES[name]),
      });
    }
  });
});

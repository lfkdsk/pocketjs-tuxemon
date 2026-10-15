import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { open, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  ReplayRelease,
  ReplayReleaseArtifact,
  ReplayReleaseArtifactName,
} from "./tux-link-replay-routing.ts";

export const REPLAY_RELEASE_ARTIFACT_NAMES = [
  "replay.html",
  "battle-replay.js",
  "battle-replay.pak",
  "audio-worklet.js",
] as const satisfies readonly ReplayReleaseArtifactName[];

export const REPLAY_RELEASE_ARTIFACT_MAX_BYTES: Readonly<Record<ReplayReleaseArtifactName, number>> = {
  "replay.html": 1 * 1024 * 1024,
  "battle-replay.js": 16 * 1024 * 1024,
  "battle-replay.pak": 256 * 1024 * 1024,
  "audio-worklet.js": 1 * 1024 * 1024,
};

export type ReplayArtifactFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

async function sha256File(path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const value = chunk as Buffer;
    bytes += value.byteLength;
    hash.update(value);
  }
  return { bytes, sha256: hash.digest("hex") };
}

function finalHttpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("historical replay artifact returned no absolute final URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("historical replay artifact final URL is not trusted HTTPS");
  }
  return url;
}

async function verifyExisting(path: string, artifact: ReplayReleaseArtifact): Promise<boolean> {
  if (!existsSync(path)) return false;
  const actual = await sha256File(path);
  if (actual.bytes !== artifact.bytes || actual.sha256 !== artifact.sha256) {
    throw new Error(`historical replay artifact at ${path} does not match its immutable lock`);
  }
  return true;
}

let partialSequence = 0;

async function downloadArtifact(
  target: string,
  artifact: ReplayReleaseArtifact,
  fetcher: ReplayArtifactFetch,
): Promise<void> {
  if (await verifyExisting(target, artifact)) return;
  const response = await fetcher(artifact.url, {
    credentials: "omit",
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`historical replay artifact fetch failed with HTTP ${response.status}`);
  }
  finalHttpsUrl(response.url);
  if (!response.body) throw new Error("historical replay artifact response has no body");
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== artifact.bytes)) {
    throw new Error("historical replay artifact content-length does not match its immutable lock");
  }

  mkdirSync(dirname(target), { recursive: true });
  const partial = `${target}.partial-${process.pid}-${++partialSequence}`;
  const file = await open(partial, "wx");
  const hash = createHash("sha256");
  const reader = response.body.getReader();
  let bytes = 0;
  let committed = false;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!part.value) continue;
      bytes += part.value.byteLength;
      if (bytes > artifact.bytes) {
        await reader.cancel();
        throw new Error("historical replay artifact exceeds its immutable byte lock");
      }
      hash.update(part.value);
      let offset = 0;
      while (offset < part.value.byteLength) {
        const written = await file.write(
          part.value,
          offset,
          part.value.byteLength - offset,
          null,
        );
        if (written.bytesWritten <= 0) throw new Error("historical replay artifact write made no progress");
        offset += written.bytesWritten;
      }
    }
    if (bytes !== artifact.bytes || hash.digest("hex") !== artifact.sha256) {
      throw new Error("historical replay artifact body does not match its immutable lock");
    }
    await file.close();
    await rename(partial, target);
    committed = true;
  } finally {
    reader.releaseLock();
    if (!committed) {
      await file.close().catch(() => {});
      await rm(partial, { force: true });
    }
  }
}

/** Restore every non-current immutable player into a fresh Web build. A
 * revision may become historical only after all four release assets have
 * checked-in HTTPS URL, byte-count and SHA-256 locks. */
export async function materializeHistoricalReplayReleases(options: {
  releases: readonly ReplayRelease[];
  current: ReplayRelease;
  outDir: string;
  fetcher?: ReplayArtifactFetch;
}): Promise<void> {
  const fetcher = options.fetcher ?? (fetch as ReplayArtifactFetch);
  for (const release of options.releases) {
    if (release.artifactId === options.current.artifactId) continue;
    if (!release.artifacts) {
      throw new Error(
        `historical replay '${release.artifactId}' has no published immutable artifact lock`,
      );
    }
    const directory = join(options.outDir, release.artifactId);
    for (const name of REPLAY_RELEASE_ARTIFACT_NAMES) {
      await downloadArtifact(join(directory, name), release.artifacts[name], fetcher);
    }
  }
}

/** Produce the metadata pasted into replay-releases.json after the exact
 * production player files have been uploaded under an immutable HTTPS base. */
export async function lockReplayReleaseArtifacts(
  directory: string,
  assetBase: string,
): Promise<Record<ReplayReleaseArtifactName, ReplayReleaseArtifact>> {
  const base = finalHttpsUrl(assetBase);
  if (!base.pathname.endsWith("/") || base.search) {
    throw new Error("replay release asset base must be a query-free HTTPS directory URL");
  }
  const result = {} as Record<ReplayReleaseArtifactName, ReplayReleaseArtifact>;
  for (const name of REPLAY_RELEASE_ARTIFACT_NAMES) {
    const path = join(directory, name);
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`replay release artifact is not a file: ${name}`);
    const digest = await sha256File(path);
    if (digest.bytes <= 0 || digest.bytes > REPLAY_RELEASE_ARTIFACT_MAX_BYTES[name]) {
      throw new Error(`replay release artifact has invalid size: ${name}`);
    }
    result[name] = {
      url: new URL(name, base).href,
      bytes: digest.bytes,
      sha256: digest.sha256,
    };
  }
  return result;
}

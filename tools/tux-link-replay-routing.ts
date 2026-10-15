export interface ReplayRelease {
  engineRevision: string;
  dataDigest: string;
  artifactId: string;
  /** Once this entry is no longer current, these content-addressed release
   * assets restore its immutable player into each fresh Pages build. */
  artifacts?: ReplayReleaseArtifacts;
}

export type ReplayReleaseArtifactName =
  | "replay.html"
  | "battle-replay.js"
  | "battle-replay.pak"
  | "audio-worklet.js";

export interface ReplayReleaseArtifact {
  url: string;
  bytes: number;
  sha256: string;
}

export type ReplayReleaseArtifacts = Record<ReplayReleaseArtifactName, ReplayReleaseArtifact>;

export type ReplayRouteSelection =
  | { ok: true; release: ReplayRelease; raw: boolean }
  | { ok: false; reason: "invalid-document" | "player-unavailable" };

const REVISION = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ARTIFACT_ID = /^[a-z0-9][a-z0-9._-]{0,126}$/;
const ARTIFACT_NAMES: readonly ReplayReleaseArtifactName[] = [
  "replay.html", "battle-replay.js", "battle-replay.pak", "audio-worklet.js",
];
const ARTIFACT_MAX_BYTES: Readonly<Record<ReplayReleaseArtifactName, number>> = {
  "replay.html": 1 * 1024 * 1024,
  "battle-replay.js": 16 * 1024 * 1024,
  "battle-replay.pak": 256 * 1024 * 1024,
  "audio-worklet.js": 1 * 1024 * 1024,
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function validArtifactUrl(value: unknown): value is string {
  if (typeof value !== "string" || value !== value.trim() || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash &&
    !/%(?:2f|5c)/i.test(url.pathname) && url.href === value;
}

function validArtifacts(value: unknown): value is ReplayReleaseArtifacts {
  if (!record(value) || !exactKeys(value, ARTIFACT_NAMES)) return false;
  return ARTIFACT_NAMES.every((name) => {
    const artifact = value[name];
    return record(artifact) && exactKeys(artifact, ["url", "bytes", "sha256"]) &&
      validArtifactUrl(artifact.url) && Number.isSafeInteger(artifact.bytes) &&
      (artifact.bytes as number) > 0 && (artifact.bytes as number) <= ARTIFACT_MAX_BYTES[name] &&
      typeof artifact.sha256 === "string" && SHA256.test(artifact.sha256);
  });
}

function validRelease(value: unknown): value is ReplayRelease {
  return record(value) &&
    (exactKeys(value, ["engineRevision", "dataDigest", "artifactId"]) ||
      exactKeys(value, ["engineRevision", "dataDigest", "artifactId", "artifacts"])) &&
    typeof value.engineRevision === "string" && REVISION.test(value.engineRevision) &&
    typeof value.dataDigest === "string" && SHA256.test(value.dataDigest) &&
    typeof value.artifactId === "string" && ARTIFACT_ID.test(value.artifactId) &&
    (value.artifacts === undefined || validArtifacts(value.artifacts));
}

/** Parse the checked-in immutable-player allowlist. Artifact paths come only
 * from this manifest; replay documents never contribute path segments. */
export function parseReplayReleaseManifest(value: unknown): ReplayRelease[] {
  if (!record(value) || !exactKeys(value, ["v", "releases"]) || value.v !== 1 ||
    !Array.isArray(value.releases) || value.releases.length === 0 ||
    !value.releases.every(validRelease)) {
    throw new Error("replay release manifest is invalid");
  }
  const releases = value.releases.map((release) => {
    const valid = release as ReplayRelease;
    return {
      engineRevision: valid.engineRevision,
      dataDigest: valid.dataDigest,
      artifactId: valid.artifactId,
      ...(valid.artifacts
        ? { artifacts: Object.fromEntries(ARTIFACT_NAMES.map((name) => [name, { ...valid.artifacts![name] }])) as ReplayReleaseArtifacts }
        : {}),
    };
  });
  const identities = releases.map((release) => `${release.engineRevision}\n${release.dataDigest}`);
  const artifactIds = releases.map((release) => release.artifactId);
  if (new Set(identities).size !== identities.length || new Set(artifactIds).size !== artifactIds.length) {
    throw new Error("replay release manifest contains duplicate identity or artifact ids");
  }
  return releases;
}

export function requireReplayRelease(
  releases: readonly ReplayRelease[],
  identity: Pick<ReplayRelease, "engineRevision" | "dataDigest">,
): ReplayRelease {
  const release = releases.find((candidate) =>
    candidate.engineRevision === identity.engineRevision && candidate.dataDigest === identity.dataDigest
  );
  if (!release) throw new Error("current replay identity is missing from replay-releases.json");
  return release;
}

/** Select a fixed artifact using only the embedded allowlist. Kind-less input
 * is legacy raw BattleTape and always uses the current release. */
export function selectReplayRelease(
  value: unknown,
  releases: readonly ReplayRelease[],
  current: ReplayRelease,
): ReplayRouteSelection {
  if (!record(value) || !Object.prototype.hasOwnProperty.call(value, "kind")) {
    return { ok: true, release: current, raw: true };
  }
  if (value.kind !== "tux-link-replay" || value.v !== 1 ||
    typeof value.engineRevision !== "string" || typeof value.dataDigest !== "string") {
    return { ok: false, reason: "invalid-document" };
  }
  const release = releases.find((candidate) =>
    candidate.engineRevision === value.engineRevision && candidate.dataDigest === value.dataDigest
  );
  return release
    ? { ok: true, release, raw: false }
    : { ok: false, reason: "player-unavailable" };
}

export function replayArtifactPageUrl(
  pageUrl: string,
  search: string,
  release: ReplayRelease,
): string {
  if (!ARTIFACT_ID.test(release.artifactId)) throw new Error("unsafe replay artifact id");
  const target = new URL(`replays/${release.artifactId}/replay.html`, pageUrl);
  target.search = search;
  return target.href;
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** A small non-player page that reads only enough bounded JSON to select an
 * immutable player. The selected path is always an allowlisted artifact id. */
export function tuxLinkReplayDispatcherHtml(
  releases: readonly ReplayRelease[],
  current: ReplayRelease,
  maxBytes: number,
  trustedReplayBase: string | null = null,
): string {
  if (trustedReplayBase !== null && !validTrustedReplayBase(trustedReplayBase)) {
    throw new Error("trusted replay base is invalid");
  }
  const route = ({ engineRevision, dataDigest, artifactId }: ReplayRelease): ReplayRelease => ({
    engineRevision, dataDigest, artifactId,
  });
  const config = scriptJson({
    v: 1,
    releases: releases.map(route),
    current: route(current),
    maxBytes,
    trustedReplayBase,
  });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Crect width='8' height='8' rx='1' fill='%23071923'/%3E%3Cpath d='M1 4h6M4 1v6' stroke='%2373e5ef'/%3E%3C/svg%3E">
  <title>Battle replay · Pocket Tuxemon</title>
  <style>body{margin:0;background:#071923;color:#e7f7fa;font:16px system-ui,sans-serif}main{max-width:44rem;margin:12vh auto;padding:2rem;border:1px solid #547583;border-radius:.75rem;background:#102b37}h1{color:#73e5ef}p{line-height:1.6}</style>
</head>
<body>
  <main><h1>Battle replay / 对战回放</h1><p id="replay-route-status" role="alert" aria-live="assertive">Selecting an immutable replay player… / 正在选择固定版本回放播放器…</p></main>
  <script type="application/json" id="replay-routing">${config}</script>
  <script>
  (() => {
    "use strict";
    const cfg = JSON.parse(document.getElementById("replay-routing").textContent);
    const status = document.getElementById("replay-route-status");
    const zh = (navigator.language || "").toLowerCase().startsWith("zh");
    const messages = {
      source: ["Replay source is invalid or unavailable.", "回放来源无效或不可用。"],
      document: ["Replay document is invalid.", "回放文档无效。"],
      unavailable: ["No immutable player is available for this replay version.", "此回放版本没有可用的固定播放器。"]
    };
    const fail = (kind) => { status.textContent = messages[kind][zh ? 1 : 0]; };
    const size = (text) => new TextEncoder().encode(text).byteLength;
    const bounded = (text) => {
      if (size(text) > cfg.maxBytes) throw new Error("source");
      return text;
    };
    const trustedLocal = (url) => {
      if (!cfg.trustedReplayBase || url.protocol !== "http:") return false;
      let base;
      try { base = new URL(cfg.trustedReplayBase); } catch { return false; }
      return base.protocol === "http:" && url.origin === base.origin &&
        base.pathname.endsWith("/") && url.pathname.startsWith(base.pathname) &&
        !/%(?:2f|5c)/i.test(base.pathname) && !/%(?:2f|5c)/i.test(url.pathname) &&
        !url.username && !url.password && !url.hash;
    };
    const dataText = (value) => {
      const comma = value.indexOf(",");
      if (comma < 0) throw new Error("source");
      const metadata = value.slice(5, comma).split(";");
      if ((metadata.shift() || "").toLowerCase() !== "application/json") throw new Error("source");
      let base64 = false;
      for (const raw of metadata) {
        const token = raw.toLowerCase();
        if (token === "base64" && !base64) base64 = true;
        else if (token !== "charset=utf-8" && token !== "charset=utf8") throw new Error("source");
      }
      const payload = value.slice(comma + 1);
      if (!base64) return bounded(decodeURIComponent(payload));
      if (payload.length > Math.ceil(cfg.maxBytes / 3) * 4 + 4) throw new Error("source");
      const binary = atob(payload);
      if (binary.length > cfg.maxBytes) throw new Error("source");
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    };
    const responseText = async (response) => {
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > cfg.maxBytes) throw new Error("source");
      if (!response.body) throw new Error("source");
      const reader = response.body.getReader();
      const chunks = [];
      let length = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          if (!part.value) continue;
          length += part.value.byteLength;
          if (length > cfg.maxBytes) {
            await reader.cancel();
            throw new Error("source");
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    };
    const load = async () => {
      const params = new URLSearchParams(location.search);
      const value = params.get("battleReplay");
      if (!value) throw new Error("source");
      if (value.slice(0, 5).toLowerCase() === "data:") return dataText(value);
      const requested = new URL(value, location.href);
      if (requested.username || requested.password || !["http:", "https:"].includes(requested.protocol)) throw new Error("source");
      const external = requested.origin !== location.origin;
      if (external && (params.get("battleReplayExternal") !== "1" ||
          (requested.protocol !== "https:" && !trustedLocal(requested)))) throw new Error("source");
      const response = await fetch(requested.href, { credentials: external ? "omit" : "same-origin" });
      if (!response.ok) throw new Error("source");
      if (!response.url) throw new Error("source");
      const finalUrl = new URL(response.url);
      if ((!external && finalUrl.origin !== location.origin) ||
          (external && finalUrl.protocol !== "https:" && !trustedLocal(finalUrl))) throw new Error("source");
      const mime = (response.headers.get("content-type") || "").split(";", 1)[0].trim();
      if (!/^application\\/(?:[a-z0-9!#$&^_.+-]+\\+)?json$/i.test(mime)) throw new Error("source");
      return responseText(response);
    };
    const select = (value) => {
      const object = typeof value === "object" && value !== null && !Array.isArray(value);
      if (!object || !Object.prototype.hasOwnProperty.call(value, "kind")) return cfg.current;
      if (value.kind !== "tux-link-replay" || value.v !== 1 ||
          typeof value.engineRevision !== "string" || typeof value.dataDigest !== "string") throw new Error("document");
      const release = cfg.releases.find((candidate) => candidate.engineRevision === value.engineRevision && candidate.dataDigest === value.dataDigest);
      if (!release) throw new Error("unavailable");
      return release;
    };
    load().then((text) => {
      let value;
      try { value = JSON.parse(text); } catch { throw new Error("document"); }
      const release = select(value);
      const target = new URL("replays/" + release.artifactId + "/replay.html", location.href);
      target.search = location.search;
      location.replace(target.href);
    }).catch((error) => fail(error instanceof Error && error.message === "unavailable" ? "unavailable" : error instanceof Error && error.message === "document" ? "document" : "source"));
  })();
  </script>
</body>
</html>
`;
}

function validTrustedReplayBase(value: string): boolean {
  if (value !== value.trim() || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const local = url.protocol === "http:" && (
    url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
  );
  return (url.protocol === "https:" || local) && url.username === "" && url.password === "" &&
    url.search === "" && url.hash === "" && !/%(?:2f|5c)/i.test(url.pathname) &&
    url.pathname.endsWith("/") && url.href === value;
}

/** Shared, transport-only policy for bounded JSON replay sources.
 *
 * Format-specific modules validate the returned text. This layer deliberately
 * knows nothing about battle seeds, expedition observations, or reducers.
 */

import { base64ToBytes } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/src/bytes.ts";
import { utf8Encode } from "../vendor/pocket-rpgkit/src/engine/save.ts";

export interface ReplayJsonSourcePolicy {
  sourceParam: string;
  externalParam: string;
  maxBytes: number;
  errorPrefix: string;
}

export type ReplayJsonSource =
  | { kind: "inline"; json: string }
  | { kind: "url"; url: string; external: boolean };

export interface ReplayJsonResponse {
  ok: boolean;
  status: number;
  url: string;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}

export type ReplayJsonFetch = (
  url: string,
  init: { credentials: "same-origin" | "omit" },
) => Promise<ReplayJsonResponse>;

/** Bounded JSON text plus the transport facts needed by format-specific trust
 * policies. `finalUrl` is the normalized final response URL for fetched input,
 * and null for inline data URLs. Fetched input fails closed when the host does
 * not expose an absolute final response URL. */
export interface LoadedReplayJsonText {
  text: string;
  source: ReplayJsonSource;
  finalUrl: string | null;
}

export class ReplaySourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplaySourceError";
  }
}

const JSON_MIME = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/i;

function sourceError(policy: ReplayJsonSourcePolicy, message: string): never {
  throw new ReplaySourceError(`${policy.errorPrefix}: ${message}`);
}

export function assertReplayJsonSize(
  text: string,
  policy: ReplayJsonSourcePolicy,
  noun: string,
): string {
  if (utf8Encode(text).byteLength > policy.maxBytes) {
    sourceError(policy, `${noun} exceeds ${policy.maxBytes} decoded bytes`);
  }
  return text;
}

async function readResponseJson(
  body: ReadableStream<Uint8Array> | null,
  policy: ReplayJsonSourcePolicy,
  noun: string,
): Promise<string> {
  if (!body) sourceError(policy, "source response has no body");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      length += value.byteLength;
      if (length > policy.maxBytes) {
        await reader.cancel();
        sourceError(policy, `${noun} exceeds ${policy.maxBytes} decoded bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    sourceError(policy, "source is not valid UTF-8 JSON");
  }
}

function decodeDataUrl(
  value: string,
  policy: ReplayJsonSourcePolicy,
  noun: string,
): string {
  const comma = value.indexOf(",");
  if (comma < 0) sourceError(policy, "malformed data URL");
  const metadata = value.slice(5, comma).split(";");
  if (metadata.shift()?.toLowerCase() !== "application/json") {
    sourceError(policy, "data URLs must use application/json");
  }
  let base64 = false;
  for (const raw of metadata) {
    const token = raw.toLowerCase();
    if (token === "base64" && !base64) base64 = true;
    else if (token === "charset=utf-8" || token === "charset=utf8") continue;
    else sourceError(policy, `unsupported data URL metadata '${raw}'`);
  }
  const payload = value.slice(comma + 1);
  try {
    if (!base64) {
      return assertReplayJsonSize(decodeURIComponent(payload), policy, noun);
    }
    if (payload.length > Math.ceil(policy.maxBytes / 3) * 4 + 4) {
      sourceError(policy, `${noun} exceeds ${policy.maxBytes} decoded bytes`);
    }
    const bytes = base64ToBytes(payload);
    if (bytes.byteLength > policy.maxBytes) {
      sourceError(policy, `${noun} exceeds ${policy.maxBytes} decoded bytes`);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof ReplaySourceError) throw error;
    sourceError(policy, "data URL is not valid UTF-8 JSON");
  }
}

/** Resolve a replay query without fetching or evaluating source text. */
export function resolveReplayJsonSource(
  search: string,
  baseUrl: string,
  policy: ReplayJsonSourcePolicy,
  noun: string,
  trustedExternalBase?: string,
): ReplayJsonSource {
  const params = new URLSearchParams(search);
  const value = params.get(policy.sourceParam);
  if (!value) sourceError(policy, `missing ${policy.sourceParam} query parameter`);
  if (value.slice(0, 5).toLowerCase() === "data:") {
    return { kind: "inline", json: decodeDataUrl(value, policy, noun) };
  }
  let base: URL;
  let url: URL;
  try {
    base = new URL(baseUrl);
    url = new URL(value, base);
  } catch {
    sourceError(policy, "source URL is malformed");
  }
  if (url.username || url.password || (url.protocol !== "http:" && url.protocol !== "https:")) {
    sourceError(policy, "source URL must use HTTP(S) without embedded credentials");
  }
  const external = url.origin !== base.origin;
  if (external && params.get(policy.externalParam) !== "1") {
    sourceError(policy, `cross-origin source requires ${policy.externalParam}=1`);
  }
  if (external && url.protocol !== "https:" && !trustedLoopbackExternal(url, trustedExternalBase)) {
    sourceError(policy, "cross-origin source must use HTTPS");
  }
  return { kind: "url", url: url.href, external };
}

/** Load one bounded JSON document while retaining its source and final URL.
 * Redirects preserve the source trust class. Format-specific code may impose a
 * narrower final-origin/path policy after this transport-only validation. */
export async function loadReplayJsonTextWithMetadata(
  search: string,
  baseUrl: string,
  fetcher: ReplayJsonFetch,
  policy: ReplayJsonSourcePolicy,
  noun: string,
  trustedExternalBase?: string,
): Promise<LoadedReplayJsonText> {
  const source = resolveReplayJsonSource(search, baseUrl, policy, noun, trustedExternalBase);
  if (source.kind === "inline") {
    return { text: source.json, source, finalUrl: null };
  }
  const response = await fetcher(source.url, {
    credentials: source.external ? "omit" : "same-origin",
  });
  if (!response.ok) sourceError(policy, `source request failed with HTTP ${response.status}`);
  if (typeof response.url !== "string" || response.url.length === 0) {
    sourceError(policy, "source response did not expose its final URL");
  }
  let finalUrl: URL;
  try {
    finalUrl = new URL(response.url);
  } catch {
    sourceError(policy, "source returned an invalid final URL");
  }
  const base = new URL(baseUrl);
  if (!source.external && finalUrl.origin !== base.origin) {
    sourceError(policy, "same-origin source redirected across origins");
  }
  if (source.external && finalUrl.protocol !== "https:" &&
    !trustedLoopbackExternal(finalUrl, trustedExternalBase)) {
    sourceError(policy, "external source redirected away from HTTPS");
  }
  const mime = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim();
  if (!JSON_MIME.test(mime)) sourceError(policy, "source response must be JSON");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > policy.maxBytes) {
    sourceError(policy, `${noun} exceeds ${policy.maxBytes} decoded bytes`);
  }
  return {
    text: await readResponseJson(response.body, policy, noun),
    source,
    finalUrl: finalUrl.href,
  };
}

/** Backward-compatible text-only facade used by existing replay formats. */
export async function loadReplayJsonText(
  search: string,
  baseUrl: string,
  fetcher: ReplayJsonFetch,
  policy: ReplayJsonSourcePolicy,
  noun: string,
  trustedExternalBase?: string,
): Promise<string> {
  return (await loadReplayJsonTextWithMetadata(
    search,
    baseUrl,
    fetcher,
    policy,
    noun,
    trustedExternalBase,
  )).text;
}

/** The only HTTP exception is an exact configured loopback origin and path
 * prefix. Production callers omit this parameter and retain HTTPS-only cross
 * origin behavior. */
function trustedLoopbackExternal(url: URL, trustedExternalBase?: string): boolean {
  if (!trustedExternalBase) return false;
  let trusted: URL;
  try {
    trusted = new URL(trustedExternalBase);
  } catch {
    return false;
  }
  if (trusted.protocol !== "http:" || !loopbackHost(trusted.hostname) ||
    trusted.username || trusted.password || trusted.search || trusted.hash) return false;
  const prefix = trusted.pathname.endsWith("/") ? trusted.pathname : `${trusted.pathname}/`;
  if (encodedPathSeparator(trusted.pathname) || encodedPathSeparator(url.pathname)) return false;
  return url.protocol === "http:" && loopbackHost(url.hostname) &&
    url.username === "" && url.password === "" && url.hash === "" &&
    url.origin === trusted.origin && url.pathname.startsWith(prefix);
}

function encodedPathSeparator(pathname: string): boolean {
  return /%(?:2f|5c)/i.test(pathname);
}

function loopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const octets = hostname.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((octet) =>
    /^(0|[1-9][0-9]{0,2})$/.test(octet) && Number(octet) <= 255
  );
}

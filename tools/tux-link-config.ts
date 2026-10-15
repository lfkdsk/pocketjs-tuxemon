export interface TuxLinkConfig {
  httpBase: string;
  wsBase: string;
  trustedReplayBase: string;
}

export interface TuxLinkWebAuthConfig {
  github: {
    clientId: string;
    worker: string;
  };
}

export type TuxLinkEnvironment = Readonly<Record<string, string | undefined>>;

const FLAG = "--tux-battle-url";
const ENV_KEY = "TUX_BATTLE_BASE_URL";
const REPLAY_PREFIX = "tux/v1/replays/";
const AUTH_CLIENT_FLAG = "--tux-github-client-id";
const AUTH_WORKER_FLAG = "--tux-github-auth-worker";
const AUTH_CLIENT_ENV = "TUX_GITHUB_CLIENT_ID";
const AUTH_WORKER_ENV = "TUX_GITHUB_AUTH_WORKER";

function fail(reason: string): never {
  throw new Error(`invalid Tux Battle base URL: ${reason}`);
}

/** Return an explicitly written port, including a default port URL would drop. */
function explicitPort(authority: string): string | null {
  if (authority.startsWith("[")) {
    const closingBracket = authority.indexOf("]");
    if (closingBracket < 0) fail("invalid IPv6 host");
    const suffix = authority.slice(closingBracket + 1);
    if (suffix === "") return null;
    if (!/^:\d+$/.test(suffix)) fail("invalid port");
    return String(Number(suffix.slice(1)));
  }

  const colon = authority.lastIndexOf(":");
  if (colon < 0) return null;
  const port = authority.slice(colon + 1);
  if (!/^\d+$/.test(port)) fail("invalid port");
  return String(Number(port));
}

function isHttpLoopback(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const octets = hostname.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.every((octet) => /^\d+$/.test(octet) && Number(octet) <= 255);
}

/**
 * Parse the single deploy-time service URL into the bases embedded in Web
 * artifacts. This function is pure and deliberately does not inspect argv or
 * process.env.
 */
export function parseTuxBattleBaseUrl(value: string): TuxLinkConfig {
  if (typeof value !== "string" || value.length === 0) fail("value is empty");
  if (value !== value.trim() || /[\u0000-\u0020\u007f\\]/.test(value)) {
    fail("whitespace, control characters, and backslashes are not allowed");
  }
  if (value.includes("?") || value.includes("#")) fail("query strings and fragments are not allowed");

  const match = /^(https?):\/\/([^/?#]+)(?:\/[^?#]*)?$/i.exec(value);
  if (!match) fail("expected an absolute HTTP(S) URL");
  const authority = match[2]!;
  if (authority.includes("@")) fail("userinfo is not allowed");

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail("expected an absolute HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail("expected an absolute HTTP(S) URL");
  }
  if (parsed.username !== "" || parsed.password !== "") fail("userinfo is not allowed");
  if (/%(?:2f|5c)/i.test(parsed.pathname)) fail("encoded path separators are not allowed");

  const port = explicitPort(authority);
  if (port === "NaN" || Number(port) > 65535) fail("invalid port");
  if (parsed.protocol === "http:" && !isHttpLoopback(parsed.hostname)) {
    fail("HTTP is allowed only for localhost, 127.0.0.0/8, or [::1]");
  }

  const pathPrefix = parsed.pathname.replace(/\/+$/, "");
  const pathname = `${pathPrefix}/`;
  const host = `${parsed.hostname}${port === null ? "" : `:${port}`}`;
  const httpBase = `${parsed.protocol}//${host}${pathname}`;
  const wsProtocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  const wsBase = `${wsProtocol}//${host}${pathname}`;

  return {
    httpBase,
    wsBase,
    trustedReplayBase: `${httpBase}${REPLAY_PREFIX}`,
  };
}

/** Resolve the CLI-over-environment build contract without reading globals. */
export function resolveTuxLinkConfig(
  args: readonly string[],
  env: TuxLinkEnvironment,
): TuxLinkConfig | null {
  let cliValue: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    let value: string | undefined;
    if (arg === FLAG) {
      value = args[++index];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${FLAG} requires a value`);
      }
    } else if (arg.startsWith(`${FLAG}=`)) {
      value = arg.slice(FLAG.length + 1);
    } else {
      continue;
    }

    if (cliValue !== undefined) throw new Error(`${FLAG} may be specified only once`);
    if (value.length === 0) throw new Error(`${FLAG} requires a value`);
    cliValue = value;
  }

  const envValue = env[ENV_KEY];
  const selected = cliValue ?? envValue;
  if (selected === undefined) return null;
  if (selected.length === 0) throw new Error(`${ENV_KEY} must not be empty`);
  return parseTuxBattleBaseUrl(selected);
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  let selected: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    let value: string | undefined;
    if (arg === flag) {
      value = args[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    } else if (arg.startsWith(`${flag}=`)) {
      value = arg.slice(flag.length + 1);
    } else {
      continue;
    }
    if (selected !== undefined) throw new Error(`${flag} may be specified only once`);
    if (value.length === 0) throw new Error(`${flag} requires a value`);
    selected = value;
  }
  return selected;
}

/** Optional page-chrome OAuth metadata. It is a build input rather than a
 * repository default so public source never pins a deployment address. */
export function resolveTuxLinkWebAuthConfig(
  args: readonly string[],
  env: TuxLinkEnvironment,
): TuxLinkWebAuthConfig | null {
  const clientId = flagValue(args, AUTH_CLIENT_FLAG) ?? env[AUTH_CLIENT_ENV];
  const workerValue = flagValue(args, AUTH_WORKER_FLAG) ?? env[AUTH_WORKER_ENV];
  if (clientId === undefined && workerValue === undefined) return null;
  if (clientId === undefined || workerValue === undefined) {
    throw new Error(`${AUTH_CLIENT_ENV} and ${AUTH_WORKER_ENV} must be configured together`);
  }
  if (!/^[A-Za-z0-9_]+$/.test(clientId)) throw new Error(`${AUTH_CLIENT_ENV} is not a valid OAuth client id`);
  if (workerValue !== workerValue.trim() || /[\u0000-\u0020\u007f\\]/.test(workerValue) ||
    workerValue.includes("?") || workerValue.includes("#")) {
    throw new Error(`${AUTH_WORKER_ENV} must be an absolute HTTPS URL without query or fragment`);
  }
  let worker: URL;
  try {
    worker = new URL(workerValue);
  } catch {
    throw new Error(`${AUTH_WORKER_ENV} must be an absolute HTTPS URL`);
  }
  if (worker.protocol !== "https:" || worker.username || worker.password) {
    throw new Error(`${AUTH_WORKER_ENV} must be an absolute HTTPS URL without userinfo`);
  }
  worker.pathname = worker.pathname.replace(/\/+$/, "");
  return { github: { clientId, worker: worker.toString().replace(/\/$/, "") } };
}

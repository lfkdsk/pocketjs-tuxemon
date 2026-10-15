// Bind the finalized desktop JavaScript, startup pak, native package and
// data.fs project shells to one launcher invocation. The runtime reads the
// shells from the sidecar, so their bytes cannot be correlated by searching
// the bundle.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const FORMAT = "pocket-tuxemon/desktop-build-receipt/v2";
const SHA256 = /^[0-9a-f]{64}$/;

export interface DesktopBuildIdentity {
  readonly inputRoot: string;
  readonly appDist: string;
  readonly target: string;
  readonly appId: string;
  readonly output: string;
}

interface ArtifactReceipt {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface DesktopBuildReceipt {
  readonly format: typeof FORMAT;
  readonly target: string;
  readonly appId: string;
  readonly output: string;
  readonly artifacts: {
    readonly bundle: ArtifactReceipt;
    readonly startupPak: ArtifactReceipt;
    readonly nativePackage: ArtifactReceipt;
    readonly englishProjectShell: ArtifactReceipt;
    readonly chineseProjectShell: ArtifactReceipt;
  };
}

interface DesktopBuildPaths {
  readonly receipt: string;
  readonly bundle: string;
  readonly startupPak: string;
  readonly nativePackage: string;
  readonly englishProjectShell: string;
  readonly stagedEnglishProjectShell: string;
  readonly chineseProjectShell: string;
  readonly stagedChineseProjectShell: string;
}

function pathsFor(identity: DesktopBuildIdentity): DesktopBuildPaths {
  const data = join(identity.inputRoot, "dist", "runtime-data", identity.appId, "data");
  return {
    receipt: join(identity.appDist, `${identity.output}.build-receipt.json`),
    bundle: join(identity.appDist, `${identity.output}.js`),
    startupPak: join(identity.appDist, `${identity.output}.pak`),
    nativePackage: join(identity.appDist, `${identity.output}.pocket`),
    englishProjectShell: join(identity.inputRoot, "dist", "project-shell.json"),
    stagedEnglishProjectShell: join(data, "l10n", "en_US", "project-shell.json"),
    chineseProjectShell: join(identity.inputRoot, "dist", "project-shell.zh_CN.json"),
    stagedChineseProjectShell: join(data, "l10n", "zh_CN", "project-shell.json"),
  };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifact(path: string, label: string): ArtifactReceipt {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new Error(`missing desktop build artifact: ${path}`);
  }
  return { path: label, bytes: bytes.length, sha256: digest(bytes) };
}

function assertSameBytes(source: string, staged: string, label: string): void {
  let sourceBytes: Buffer;
  let stagedBytes: Buffer;
  try {
    sourceBytes = readFileSync(source);
  } catch {
    throw new Error(`missing generated ${label} project shell: ${source}`);
  }
  try {
    stagedBytes = readFileSync(staged);
  } catch {
    throw new Error(`missing staged ${label} project shell: ${staged}`);
  }
  if (!sourceBytes.equals(stagedBytes)) {
    throw new Error(`desktop package is stale relative to ${basename(source)}`);
  }
}

function expectedReceipt(identity: DesktopBuildIdentity): DesktopBuildReceipt {
  const paths = pathsFor(identity);
  assertSameBytes(paths.englishProjectShell, paths.stagedEnglishProjectShell, "English");
  assertSameBytes(paths.chineseProjectShell, paths.stagedChineseProjectShell, "Chinese");
  return {
    format: FORMAT,
    target: identity.target,
    appId: identity.appId,
    output: identity.output,
    artifacts: {
      bundle: artifact(paths.bundle, `${identity.output}.js`),
      startupPak: artifact(paths.startupPak, `${identity.output}.pak`),
      nativePackage: artifact(paths.nativePackage, `${identity.output}.pocket`),
      englishProjectShell: artifact(
        paths.stagedEnglishProjectShell,
        "data/l10n/en_US/project-shell.json",
      ),
      chineseProjectShell: artifact(
        paths.stagedChineseProjectShell,
        "data/l10n/zh_CN/project-shell.json",
      ),
    },
  };
}

export function writeDesktopBuildReceipt(identity: DesktopBuildIdentity): string {
  const path = pathsFor(identity).receipt;
  writeFileSync(path, JSON.stringify(expectedReceipt(identity), null, 2) + "\n");
  return path;
}

function isArtifactReceipt(value: unknown): value is ArtifactReceipt {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ArtifactReceipt>;
  return typeof candidate.path === "string"
    && Number.isSafeInteger(candidate.bytes)
    && (candidate.bytes ?? -1) >= 0
    && typeof candidate.sha256 === "string"
    && SHA256.test(candidate.sha256);
}

function readReceipt(path: string): DesktopBuildReceipt {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`missing or malformed desktop build receipt: ${path}`);
  }
  if (typeof value !== "object" || value === null) {
    throw new Error(`malformed desktop build receipt: ${path}`);
  }
  const receipt = value as Partial<DesktopBuildReceipt>;
  const artifacts = receipt.artifacts as Partial<DesktopBuildReceipt["artifacts"]> | undefined;
  if (
    receipt.format !== FORMAT
    || typeof receipt.target !== "string"
    || typeof receipt.appId !== "string"
    || typeof receipt.output !== "string"
    || artifacts === undefined
    || !isArtifactReceipt(artifacts.bundle)
    || !isArtifactReceipt(artifacts.startupPak)
    || !isArtifactReceipt(artifacts.nativePackage)
    || !isArtifactReceipt(artifacts.englishProjectShell)
    || !isArtifactReceipt(artifacts.chineseProjectShell)
  ) {
    throw new Error(`malformed desktop build receipt: ${path}`);
  }
  return receipt as DesktopBuildReceipt;
}

export function assertDesktopBuildFresh(identity: DesktopBuildIdentity): DesktopBuildReceipt {
  const path = pathsFor(identity).receipt;
  const actual = readReceipt(path);
  const expected = expectedReceipt(identity);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("desktop build receipt does not match the current bundle, pak, native package and project shells");
  }
  return actual;
}

interface PocketManifest {
  readonly id?: unknown;
  readonly app?: { readonly output?: unknown };
}

function identityFromArgs(inputRoot: string, appDist: string): DesktopBuildIdentity {
  let manifest: PocketManifest;
  try {
    manifest = JSON.parse(readFileSync(join(inputRoot, "pocket.json"), "utf8")) as PocketManifest;
  } catch {
    throw new Error(`missing or malformed pocket.json under ${inputRoot}`);
  }
  if (typeof manifest.id !== "string" || typeof manifest.app?.output !== "string") {
    throw new Error("pocket.json must declare string id and app.output fields");
  }
  return {
    inputRoot,
    appDist,
    target: basename(appDist),
    appId: manifest.id,
    output: manifest.app.output,
  };
}

if (import.meta.main) {
  const [command, inputRoot, appDist] = process.argv.slice(2);
  if (command !== "verify" || !inputRoot || !appDist) {
    console.error("usage: bun tools/desktop-build-receipt.ts verify <input-root> <app-dist>");
    process.exit(2);
  }
  try {
    assertDesktopBuildFresh(identityFromArgs(inputRoot, appDist));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

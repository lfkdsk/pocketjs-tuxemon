// Build and verify the target-specific package consumed by native hosts.
// The game's JS and pak transforms run first; bytecode must be compiled from
// those final bytes so the fast path and source fallback are the same release.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  POCKET_SECTION,
  decodeBytecodeEnvelope,
  decodePocketPackage,
  findSection,
  findVariant,
} from "../vendor/pocket-rpgkit/vendor/pocketjs/contracts/spec/pocket-package.ts";
import type { ResolvedBuildPlan } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/src/manifest/plan.ts";
import {
  quickJsEngineAbiForTarget,
} from "../vendor/pocket-rpgkit/vendor/pocketjs/contracts/spec/quickjs-bytecode.ts";
import { packageNativeArtifacts } from "../vendor/pocket-rpgkit/tools/lib/native-package.ts";

export interface NativeReleasePackageInput {
  readonly projectRoot: string;
  readonly outdir: string;
  readonly packagePath: string;
  readonly target: string;
  readonly plan: ResolvedBuildPlan;
}

export interface NativeReleasePackageSummary {
  readonly path: string;
  readonly sourceBytes: number;
  readonly bytecodeBytes: number;
  readonly engineAbi: string;
}

/** Decode the published artifact, not an intermediate command line, and
 * require both the source fallback and target-compatible bytecode. */
export function assertNativeReleasePackage(
  packagePath: string,
  target: string,
): NativeReleasePackageSummary {
  const pkg = decodePocketPackage(new Uint8Array(readFileSync(packagePath)));
  if (pkg.variants.length !== 1) {
    throw new Error(`native release package must contain exactly one variant, found ${pkg.variants.length}`);
  }
  const variant = findVariant(pkg, target);
  if (!variant) throw new Error(`native release package has no ${target} variant`);
  const source = findSection(variant, POCKET_SECTION.js);
  if (!source || source.byteLength <= 1 || source[source.byteLength - 1] !== 0) {
    throw new Error(`native release ${target} is missing its NUL-terminated source fallback`);
  }
  const bytecode = findSection(variant, POCKET_SECTION.bytecode);
  if (!bytecode) {
    throw new Error(`native release ${target} is missing QuickJS bytecode; pass --bytecode`);
  }
  const envelope = decodeBytecodeEnvelope(bytecode);
  const expectedAbi = quickJsEngineAbiForTarget(target);
  if (!expectedAbi) throw new Error(`native release ${target} has no QuickJS engine ABI descriptor`);
  if (envelope.engineAbi !== expectedAbi.sha256) {
    throw new Error(`native release ${target} QuickJS engine ABI drifted`);
  }
  return {
    path: packagePath,
    sourceBytes: source.byteLength - 1,
    bytecodeBytes: envelope.bytecode.byteLength,
    engineAbi: envelope.engineAbi,
  };
}

/** Compile bytecode from the final loose artifacts, keep those source bytes
 * in section 3, and fail closed if the emitted release cannot pass the game
 * package gate. */
export async function writeNativeReleasePackage(
  input: NativeReleasePackageInput,
): Promise<NativeReleasePackageSummary> {
  const output = input.plan.app.output;
  const source = new Uint8Array(readFileSync(join(input.outdir, `${output}.js`)));
  const pak = new Uint8Array(readFileSync(join(input.outdir, `${output}.pak`)));
  const release = await packageNativeArtifacts({
    manifest: new Uint8Array(readFileSync(join(input.projectRoot, "pocket.json"))),
    plan: input.plan,
    javascript: source,
    pak,
    // Native bytecode is an explicit release choice. Web never calls this
    // helper and keeps the ordinary JavaScript produced by tools/web.ts.
    bytecode: true,
    bytecodeBuildDirectory: join(input.projectRoot, ".pocket-build", "bytecode", input.target),
  });
  writeFileSync(input.packagePath, release.bytes);
  return assertNativeReleasePackage(input.packagePath, input.target);
}

// Build and launch Pocket Tuxemon in PocketJS's portable desktop host.

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { desktopHostFeatures } from "../vendor/pocket-rpgkit/tools/lib/desktop.ts";
import { validateAndResolveBuildPlan } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/src/manifest/resolve.ts";
import { externalizeDesktopPak } from "./desktop-audio.ts";
import { writeDesktopBuildReceipt } from "./desktop-build-receipt.ts";
import { writeNativeReleasePackage } from "./native-release-package.ts";
import { minifyRuntimeBundle } from "./runtime-bundle.ts";

const root = resolve(import.meta.dir, "..");
const pocketjs = join(root, "vendor", "pocket-rpgkit", "vendor", "pocketjs");
const target = process.platform === "darwin" ? "macos-app" : "linux-app";
const argv = process.argv.slice(2);
const buildOnly = argv.includes("--build-only");
// --lang zh (or --lang=zh) selects the Chinese content: it is staged as
// data.fs lang.json (the bundle reads it at boot) and stripped from the
// passthrough so the host's flag parser never sees it.
let lang: string | undefined;
const passthrough: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg === "--build-only" || arg === "--") continue;
  if (arg === "--lang") { lang = argv[++i]; continue; }
  if (arg.startsWith("--lang=")) { lang = arg.slice("--lang=".length); continue; }
  passthrough.push(arg);
}
if (lang !== undefined && lang !== "zh" && lang !== "zh_CN" && lang !== "en" && lang !== "en_US") {
  throw new Error(`desktop: unsupported --lang '${lang}' (use zh or en)`);
}

await $`bun ${join(root, "gen-assets.ts")}`.cwd(root);
const manifest = await Bun.file(join(root, "pocket.json")).json();
const resolution = validateAndResolveBuildPlan(manifest, { target });
if (!resolution.ok) {
  throw new Error(
    `desktop: pocket.json did not resolve against ${target}: ` +
      resolution.diagnostics.map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`).join("; "),
  );
}
const plan = resolution.plan;
const outdir = join(root, "dist", target);
mkdirSync(outdir, { recursive: true });
const dataRoot = join(root, "dist", "runtime-data");
const appDataRoot = join(dataRoot, plan.app.id, "data");
mkdirSync(appDataRoot, { recursive: true });
// --lang stages the boot language the bundle reads from data.fs.
if (lang !== undefined) {
  const normalized = lang === "zh" ? "zh_CN" : lang === "en" ? "en_US" : lang;
  writeFileSync(join(appDataRoot, "lang.json"), JSON.stringify({ lang: normalized }) + "\n");
}
const planPath = join(root, ".pocket", target, `${plan.app.output}.plan.json`);
mkdirSync(resolve(planPath, ".."), { recursive: true });
await Bun.write(planPath, JSON.stringify(plan, null, 2) + "\n");
await $`bun ${join(pocketjs, "tools", "build.ts")} --plan=${planPath} --project-root=${root} --outdir=${outdir}`.cwd(root);
const bundle = await minifyRuntimeBundle(join(outdir, `${plan.app.output}.js`));
console.log(`runtime bundle: ${bundle.before} -> ${bundle.after} bytes`);
const desktopPak = join(outdir, `${plan.app.output}.pak`);
const sidecar = externalizeDesktopPak(
  desktopPak,
  appDataRoot,
);
console.log(
  `desktop: staged ${sidecar.dataEntries} data entries (${sidecar.dataBytes} bytes) and ` +
    `${sidecar.audioEntries} audio entries (${sidecar.audioBytes} bytes) in data.fs; ` +
    `startup pak ${sidecar.fullPakBytes} -> ${sidecar.startupPakBytes} bytes`,
);
const packagePath = join(outdir, `${plan.app.output}.pocket`);
const releasePackage = await writeNativeReleasePackage({
  projectRoot: root,
  outdir,
  packagePath,
  target,
  plan,
});
console.log(
  `desktop: native package keeps ${releasePackage.sourceBytes} source bytes and ` +
    `${releasePackage.bytecodeBytes} bytecode bytes`,
);
copyFileSync(
  join(root, "licenses", "AUDIO-ATTRIBUTIONS.md"),
  join(outdir, "AUDIO-ATTRIBUTIONS.md"),
);
const receipt = writeDesktopBuildReceipt({
  inputRoot: root,
  appDist: outdir,
  target,
  appId: plan.app.id,
  output: plan.app.output,
});
console.log(`desktop: wrote ${receipt}`);
await $`cargo build --release ${desktopHostFeatures()}`.cwd(join(pocketjs, "hosts", "desktop"));

const bin = join(pocketjs, "hosts", "desktop", "target", "release", "pocket-desktop-host");
if (buildOnly) {
  console.log(`desktop: built ${plan.app.output} for ${target} + release host (${bin})`);
  process.exit(0);
}

const flags = [
  "--pocket", packagePath,
  "--data-root", dataRoot,
];
await $`${bin} ${flags} ${passthrough}`.env({ ...process.env, RUST_LOG: process.env.RUST_LOG ?? "info" });

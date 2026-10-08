// Build the complete game for PSP while keeping the large resource pak beside
// EBOOT.PBP. Only boot resources and the external-pak directory are embedded.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { FIXED_INITIAL_CIVIL_TIME } from "../battle/time-weather.ts";
import {
  pack,
  unpack,
} from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/compiler/pak.ts";
import { checkExternalPak } from "./psp-external-check.ts";
import { bakeSegmentBundle, resolveSegment, replaySuffixTerminal } from "./psp-segment.ts";

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

const args = new Set(process.argv.slice(2));
const allowed = new Set(["--skip-assets", "--bench", "--journey", "--capture", "--help", "--zh"]);
for (const arg of args) {
  if (!allowed.has(arg) && !arg.startsWith("--journey-segment=")
      && !arg.startsWith("--journey-segment-end=")
      && !arg.startsWith("--journey-tape=")) {
    throw new Error(`Unknown PSP option: ${arg}`);
  }
}
// --zh builds the Chinese package: CJK fallback fonts stay baked, the real
// ui/zh-data.ts and the zh_CN shards ship, and the bundle boots in Chinese
// (the PSP host has no localStorage and mounts no fs module, so the language
// is a build-time choice injected here rather than a runtime switch). The
// English package (the default) is unchanged.
const zh = args.has("--zh");
if (args.has("--help")) {
  console.log(
    "bun run build:psp [--skip-assets] [--bench] [--journey] [--journey-segment=<chapter>] [--journey-segment-end=<frame>] [--capture]\n" +
      "Normal builds accept live controls. --bench enables timing logs. " +
      "--journey replays the maintained opening and implies --bench. " +
      "--journey-segment replays a mainline chapter suffix from a chapter save and implies --bench. " +
      "--capture writes a short PPSSPP framebuffer sequence and exits; it may combine with " +
      "--journey or --journey-segment to capture the replayed tape (PSP_CAP_START is tape- or " +
      "suffix-relative, PSP_CAP_N is the frame count).",
  );
  process.exit(0);
}
const segmentArg = [...args].find((a) => a.startsWith("--journey-segment="));
const segmentChapter = segmentArg?.slice("--journey-segment=".length);
const journeyTapeArg = [...args].find((a) => a.startsWith("--journey-tape="));
if (segmentChapter !== undefined && args.has("--journey")) {
  throw new Error("--journey and --journey-segment are mutually exclusive");
}
if (journeyTapeArg !== undefined && (args.has("--journey") || segmentChapter !== undefined)) {
  throw new Error("--journey-tape is mutually exclusive with --journey and --journey-segment");
}
const benchmark = args.has("--bench") || args.has("--journey") || segmentChapter !== undefined
  || journeyTapeArg !== undefined;
const root = resolve(import.meta.dir, "..");
const framework = join(root, "vendor/pocket-rpgkit/vendor/pocketjs");
const out = join(root, "dist/psp");
mkdirSync(out, { recursive: true });

// The pinned SDK archive carries the author's native GCC wrapper on macOS.
// Linux CI uses LLVM's MIPS backend against the same headers and libraries.
const cCompiler = process.env.POCKETJS_PSP_C_COMPILER ??
  (process.platform === "linux" ? "clang" : "gcc");
if (!["gcc", "clang"].includes(cCompiler)) {
  throw new Error("POCKETJS_PSP_C_COMPILER must be gcc or clang");
}
const discoveredClang = Bun.which("clang");
const discoveredClangBin = discoveredClang ? dirname(realpathSync(discoveredClang)) : undefined;
const discoveredLlvmBin = discoveredClangBin &&
    existsSync(join(discoveredClangBin, "llvm-ar"))
  ? discoveredClangBin
  : undefined;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function linuxCrossLlvmBin(realLlvmBin: string): string {
  const manifest = JSON.parse(readFileSync(
    join(framework, "tools/cli/psp-toolchain.json"),
    "utf8",
  )) as { sdk: { cachePath: string } };
  const cacheRoot = process.env.POCKET_NEXUS_CACHE_DIR?.trim() ||
    join(process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache"), "pocket-nexus");
  const sdk = resolve(
    process.env.PSP_SDK?.trim() || process.env.PSPDEV?.trim() ||
      join(cacheRoot, manifest.sdk.cachePath),
  );
  const wrappers = join(root, ".pocket-build/psp-llvm-bin");
  mkdirSync(wrappers, { recursive: true });
  for (const tool of ["clang", "llvm-ar", "llvm-ranlib", "llvm-objcopy"]) {
    const executable = join(realLlvmBin, tool);
    if (!existsSync(executable)) throw new Error(`PSP LLVM tool is missing: ${executable}`);
    const prefix = tool === "clang"
      ? ` --sysroot=${shellQuote(join(sdk, "psp"))}`
      : "";
    const wrapper = join(wrappers, tool);
    writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(executable)}${prefix} \"$@\"\n`);
    chmodSync(wrapper, 0o755);
  }
  return wrappers;
}

const realLlvmBin = process.env.POCKETJS_LLVM_BIN || discoveredLlvmBin;
const pspLlvmBin = process.platform === "linux" && cCompiler === "clang" && realLlvmBin
  ? linuxCrossLlvmBin(realLlvmBin)
  : realLlvmBin;

async function run(command: string[], env: Record<string, string> = {}): Promise<void> {
  const child = Bun.spawn([process.execPath, ...command], {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  // Throw (not process.exit) so the caller's finally block restores any
  // swapped files (fonts.json, ui/zh-data.ts) before the process ends.
  if (await child.exited !== 0) throw new Error(`psp build step failed: ${command.join(" ")}`);
}

if (!args.has("--skip-assets")) await run([join(root, "gen-assets.ts")]);

// Both PSP packages bake fonts without the CJK fallback: the boot pak's
// atlases are ASCII-only so the embedded PRX stays small and the arena keeps
// its full capacity. The --zh package streams CJK glyphs on demand from a
// 2bpp font archive on the memory stick (ui/zh-font-stream.ts) instead of
// baking the full subset into the boot pak, which would not fit the arena.
// The zh_CN data module is stubbed only for the English package.
const fontsJsonPath = join(root, "fonts.json");
const savedFontsJson = readFileSync(fontsJsonPath, "utf8");
const zhDataPath = join(root, "ui", "zh-data.ts");
const savedZhData = readFileSync(zhDataPath, "utf8");
const englishOnlyFonts = JSON.stringify({ fallback: [], characterFiles: [] }, null, 2) + "\n";
writeFileSync(fontsJsonPath, englishOnlyFonts);
if (!zh) {
  // Normal web/desktop builds read the five zh_CN startup documents through
  // ui/zh-data.ts. Swapping in the English-only stub makes Chinese unavailable
  // during PSP compilation; the matching pak entries are filtered below.
  const stubZhData = readFileSync(join(root, "tools", "psp-stubs", "zh-data.ts"), "utf8");
  writeFileSync(zhDataPath, stubZhData);
}
try {
  await run([
    join(framework, "tools/pocket.ts"),
    "compile",
    "--target",
    "psp",
    "--outdir",
    out,
  ]);
} finally {
  writeFileSync(fontsJsonPath, savedFontsJson);
  if (!zh) {
    writeFileSync(zhDataPath, savedZhData);
  }
}

const pakPath = join(out, "pocket-tuxemon.pak");
const fullPak = readFileSync(pakPath);
// The external assets.pak carries everything the embedded boot pak does not;
// the English build strips the zh_CN shards so its download stays
// English-only. The --zh build keeps them (they cost download bytes, not
// PSP RAM — the external pak is read on demand from the memory stick).
const externalEntries = unpack(fullPak).filter((entry) =>
  zh || (!entry.key.includes("zh_CN") && !entry.key.startsWith("battle-zh/")
    && !entry.key.startsWith("maps-zh/")
    && !entry.key.startsWith("license:NotoSansCJK"))
);
// The sidecar and its embedded index MUST be built from the SAME filtered
// entry list: the PSP host (pak_external.rs) rejects a sidecar whose length
// or byte-for-byte index prefix does not match the embedded directory.
const externalPak = pack(externalEntries);
writeFileSync(join(out, "assets.pak"), externalPak);
const dataOffset = new DataView(externalPak.buffer, externalPak.byteOffset, externalPak.byteLength).getUint32(20, true);
if (dataOffset <= 24 || dataOffset > externalPak.length) {
  throw new Error(`PSP external pak has an invalid data offset: ${dataOffset}`);
}
const bootEntries = unpack(fullPak).filter((entry) =>
  entry.key === "ui:styles" || entry.key.startsWith("ui:font.") || entry.key.startsWith("ui:sprite.")
  // The CJK font license ships inside the pak with the glyphs it covers.
  || (zh && entry.key.startsWith("license:NotoSansCJK"))
);
if (bootEntries.length === 0) throw new Error("PSP external pak contains no boot resources");
bootEntries.push({
  key: "pocket:external-index",
  dtype: 0,
  data: externalPak.subarray(0, dataOffset),
});
writeFileSync(pakPath, pack(bootEntries));
console.log(
  `PSP: ${externalPak.length} bytes external, ${readFileSync(pakPath).length} bytes embedded`,
);

// Self-check: the embedded index must satisfy the PSP host's acceptance rules
// (declared length == sidecar length; index is a byte-for-byte prefix of the
// sidecar), and one map, one audio and one battle entry must be readable
// through the host's binary-search + read_at path.
checkExternalPak(out);

// The --zh package streams CJK glyphs from a 2bpp font archive on the
// memory stick (the boot pak's atlases are ASCII-only). Bake the archive
// from the subset font, one strike per boot-pak slot, and ship it beside
// assets.pak; the PSP offload provider reads it from
// ms0:/PSP/COMMON/pocketjs/font-archive.bin (see ui/zh-font-stream.ts).
if (zh) {
  const { bakeFontArchive } = await import(
    join(framework, "framework/compiler/font-archive.ts")
  );
  const { fontSlotFor } = await import(
    join(framework, "framework/compiler/tailwind.ts")
  );
  const charset = [...new Set([...readFileSync(join(root, "fonts/cjk-charset.txt"), "utf8")])]
    .filter((ch) => {
      const cp = ch.codePointAt(0)!;
      // Every scalar the subset font covers (CJK ideographs, fullwidth
      // punctuation, symbols); the cjk-font tool already excluded Inter's.
      return cp >= 32 && cp !== 127 && !(cp >= 0xd800 && cp <= 0xdfff);
    })
    .map((ch) => ch.codePointAt(0)!);
  // The boot pak bakes slots 0(12r),1(14r),2(16r),3(18r),7(12b),19(10r);
  // the archive needs a matching strike per slot so the stream can extend
  // each atlas.
  const slots = [
    fontSlotFor(12, false),
    fontSlotFor(14, false),
    fontSlotFor(16, false),
    fontSlotFor(18, false),
    fontSlotFor(12, true),
    fontSlotFor(10, false),
  ];
  const archive = await bakeFontArchive({
    font: join(root, "fonts/NotoSansCJKsc-subset.otf"),
    slots,
    codepoints: charset,
  });
  writeFileSync(join(out, "font-archive.bin"), archive);
  console.log(`PSP zh: font-archive.bin ${archive.length} bytes (${(archive.length / 1048576).toFixed(2)} MiB), ${charset.length} CJK chars × ${slots.length} strikes`);
}

// The PSP host has no localStorage and mounts no fs module, so the language
// is a build-time choice: --zh injects the boot-language override the kit
// reads before any URL/storage/fs lookup (ui/language.ts detectLang).
const langPrefix = zh
  ? `globalThis.__pocketTuxemonLang="zh_CN";\n`
  : "";
if (zh && !args.has("--journey") && segmentChapter === undefined) {
  const bundlePath = join(out, "pocket-tuxemon.js");
  writeFileSync(bundlePath, langPrefix + readFileSync(bundlePath, "utf8"));
}

let journeyBuildId: string | undefined;
if (args.has("--journey")) {
  const bundlePath = join(out, "pocket-tuxemon.js");
  const original = readFileSync(bundlePath, "utf8");
  // The Chinese package replays the zh_CN opening smoke tape; the English
  // package replays the maintained English opening (g6-journey).
  const tapeFile = zh ? "data/zh-smoke-journey.json" : "data/g6-journey.json";
  const tape = JSON.parse(readFileSync(join(root, tapeFile), "utf8")).masks as number[];
  journeyBuildId = createHash("sha256")
    .update(original)
    .update(JSON.stringify(tape))
    .update(JSON.stringify(FIXED_INITIAL_CIVIL_TIME))
    .digest("hex");
  const prefix =
    `${langPrefix}globalThis.__pocketTuxemonInitialCivilTime=${JSON.stringify(FIXED_INITIAL_CIVIL_TIME)};\n`;
  const suffix =
    `\n;(function(){var id=${JSON.stringify(journeyBuildId)};` +
    `__pspLog(JSON.stringify({kind:"session",buildId:id}));` +
    `[0,-0,1.25,-4.5,1e30,Number.MIN_VALUE,NaN,Infinity,-Infinity].forEach(function(v){` +
    `if(!Object.is(__pspRoundTrip(v),v))throw new Error("PSP double ABI round trip failed");});` +
    `__pspLog(JSON.stringify({kind:"abi",passed:true,buildId:id}));` +
    `var f=globalThis.frame,n=0,tape=${JSON.stringify(tape)};` +
    `globalThis.frame=function(buttons,analog){f(n<tape.length?tape[n]:buttons,analog);n++;` +
    `var s=globalThis.__rpgSessionState;` +
    `if(n%300===0)__pspLog(JSON.stringify({frame:n,map:s.mapId,pos:[s.move.tx,s.move.ty],` +
    `scene:s.scene?.kind,modal:s.interp.modal,error:s.interp.error,buildId:id}));` +
    `if(n===tape.length)__pspLog(JSON.stringify({kind:"terminal",frame:n,state:s,buildId:id}));` +
    `if(n===tape.length&&typeof __pspExit==="function")__pspExit();};})();\n`;
  writeFileSync(bundlePath, prefix + original + suffix);
}

// Custom-tape journey: like --journey, but the tape and the state-log point
// come from a JSON file ({masks:number[], logAt?:number}). The save/load
// e2e (tools/verify-psp-save.ts) uses it to drive the START menu under
// PPSSPP and log the live state right after a save or a load, so the two
// runs can be compared field-by-field. Implies --bench (the wrapper calls
// __pspLog/__pspExit, which the bench feature registers).
if (journeyTapeArg !== undefined) {
  const tapeFile = journeyTapeArg.slice("--journey-tape=".length);
  const tapeSpec = JSON.parse(readFileSync(tapeFile, "utf8")) as {
    masks: number[];
    logAt?: number;
    label?: string;
  };
  if (!Array.isArray(tapeSpec.masks) || tapeSpec.masks.length === 0) {
    throw new Error(`--journey-tape: ${tapeFile} has no masks`);
  }
  const bundlePath = join(out, "pocket-tuxemon.js");
  const original = readFileSync(bundlePath, "utf8");
  journeyBuildId = createHash("sha256")
    .update(original)
    .update(JSON.stringify(tapeSpec.masks))
    .update(JSON.stringify(FIXED_INITIAL_CIVIL_TIME))
    .digest("hex");
  const prefix =
    `${langPrefix}globalThis.__pocketTuxemonInitialCivilTime=${JSON.stringify(FIXED_INITIAL_CIVIL_TIME)};\n`;
  const logAt = tapeSpec.logAt ?? -1;
  const suffix =
    `\n;(function(){var id=${JSON.stringify(journeyBuildId)};` +
    `__pspLog(JSON.stringify({kind:"session",buildId:id}));` +
    `var f=globalThis.frame,n=0,tape=${JSON.stringify(tapeSpec.masks)},logAt=${logAt};` +
    `globalThis.frame=function(buttons,analog){f(n<tape.length?tape[n]:buttons,analog);n++;` +
    `var s=globalThis.__rpgSessionState;` +
    `if(n===logAt){var m=null;try{var h=globalThis.__pocketTuxemonSave;m=h?h.menu():null;}catch(e){}` +
    `__pspLog(JSON.stringify({kind:"marked",frame:n,state:s,menu:m,buildId:id}));}` +
    `if(n===tape.length)__pspLog(JSON.stringify({kind:"terminal",frame:n,state:s,buildId:id}));` +
    `if(n===tape.length&&typeof __pspExit==="function")__pspExit();};})();\n`;
  writeFileSync(bundlePath, prefix + original + suffix);
}

// Segment build: replay a mainline chapter suffix from a chapter save, so the
// full GB6+J1+J2+J3+J4 mainline can run under the emulator in bounded pieces.
// The boot-snapshot overlay (ui/boot-snapshot-overlay.tsx) restores the
// chapter envelope before the first tape mask is folded. The build receipt
// carries the segment's frame range, the desktop terminal pin (replayed
// through the same reducer path as tools/bake-chapters.ts) and the envelope
// itself, so tools/verify-psp-journey.ts can verify a run from the receipt
// alone — for committed chapters and for generated intermediate envelopes.
let segmentReceipt: Record<string, unknown> | undefined;
let segmentSuffix: number[] | undefined;
if (segmentChapter !== undefined) {
  const bundlePath = join(out, "pocket-tuxemon.js");
  const segmentEndArg = [...args].find((a) => a.startsWith("--journey-segment-end="));
  const segmentEnd = segmentEndArg
    ? Number(segmentEndArg.slice("--journey-segment-end=".length))
    : undefined;
  const spec = resolveSegment(root, segmentChapter, segmentEnd);
  const pin = replaySuffixTerminal(root, spec);
  const suffix = spec.suffix;
  segmentSuffix = suffix;
  const { bundle, journeyBuildId: segmentBuildId } = bakeSegmentBundle(
    readFileSync(bundlePath, "utf8"),
    spec,
    FIXED_INITIAL_CIVIL_TIME,
  );
  journeyBuildId = segmentBuildId;
  writeFileSync(bundlePath, bundle);
  segmentReceipt = {
    chapter: spec.chapter,
    generated: spec.generated,
    startFrame: spec.startFrame,
    endFrame: spec.endFrame,
    frames: suffix.length,
    snapshotSha256: sha256(spec.envelope.snapshot),
    tapeSha256: sha256(JSON.stringify(suffix)),
    terminalSha256: pin.terminalSha256,
    endMap: pin.endMap,
    endPosition: pin.endPosition,
    terminalFrame: pin.endFrame,
    envelope: spec.envelope,
  };
}

// Capture builds dump the framebuffer and exit after their bounded window;
// they may combine with --journey/--journey-segment so the dumped frames come
// from the same tape path the terminal gate verifies. PSP_CAP_START is
// tape-relative (opening) or suffix-relative (segment): a segment feeds its
// first suffix mask on host frame 1 (frame 0 restores the chapter save), so
// the host's capture window is offset by one there.
//
// A capture that replays a journey needs BOTH host features: capture (the
// framebuffer dump) and bench (which registers __pspLog/__pspRoundTrip/
// __pspExit the journey wrapper calls). The vendor's --bench flag enables
// both; POCKETJS_BENCH_DUMP_FRAMES=1 makes the dump path write frames
// instead of exiting silently after the window. A plain capture (no tape)
// keeps --capture alone.
const captureWithJourney = args.has("--capture") &&
  (args.has("--journey") || segmentChapter !== undefined || journeyTapeArg !== undefined);
const captureEnv: Record<string, string> = {};
if (args.has("--capture")) {
  const capStart = Number(process.env.PSP_CAP_START ?? "16");
  const capN = Number(process.env.PSP_CAP_N ?? "32");
  captureEnv.POCKETJS_CAP_START = String(capStart + (segmentChapter !== undefined ? 1 : 0));
  captureEnv.POCKETJS_CAP_N = String(capN);
  if (captureWithJourney) captureEnv.POCKETJS_BENCH_DUMP_FRAMES = "1";
}

// Segment perf builds (no --capture) bake the bench window to cover the whole
// segment: host frame 0 restores the chapter save, frames 1..L replay the L
// suffix masks, so the single window [0, L+1) flushes at the terminal frame
// instead of losing the <300-frame tail the rotating 300-frame windows left
// unlogged. The vendor --bench flag enables capture+bench; with
// BENCH_DUMP_FRAMES unset the host dumps no framebuffers and exits cleanly at
// the window end (the journey wrapper delays __pspExit by one frame so the
// terminal frame's window flushes first).
const segmentPerf = segmentChapter !== undefined && !args.has("--capture");
const perfEnv: Record<string, string> = {};
if (segmentPerf) {
  perfEnv.POCKETJS_CAP_START = "0";
  perfEnv.POCKETJS_CAP_N = String(segmentSuffix!.length + 1);
}

// Hardware timing needs the bench functions, but not the capture feature:
// capture intentionally exits after its bounded framebuffer window.
const hostFeatures = args.has("--capture")
  ? (captureWithJourney ? ["--bench"] : ["--capture"])
  : segmentPerf
    ? ["--bench"]
    : benchmark
      ? ["--features=bench"]
      : [];
await run(
  [
    join(framework, "tools/psp.ts"),
    `--plan=${join(root, ".pocket/psp/plan.json")}`,
    `--project-root=${root}`,
    `--outdir=${out}`,
    "--skip-build",
    "--release",
    ...hostFeatures,
  ],
  {
    POCKETJS_PSP_C_COMPILER: cCompiler,
    ...(!pspLlvmBin
      ? {}
      : { POCKETJS_LLVM_BIN: pspLlvmBin }),
    ...captureEnv,
    ...perfEnv,
  },
);

const target = join(framework, "hosts/psp/target/mipsel-sony-psp/release");
copyFileSync(join(target, "pocketjs-psp.prx"), join(out, "pocket-tuxemon.prx"));
copyFileSync(join(target, "EBOOT.PBP"), join(out, "EBOOT.PBP"));
copyFileSync(
  join(root, "licenses", "AUDIO-ATTRIBUTIONS.md"),
  join(out, "AUDIO-ATTRIBUTIONS.md"),
);

const identity = (cwd: string) => {
  const changed = execFileSync(
    "git",
    ["ls-files", "--modified", "--others", "--exclude-standard", "-z"],
    { cwd, encoding: "utf8" },
  ).split("\0").filter(Boolean).sort();
  const files = Object.fromEntries(changed.filter((name) => {
    try {
      return statSync(join(cwd, name)).isFile();
    } catch {
      return false;
    }
  }).map((name) => [name, sha256(readFileSync(join(cwd, name)))]));
  return {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim(),
    diffSha256: sha256(execFileSync(
      "git",
      ["diff", "HEAD", "--binary", "--ignore-submodules=dirty"],
      // An uncommitted merge with binary assets easily passes the default
      // 1 MiB buffer and would abort the build with ENOBUFS.
      { cwd, maxBuffer: 1 << 30 },
    )),
    changedFiles: files,
  };
};

writeFileSync(join(out, "build-receipt.json"), JSON.stringify({
  target: "psp",
  cCompiler,
  benchmark,
  capture: args.has("--capture"),
  journey: args.has("--journey") || segmentChapter !== undefined || journeyTapeArg !== undefined,
  zh,
  ...(segmentReceipt === undefined ? {} : { journeySegment: segmentReceipt }),
  ...(journeyBuildId === undefined ? {} : { journeyBuildId }),
  ...(!segmentPerf ? {} : {
    benchWindow: { start: 0, n: segmentSuffix!.length + 1 },
  }),
  ...(!args.has("--capture") ? {} : {
    captureWindow: {
      start: Number(process.env.PSP_CAP_START ?? "16") + (segmentChapter !== undefined ? 1 : 0),
      n: Number(process.env.PSP_CAP_N ?? "32"),
      tapeRelativeStart: Number(process.env.PSP_CAP_START ?? "16"),
    },
  }),
  source: identity(root),
  rpgkit: identity(join(root, "vendor/pocket-rpgkit")),
  pocketjs: identity(framework),
  artifacts: Object.fromEntries([
    "pocket-tuxemon.prx",
    "EBOOT.PBP",
    "assets.pak",
    "pocket-tuxemon.js",
    "pocket-tuxemon.pak",
    "AUDIO-ATTRIBUTIONS.md",
    // The CJK glyph archive ships only in the Chinese package; bind it to the
    // build the same way as the PRX and pak so the verifier can audit it.
    ...(zh ? ["font-archive.bin"] : []),
  ].map((name) => {
    const bytes = readFileSync(join(out, name));
    return [name, { bytes: bytes.length, sha256: sha256(bytes) }];
  })),
}, null, 2) + "\n");

// Fresh-process startup comparison for the production QuickJS harness.
// Each cell alternates ABBA / BAAB windows and keeps failed >250 ms samples.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadavg } from "node:os";

export interface StartupSample {
  type: "sample";
  cell: string;
  language: "en_US" | "zh_CN";
  viewport: string;
  window: number;
  slot: number;
  order: "ABBA" | "BAAB";
  variant: "baseline" | "candidate";
  startupMs: number;
  processWallMs: number;
  launcherEnvelopeMs: number;
  budgetPassed: boolean;
  exitCode: number;
  loadBefore: readonly number[];
  loadAfter: readonly number[];
  cpuIdlePercent: number;
  hostStages: Record<string, number>;
  stages: Record<string, number>;
  timestamp: string;
}

export interface Interval {
  low: number;
  high: number;
}

export interface VariantSummary {
  n: number;
  medianMs: number;
  median95: Interval;
  worstMs: number;
  budgetFailures: number;
}

export interface CellSummary {
  cell: string;
  baseline: VariantSummary;
  candidate: VariantSummary;
  pairedDeltaPercent: number;
  pairedDelta95: Interval;
}

export interface StartupCell {
  language: "en_US" | "zh_CN";
  viewport: "480 272" | "960 544";
}

export const STARTUP_CELLS: readonly StartupCell[] = [
  { language: "en_US", viewport: "480 272" },
  { language: "en_US", viewport: "960 544" },
  { language: "zh_CN", viewport: "480 272" },
  { language: "zh_CN", viewport: "960 544" },
];

function cellName(cell: StartupCell): string {
  return `${cell.language}-${cell.viewport.replace(" ", "x")}`;
}

export function selectStartupCells(filter?: string): readonly StartupCell[] {
  if (!filter) return STARTUP_CELLS;
  const requested = new Set(filter.split(",").map((value) => value.trim()).filter(Boolean));
  const known = new Set(STARTUP_CELLS.map(cellName));
  const unknown = [...requested].filter((value) => !known.has(value));
  if (unknown.length > 0) {
    throw new Error(`unknown STARTUP_ABBA_CELLS: ${unknown.join(", ")}`);
  }
  const selected = STARTUP_CELLS.filter((cell) => requested.has(cellName(cell)));
  if (selected.length === 0) throw new Error("STARTUP_ABBA_CELLS selected no cells");
  return selected;
}

function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median requires at least one value");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
}

function random(seed: { value: number }): number {
  let value = seed.value | 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  seed.value = value | 0;
  return (value >>> 0) / 0x1_0000_0000;
}

export function bootstrapMedian95(
  values: readonly number[],
  iterations = 20_000,
  initialSeed = 0x51a7_7a2d,
): Interval {
  if (values.length === 0) throw new Error("bootstrap requires at least one value");
  const seed = { value: initialSeed };
  const medians = new Array<number>(iterations);
  const sample = new Array<number>(values.length);
  for (let iteration = 0; iteration < iterations; iteration++) {
    for (let index = 0; index < values.length; index++) {
      sample[index] = values[Math.floor(random(seed) * values.length)]!;
    }
    medians[iteration] = median(sample);
  }
  medians.sort((a, b) => a - b);
  return { low: percentile(medians, 0.025), high: percentile(medians, 0.975) };
}

export function summarizeStartupSamples(samples: readonly StartupSample[]): CellSummary[] {
  const cells = [...new Set(samples.map((sample) => sample.cell))].sort();
  return cells.map((cell) => {
    const rows = samples.filter((sample) => sample.cell === cell);
    const values = (variant: StartupSample["variant"]) =>
      rows.filter((sample) => sample.variant === variant).map((sample) => sample.startupMs);
    const summarizeVariant = (variant: StartupSample["variant"]): VariantSummary => {
      const selected = values(variant);
      return {
        n: selected.length,
        medianMs: median(selected),
        median95: bootstrapMedian95(selected),
        worstMs: Math.max(...selected),
        budgetFailures: rows.filter(
          (sample) => sample.variant === variant && !sample.budgetPassed,
        ).length,
      };
    };
    const windows = [...new Set(rows.map((sample) => sample.window))].sort((a, b) => a - b);
    const windowDeltas = windows.map((window) => {
      const inWindow = rows.filter((sample) => sample.window === window);
      const slots = [...inWindow].sort((a, b) => a.slot - b.slot);
      const expectedOrder = window % 2 === 1 ? "ABBA" : "BAAB";
      if (
        slots.length !== 4
        || slots.map((sample) => sample.slot).join(",") !== "1,2,3,4"
        || slots.some((sample) => sample.order !== expectedOrder)
        || slots.map((sample) => sample.variant === "baseline" ? "A" : "B").join("")
          !== expectedOrder
      ) {
        throw new Error(`startup summary requires a complete ${expectedOrder} window: ${cell} window ${window}`);
      }
      const baseline = median(
        inWindow.filter((sample) => sample.variant === "baseline").map((sample) => sample.startupMs),
      );
      const candidate = median(
        inWindow.filter((sample) => sample.variant === "candidate").map((sample) => sample.startupMs),
      );
      return (candidate / baseline - 1) * 100;
    });
    return {
      cell,
      baseline: summarizeVariant("baseline"),
      candidate: summarizeVariant("candidate"),
      pairedDeltaPercent: median(windowDeltas),
      pairedDelta95: bootstrapMedian95(windowDeltas, 20_000, 0x2f6e_19b3),
    };
  });
}

export function parseStartupOutput(output: string): {
  startupMs: number;
  hostStages: Record<string, number>;
  stages: Record<string, number>;
} {
  const boot = output.match(/\bBOOT\b[^\n]*\bstartup_to_first=([0-9.]+)ms/);
  if (!boot) throw new Error("startup benchmark produced no BOOT sample");
  const collect = (prefix: string): Record<string, number> => {
    const result: Record<string, number> = {};
    for (const line of output.split(/\r?\n/)) {
      if (!line.startsWith(prefix)) continue;
      const name = line.match(/\bname=([^ ]+)/)?.[1];
      const delta = line.match(/\bdelta_ms=(-?[0-9.]+)/)?.[1];
      if (name && delta !== undefined) result[name] = Number(delta);
    }
    return result;
  };
  return {
    startupMs: Number(boot[1]),
    hostStages: collect("HOST_STAGE "),
    stages: collect("STAGE "),
  };
}

interface CpuStat {
  total: number;
  idle: number;
}

function cpuStat(cpu: number): CpuStat {
  const line = readFileSync("/proc/stat", "utf8")
    .split("\n")
    .find((candidate) => candidate.startsWith(`cpu${cpu} `));
  if (!line) throw new Error(`logical CPU ${cpu} is not present in /proc/stat`);
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  return { total: fields.reduce((sum, value) => sum + value, 0), idle: fields[3] ?? 0 };
}

function cpuIdlePercent(before: CpuStat, after: CpuStat): number {
  const total = after.total - before.total;
  return total > 0 ? (after.idle - before.idle) / total * 100 : 0;
}

function requiredDirectory(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  const path = resolve(value);
  for (const file of ["pocket-tuxemon.js", "pocket-tuxemon.pak"]) {
    if (!existsSync(join(path, file))) throw new Error(`${name} is missing ${file}: ${path}`);
  }
  return path;
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  const baseline = requiredDirectory("STARTUP_BASELINE_DIST");
  const candidate = requiredDirectory("STARTUP_CANDIDATE_DIST");
  const output = resolve(
    process.env.STARTUP_ABBA_OUTPUT
      ?? join(process.env.TMPDIR ?? "/var/tmp", "pocket-tuxemon-startup-abba.ndjson"),
  );
  const log = output.replace(/\.ndjson$/, "") + ".log";
  const cpu = Number(process.env.STARTUP_BENCH_CPU ?? "0");
  const windows = Number(process.env.STARTUP_ABBA_WINDOWS ?? "10");
  const maxLoad = Number(process.env.STARTUP_MAX_LOAD ?? "6");
  if (!Number.isInteger(cpu) || cpu < 0) throw new Error("STARTUP_BENCH_CPU must be non-negative");
  if (!Number.isInteger(windows) || windows < 1) {
    throw new Error("STARTUP_ABBA_WINDOWS must be a positive integer");
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify({
    type: "header",
    baseline,
    candidate,
    cpu,
    windows,
    maxLoad,
    uptime: Bun.spawnSync(["uptime"], { stdout: "pipe" }).stdout.toString().trim(),
    startedAt: new Date().toISOString(),
  })}\n`);
  writeFileSync(log, "");
  const samples: StartupSample[] = [];
  const cells = selectStartupCells(process.env.STARTUP_ABBA_CELLS);
  for (const { language, viewport } of cells) {
    const cell = `${language}-${viewport.replace(" ", "x")}`;
    for (let window = 1; window <= windows; window++) {
      const order = window % 2 === 1 ? "ABBA" as const : "BAAB" as const;
      for (let slot = 0; slot < order.length; slot++) {
        const loadBefore = loadavg();
        if (loadBefore[0] > maxLoad) {
          throw new Error(
            `quiet startup batch refused at load ${loadBefore.map((value) => value.toFixed(2)).join(" ")} (limit ${maxLoad})`,
          );
        }
        const variant = order[slot] === "A" ? "baseline" as const : "candidate" as const;
        const dist = variant === "baseline" ? baseline : candidate;
        const env: Record<string, string> = {
          ...Object.fromEntries(
            Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
          ),
          G6_DIST: dist,
          G6_BENCH_ROOT: process.env.G6_BENCH_ROOT
            ?? join(process.env.TMPDIR ?? "/var/tmp", "pocket-tuxemon-quickjs"),
          G6_REUSE_HOST: "1",
          G6_SKIP_MAP_BENCH: "1",
          G6_STARTUP_ONLY: "1",
          G6_SHOW_TITLE: "1",
          G6_COLD_RUNS: "1",
          G6_BENCH_VIEWPORT: viewport,
        };
        delete env.G6_STARTUP_MS;
        delete env.G6_BUDGET_MS;
        delete env.G6_STARTUP_PROFILE;
        if (language === "zh_CN") env.G6_LANG = language;
        else delete env.G6_LANG;
        const cpuBefore = cpuStat(cpu);
        const started = performance.now();
        const run = Bun.spawnSync({
          cmd: ["taskset", "-c", String(cpu), "bash", "tools/bench-g6-quickjs.sh"],
          cwd: root,
          env,
          stdout: "pipe",
          stderr: "pipe",
        });
        const processWallMs = performance.now() - started;
        const cpuAfter = cpuStat(cpu);
        const loadAfter = loadavg();
        const text = `${run.stdout.toString()}${run.stderr.toString()}`;
        appendFileSync(
          log,
          `\n===== cell=${cell} window=${window} slot=${slot + 1} order=${order} variant=${variant} =====\n${text}`,
        );
        const parsed = parseStartupOutput(text);
        const sample: StartupSample = {
          type: "sample",
          cell,
          language,
          viewport: viewport.replace(" ", "x"),
          window,
          slot: slot + 1,
          order,
          variant,
          startupMs: parsed.startupMs,
          processWallMs,
          launcherEnvelopeMs: Math.max(0, processWallMs - parsed.startupMs),
          budgetPassed: run.exitCode === 0 && parsed.startupMs <= 250,
          exitCode: run.exitCode,
          loadBefore,
          loadAfter,
          cpuIdlePercent: cpuIdlePercent(cpuBefore, cpuAfter),
          hostStages: parsed.hostStages,
          stages: parsed.stages,
          timestamp: new Date().toISOString(),
        };
        samples.push(sample);
        appendFileSync(output, `${JSON.stringify(sample)}\n`);
        console.log(
          `STARTUP_ABBA cell=${cell} window=${window}/${windows} slot=${slot + 1}/4 order=${order} variant=${variant} startup=${sample.startupMs.toFixed(3)}ms budget=${sample.budgetPassed ? "pass" : "fail"} cpu_idle=${sample.cpuIdlePercent.toFixed(1)}% load=${loadBefore[0].toFixed(2)}`,
        );
      }
    }
  }
  const summary = summarizeStartupSamples(samples);
  appendFileSync(output, `${JSON.stringify({ type: "summary", summary })}\n`);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`STARTUP_ABBA_OUTPUT ${output}`);
  console.log(`STARTUP_ABBA_LOG ${log}`);
}

if (import.meta.main) await main();

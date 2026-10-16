export type BenchVariant = "baseline" | "candidate";

export interface Distribution {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  over16_7: number;
  over33: number;
}

export interface FrameSampleSummary {
  work: Distribution;
  raf: Distribution;
  longTasks: {
    count: number;
    totalMs: number;
    maxMs: number;
  };
}

export function quantile(values: readonly number[], probability: number): number {
  if (values.length === 0) return 0;
  if (!(probability >= 0 && probability <= 1)) {
    throw new RangeError(`quantile probability must be in [0, 1], got ${probability}`);
  }
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

export function median(values: readonly number[]): number {
  return quantile(values, 0.5);
}

export function distribution(values: readonly number[]): Distribution {
  const count = values.length;
  const ratio = (threshold: number): number => count === 0
    ? 0
    : values.filter((value) => value > threshold).length / count;
  return {
    count,
    p50: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    p99: quantile(values, 0.99),
    max: count === 0 ? 0 : Math.max(...values),
    over16_7: ratio(16.7),
    over33: ratio(33),
  };
}

export function summarizeFrames(
  work: readonly number[],
  raf: readonly number[],
  longTasks: readonly number[],
): FrameSampleSummary {
  return {
    work: distribution(work),
    raf: distribution(raf),
    longTasks: {
      count: longTasks.length,
      totalMs: longTasks.reduce((sum, value) => sum + value, 0),
      maxMs: longTasks.length === 0 ? 0 : Math.max(...longTasks),
    },
  };
}

/** Alternate ABBA and BAAB windows so warm-up or host drift cannot always
 * favour one build. Every complete window contributes two samples per build. */
export function alternatingWindows(windows: number): BenchVariant[][] {
  if (!Number.isSafeInteger(windows) || windows < 1) {
    throw new RangeError(`windows must be a positive integer, got ${windows}`);
  }
  return Array.from({ length: windows }, (_, index) => index % 2 === 0
    ? ["baseline", "candidate", "candidate", "baseline"]
    : ["candidate", "baseline", "baseline", "candidate"]);
}

export function medianDistribution(samples: readonly Distribution[]): Distribution {
  if (samples.length === 0) return distribution([]);
  return {
    count: Math.round(median(samples.map((sample) => sample.count))),
    p50: median(samples.map((sample) => sample.p50)),
    p95: median(samples.map((sample) => sample.p95)),
    p99: median(samples.map((sample) => sample.p99)),
    max: median(samples.map((sample) => sample.max)),
    over16_7: median(samples.map((sample) => sample.over16_7)),
    over33: median(samples.map((sample) => sample.over33)),
  };
}

export interface FrameGateInput {
  throttle: number;
  baseline: Distribution;
  candidate: Distribution;
  /** Relative paired-noise allowance. Default 8%. */
  regressionRatio?: number;
  /** Fixed paired-noise allowance in milliseconds. Default 0.5 ms. */
  regressionSlackMs?: number;
}

export interface FrameGateResult {
  pass: boolean;
  targetMs: number;
  regressionLimitMs: number;
  reasons: string[];
}

export function evaluateFrameGate(input: FrameGateInput): FrameGateResult {
  if (input.throttle !== 4 && input.throttle !== 6) {
    throw new RangeError(`mobile frame gate supports 4x or 6x CPU throttle, got ${input.throttle}`);
  }
  const targetMs = input.throttle === 4 ? 16.7 : 33;
  const ratio = input.regressionRatio ?? 1.08;
  const slack = input.regressionSlackMs ?? 0.5;
  const regressionLimitMs = input.baseline.p95 * ratio + slack;
  const reasons: string[] = [];
  if (input.candidate.count < 30) reasons.push(`only ${input.candidate.count} presented frames`);
  if (input.candidate.p95 > targetMs) {
    reasons.push(`candidate p95 ${input.candidate.p95.toFixed(3)} ms exceeds ${targetMs.toFixed(1)} ms`);
  }
  if (input.candidate.p95 > regressionLimitMs) {
    reasons.push(
      `candidate p95 ${input.candidate.p95.toFixed(3)} ms exceeds paired-noise limit ${regressionLimitMs.toFixed(3)} ms`,
    );
  }
  return { pass: reasons.length === 0, targetMs, regressionLimitMs, reasons };
}

export interface CpuProfileNode {
  id: number;
  callFrame: {
    functionName: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
}

export interface CpuProfile {
  nodes: CpuProfileNode[];
  samples?: number[];
  timeDeltas?: number[];
}

export interface ProfileHotspot {
  functionName: string;
  url: string;
  line: number;
  selfMs: number;
  samples: number;
}

export function splitProfileHotspots(profile: CpuProfile, limit = 10): {
  js: ProfileHotspot[];
  wasm: ProfileHotspot[];
} {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const totals = new Map<string, ProfileHotspot>();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  for (let index = 0; index < samples.length; index++) {
    const node = nodes.get(samples[index]!);
    if (!node) continue;
    const frame = node.callFrame;
    const key = `${frame.functionName}\u0000${frame.url}\u0000${frame.lineNumber}`;
    let hotspot = totals.get(key);
    if (!hotspot) {
      hotspot = {
        functionName: frame.functionName || "(anonymous)",
        url: frame.url,
        line: frame.lineNumber < 0 ? 0 : frame.lineNumber + 1,
        selfMs: 0,
        samples: 0,
      };
      totals.set(key, hotspot);
    }
    hotspot.samples++;
    hotspot.selfMs += (deltas[index] ?? 0) / 1000;
  }
  const sorted = [...totals.values()].sort((left, right) => right.selfMs - left.selfMs);
  const isWasm = (hotspot: ProfileHotspot): boolean =>
    hotspot.url.startsWith("wasm://") || hotspot.functionName.startsWith("wasm-function");
  return {
    js: sorted.filter((hotspot) => !isWasm(hotspot)).slice(0, limit),
    wasm: sorted.filter(isWasm).slice(0, limit),
  };
}

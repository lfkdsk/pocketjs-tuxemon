export type Disposition = "native" | "degraded" | "placeholder" | "dropped";

export interface CoverageEntry {
  kind: "action" | "condition";
  /** Display/grouping key: action type, or "is|not condition_type". */
  type: string;
  /** The raw Tuxemon type, used only for the S1 T1 membership check. */
  sourceType: string;
  disposition: Disposition;
  reason: string;
}

export interface CoverageRow {
  type: string;
  total: number;
  native: number;
  degraded: number;
  placeholder: number;
  dropped: number;
  reasons: Partial<Record<Disposition, string[]>>;
}

export interface CoverageSummary {
  types: number;
  uses: number;
  native: number;
  degraded: number;
  placeholder: number;
  dropped: number;
  nativePercent: number;
  executablePercent: number;
  tier1: {
    uses: number;
    percent: number;
    requiredUses: number;
    requiredPercent: number;
    meetsBaseline: boolean;
  };
}

export interface ExternalCoverageMaterialization {
  source: string;
  disposition: "native";
  events: number;
  actions: number;
  conditions: number;
  reason: string;
}

export interface CoverageReport {
  view: "source-file";
  accounting: "conversion-path";
  sourceEvents: number;
  externalMaterializations: ExternalCoverageMaterialization[];
  actions: { summary: CoverageSummary; rows: CoverageRow[] };
  conditions: { summary: CoverageSummary; rows: CoverageRow[] };
}

const T1_ACTIONS = new Set([
  "add_item",
  "add_tracker",
  "char_stop",
  "char_talk",
  "char_wander",
  "clear_variable",
  "load_yaml",
  "lock_controls",
  "modify_money",
  "pause_music",
  "play_music",
  "play_sound",
  "fadeout_music",
  "random_integer",
  "remove_collision",
  "set_random_variable",
  "set_variable",
  "transition_teleport",
  "translated_dialog",
  "translated_dialog_choice",
  "unlock_controls",
  "unpause_music",
  "wait",
]);

const T1_CONDITIONS = new Set([
  "button_pressed",
  "char_at",
  "char_facing_tile",
  "char_moved",
  "has_item",
  "location_inside",
  "location_type",
  "money_is",
  "music_playing",
  "tracker",
  "variable_set",
]);

function blank(type: string): CoverageRow {
  return {
    type,
    total: 0,
    native: 0,
    degraded: 0,
    placeholder: 0,
    dropped: 0,
    reasons: {},
  };
}

function percent(count: number, total: number, digits = 1): number {
  const scale = 10 ** digits;
  return Math.round(count * 100 * scale / total) / scale;
}

function aggregate(
  entries: CoverageEntry[],
  tier1Types: ReadonlySet<string>,
  baseline: { uses: number; percent: number },
): { summary: CoverageSummary; rows: CoverageRow[] } {
  const grouped = new Map<string, CoverageRow>();
  let tier1Uses = 0;
  for (const entry of entries) {
    const row = grouped.get(entry.type) ?? blank(entry.type);
    row.total++;
    row[entry.disposition]++;
    const reasons = row.reasons[entry.disposition] ?? [];
    if (!reasons.includes(entry.reason)) reasons.push(entry.reason);
    row.reasons[entry.disposition] = reasons;
    grouped.set(entry.type, row);
    if (tier1Types.has(entry.sourceType) &&
        (entry.disposition === "native" || entry.disposition === "degraded")) {
      tier1Uses++;
    }
  }
  const rows = [...grouped.values()].sort((a, b) =>
    a.type < b.type ? -1 : a.type > b.type ? 1 : 0
  );
  const uses = entries.length;
  const total = (key: Disposition) => rows.reduce((sum, row) => sum + row[key], 0);
  const native = total("native");
  const degraded = total("degraded");
  const placeholder = total("placeholder");
  const dropped = total("dropped");
  const tier1Percent = percent(tier1Uses, uses, 2);
  return {
    summary: {
      types: rows.length,
      uses,
      native,
      degraded,
      placeholder,
      dropped,
      nativePercent: percent(native, uses),
      executablePercent: percent(native + degraded + placeholder, uses),
      tier1: {
        uses: tier1Uses,
        percent: tier1Percent,
        requiredUses: baseline.uses,
        requiredPercent: baseline.percent,
        meetsBaseline: tier1Uses >= baseline.uses,
      },
    },
    rows,
  };
}

export function buildCoverageReport(
  sourceEvents: number,
  entries: readonly CoverageEntry[],
  externalMaterializations: readonly ExternalCoverageMaterialization[] = [],
): CoverageReport {
  const actions = entries.filter((entry) => entry.kind === "action");
  const conditions = entries.filter((entry) => entry.kind === "condition");
  return {
    view: "source-file",
    accounting: "conversion-path",
    sourceEvents,
    externalMaterializations: externalMaterializations.map((entry) => ({ ...entry })),
    actions: aggregate(actions, T1_ACTIONS, { uses: 6_246, percent: 45.9 }),
    conditions: aggregate(conditions, T1_CONDITIONS, { uses: 4_591, percent: 53.0 }),
  };
}

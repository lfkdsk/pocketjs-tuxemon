// Generate and verify the exhaustive non-Native event ranking in
// findings/G-EVENTS.md. Counts and disposition reasons come from the generated
// coverage artifacts; source locations are resolved at run time so line-number
// drift cannot silently stale the handoff.
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  loadAllFileEvents,
  loadAllMaps,
  MAPS_DIR,
  TUXEMON_SRC,
  type Cond,
  type Rule,
  type TuxEvent,
} from "../importer/source.ts";

const ROOT = resolve(import.meta.dir, "..");
const COVERAGE_MD = join(ROOT, "reports/G1-coverage.md");
const IMPORT_REPORT = join(ROOT, "dist/import-report.json");
const IMPORTER = join(ROOT, "importer/project.ts");
const BEGIN = "<!-- BEGIN GENERATED NON-NATIVE EVENT AUDIT -->";
const END = "<!-- END GENERATED NON-NATIVE EVENT AUDIT -->";

type Kind = "Action" | "Condition";
interface CoverageRow {
  type: string;
  total: number;
  native: number;
  degraded: number;
  placeholder: number;
  dropped: number;
  reasons: Partial<Record<"native" | "degraded" | "placeholder" | "dropped", string[]>>;
}
interface Report {
  coverage: {
    actions: { summary: CoverageRow; rows: CoverageRow[] };
    conditions: { summary: CoverageRow; rows: CoverageRow[] };
  };
}
interface LocatedRule {
  event: TuxEvent;
  rule: Rule | Cond;
}

function fail(message: string): never {
  throw new Error(`non-Native event audit: ${message}`);
}

function markdownRows(): Map<string, Omit<CoverageRow, "reasons">> {
  const rows = new Map<string, Omit<CoverageRow, "reasons">>();
  const pattern = /^\| (Action|Condition) \| `([^`]+)` \| (\d+) \| (\d+) \| (\d+) \| (\d+) \| (\d+) \|$/gm;
  for (const match of readFileSync(COVERAGE_MD, "utf8").matchAll(pattern)) {
    const [, kind, type, native, degraded, placeholder, dropped, total] = match;
    rows.set(`${kind}\0${type}`, {
      type: type!, native: Number(native), degraded: Number(degraded),
      placeholder: Number(placeholder), dropped: Number(dropped), total: Number(total),
    });
  }
  return rows;
}

const sourceEventKey = (event: TuxEvent): string => event.objectId === null
  ? `${event.source}:${event.kind}:${event.name}`
  : `${event.source}:object:${event.objectId}`;

function rulesFor(kind: Kind, type: string, event: TuxEvent): (Rule | Cond)[] {
  if (kind === "Action") return event.acts.filter((rule) => rule.type === type);
  const space = type.indexOf(" ");
  const op = type.slice(0, space);
  const base = type.slice(space + 1);
  return event.conds.filter((rule) => rule.op === op && rule.type === base);
}

function sourceCandidates(kind: Kind, type: string, events: readonly TuxEvent[]): LocatedRule[] {
  return events.flatMap((event) => rulesFor(kind, type, event).map((rule) => ({ event, rule })));
}

function chooseSample(
  kind: Kind,
  type: string,
  row: CoverageRow,
  candidates: readonly LocatedRule[],
  materializedKeys: ReadonlySet<string>,
): LocatedRule {
  const dropped = row.reasons.dropped ?? [];
  const score = ({ event }: LocatedRule): number => {
    let value = 0;
    const absent = !materializedKeys.has(sourceEventKey(event));
    if (dropped.some((reason) => reason.includes("not materialized")) && absent) value += 100;
    if (dropped.some((reason) => reason.includes("current_state")) &&
        event.conds.some((condition) => condition.type === "current_state" && !condition.args[0]?.split(":").includes("WorldState"))) value += 80;
    if (dropped.some((reason) => reason.includes("K_RETURN")) &&
        event.conds.some((condition) => condition.type === "button_pressed" && condition.args[0] === "K_RETURN")) value += 80;
    if (dropped.some((reason) => reason.includes("char_gender")) &&
        event.conds.some((condition) => condition.type === "char_gender")) value += 80;
    if (dropped.some((reason) => reason.includes("direction 'bottom'")) &&
        event.conds.some((condition) => condition.type === "char_facing" && condition.args[1] === "bottom")) value += 80;
    if (dropped.some((reason) => reason.includes("zero-size")) && (!event.w || !event.h)) value += 70;
    if (dropped.some((reason) => reason.includes("never starts an event without")) &&
        event.conds.length === 0 && event.behavs.length === 0) value += 70;
    return value;
  };
  const sorted = [...candidates].sort((a, b) => score(b) - score(a) ||
    a.event.source.localeCompare(b.event.source) || a.event.name.localeCompare(b.event.name));
  return sorted[0] ?? fail(`${kind} ${type} has coverage but no source rule`);
}

function sourceLine(sample: LocatedRule): string {
  const path = join(MAPS_DIR, sample.event.source);
  const lines = readFileSync(path, "utf8").split("\n");
  const raw = sample.rule.raw;
  let start = 0;
  if (path.endsWith(".tmx")) {
    const objectNeedle = sample.event.objectId === null ? "" : `id=\"${sample.event.objectId}\"`;
    const found = objectNeedle ? lines.findIndex((line) => line.includes("<object ") && line.includes(objectNeedle)) : -1;
    if (found >= 0) start = found;
  } else {
    const found = lines.findIndex((line) => line.trim() === `${sample.event.name}:`);
    if (found >= 0) start = found;
  }
  const end = path.endsWith(".tmx")
    ? Math.min(lines.length, start + 80)
    : Math.min(lines.length, start + 120);
  let index = lines.slice(start, end).findIndex((line) => line.includes(raw));
  if (index >= 0) index += start;
  else index = lines.findIndex((line) => line.includes(raw));
  if (index < 0) fail(`cannot locate raw rule '${raw}' in ${sample.event.source}`);
  return `mods/tuxemon/maps/${sample.event.source}:${index + 1}`;
}

function lineContaining(lines: readonly string[], needle: string, start = 0, end = lines.length): number {
  const index = lines.slice(start, end).findIndex((line) => line.includes(needle));
  return index < 0 ? -1 : start + index + 1;
}

function importerLine(kind: Kind, type: string): string {
  const lines = readFileSync(IMPORTER, "utf8").split("\n");
  const base = kind === "Action" ? type : type.slice(type.indexOf(" ") + 1);
  if (kind === "Action") {
    const start = lines.findIndex((line) => line.includes("function convertActions("));
    const end = lines.findIndex((line, index) => index > start && line.startsWith("function "));
    const direct = lineContaining(lines, `case \"${base}\"`, start, end < 0 ? lines.length : end);
    const fallbackIndex = lines.slice(start, end < 0 ? lines.length : end)
      .findIndex((line) => line === "      default:");
    const fallback = fallbackIndex < 0 ? -1 : start + fallbackIndex + 1;
    const line = direct > 0 ? direct : fallback;
    if (line < 1) fail(`cannot locate importer action branch for ${type}`);
    return `importer/project.ts:${line}`;
  }
  const start = lines.findIndex((line) => line.startsWith("function clauses("));
  const end = lines.findIndex((line, index) => index > start && line.startsWith("function toIf("));
  const direct = lineContaining(lines, `case \"${base}\"`, start, end);
  const trigger = lineContaining(lines, `c.type === \"${base}\"`, start, end);
  const listed = lineContaining(lines, `\"${base}\"`, 0, end);
  const fallbackIndex = lines.slice(start, end).findIndex((line) => line === "    default:");
  const fallback = fallbackIndex < 0 ? -1 : start + fallbackIndex + 1;
  const line = direct > 0 ? direct : trigger > 0 ? trigger : listed > 0 ? listed : fallback;
  if (line < 1) fail(`cannot locate importer condition branch for ${type}`);
  return `importer/project.ts:${line}`;
}

function importerEvidence(kind: Kind, type: string, row: CoverageRow): string {
  const lines = readFileSync(IMPORTER, "utf8").split("\n");
  const refs = new Set<string>([importerLine(kind, type)]);
  const anchor = (needle: string) => {
    const line = lineContaining(lines, needle);
    if (line > 0) refs.add(`importer/project.ts:${line}`);
  };
  for (const reason of [...(row.reasons.degraded ?? []), ...(row.reasons.dropped ?? [])]) {
    if (reason.includes("source event is not materialized")) anchor("absent.dropAll(\"source event is not materialized by any map\")");
    if (reason.includes("never starts an event without")) anchor("if (!e.conds.some((condition) => !condition.synthetic) && !e.behavs.length)");
    if (reason.includes("zero-size TMX event")) anchor("if (e.origin === \"tmx\" && (e.w === 0 || e.h === 0))");
    if (reason.startsWith("fixed-false guard")) anchor("const fixedFalse = cls.find(");
    if (reason.includes("every action was removed")) anchor("if (!cmds.length)");
  }
  return [...refs].map((ref) => `\`${ref}\``).join(", ");
}

function upstreamLine(kind: Kind, type: string): string {
  const base = kind === "Action" ? type : type.slice(type.indexOf(" ") + 1);
  const group = kind === "Action" ? "actions" : "conditions";
  const path = join(TUXEMON_SRC, "tuxemon/event", group, `${base}.py`);
  if (existsSync(path)) {
    const lines = readFileSync(path, "utf8").split("\n");
    const method = kind === "Action" ? "    def start(" : "    def test(";
    let line = lineContaining(lines, method);
    if (line < 1) line = lineContaining(lines, `name = \"${base}\"`);
    if (line < 1) line = lineContaining(lines, `name: ClassVar[str] = \"${base}\"`);
    if (line < 1) fail(`cannot locate upstream entry point for ${kind} ${type}`);
    return `tuxemon/event/${group}/${base}.py:${line}`;
  }
  const fallback = join(TUXEMON_SRC, "tuxemon/event", kind === "Action" ? "eventaction.py" : "eventcondition.py");
  const lines = readFileSync(fallback, "utf8").split("\n");
  const line = lines.findIndex((value) => value.includes("not implemented")) + 1;
  if (!line) fail(`cannot locate upstream missing-handler path for ${kind} ${type}`);
  return `tuxemon/event/${kind === "Action" ? "eventaction.py" : "eventcondition.py"}:${line} (no ${base} handler)`;
}

function effect(kind: Kind, type: string, row: CoverageRow): { priority: number; label: string } {
  const base = kind === "Action" ? type : type.slice(type.indexOf(" ") + 1);
  const includes = (...values: string[]) => values.includes(base);
  let priority = 3;
  let label = "story/runtime state";
  if (includes("translated_dialog", "translated_dialog_choice")) {
    priority = 1; label = "dialogue or player choice";
  } else if (includes("add_item", "access_pc")) {
    priority = 1; label = "inventory/economy";
  } else if (includes("start_battle", "wild_encounter", "battle_outcome", "random_monster",
    "park_experience", "party_size", "char_defeated", "check_max_tech", "get_pending_moves",
    "remove_tech", "set_monster_level", "set_party_status", "modify_monster_bond", "quarantine",
    "get_player_monster")) {
    priority = 1; label = "battle or party progression";
  } else if (includes("transition_teleport")) {
    priority = 1; label = "map transfer";
  } else if (includes("char_face", "char_move", "char_position", "char_run", "char_speed", "char_wander",
    "char_at", "char_facing", "char_facing_tile", "char_in", "player_facing_tile", "button_pressed")) {
    priority = 2; label = "movement/facing/input";
  } else if (includes("create_npc", "char_exists")) {
    priority = 2; label = "NPC presence/story staging";
  } else if (includes("play_music", "set_environment", "set_template", "wait")) {
    priority = 2; label = "world presentation/timing";
  } else if (includes("open_journal", "rename_player", "set_tuxepedia", "tune_radio", "change_taste", "dojo_method")) {
    priority = 2; label = "player-visible UI/presentation";
  } else if (includes("variable_set", "set_variable", "load_yaml", "current_state")) {
    priority = 2; label = "story branch/event availability";
  } else if (includes("environment_is")) {
    priority = 2; label = "battle-environment branch";
  } else if (includes("add_step_tracker", "add_tracker", "check_char_parameter", "tile_property_updated")) {
    priority = 3; label = "step/terrain trigger fidelity";
  } else if (includes("char_gender", "cooldown_days", "set_char_attribute", "update_time")) {
    priority = 3; label = "character/meta state";
  } else if (base === "not" || base === "quit_world") {
    priority = 4; label = "invalid/orphan or non-campaign meta action";
  }
  const reasons = row.reasons.dropped ?? [];
  const cannotRun = (reason: string) =>
    reason.includes("source event is not materialized") ||
    reason.includes("never starts an event without") ||
    reason.includes("zero-size TMX event") ||
    reason.includes("every action was removed") ||
    reason.includes("source button 'K_RETURN'") ||
    reason.includes("source direction 'bottom'") ||
    reason.includes("source direction 'top'");
  if (row.degraded === 0 && reasons.length > 0 && reasons.every(cannotRun)) {
    priority = 4;
    label = `no reachable effect for the non-Native uses; semantic effect would be ${label}`;
  } else if (row.degraded === 0 && reasons.length > 0 &&
      reasons.every((reason) => cannotRun(reason) || reason.includes("current_state") || reason === "presentation / meta")) {
    priority = Math.max(priority, 3);
    label = `battle/menu-only or meta path; ${label}`;
  }
  if (kind === "Condition") label += "; guard controls whether its event runs";
  return { priority, label };
}

function clean(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function dispositionReasons(row: CoverageRow): string {
  const parts = [
    ...(row.reasons.degraded ?? []).map((reason) => `Degraded: ${reason}`),
    ...(row.reasons.dropped ?? []).map((reason) => `Dropped: ${reason}`),
  ];
  return clean(parts.join("; "));
}

const report = JSON.parse(readFileSync(IMPORT_REPORT, "utf8")) as Report;
const mdRows = markdownRows();
const sourceEvents = loadAllFileEvents();
const maps = loadAllMaps();
const materializedKeys = new Set(maps.flatMap((map) => map.events.map(sourceEventKey)));
const allRows: { kind: Kind; row: CoverageRow }[] = [
  ...report.coverage.actions.rows.map((row) => ({ kind: "Action" as const, row })),
  ...report.coverage.conditions.rows.map((row) => ({ kind: "Condition" as const, row })),
].filter(({ row }) => row.degraded > 0 || row.dropped > 0);

for (const { kind, row } of allRows) {
  const md = mdRows.get(`${kind}\0${row.type}`) ?? fail(`coverage markdown is missing ${kind} ${row.type}`);
  for (const field of ["native", "degraded", "placeholder", "dropped", "total"] as const) {
    if (md[field] !== row[field]) fail(`${kind} ${row.type} ${field}: markdown=${md[field]} json=${row[field]}`);
  }
  const candidates = sourceCandidates(kind, row.type, sourceEvents);
  if (candidates.length !== row.total) {
    fail(`${kind} ${row.type}: parsed source uses=${candidates.length}, coverage total=${row.total}`);
  }
}

const ranked = allRows.map(({ kind, row }) => {
  const candidates = sourceCandidates(kind, row.type, sourceEvents);
  const sample = chooseSample(kind, row.type, row, candidates, materializedKeys);
  const affectedMaps = new Set<string>();
  let affectedEvents = 0;
  for (const map of maps) {
    for (const event of map.events) {
      const count = rulesFor(kind, row.type, event).length;
      if (!count) continue;
      affectedMaps.add(map.slug);
      affectedEvents += count;
    }
  }
  return { kind, row, sample, affectedMaps: affectedMaps.size, affectedEvents, ...effect(kind, row.type, row) };
}).sort((a, b) => a.priority - b.priority || b.row.dropped - a.row.dropped ||
  b.row.degraded - a.row.degraded || a.kind.localeCompare(b.kind) || a.row.type.localeCompare(b.row.type));

const tableLines = [
  "| Rank | Kind / source type | N / Dgr / Drop / Total | Materialized reach | Player-perceivable effect | Current limitation / hard reason | Evidence (importer · upstream · source sample) |",
  "|---:|---|---:|---:|---|---|---|",
  ...ranked.map(({ kind, row, sample, affectedMaps, affectedEvents, priority, label }) => {
    const sampleId = sample.event.objectId === null ? sample.event.name : `${sample.event.name || "object"}#${sample.event.objectId}`;
    const reach = `${affectedMaps} maps / ${affectedEvents} uses; ${sourceCandidates(kind, row.type, sourceEvents).length} source uses`;
    return `| P${priority} | ${kind} \`${row.type}\` | ${row.native} / ${row.degraded} / ${row.dropped} / ${row.total} | ${reach} | ${label} | ${dispositionReasons(row)} | ${importerEvidence(kind, row.type, row)} · \`${upstreamLine(kind, row.type)}\` · \`${sourceLine(sample)}\` \`${clean(sampleId)}\` |`;
  }),
];
const table = tableLines.join("\n");
const actions = allRows.filter((entry) => entry.kind === "Action");
const conditions = allRows.filter((entry) => entry.kind === "Condition");
const dispositions = allRows.reduce((total, { row }) =>
  total + Number(row.degraded > 0) + Number(row.dropped > 0), 0);
const actionSummary = report.coverage.actions.summary;
const conditionSummary = report.coverage.conditions.summary;
const hash = new Bun.CryptoHasher("sha256").update(table).digest("hex");
const summary = [
  `AUDIT non_native_rows=${allRows.length} actions=${actions.length} conditions=${conditions.length} dispositions=${dispositions}`,
  `AUDIT coverage actions=${actionSummary.native}/${actionSummary.degraded}/${actionSummary.dropped} conditions=${conditionSummary.native}/${conditionSummary.degraded}/${conditionSummary.dropped}`,
  `AUDIT table_sha256=${hash}`,
].join("\n");

const checkIndex = process.argv.indexOf("--check");
if (checkIndex >= 0) {
  const reportPath = resolve(process.argv[checkIndex + 1] ?? join(ROOT, "findings/G-EVENTS.md"));
  const text = readFileSync(reportPath, "utf8");
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (begin < 0 || end < begin) fail(`${relative(ROOT, reportPath)} has no generated audit markers`);
  const actual = text.slice(begin + BEGIN.length, end).trim();
  if (actual !== table) fail(`${relative(ROOT, reportPath)} generated table is stale; rerun this tool and replace the marked block`);
  console.log(summary);
  console.log(`AUDIT report=${relative(ROOT, reportPath)} status=PASS`);
} else {
  console.log(table);
  console.log();
  console.log(summary);
}

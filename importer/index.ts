import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  availableMapIds,
  buildProject,
  DEFAULT_MAPS,
  KIT_V2_IMPORT_OPTIONS,
  type ImportOptions,
  type ImportReport,
} from "./project.ts";
import {
  PREVIEW_REASON_LABELS,
  type PreviewCoverageTotals,
} from "./preview-coverage.ts";
import { SANDBOX_PREVIEW_REJECT_REASONS } from "../vendor/pocket-rpgkit/src/engine/world-preview-sandbox.ts";

export interface ImportPaths {
  project: string;
  variables: string;
  world: string;
  report: string;
  coverage: string;
}

export function jsonBytes(value: unknown): string {
  return JSON.stringify(value, null, 1) + "\n";
}

function previewTotalsLine(totals: PreviewCoverageTotals): string {
  return `${totals.maps} maps, ${totals.events} events: ${totals.previewed} previewable`
    + ` (${totals.fallback} from the static rules), ${totals.hidden} hidden, ${totals.rejected} rejected;`
    + ` ${totals.previewablePercent}% of the events that paint are previewable;`
    + ` ${totals.mapsWithPreview} maps show at least one character`;
}

/** The neighbour character preview section (bilingual: the same section
 *  ships in the en_US and zh_CN report files). */
function previewSection(report: ImportReport): string {
  const preview = report.preview;
  if (!preview) {
    return `## Neighbour character preview / 邻图 NPC 预览

Not computed by this import path (only the full cook, \`bun run import\`, runs
the sandbox).
`;
  }
  const reasonRows = SANDBOX_PREVIEW_REJECT_REASONS
    .map((reason) => `| \`${reason}\` | ${preview.all.reasons[reason]} | ${preview.mainline.reasons[reason]} | ${PREVIEW_REASON_LABELS[reason]} |`)
    .join("\n");
  const perMapRows = preview.perMap
    .map((row) => {
      const reasons = SANDBOX_PREVIEW_REJECT_REASONS
        .filter((reason) => (row.reasons[reason] ?? 0) > 0)
        .map((reason) => `${reason}:${row.reasons[reason]}`)
        .join(", ");
      return `| \`${row.mapId}\` | ${row.events} | ${row.previewed} | ${row.fallback} | ${row.hidden} | ${row.rejected} | ${reasons || "—"} |`;
    })
    .join("\n");
  return `## Neighbour character preview / 邻图 NPC 预览

The world renderer previews the characters on visible neighbour maps by
entering each map in a sandbox: a private copy of the durable state goes
through the real map entry, folds the first target tick and is read back
(kit README, "Sandboxed-entry preview"). The game's cache key drops the step
countdowns and keeps, of the clock and weather, the ${preview.probes.key} (every
\`time_is\` property is a function of the day and hour); the volatile probe moves the
minute by ${preview.probes.minuteShift} inside the same hour. This table is the same
verdict at the ${preview.evaluatedAt} state; \`bun run verify:preview:coverage\`
repeats it at every mainline chapter.

世界渲染器在沙盒里真实进入邻图（持久状态的私有副本、跑第一个目标 tick）来画邻图上的人；
游戏钩子的缓存键去掉步数倒计时，时钟与天气只保留日期、小时与天气（\`time_is\` 的每个属性都由日期和小时决定）；扰动探针在同一小时内把分钟拨 ${preview.probes.minuteShift}。
下表是新游戏状态下的结果；各主线章节的结果见 \`bun run verify:preview:coverage\`。

- All maps / 全部地图: ${previewTotalsLine(preview.all)}.
- Mainline (\`spyder_*\`) / 主线: ${previewTotalsLine(preview.mainline)}.

| Reject reason / 拒绝原因 | All / 全部 | Mainline / 主线 | Meaning / 含义 |
|---|---:|---:|---|
${reasonRows}

Maps with a previewable or rejected event / 有可预览或被拒绝事件的地图
(every other map only holds hidden events / 其余地图只有隐藏事件):

| Map | Events | Previewable | Static | Hidden | Rejected | Reasons |
|---|---:|---:|---:|---:|---:|---|
${perMapRows}
`;
}

export function coverageMarkdown(report: ImportReport): string {
  const { actions, conditions } = report.coverage;
  const baselineDelta = (value: typeof actions.summary): string => {
    const delta = value.tier1.uses - value.tier1.requiredUses;
    return `${Math.abs(delta)} ${delta >= 0 ? "above" : "below"}`;
  };
  const summary = (kind: string, value: typeof actions.summary) =>
    `| ${kind} | ${value.types} | ${value.uses} | ${value.native} | ${value.degraded} | ${value.placeholder} | ${value.dropped} | ${value.tier1.uses} / ${value.tier1.requiredUses} (${value.tier1.percent.toFixed(2)}% / ${value.tier1.requiredPercent.toFixed(1)}%) |`;
  const rows = (kind: string, values: typeof actions.rows) => values
    .map((row) =>
      `| ${kind} | \`${row.type}\` | ${row.native} | ${row.degraded} | ${row.placeholder} | ${row.dropped} | ${row.total} |`
    )
    .join("\n");
  const placeholderRows = [
    ...actions.rows.map((row) => ({ kind: "Action", row })),
    ...conditions.rows.map((row) => ({ kind: "Condition", row })),
  ].filter(({ row }) => row.placeholder > 0);
  const placeholderUses = placeholderRows.reduce((sum, { row }) => sum + row.placeholder, 0);
  const placeholderAudit = placeholderRows.map(({ kind, row }) =>
    `| ${kind} | \`${row.type}\` | ${row.placeholder} | ${(row.reasons.placeholder ?? []).join("; ")} |`
  ).join("\n");
  const repairs = report.transferRepairs.length
    ? report.transferRepairs.map((repair) =>
      `- \`${repair.sourceMap}\` → \`${repair.targetMap}\`: requested (${repair.requested.x}, ${repair.requested.y}), clamped (${repair.clamped.x}, ${repair.clamped.y}), emitted (${repair.emitted.x}, ${repair.emitted.y})`
    ).join("\n")
    : "- None.";
  const openShop = actions.rows.find((row) => row.type === "open_shop");
  const partyMonster = actions.rows.find((row) => row.type === "get_party_monster");
  const playerMonster = actions.rows.find((row) => row.type === "get_player_monster");
  const choiceMonster = actions.rows.find((row) => row.type === "choice_monster");
  const worldRows = report.world.worlds.map((world) =>
    `| ${world.worldId} | ${world.outdoorMaps} / ${world.sourceMembers} | ${world.bboxTiles.width}×${world.bboxTiles.height} | ${world.geometricContacts} | ${world.acceptedSeams} | ${world.coordinatePreservingSeams} / ${world.mixedHandoffSeams} / ${world.portalOnlySeams} / ${world.directionOnlySeams} | ${world.rejectedGeometricContacts} | ${world.rejectedGaps} | ${world.dimensionCorrections} | ${world.componentSizes.join(" + ")} |`
  ).join("\n");
  const handoffExclusions = report.seamlessHandoff.notEnabled.length
    ? report.seamlessHandoff.notEnabled.map((row) => `| \`${row.reason}\` | ${row.count} |`).join("\n")
    : "| None | 0 |";
  const missingSafeOpenings = report.seamlessHandoff.notEnabledSafePortalIds.length
    ? report.seamlessHandoff.notEnabledSafePortalIds.map((portalId) => `- \`${portalId}\``).join("\n")
    : "- None";
  const partialPromotions = report.seamlessHandoff.partialPromotions.length
    ? report.seamlessHandoff.partialPromotions.map((promotion) =>
      `| \`${promotion.portalId}\` | \`${promotion.sourceMap}@${promotion.source.x},${promotion.source.y}\` | \`${promotion.targetMap}@${promotion.target.x},${promotion.target.y}\` | ${promotion.legacyCells} |`
    ).join("\n")
    : "| None | — | — | 0 |";
  const fullyLegacyPortalOnly = report.seamlessHandoff.fullyLegacyPortalOnlyPortalIds.length
    ? report.seamlessHandoff.fullyLegacyPortalOnlyPortalIds.map((portalId) => `- \`${portalId}\``).join("\n")
    : "- None";
  return `# G1 import coverage

Generated by \`bun run import\` from the pinned Tuxemon source. Counts use the
per-file source view: shared scenario YAML is counted once. Dispositions are
recorded inside the converter branch that handles each action/condition, using
the highest-support materialization of a shared event (with map-id order as the
deterministic tie-breaker).
When conversion discards a whole event, every source rule in it is Dropped.

## Summary

| Kind | Kinds | Uses | Native | Degraded | Placeholder | Dropped | S1 T1 baseline |
|---|---:|---:|---:|---:|---:|---:|---:|
${summary("Actions", actions.summary)}
${summary("Conditions", conditions.summary)}

The S1 acceptance baselines are 6,246 action uses (45.9%) and 4,591
condition uses (53.0%). Only T1 source types whose disposition is Native or
Degraded count toward them. This import records ${actions.summary.tier1.uses}
(${actions.summary.tier1.percent.toFixed(2)}%) and ${conditions.summary.tier1.uses}
(${conditions.summary.tier1.percent.toFixed(2)}%), respectively: ${baselineDelta(actions.summary)}
for actions and ${baselineDelta(conditions.summary)} for conditions. The old
type-table Native figure was 5,448 / 13,617 (40.0%); conversion-path accounting
supersedes it with ${actions.summary.native} / ${actions.summary.uses}
(${actions.summary.nativePercent.toFixed(1)}%). “Executable”
(native + degraded + deliberate P1 placeholder) is
${actions.summary.executablePercent.toFixed(1)}% for actions and
${conditions.summary.executablePercent.toFixed(1)}% for conditions.

Definitions:

- **Native**: represented by current RPG Kit v1 commands without a gameplay loss.
- **Degraded**: runs in v1 with a documented limitation or importer lowering.
- **Placeholder**: deliberate visible or deterministic fallback for behavior
  whose complete runtime or presentation mapping has not landed yet.
- **Dropped**: no equivalent output, including rules inside an event that the
  converter proves cannot start or otherwise omits. Per-disposition reasons are
  retained in \`dist/import-report.json\`.

## Dialogue layout parameter coverage

Tuxemon's \`translated_dialog\` carries optional position and word-alignment
parameters in addition to its translation key. All
${report.dialogLayout.actionsWithLayout} source-file actions that carry at least
one layout parameter are Native; none are discarded. Missing/default parameters
remain absent from generated \`text\` commands, preserving the existing default
box bytes.

| Scope | Source uses | Native | Dropped |
|---|---:|---:|---:|
| Actions with any layout parameter | ${report.dialogLayout.actionsWithLayout} | ${report.dialogLayout.native} | ${report.dialogLayout.dropped} |
| \`position\` | ${report.dialogLayout.parameters.position.source} | ${report.dialogLayout.parameters.position.native} | ${report.dialogLayout.parameters.position.dropped} |
| \`h_alignment\` | ${report.dialogLayout.parameters.hAlignment.source} | ${report.dialogLayout.parameters.hAlignment.native} | ${report.dialogLayout.parameters.hAlignment.dropped} |
| \`v_alignment\` | ${report.dialogLayout.parameters.vAlignment.source} | ${report.dialogLayout.parameters.vAlignment.native} | ${report.dialogLayout.parameters.vAlignment.dropped} |

## P2 battle and monster placeholder audit

There are ${placeholderUses} source-file uses across ${placeholderRows.length}
source types that still carry Placeholder disposition: battle/monster behavior.
Player-versus-trainer, double, scripted-wild, random-wild, battle-outcome,
party-size, has-monster, evolution, environment, faint-transfer, and live-party
defeat behavior are Native. The remaining non-native behavior is explicit:

| Kind | Source type | Placeholder uses | Reason |
|---|---|---:|---|
${placeholderAudit}

The five \`start_battle\` NPC-versus-NPC scenes play out in the real battle
scene as spectator fights: both parties, their techniques, damage and results
are visible, the player cannot open menus, and confirm toggles fast-forward
(1x/2x/4x) while cancel skips to the result. The outcome matches the headless
resolver exactly — one RNG draw from the saved cursor, post-spawn seed, seeded
AI policy on both sides — and a decisive fight is recorded per upstream. A true draw is Degraded: upstream raises before
either result variable is written, so this port writes the draw code and
the fighter (challenger) trainer code as a deterministic fallback. The
other rows are global or legacy content. \`get_player_monster\` has
${playerMonster?.native ?? 0} Native uses (the KC1 \`extChoice\` over the live
party) and ${playerMonster?.degraded ?? 0} Degraded uses (the party picker that
feeds an adjacent \`rename_monster\`); \`choice_monster\` has
${choiceMonster?.native ?? 0} Native uses: authored \`choices\` boxes whose rows
show the monster's static menu-face icon beside its translated name (upstream's
animated 24 px menu faces are baked to one 16 px frame, a visual downgrade).
\`choice_npc\` is Native: a choice box whose rows show each
appearance's front walker frame as an icon, beside the shared label and the
option's own name. \`remove_monster\` deletes an iid
from its owner. An NPC's party lives as long as the NPC, as upstream: it is
cleared when the NPC is created afresh (every map entry) or removed, and
battle-time monsters stay in it until then. All
${(partyMonster?.native ?? 0) + (partyMonster?.degraded ?? 0)} executable
\`get_party_monster\` uses are Native: NPC trainer parties are staged live
(not folded into the battle setup) when an event inspects or mutates them,
so \`iid_slot_*\` always has a party to read. Scripted \`trading\` runs the \`tux.trade\` scene,
which replaces the sent monster in its party slot with a freshly spawned
monster at the same level and records it as caught. \`access_pc\` opens the
\`tux.pc\` storage scene (monster boxes plus the item locker: deposit,
withdraw with a quantity picker, and disband); \`create_kennel\`,
\`set_kennel_visible\`, \`kennel\` and
\`has_kennel\` read and write the same saved boxes. \`quarantine\` is Degraded
(it moves infected monsters between the party and the hidden \`boxes.quarantine\`
box, honouring the box's own capacity; unlike upstream it keeps an
over-capacity monster inoculated in the party instead of renaming the full
box into a successor. That branch is unreachable in the authored campaign:
both admissions share one one-shot guard and can move at most the six-member
party into a hidden capacity-30 box. Release matches upstream, including a
full-party release appending past the ordinary Kennel capacity),
and \`park_experience\` with the unreachable
Eclipse park session. Plague-state rows stay deterministic without being
claimed as full P2 behavior. The long-term target remains zero Placeholder
uses.

## Economy and item catalog

The importer read ${report.economy.sourceEconomies} economies with
${report.economy.itemGoods} item rows and ${report.economy.monsterGoods} monster
rows. Item shops changed from the prior 0 Native / 28 Placeholder baseline to
${openShop?.native ?? 0} Native / ${openShop?.placeholder ?? 0} Placeholder.
Monster purchases (\`buy_monster\`) open the \`tux.monsterShop\` scene with
the economy's price, level and stock; sales are saved per
\`<economy>:<slug>\` stock label. The imported
item rows include ${report.economy.finiteStockGoods} finite-stock goods and
${report.economy.conditionedGoods} variable-conditioned goods.

The project item catalog contains ${report.economy.itemCatalog.uniqueItems}
unique slugs from ${report.economy.itemCatalog.sourceRows} source rows, with
translated names, intrinsic prices, and \`behaviors.resellable\` mapped to
\`Item.sellable\`. All translated descriptions are retained in the machine
report; the v1 project Item schema has no description field, so displaying them
is currently degraded.

Item sprites point at the declared \`${report.itemIcons.sheet.id}\` sheet
(${report.itemIcons.sheet.cols}x${report.itemIcons.sheet.rows} cells, pak
\`${report.itemIcons.sheet.pak}\`). ${report.itemIcons.uniqueIcons} upstream
icon files are baked into one TILESET entry; ${report.itemIcons.missing.length}
item${report.itemIcons.missing.length === 1 ? "" : "s"} without upstream art
share the placeholder cell ${report.itemIcons.placeholderCell}:${
  report.itemIcons.missing.length
    ? ` ${report.itemIcons.missing.map((slug) => `\`${slug}\``).join(", ")}`
    : " none"
}.

- **Degraded — full bag:** ${report.economy.limitations.lockerOverflow.reason}
- **Degraded — item descriptions:** ${report.economy.limitations.itemDescription.reason}

## Outdoor world index

The four Tiled world files contribute ${report.world.totals.sourceMembers} source
members. TMX \`inside=true\` excludes ${report.world.totals.excludedIndoorMaps}
interiors, leaving ${report.world.totals.outdoorMaps} stitchable outdoor maps.
Corrected TMX geometry yields ${report.world.totals.geometricContacts} positive-span
edge contacts: ${report.world.totals.acceptedSeams} enter the evidence-backed seam
allowlist and ${report.world.totals.rejectedGeometricContacts} remain rejected.
The index also records ${report.world.totals.rejectedGaps} non-spatial portal/cardinal links,
${report.world.totals.rejectedOverlaps} overlaps, and
${report.world.totals.dimensionCorrections} stale/zero source dimensions
(${report.world.totals.outdoorDimensionCorrections} outdoors).

Topology evidence does not by itself authorize coordinate-preserving handoff.
Of the allowlisted seams, ${report.world.totals.coordinatePreservingSeams} have
only compatible portal openings, ${report.world.totals.mixedHandoffSeams} mix
compatible and portal-only openings, ${report.world.totals.portalOnlySeams} have
only fixed/misaligned portal openings, and ${report.world.totals.directionOnlySeams}
have cardinal metadata but no edge portal. Across individual openings,
${report.world.totals.coordinatePreservingOpenings} are coordinate-preserving and
${report.world.totals.portalOnlyOpenings} must retain teleport semantics.
${report.world.totals.ambiguousDirections} non-unique cardinal aliases are retained
as ambiguity diagnostics and are not expanded into pairwise gaps.

Artifact: \`${report.world.artifact}\`; content SHA-256:
\`${report.world.contentHash}\`. S5 expected ${report.world.s5Comparison.expectedSeams}
accepted seams; generated ${report.world.s5Comparison.actualSeams}
(${report.world.s5Comparison.matches ? "match" : `mismatch: ${report.world.s5Comparison.differences.join("; ")}`}).

| World | Outdoor / source | Bbox tiles | Contacts | Allowlisted | Handoff seams (safe / mixed / portal / direction) | Rejected contacts | Linked gaps | Size fixes | Components |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${worldRows}

## Seamless opening handoff

The generated project opts into \`${report.seamlessHandoff.mode}\`. Of
${report.seamlessHandoff.topologySafeOpenings} coordinate-preserving topology openings,
all are runtime-direct. A further ${report.seamlessHandoff.partialPromotions.length} fixed-destination
rectangles each expose their one already-coordinate-continuous lane without changing
the authored fixed landing: ${report.seamlessHandoff.partialSeamlessCells} such cells are
seamless and ${report.seamlessHandoff.partialLegacyCells} funneling cells in the same
rectangles keep the legacy fade. In total ${report.seamlessHandoff.enabledTransfers} of
${report.seamlessHandoff.runtimeEligibleOpenings} eligible portal IDs carry a stable
\`handoff.portalId\`. The source maps selected for this build contain
${report.seamlessHandoff.sourceTransferActions} transfer-like actions
(\`transition_teleport\` plus faint recovery). Exclusions are classified without
per-map overrides:

| Not enabled reason | Count |
|---|---:|
${handoffExclusions}

Safe topology openings not emitted as runtime-direct transfers:

${missingSafeOpenings}

Partially promoted fixed-destination openings:

| Portal | Seamless source cell | Authored target | Legacy cells retained |
|---|---|---|---:|
${partialPromotions}

Portal-only openings that remain wholly legacy:

${fullyLegacyPortalOnly}

Topology-only exclusions use their natural units: ${report.seamlessHandoff.topologyExcluded.portalOnlyOpenings}
portal-only openings (including ${report.seamlessHandoff.topologyExcluded.mixedUnsafeOpenings}
unsafe opening on a mixed seam), ${report.seamlessHandoff.topologyExcluded.directionOnlySeams}
direction-only seams, ${report.seamlessHandoff.topologyExcluded.linkedGaps} linked gaps,
${report.seamlessHandoff.topologyExcluded.rejectedContacts} rejected contacts, and
${report.seamlessHandoff.topologyExcluded.indoorMaps} indoor world members. The partial
rows above are the only portal-only openings with a marked lane; all other excluded
topology and transfer classes keep their legacy behavior.

${previewSection(report)}
## Transfer repairs

The generated project has ${report.transferErrors.length} invalid transfers.
${report.transferRepairs.length} out-of-range coordinates in the upstream data
are clamped deterministically. If the clamped cell has no walkable exit, a
four-neighbour BFS with fixed tie-breaking selects the nearest walkable cell:

${repairs}

## Actions

| Kind | Source type | Native | Degraded | Placeholder | Dropped | Total |
|---|---|---:|---:|---:|---:|---:|
${rows("Action", actions.rows)}

## Conditions

Condition keys include the \`is\` / \`not\` operator, matching S1's 64-pair
census.

| Kind | Source type | Native | Degraded | Placeholder | Dropped | Total |
|---|---|---:|---:|---:|---:|---:|
${rows("Condition", conditions.rows)}
${l10nSection(report)}`;
}

/** zh_CN builds only: the catalog fallback accounting. */
function l10nSection(report: ImportReport): string {
  if (!report.l10n) return "";
  const { fallbackKeys, missingKeys, missingKeyCategories } = report.l10n;
  const list = (keys: readonly string[]): string => keys.length
    ? keys.map((key) => `\`${key}\``).join(", ")
    : "_None._";
  const byCategory = (category: string): string[] =>
    missingKeyCategories.filter((entry) => entry.category === category).map((entry) => entry.key);
  const categoryLine = (label: string, category: string): string => {
    const keys = byCategory(category);
    return `  - ${label} (${keys.length}): ${list(keys)}`;
  };
  return `
## zh_CN catalog

Text source priority: upstream zh_CN community catalog → project supplement
(\`l10n/zh_CN/supplement.po\`) → en_US fallback. Punctuation of upstream
translations is normalized to Chinese convention next to CJK text; template
tokens are untouched.

- **${fallbackKeys.length} keys fell back to en_US** (untranslated): ${list(fallbackKeys)}
- **${missingKeys.length} keys are absent from every catalog** (the importer
  shows the raw key as fallback text). These keys do not exist in en_US
  either, so the English build shows the raw key for the same lines; they
  are upstream content gaps, not translation gaps:
${categoryLine("real dialog (translated_dialog/char_talk)", "dialog")}
${categoryLine("choice option values / passwords", "choice")}
${categoryLine("map / NPC / monster / item name lookups", "name")}
`;
}

export function writeImport(
  mapIds: readonly string[],
  outDir = resolve(import.meta.dir, "../dist"),
  options: Partial<ImportOptions> = {},
): ImportPaths {
  const result = buildProject(mapIds, options);
  if (result.report.schemaErrors.length) {
    const detail = result.report.schemaErrors
      .slice(0, 20)
      .map((error) => `${error.path}: ${error.msg}`)
      .join("\n");
    throw new Error(`${result.report.schemaErrors.length} schema error(s)\n${detail}`);
  }
  if (result.report.transferErrors.length) {
    const detail = result.report.transferErrors
      .slice(0, 20)
      .map((error) =>
        `${error.sourceMap}/${error.event}: ${error.targetMap}@${error.x},${error.y} (${error.reason})`
      )
      .join("\n");
    throw new Error(`${result.report.transferErrors.length} invalid transfer(s)\n${detail}`);
  }
  mkdirSync(outDir, { recursive: true });
  const paths: ImportPaths = {
    project: resolve(outDir, "project.json"),
    variables: resolve(outDir, "variable-enums.json"),
    world: resolve(outDir, "world-index.json"),
    report: resolve(outDir, "import-report.json"),
    coverage: resolve(import.meta.dir, "../reports/G1-coverage.md"),
  };
  writeFileSync(paths.project, jsonBytes(result.project));
  writeFileSync(paths.variables, jsonBytes(result.variables));
  writeFileSync(paths.world, jsonBytes(result.worldIndex));
  writeFileSync(paths.report, jsonBytes(result.report));
  writeFileSync(paths.coverage, coverageMarkdown(result.report));
  return paths;
}

function main(): void {
  const args = process.argv.slice(2);
  const named = args.filter((arg) => !arg.startsWith("--"));
  const selected = args.includes("--sample")
    ? DEFAULT_MAPS
    : named.length ? named : availableMapIds();
  const paths = writeImport(
    selected,
    resolve(import.meta.dir, "../dist"),
    args.includes("--kit=v2") ? KIT_V2_IMPORT_OPTIONS : {},
  );
  console.log(`Imported ${selected.length} map(s); schema errors: 0`);
  console.log(`Project: ${paths.project}`);
  console.log(`Variables: ${paths.variables}`);
  console.log(`World: ${paths.world}`);
  console.log(`Report: ${paths.report}`);
  console.log(`Coverage: ${paths.coverage}`);
}

if (import.meta.main) main();

// Neighbour character preview coverage, by the kit's sandboxed map entry —
// the same verdict the world renderer paints (main.tsx registers
// TUXEMON_PREVIEW_HOOKS). For every map the sandbox enters the map from a
// given durable state in a private copy, folds the first target tick and
// probes the player position/facing, the random cursor and the game's
// volatile state (the minute inside the hour); each event is then previewable,
// hidden (paints nothing on entry) or rejected with the kit's first reason.
// Events the sandbox rejects but the static rules prove are shown from the
// static preview, as at run time (`fallback`).

import {
  createSession,
  startSession,
  type Session,
  type SessionOptions,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { JsonValue, Project } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { createWorldHandoffResolver } from "../vendor/pocket-rpgkit/src/engine/world-handoff.ts";
import { selectWorldMapPreview } from "../vendor/pocket-rpgkit/src/engine/world-preview.ts";
import {
  compileSandboxMap,
  createSandboxSession,
  holdSandboxMap,
  SANDBOX_PREVIEW_REJECT_REASONS,
  sandboxWorldMapPreview,
  summarizeSandboxPreviewCoverage,
  type SandboxMapPreview,
  type SandboxPreviewCoverage,
  type SandboxPreviewRejectReason,
} from "../vendor/pocket-rpgkit/src/engine/world-preview-sandbox.ts";
import { createTuxemonExtensions } from "../battle/extension.ts";
import { PREVIEW_MINUTE_SHIFT, TUXEMON_PREVIEW_HOOKS } from "../battle/preview-hooks.ts";
import { createTuxemonBattleRules, type VariableEnums } from "../battle/runtime.ts";
import { createTuxemonScenes } from "../battle/scenes.ts";
import { createTuxemonTextTokens } from "../battle/text-tokens.ts";
import { validateBattleDb } from "./battle-schema.ts";

/** Maps of the Spyder campaign, the mainline the journeys play. */
export const MAINLINE_MAP_PREFIX = "spyder_";

export interface PreviewCoverageTotals extends SandboxPreviewCoverage {
  /** Maps with at least one previewed character. */
  mapsWithPreview: number;
  /** previewed / (previewed + rejected), in percent with one decimal. */
  previewablePercent: string;
}

export interface PreviewCoverageMapRow {
  mapId: string;
  events: number;
  previewed: number;
  fallback: number;
  hidden: number;
  rejected: number;
  /** Only the reasons this map hits. */
  reasons: Partial<Record<SandboxPreviewRejectReason, number>>;
}

export interface PreviewCoverageReport {
  /** The durable state the sandbox entered from. */
  evaluatedAt: "new-game";
  probes: {
    /** What of the clock and weather the cache key holds. */
    key: "calendar day + hour + weather";
    /** The volatile probe: minutes moved inside the same hour. */
    minuteShift: number;
  };
  all: PreviewCoverageTotals;
  mainline: PreviewCoverageTotals;
  /** Maps with at least one event that paints or is rejected; the rest
   * only hold hidden events. */
  perMap: PreviewCoverageMapRow[];
}

/** The production session wiring (battle/game.ts) built from in-memory
 * import results, so the cook does not read its own outputs back. */
export function tuxemonPreviewSessionOptions(
  project: Pick<Project, "worldLayout">,
  battleDb: unknown,
  variables: VariableEnums,
  mapDescriptions: Record<string, string>,
  monthNames: string[],
): SessionOptions {
  const db = validateBattleDb(battleDb);
  return {
    extensions: createTuxemonExtensions(db),
    battle: createTuxemonBattleRules(db, variables),
    scenes: createTuxemonScenes(db).rules,
    textTokens: createTuxemonTextTokens("en_US", { mapDescriptions, monthNames }),
    immutableState: true,
    worldTraversal: "seamless-v1",
    ...(project.worldLayout ? { handoff: createWorldHandoffResolver(project.worldLayout) } : {}),
  };
}

/** The sandbox verdict of every listed map from `live`, with the static
 * preview as fallback, exactly as the renderer reads it. */
export function sandboxPreviews(
  session: Session,
  live: Readonly<SessionState>,
  mapIds: readonly string[],
): SandboxMapPreview[] {
  const sandbox = createSandboxSession(session);
  return mapIds.map((id) => {
    const map = session.maps.get(id);
    if (!map) throw new Error(`preview coverage: map ${id} is not resident`);
    if (holdSandboxMap(sandbox, session, map)) {
      while (!compileSandboxMap(sandbox, id)) { /* bounded slices */ }
    }
    return sandboxWorldMapPreview(sandbox, live, id, {
      ...TUXEMON_PREVIEW_HOOKS,
      fallback: selectWorldMapPreview(map, live.sw, { commonEvents: session.commonEvents }),
    });
  });
}

export function previewTotals(previews: readonly SandboxMapPreview[]): PreviewCoverageTotals {
  const summary = summarizeSandboxPreviewCoverage(previews);
  const paintable = summary.previewed + summary.rejected;
  return {
    ...summary,
    mapsWithPreview: previews.filter((preview) => preview.actors.length > 0).length,
    previewablePercent: paintable > 0 ? ((summary.previewed / paintable) * 100).toFixed(1) : "100.0",
  };
}

export function previewMapRow(preview: SandboxMapPreview): PreviewCoverageMapRow {
  const reasons: Partial<Record<SandboxPreviewRejectReason, number>> = {};
  for (const reason of SANDBOX_PREVIEW_REJECT_REASONS) {
    const count = preview.rejected.filter((entry) => entry.reason === reason).length;
    if (count > 0) reasons[reason] = count;
  }
  return {
    mapId: preview.mapId,
    events: preview.events,
    previewed: preview.actors.length,
    fallback: preview.actors.filter((actor) => actor.fallback).length,
    hidden: preview.hidden,
    rejected: preview.rejected.length,
    reasons,
  };
}

export function previewCoverageOf(previews: readonly SandboxMapPreview[]): Omit<PreviewCoverageReport, "evaluatedAt" | "probes"> {
  const sorted = [...previews].sort((a, b) => (a.mapId < b.mapId ? -1 : a.mapId > b.mapId ? 1 : 0));
  return {
    all: previewTotals(sorted),
    mainline: previewTotals(sorted.filter((preview) => preview.mapId.startsWith(MAINLINE_MAP_PREFIX))),
    perMap: sorted
      .filter((preview) => preview.actors.length > 0 || preview.rejected.length > 0)
      .map(previewMapRow),
  };
}

/** Coverage of every map of a freshly imported project at the new-game
 * state. */
export function buildPreviewCoverage(project: Project, options: SessionOptions): PreviewCoverageReport {
  const session = createSession(project, 60, options);
  const live = startSession(project, session);
  const mapIds = project.maps.map((map) => map.id);
  return {
    evaluatedAt: "new-game",
    probes: { key: "calendar day + hour + weather", minuteShift: PREVIEW_MINUTE_SHIFT },
    ...previewCoverageOf(sandboxPreviews(session, live, mapIds)),
  };
}

/** Bilingual reason labels (the same section ships in both report files). */
export const PREVIEW_REASON_LABELS: Record<SandboxPreviewRejectReason, string> = {
  "duplicate-id": "two events share one id / 两个事件同 id",
  "entry-transfer": "the map's entry transfers away / 进图即传送走（整图）",
  "entry-scene": "the map's entry starts a battle or scene / 进图即开战斗或场景（整图）",
  "entry-error": "the map's entry raised an error / 进图报错（整图）",
  "entry-runtime-branch": "an entry program branches on facing, timer or BGM / 入口程序按朝向、计时器或 BGM 分支（整图）",
  "facing-condition": "a page condition reads the player's facing / 页条件读玩家朝向",
  "runtime-condition": "a page condition reads the timer or BGM / 页条件读计时器或 BGM",
  "player-dependent": "differs with the player elsewhere / 玩家位置、朝向不同则不同",
  "random-dependent": "differs with another random cursor / 换随机数则不同",
  "volatile-dependent": "differs with the minute inside the hour / 同一小时内的分钟不同则不同",
};

export type { JsonValue };

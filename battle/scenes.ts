import { nameInputRules, NAME_INPUT_SCENE_ID } from "../vendor/pocket-rpgkit/src/engine/name-input.ts";
import type { ExtensionReadContext } from "../vendor/pocket-rpgkit/src/engine/extensions.ts";
import type { SceneCompletion, SceneInput, SceneRules } from "../vendor/pocket-rpgkit/src/engine/scene.ts";
import type { JsonValue } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import type {
  BattleDb,
  BattleRuntimeShell,
  JournalMonsterIndexEntry,
} from "../importer/battle-schema.ts";
import { createDaycareSceneRules, TUXEMON_DAYCARE_SCENE_ID } from "./daycare-scenes.ts";
import {
  resolveBattleDb,
  tuxemonExtensionState,
  type BattleDbSource,
  type GameLang,
} from "./extension.ts";
import { createStorageSceneRules } from "./storage-scenes.ts";
import { radioSceneRules, TUXEMON_RADIO_SCENE_ID } from "./radio-scenes.ts";
import { emptyParkSession, parkSummary, type ParkSummary } from "./park.ts";

export { TUXEMON_RADIO_SCENE_ID } from "./radio-scenes.ts";

export const TUXEMON_JOURNAL_SCENE_ID = "tux.journal";
export const TUXEMON_MONSTER_PICKER_SCENE_ID = "tux.monsterPicker";
export const TUXEMON_PARK_SUMMARY_SCENE_ID = "tux.parkSummary";
export const PARK_SUMMARY_TOUCH_CLOSE = 0;

export type JournalStatus = "unknown" | "seen" | "caught";

export interface JournalSceneState {
  kind: "journal";
  cursor: number;
  seen: string[];
  caught: string[];
  revealed: string | null;
  phase: "browse" | "done";
  cancelled: boolean;
}

export interface MonsterPickerEntry {
  iid: string;
  slug: string;
  label: string;
}

export interface MonsterPickerSceneState {
  kind: "monsterPicker";
  cursor: number;
  variable: string;
  title: string;
  entries: MonsterPickerEntry[];
  /** Upstream's unfiltered get_player_monster menu cannot be dismissed. */
  cancellable: boolean;
  phase: "choose" | "done";
  cancelled: boolean;
}

export interface ParkSummarySceneLabels {
  title: string;
  uniqueSeen: string;
  attempts: string;
  successful: string;
  failed: string;
  successRate: string;
  topSightings: string;
  highlights: string;
  none: string;
  close: string;
  seenTimes: (count: number) => string;
  averageTurns: (turns: number) => string;
}

export interface ParkSummarySceneState extends ParkSummary {
  kind: "parkSummary";
  phase: "summary" | "done";
  labels: ParkSummarySceneLabels;
  sightings: Array<{ monster: string; name: string; count: number }>;
  highlights: Array<{ monster: string; name: string; averageTurnsRemaining: number }>;
}

export interface TuxemonSceneCatalog {
  readonly index: readonly JournalMonsterIndexEntry[];
  monster(slug: string): BattleDb["monsters"][string] | undefined;
}

export interface TuxemonSceneBundle {
  readonly rules: Readonly<Record<string, SceneRules>>;
  readonly catalog: TuxemonSceneCatalog;
}

function record(value: JsonValue): Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

function stateOf<T>(value: JsonValue): T {
  return value as unknown as T;
}

function wrap(index: number, length: number): number {
  return length > 0 ? (index + length) % length : 0;
}

function journalStatus(state: Readonly<JournalSceneState>, slug: string): JournalStatus {
  return state.caught.includes(slug) ? "caught"
    : state.seen.includes(slug) ? "seen"
      : "unknown";
}

export function journalEntryStatus(
  state: Readonly<JournalSceneState>,
  slug: string,
): JournalStatus {
  return journalStatus(state, slug);
}

export function selectedJournalEntry(
  state: Readonly<JournalSceneState>,
  catalog: Readonly<TuxemonSceneCatalog>,
): JournalMonsterIndexEntry | undefined {
  return catalog.index[state.cursor];
}

function journalRules(index: readonly JournalMonsterIndexEntry[]): SceneRules {
  return {
    start(ext, rawArgs) {
      const args = record(rawArgs);
      const target = typeof args.monster === "string" ? args.monster : null;
      const cursor = target === null ? 0 : index.findIndex((entry) => entry.id === target);
      if (target !== null && cursor < 0) {
        throw new Error(`tux.journal: unknown monster '${target}'`);
      }
      const current = tuxemonExtensionState(ext);
      const state: JournalSceneState = {
        kind: "journal",
        cursor: Math.max(0, cursor),
        seen: [...current.seen],
        caught: [...current.caught],
        revealed: args.reveal === true ? target : null,
        phase: "browse",
        cancelled: false,
      };
      return { ext, state: state as unknown as JsonValue };
    },

    step(rawState, input) {
      const state = stateOf<JournalSceneState>(rawState);
      if (state.phase !== "browse") return rawState;
      if (input.cancelEdge || input.confirmEdge) {
        state.phase = "done";
        state.cancelled = input.cancelEdge === true;
      } else if (state.revealed !== null) {
        // Tuxemon's open_journal action opens one revealed entry and disables
        // directional cycling. A journal opened without a target remains a
        // browsable list for future menu integrations.
      } else if (input.upEdge) {
        state.cursor = wrap(state.cursor - 1, index.length);
      } else if (input.downEdge) {
        state.cursor = wrap(state.cursor + 1, index.length);
      } else if (input.leftEdge) {
        state.cursor = wrap(state.cursor - 8, index.length);
      } else if (input.rightEdge) {
        state.cursor = wrap(state.cursor + 8, index.length);
      }
      return rawState;
    },

    done(rawState): SceneCompletion | null {
      const state = stateOf<JournalSceneState>(rawState);
      return state.phase === "done" ? { cancelled: state.cancelled } : null;
    },
  };
}

function pickerRules(index: readonly JournalMonsterIndexEntry[]): SceneRules {
  const names = new Map(index.map((entry) => [entry.id, entry.name]));
  return {
    start(ext, rawArgs, _seed, context: ExtensionReadContext) {
      const args = record(rawArgs);
      if (typeof args.variable !== "string" || args.variable.length === 0) {
        throw new Error("tux.monsterPicker: variable must be a string");
      }
      const current = tuxemonExtensionState(ext);
      if (current.party.length === 0) return null;
      const entries = current.party.map((monster): MonsterPickerEntry => ({
        iid: monster.iid!,
        slug: monster.slug,
        label: monster.nickname ?? names.get(monster.slug) ?? monster.slug,
      }));
      const live = context.variables[args.variable];
      const selected = typeof live === "string"
        ? entries.findIndex((entry) => entry.iid === live)
        : -1;
      const state: MonsterPickerSceneState = {
        kind: "monsterPicker",
        cursor: Math.max(0, selected),
        variable: args.variable,
        title: typeof args.title === "string" && args.title.length > 0
          ? args.title
          : "Choose a Tuxemon",
        entries,
        cancellable: args.cancellable === true,
        phase: "choose",
        cancelled: false,
      };
      return { ext, state: state as unknown as JsonValue };
    },

    step(rawState, input: Readonly<SceneInput>) {
      const state = stateOf<MonsterPickerSceneState>(rawState);
      if (state.phase !== "choose") return rawState;
      if (input.cancelEdge && state.cancellable) {
        state.phase = "done";
        state.cancelled = true;
      } else if (input.confirmEdge) {
        state.phase = "done";
      } else if (input.upEdge || input.leftEdge) {
        state.cursor = wrap(state.cursor - 1, state.entries.length);
      } else if (input.downEdge || input.rightEdge) {
        state.cursor = wrap(state.cursor + 1, state.entries.length);
      }
      return rawState;
    },

    done(rawState): SceneCompletion | null {
      const state = stateOf<MonsterPickerSceneState>(rawState);
      if (state.phase !== "done") return null;
      if (state.cancelled) return { cancelled: true };
      const selected = state.entries[state.cursor];
      return selected ? { writes: { [state.variable]: selected.iid } } : { cancelled: true };
    },
  };
}

function parkLabels(lang: GameLang): ParkSummarySceneLabels {
  return lang === "zh_CN" ? {
    title: "Eclipse 公园结算",
    uniqueSeen: "发现种类",
    attempts: "捕获尝试",
    successful: "成功捕获",
    failed: "捕获失败",
    successRate: "成功率",
    topSightings: "常见精灵",
    highlights: "捕获亮点",
    none: "暂无记录",
    close: "返回公园入口",
    seenTimes: (count) => `遇见 ${count} 次`,
    averageTurns: (turns) => `平均剩余 ${turns.toFixed(1)} 回合`,
  } : {
    title: "Eclipse Park Results",
    uniqueSeen: "Unique sightings",
    attempts: "Capture attempts",
    successful: "Successful catches",
    failed: "Failed catches",
    successRate: "Success rate",
    topSightings: "Top sightings",
    highlights: "Capture highlights",
    none: "No encounters recorded",
    close: "Return to the park entrance",
    seenTimes: (count) => `seen ${count} time${count === 1 ? "" : "s"}`,
    averageTurns: (turns) => `avg ${turns.toFixed(1)} turns remaining`,
  };
}

function parkSummaryRules(names: ReadonlyMap<string, string>, lang: GameLang): SceneRules {
  return {
    start(ext) {
      const current = tuxemonExtensionState(ext);
      const summary = parkSummary(current.parkSession ?? emptyParkSession(false));
      const state: ParkSummarySceneState = {
        kind: "parkSummary",
        phase: "summary",
        ...summary,
        labels: parkLabels(lang),
        sightings: summary.sightings.map((entry) => ({
          ...entry,
          name: names.get(entry.monster) ?? entry.monster,
        })),
        highlights: summary.highlights.map((entry) => ({
          ...entry,
          name: names.get(entry.monster) ?? entry.monster,
        })),
      };
      return { ext, state: state as unknown as JsonValue };
    },
    step(rawState, input) {
      const state = stateOf<ParkSummarySceneState>(rawState);
      if (state.phase === "summary" && (input.confirmEdge || input.cancelEdge
        || input.selectIndex === PARK_SUMMARY_TOUCH_CLOSE)) {
        state.phase = "done";
      }
      return rawState;
    },
    done(rawState): SceneCompletion | null {
      return stateOf<ParkSummarySceneState>(rawState).phase === "done" ? {} : null;
    },
  };
}

function eagerIndex(source: BattleDb): JournalMonsterIndexEntry[] {
  return Object.entries(source.monsters)
    .map(([id, monster]) => ({ id, entry: "", txmnId: monster.txmnId, name: monster.name }))
    .sort((a, b) => a.txmnId - b.txmnId || a.id.localeCompare(b.id));
}

export function createTuxemonScenes(
  source: BattleDbSource,
  suppliedIndex?: readonly JournalMonsterIndexEntry[],
  lang: GameLang = "en_US",
): TuxemonSceneBundle {
  const index = suppliedIndex ? [...suppliedIndex] : eagerIndex(resolveBattleDb(source));
  const catalog: TuxemonSceneCatalog = {
    index,
    monster(slug) {
      return resolveBattleDb(source).monsters[slug];
    },
  };
  const names = new Map(index.map((entry) => [entry.id, entry.name]));
  return {
    catalog,
    rules: {
      [NAME_INPUT_SCENE_ID]: nameInputRules,
      [TUXEMON_JOURNAL_SCENE_ID]: journalRules(index),
      [TUXEMON_MONSTER_PICKER_SCENE_ID]: pickerRules(index),
      [TUXEMON_PARK_SUMMARY_SCENE_ID]: parkSummaryRules(names, lang),
      [TUXEMON_RADIO_SCENE_ID]: radioSceneRules,
      [TUXEMON_DAYCARE_SCENE_ID]: createDaycareSceneRules(source, (slug) => names.get(slug) ?? slug, lang),
      ...createStorageSceneRules(source, (slug) => names.get(slug) ?? slug, lang),
    },
  };
}

export function runtimeJournalIndex(shell: BattleRuntimeShell): readonly JournalMonsterIndexEntry[] {
  return shell.monstersIndex;
}

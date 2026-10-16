// START / Party / Player overlay presentation. The controller remains in
// start-menu-runtime.ts; this file owns only the fixed 480x272 composition,
// localized copy, lazy monster art, and touch gestures.

import { createMemo, createSignal, For, Show, type Component } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { getOps, hostViewport } from "@pocketjs/framework/host";
import { onFrame } from "@pocketjs/framework/lifecycle";

import type { TuxemonSceneCatalog } from "../battle/scenes.ts";
import type { SpawnedMonsterSnapshot, Stats } from "../battle/types.ts";
import type { BattleDb, BattleImageRef } from "../importer/battle-schema.ts";
import type { GameViewOverlayConfig } from "../vendor/pocket-rpgkit/src/ui/demo-contract.ts";
import { Panel } from "../vendor/pocket-rpgkit/src/ui/Panel.tsx";
import {
  createBattleImageCache,
  LazyImage,
  type TileImageSource,
} from "../vendor/pocket-rpgkit/src/ui/battle/index.ts";
import { featureText, type LocalizedFeatureText, type StartMenuData } from "./feature-modes-data.ts";
import { imageSource, title } from "./journal-scene.tsx";
import type { Lang } from "./language.ts";
import {
  formatMonsterHeight,
  formatMonsterWeight,
  formatWalkedDistance,
  type UnitMeasure,
} from "./settings.ts";
import {
  createStartMenuRuntime,
  formatMonsterExperience,
  monsterExperienceProgress,
  PARTY_ACTION_ROW_HEIGHT,
  partyMonsterView,
  type PartyActionId,
  type PartySortId,
  type StartMenuCatalog,
  type StartMenuLabels,
  type StartMenuOptions,
  type StartMenuRuntime,
} from "./start-menu-runtime.ts";
import { TUXEMON_UI_THEME } from "./tuxemon-theme.ts";

const THEME = TUXEMON_UI_THEME;
const HP_GOOD = "#5fd068";
const HP_LOW = "#e8a33b";
const HP_CRITICAL = "#e2574c";
const SELECTED_BG = "#145064";
const PANEL_BG = "#071923ed";

export const START_MENU_BASE_W = 480;
export const START_MENU_BASE_H = 272;

export interface StartMenuCanvas {
  scale: number;
  left: number;
  top: number;
}

export interface StartMenuRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function startMenuCanvas(viewport: { w: number; h: number }): StartMenuCanvas {
  const scale = Math.min(viewport.w / START_MENU_BASE_W, viewport.h / START_MENU_BASE_H);
  return {
    scale,
    left: Math.floor((viewport.w - START_MENU_BASE_W * scale) / 2),
    top: Math.floor((viewport.h - START_MENU_BASE_H * scale) / 2),
  };
}

export function startMenuViewRect(canvas: StartMenuCanvas, rect: StartMenuRect): StartMenuRect {
  return {
    x: canvas.left + rect.x * canvas.scale,
    y: canvas.top + rect.y * canvas.scale,
    w: rect.w * canvas.scale,
    h: rect.h * canvas.scale,
  };
}

export function startMenuBasePoint(canvas: StartMenuCanvas, x: number, y: number): { x: number; y: number } {
  return { x: (x - canvas.left) / canvas.scale, y: (y - canvas.top) / canvas.scale };
}

const ROOT_PANEL: StartMenuRect = { x: 128, y: 22, w: 224, h: 228 };
const ROOT_ROWS: StartMenuRect = { x: 140, y: 42, w: 200, h: 198 };
const ROOT_ROW_H = 20;
const PARTY_PANEL: StartMenuRect = { x: 8, y: 29, w: 284, h: 216 };
const PARTY_SIDE: StartMenuRect = { x: 298, y: 29, w: 174, h: 216 };
const PARTY_ROW_TOP = 7;
const PARTY_ROW_H = 34;
const ACTION_TOP = 48;
const ACTION_ROW_H = PARTY_ACTION_ROW_HEIGHT;
const DETAIL_RECT: StartMenuRect = { x: 8, y: 29, w: 464, h: 216 };
const RELEASE_RECT: StartMenuRect = { x: 70, y: 78, w: 340, h: 120 };
const BACK_RECT: StartMenuRect = { x: 394, y: 5, w: 76, h: 20 };
const SWIPE_PX = 28;

const pick = (text: LocalizedFeatureText, lang: Lang): string => featureText(text, lang);

export function startMenuLabels(
  data: Readonly<StartMenuData>,
  lang: Lang,
  nuPhoneLabel?: string | LocalizedFeatureText,
): StartMenuLabels {
  const phone = typeof nuPhoneLabel === "string"
    ? nuPhoneLabel
    : nuPhoneLabel ? pick(nuPhoneLabel, lang) : lang === "zh_CN" ? "Nu 手机" : "Nu Phone";
  return {
    root: {
      party: pick(data.root.party, lang),
      bag: pick(data.root.bag, lang),
      player: pick(data.root.player, lang),
      missions: pick(data.root.missions, lang),
      save: pick(data.root.save, lang),
      load: pick(data.root.load, lang),
      options: pick(data.root.options, lang),
      tuxepedia: pick(data.root.tuxepedia, lang),
      nuphone: phone,
      exit: pick(data.root.exit, lang),
    },
    partyActions: {
      info: pick(data.party.info, lang),
      moves: pick(data.party.techniques, lang),
      unequip: pick(data.party.unequip, lang),
      equip: pick(data.party.equip, lang),
      swapItem: pick(data.party.swapItem, lang),
      move: pick(data.party.move, lang),
      sort: pick(data.party.sort, lang),
      release: pick(data.party.release, lang),
    },
    partySorts: {
      level: pick(data.party.sortByLevel, lang),
      hp: pick(data.party.sortByHp, lang),
      name: pick(data.party.sortByName, lang),
      id: pick(data.party.sortById, lang),
    },
    yes: pick(data.common.yes, lang),
    no: pick(data.common.no, lang),
  };
}

/** A property-only adapter: resolving a runtime sort/move row touches only
 * the requested monster or technique shard, never catalog.database(). */
export function lazyStartMenuCatalog(catalog: Readonly<TuxemonSceneCatalog>): StartMenuCatalog {
  const lazyRecord = <T,>(load: (slug: string) => T | undefined): Record<string, T> =>
    new Proxy(Object.create(null) as Record<string, T>, {
      get(_target, property) {
        return typeof property === "string" ? load(property) : undefined;
      },
      has(_target, property) {
        return typeof property === "string" && load(property) !== undefined;
      },
    });
  return {
    monsters: lazyRecord((slug) => catalog.monster(slug)) as BattleDb["monsters"],
    techniques: lazyRecord((slug) => catalog.technique(slug)) as BattleDb["techniques"],
    items: lazyRecord((slug) => catalog.item(slug)) as BattleDb["items"],
    statuses: lazyRecord((slug) => catalog.status(slug)) as BattleDb["statuses"],
  };
}

export interface StartMenuOverlayOptions extends Omit<StartMenuOptions, "catalog" | "labels"> {
  data: StartMenuData;
  lang: Lang;
  catalog: TuxemonSceneCatalog;
  /** Usually featureModes.nuPhoneMap.entry.phoneLabel. */
  nuPhoneLabel?: string | LocalizedFeatureText;
  /** Live install preference; changing it updates an already-open detail page. */
  units?: () => UnitMeasure;
}

export function createStartMenuOverlay(options: StartMenuOverlayOptions): GameViewOverlayConfig & {
  runtimeRef: { current: StartMenuRuntime | null };
} {
  const runtimeRef: { current: StartMenuRuntime | null } = { current: null };
  return {
    runtimeRef,
    create(host) {
      const tuxepediaTotal = options.tuxepediaTotal
        ?? options.catalog.index.filter((entry) => entry.txmnId > 0).length;
      const runtime = createStartMenuRuntime({
        ...options,
        catalog: lazyStartMenuCatalog(options.catalog),
        labels: startMenuLabels(options.data, options.lang, options.nuPhoneLabel),
        tuxepediaTotal,
      }, host);
      runtimeRef.current = runtime;
      return {
        step: runtime.step,
        isOpen: runtime.isOpen,
        render() {
          return <StartMenuView
            runtime={runtime}
            data={options.data}
            lang={options.lang}
            catalog={options.catalog}
            units={options.units ?? (() => "metric")}
          />;
        },
      };
    },
  };
}

function fillTemplate(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\$?\{\{(\w+)\}\}|\{(\w+)\}/g, (match, doubled: string, plain: string) => {
    const key = doubled || plain;
    const value = values[key];
    if (value === undefined) return match;
    // Upstream uses `${{...}}` for every interpolated value, not just money.
    // The wallet's currency glyph belongs specifically to money_formatted;
    // preserving the sigil for `name` would render "$Red's wallet".
    return match.startsWith("$") && key === "money_formatted" ? `$${value}` : String(value);
  });
}

function hpColor(ratio: number): string {
  return ratio > 0.5 ? HP_GOOD : ratio > 0.2 ? HP_LOW : HP_CRITICAL;
}

function statLine(stats: Partial<Stats> | undefined): string {
  return `HP ${stats?.hp ?? 0}  AR ${stats?.armour ?? 0}  DG ${stats?.dodge ?? 0}  ME ${stats?.melee ?? 0}  RA ${stats?.ranged ?? 0}  SP ${stats?.speed ?? 0}`;
}

function displayValue(value: string | null | undefined): string {
  return value ? title(value) : "—";
}

const EXTRA = {
  en_US: {
    menu: "START MENU",
    party: "PARTY",
    level: "Lv.",
    experience: "Experience",
    gender: "Gender",
    stage: "Stage",
    acquisition: "Acquired",
    status: "Status",
    bond: "Bond",
    type: "Type",
    individual: "Individual values",
    training: "Training points",
    moves: "TECHNIQUES",
    controls: "○ select   × back   ←/→ change Tuxemon",
    moveHint: "Move mode: choose a new position",
    heldItem: "Held",
  },
  zh_CN: {
    menu: "开始菜单",
    party: "队伍",
    level: "等级",
    experience: "经验",
    gender: "性别",
    stage: "阶段",
    acquisition: "获得方式",
    status: "状态",
    bond: "亲密度",
    type: "属性",
    individual: "个体值",
    training: "训练点",
    moves: "技能",
    controls: "○ 选择   × 返回   ←/→ 切换精灵",
    moveHint: "移动模式：选择新的队伍位置",
    heldItem: "持有",
  },
} as const;

function MenuSprite(props: {
  monster: SpawnedMonsterSnapshot;
  catalog: Readonly<TuxemonSceneCatalog>;
  cache: ReturnType<typeof createBattleImageCache>;
  active: boolean;
  left: number;
  top: number;
  debugName: string;
}) {
  const entry = () => props.catalog.monster(props.monster.slug);
  return (
    <Show when={entry()}>
      {(monster) => {
        const rect = () => monster().art.menu[0];
        const scale = () => Math.min(30 / rect()[2], 30 / rect()[3]);
        return (
          <View
            class="absolute overflow-hidden"
            style={{ posType: 1, insetL: props.left, insetT: props.top, width: 30, height: 30 }}
            debugName={`${props.debugName}-clip`}
          >
            <LazyImage
              src={imageSource(monster().art.sheet)}
              cache={props.cache}
              active={props.active}
              class="absolute"
              style={{
                posType: 1,
                insetL: -rect()[0] * scale(),
                insetT: -rect()[1] * scale(),
                width: monster().art.sheet.width * scale(),
                height: monster().art.sheet.height * scale(),
              }}
              debugName={props.debugName}
            />
          </View>
        );
      }}
    </Show>
  );
}

function FrontSprite(props: {
  slug: string;
  catalog: Readonly<TuxemonSceneCatalog>;
  cache: ReturnType<typeof createBattleImageCache>;
  active: boolean;
}) {
  const entry = () => props.catalog.monster(props.slug);
  return (
    <Show when={entry()}>
      {(monster) => (
        <View
          class="absolute overflow-hidden"
          style={{ posType: 1, insetL: 18, insetT: 45, width: 142, height: 142 }}
          debugName="start-menu-detail-art-clip"
        >
          <LazyImage
            src={imageSource(monster().art.sheet)}
            cache={props.cache}
            active={props.active}
            class="absolute"
            style={{
              posType: 1,
              insetL: -monster().art.front[0] * 2.2,
              insetT: -monster().art.front[1] * 2.2,
              width: monster().art.sheet.width * 2.2,
              height: monster().art.sheet.height * 2.2,
            }}
            debugName="start-menu-detail-art"
          />
        </View>
      )}
    </Show>
  );
}

function HpBar(props: { hp: number; maxHp: number; selected?: boolean }) {
  const ratio = () => props.maxHp > 0 ? Math.max(0, Math.min(1, props.hp / props.maxHp)) : 0;
  return (
    <View
      class="absolute"
      style={{ posType: 1, insetL: 0, insetT: 0, width: 62, height: 7, bgColor: props.selected ? "#dce9e9" : THEME.border }}
    >
      <View
        class="absolute"
        style={{ posType: 1, insetL: 1, insetT: 1, width: Math.round(60 * ratio()), height: 5, bgColor: hpColor(ratio()) }}
      />
    </View>
  );
}

function RootPage(props: { runtime: StartMenuRuntime; heading: string }) {
  const state = () => props.runtime.state();
  return (
    <>
      <Panel theme={THEME} style={{ posType: 1, insetL: ROOT_PANEL.x, insetT: ROOT_PANEL.y, width: ROOT_PANEL.w, height: ROOT_PANEL.h }} debugName="start-menu-root-panel">
        <Text class="text-lg" style={{ posType: 1, insetL: 12, insetT: 7, width: 200, height: 25, lineHeight: 22, textAlign: 1, textColor: THEME.accent }} debugName="start-menu-root-title">
          {props.heading}
        </Text>
        <For each={props.runtime.rows()}>{(row, index) => {
          const selected = () => index() === state().rootCursor;
          return (
            <View
              class="absolute flex-row items-center"
              style={{
                posType: 1,
                insetL: 10,
                insetT: 36 + index() * ROOT_ROW_H,
                width: 204,
                height: ROOT_ROW_H - 1,
                bgColor: selected() ? SELECTED_BG : THEME.paper,
                opacity: row.enabled ? 1 : 0.55,
              }}
              debugName={`start-menu-root-row-${row.id}`}
            >
              <Text
                class="text-sm"
                style={{ marginL: 11, width: 178, height: 18, lineHeight: 17, textColor: selected() ? "#ffffff" : row.enabled ? THEME.ink : THEME.dim }}
                debugName={`start-menu-root-label-${row.id}`}
              >
                {row.label}
              </Text>
            </View>
          );
        }}</For>
      </Panel>
    </>
  );
}

function PartyList(props: {
  runtime: StartMenuRuntime;
  catalog: Readonly<TuxemonSceneCatalog>;
  cache: ReturnType<typeof createBattleImageCache>;
  active: boolean;
  data: StartMenuData;
  lang: Lang;
}) {
  const state = () => props.runtime.state();
  const menu = () => state().partyMenu;
  const selectedMonster = () => state().party[menu().cursor];
  const actionLabel = (action: PartyActionId) => props.runtime.labels.partyActions[action];
  const sortLabel = (sort: PartySortId) => props.runtime.labels.partySorts[sort];
  const t = () => EXTRA[props.lang] ?? EXTRA.en_US;
  return (
    <>
      <Text class="text-lg" style={{ posType: 1, insetL: 10, insetT: 4, width: 280, height: 23, lineHeight: 21, textColor: THEME.accent }} debugName="start-menu-party-title">
        {t().party}
      </Text>
      <Panel theme={THEME} style={{ posType: 1, insetL: PARTY_PANEL.x, insetT: PARTY_PANEL.y, width: PARTY_PANEL.w, height: PARTY_PANEL.h }} debugName="start-menu-party-list">
        <For each={state().party}>{(monster, index) => {
          const view = () => partyMonsterView(monster, lazyStartMenuCatalog(props.catalog));
          const selected = () => index() === menu().cursor;
          return (
            <View
              class="absolute"
              style={{
                posType: 1,
                insetL: 5,
                insetT: PARTY_ROW_TOP + index() * PARTY_ROW_H,
                width: 270,
                height: PARTY_ROW_H - 2,
                bgColor: selected() ? SELECTED_BG : THEME.paper,
                borderWidth: menu().phase === "move" && selected() ? 2 : 0,
                borderColor: THEME.accent,
              }}
              debugName={`start-menu-party-row-${index()}`}
            >
              <MenuSprite monster={monster} catalog={props.catalog} cache={props.cache} active={props.active} left={2} top={1} debugName={`start-menu-party-avatar-${index()}`} />
              <Text class="text-sm" style={{ posType: 1, insetL: 38, insetT: 2, width: 116, height: 18, lineHeight: 17, textColor: selected() ? "#ffffff" : THEME.ink }} debugName={`start-menu-party-name-${index()}`}>
                {view().name}
              </Text>
              <Text class="text-xs" style={{ posType: 1, insetL: 157, insetT: 3, width: 50, height: 15, lineHeight: 14, textColor: selected() ? "#ffffff" : THEME.dim }} debugName={`start-menu-party-level-${index()}`}>
                {`${t().level}${monster.level}`}
              </Text>
              <Show when={view().heldItemSlug}>
                <Text class="text-xs" style={{ posType: 1, insetR: 7, insetT: 3, width: 34, height: 14, lineHeight: 13, textAlign: 2, textColor: selected() ? "#ffffff" : THEME.accent }} debugName={`start-menu-party-held-icon-${index()}`}>◆</Text>
              </Show>
              <View class="absolute" style={{ posType: 1, insetL: 38, insetT: 21, width: 62, height: 7 }} debugName={`start-menu-party-hpbar-${index()}`}>
                <HpBar hp={view().hp} maxHp={view().maxHp} selected={selected()} />
              </View>
              <Text class="text-xs" style={{ posType: 1, insetL: 105, insetT: 17, width: 78, height: 14, lineHeight: 13, textColor: selected() ? "#ffffff" : THEME.dim }} debugName={`start-menu-party-hp-${index()}`}>
                {`${view().hp}/${view().maxHp}`}
              </Text>
              <Text class="text-xs" style={{ posType: 1, insetR: 5, insetT: 17, width: 76, height: 14, lineHeight: 13, textAlign: 2, textColor: selected() ? "#ffffff" : view().status ? HP_CRITICAL : THEME.dim }} debugName={`start-menu-party-status-${index()}`}>
                {displayValue(view().status)}
              </Text>
            </View>
          );
        }}</For>
      </Panel>
      <Panel theme={THEME} style={{ posType: 1, insetL: PARTY_SIDE.x, insetT: PARTY_SIDE.y, width: PARTY_SIDE.w, height: PARTY_SIDE.h }} debugName="start-menu-party-side">
        <Show when={menu().phase === "list" || menu().phase === "move"}>
          <Text class="text-sm" style={{ posType: 1, insetL: 9, insetT: 12, width: 150, height: 40, lineHeight: 18, textColor: THEME.accent }} debugName="start-menu-party-selected-name">
            {props.runtime.selectedMonster()?.name ?? ""}
          </Text>
          <Text class="text-xs" style={{ posType: 1, insetL: 9, insetT: 58, width: 150, height: 96, lineHeight: 15, textColor: THEME.ink }} debugName="start-menu-party-summary">
            {selectedMonster() ? `${pick(props.data.common.hp, props.lang)}  ${props.runtime.selectedMonster()!.hp}/${props.runtime.selectedMonster()!.maxHp}\n${pick(props.data.common.armour, props.lang)}  ${selectedMonster()!.base.armour}\n${pick(props.data.common.dodge, props.lang)}  ${selectedMonster()!.base.dodge}\n${pick(props.data.common.speed, props.lang)}  ${selectedMonster()!.base.speed}\n${t().heldItem}  ${displayValue(props.runtime.selectedMonster()!.heldItemName)}` : ""}
          </Text>
          <Show when={menu().phase === "move"}>
            <Text class="text-xs" style={{ posType: 1, insetL: 9, insetT: 158, width: 150, height: 42, lineHeight: 15, textColor: THEME.accent }} debugName="start-menu-party-move-hint">
              {t().moveHint}
            </Text>
          </Show>
        </Show>
        <Show when={menu().phase === "action"}>
          <Text class="text-sm" style={{ posType: 1, insetL: 9, insetT: 10, width: 150, height: 25, lineHeight: 18, textColor: THEME.accent }}>
            {props.runtime.selectedMonster()?.name ?? ""}
          </Text>
          <For each={props.runtime.actionRows()}>{(action, index) => {
            const selected = () => index() === menu().actionCursor;
            return (
              <View class="absolute flex-row items-center" style={{ posType: 1, insetL: 7, insetT: ACTION_TOP + index() * ACTION_ROW_H, width: 152, height: ACTION_ROW_H - 2, bgColor: selected() ? SELECTED_BG : THEME.paper }} debugName={`start-menu-party-action-${action}`}>
                <Text class="text-xs" style={{ marginL: 7, width: 136, height: 17, lineHeight: 15, textColor: selected() ? "#ffffff" : THEME.ink }} debugName={`start-menu-party-action-label-${action}`}>{actionLabel(action)}</Text>
              </View>
            );
          }}</For>
        </Show>
        <Show when={menu().phase === "equip"}>
          <Text class="text-sm" style={{ posType: 1, insetL: 9, insetT: 10, width: 150, height: 25, lineHeight: 18, textColor: THEME.accent }}>{props.runtime.labels.partyActions.equip}</Text>
          <For each={props.runtime.itemRows()}>{(item, index) => {
            const selected = () => index() === menu().itemCursor;
            return (
              <View class="absolute flex-row items-center" style={{ posType: 1, insetL: 7, insetT: ACTION_TOP + index() * ACTION_ROW_H, width: 152, height: ACTION_ROW_H - 2, bgColor: selected() ? SELECTED_BG : THEME.paper }} debugName={`start-menu-party-equip-${item.slug}`}>
                <Text class="text-xs" style={{ marginL: 7, width: 136, height: 17, lineHeight: 15, textColor: selected() ? "#ffffff" : THEME.ink }} debugName={`start-menu-party-equip-label-${item.slug}`}>{`${item.name} ×${item.quantity}`}</Text>
              </View>
            );
          }}</For>
        </Show>
        <Show when={menu().phase === "swapItem"}>
          <Text class="text-sm" style={{ posType: 1, insetL: 9, insetT: 10, width: 150, height: 25, lineHeight: 18, textColor: THEME.accent }}>{props.runtime.labels.partyActions.swapItem}</Text>
          <For each={props.runtime.swapRows()}>{(row, index) => {
            const selected = () => index() === menu().itemCursor;
            return (
              <View class="absolute flex-row items-center" style={{ posType: 1, insetL: 7, insetT: ACTION_TOP + index() * ACTION_ROW_H, width: 152, height: ACTION_ROW_H - 2, bgColor: selected() ? SELECTED_BG : THEME.paper }} debugName={`start-menu-party-swap-${row.partyIndex}`}>
                <Text class="text-xs" style={{ marginL: 7, width: 136, height: 17, lineHeight: 15, textColor: selected() ? "#ffffff" : THEME.ink }} debugName={`start-menu-party-swap-label-${row.partyIndex}`}>{`${row.monsterName} · ${row.itemName}`}</Text>
              </View>
            );
          }}</For>
        </Show>
        <Show when={menu().phase === "sort"}>
          <Text class="text-sm" style={{ posType: 1, insetL: 9, insetT: 10, width: 150, height: 25, lineHeight: 18, textColor: THEME.accent }}>{props.runtime.labels.partyActions.sort}</Text>
          <For each={props.runtime.sortRows}>{(sort, index) => {
            const selected = () => index() === menu().sortCursor;
            return (
              <View class="absolute flex-row items-center" style={{ posType: 1, insetL: 7, insetT: ACTION_TOP + index() * 34, width: 152, height: 31, bgColor: selected() ? SELECTED_BG : THEME.paper }} debugName={`start-menu-party-sort-${sort}`}>
                <Text class="text-xs" style={{ marginL: 7, width: 136, height: 30, lineHeight: 14, textColor: selected() ? "#ffffff" : THEME.ink }} debugName={`start-menu-party-sort-label-${sort}`}>{sortLabel(sort)}</Text>
              </View>
            );
          }}</For>
        </Show>
      </Panel>
    </>
  );
}

function DetailPage(props: {
  runtime: StartMenuRuntime;
  catalog: Readonly<TuxemonSceneCatalog>;
  cache: ReturnType<typeof createBattleImageCache>;
  active: boolean;
  data: StartMenuData;
  lang: Lang;
  units: () => UnitMeasure;
}) {
  const state = () => props.runtime.state();
  const menu = () => state().partyMenu;
  const monster = () => state().party[menu().cursor];
  const view = () => props.runtime.selectedMonster();
  const db = () => monster() ? props.catalog.monster(monster()!.slug) : undefined;
  const t = () => EXTRA[props.lang] ?? EXTRA.en_US;
  const label = (value: LocalizedFeatureText) => pick(value, props.lang);
  const types = () => (monster()?.types ?? db()?.types ?? []).map(title).join(" / ");
  const experience = () => monster()
    ? formatMonsterExperience(monsterExperienceProgress(monster()!, props.catalog.database().rules))
    : "0/0";
  return (
    <>
      <Panel theme={THEME} style={{ posType: 1, insetL: DETAIL_RECT.x, insetT: DETAIL_RECT.y, width: DETAIL_RECT.w, height: DETAIL_RECT.h }} debugName="start-menu-detail-panel">
        <Show when={monster() && view()}>
          <Text class="text-lg" style={{ posType: 1, insetL: 12, insetT: 7, width: 250, height: 25, lineHeight: 22, textColor: THEME.accent }} debugName="start-menu-detail-name">
            {`${view()!.name}  #${String(view()!.txmnId ?? 0).padStart(3, "0")}`}
          </Text>
          <Text class="text-sm" style={{ posType: 1, insetR: 12, insetT: 9, width: 100, height: 20, lineHeight: 18, textAlign: 2, textColor: THEME.dim }} debugName="start-menu-detail-level">{`${t().level}${monster()!.level}`}</Text>
          <FrontSprite slug={monster()!.slug} catalog={props.catalog} cache={props.cache} active={props.active} />
          <Text class="text-xs" style={{ posType: 1, insetL: 12, insetT: 184, width: 150, height: 20, lineHeight: 14, textAlign: 1, textColor: THEME.dim }} debugName="start-menu-detail-species">{db()?.species ?? monster()!.slug}</Text>

          <Text class="text-xs" style={{ posType: 1, insetL: 172, insetT: 38, width: 137, height: 164, lineHeight: 15, textColor: THEME.ink }} debugName="start-menu-detail-primary">
            {`${label(props.data.common.hp)}  ${view()!.hp}/${view()!.maxHp}\n${t().experience}  ${experience()}\n${t().type}  ${types() || "—"}\n${t().gender}  ${displayValue(monster()!.gender)}\n${t().stage}  ${displayValue(monster()!.stage)}\n${t().status}  ${displayValue(view()!.status)}\n${t().bond}  ${monster()!.bond ?? 0}\n${t().acquisition}  ${displayValue(monster()!.acquisition)}\n${label(props.data.common.taste)}  ${displayValue(monster()!.tasteCold)} / ${displayValue(monster()!.tasteWarm)}\n${label(props.data.common.height)}  ${formatMonsterHeight(monster()!.height, props.units())}\n${label(props.data.common.weight)}  ${formatMonsterWeight(monster()!.weight, props.units())}`}
          </Text>
          <Text class="text-xs" style={{ posType: 1, insetL: 316, insetT: 38, width: 134, height: 102, lineHeight: 15, textColor: THEME.ink }} debugName="start-menu-detail-stats">
            {`${label(props.data.common.armour)}  ${monster()!.base.armour}\n${label(props.data.common.dodge)}  ${monster()!.base.dodge}\n${label(props.data.common.melee)}  ${monster()!.base.melee}\n${label(props.data.common.ranged)}  ${monster()!.base.ranged}\n${label(props.data.common.speed)}  ${monster()!.base.speed}`}
          </Text>
          <Text class="text-xs" style={{ posType: 1, insetL: 316, insetT: 121, width: 134, height: 36, lineHeight: 14, textColor: THEME.dim }} debugName="start-menu-detail-ivs">{`${t().individual}\n${statLine(monster()!.individualValues)}`}</Text>
          <Text class="text-xs" style={{ posType: 1, insetL: 316, insetT: 163, width: 134, height: 36, lineHeight: 14, textColor: THEME.dim }} debugName="start-menu-detail-training">{`${t().training}\n${statLine(monster()!.trainingPoints)}`}</Text>
        </Show>
      </Panel>
    </>
  );
}

function MovesPage(props: {
  runtime: StartMenuRuntime;
  catalog: Readonly<TuxemonSceneCatalog>;
  cache: ReturnType<typeof createBattleImageCache>;
  active: boolean;
  data: StartMenuData;
  lang: Lang;
}) {
  const state = () => props.runtime.state();
  const menu = () => state().partyMenu;
  const monster = () => state().party[menu().cursor];
  const t = () => EXTRA[props.lang] ?? EXTRA.en_US;
  const label = (value: LocalizedFeatureText) => pick(value, props.lang);
  return (
    <Panel theme={THEME} style={{ posType: 1, insetL: DETAIL_RECT.x, insetT: DETAIL_RECT.y, width: DETAIL_RECT.w, height: DETAIL_RECT.h }} debugName="start-menu-moves-panel">
      <Text class="text-lg" style={{ posType: 1, insetL: 12, insetT: 7, width: 200, height: 25, lineHeight: 22, textColor: THEME.accent }} debugName="start-menu-moves-title">{t().moves}</Text>
      <Text class="text-sm" style={{ posType: 1, insetR: 12, insetT: 9, width: 210, height: 20, lineHeight: 18, textAlign: 2, textColor: THEME.dim }} debugName="start-menu-moves-monster">{props.runtime.selectedMonster()?.name ?? ""}</Text>
      <Show when={monster()}>
        <MenuSprite monster={monster()!} catalog={props.catalog} cache={props.cache} active={props.active} left={14} top={37} debugName="start-menu-moves-avatar" />
      </Show>
      <For each={props.runtime.moves()}>{(move, index) => {
        const selected = () => index() === menu().moveCursor;
        return (
          <View class="absolute" style={{ posType: 1, insetL: 54, insetT: 37 + index() * 39, width: 396, height: 36, bgColor: selected() ? SELECTED_BG : THEME.paper, borderWidth: 1, borderColor: selected() ? THEME.accent : THEME.border }} debugName={`start-menu-move-row-${index()}`}>
            <Text class="text-sm" style={{ posType: 1, insetL: 7, insetT: 2, width: 126, height: 18, lineHeight: 17, textColor: selected() ? "#ffffff" : THEME.ink }} debugName={`start-menu-move-name-${index()}`}>{move.name}</Text>
            <Text class="text-xs" style={{ posType: 1, insetL: 139, insetT: 3, width: 248, height: 15, lineHeight: 14, textColor: selected() ? "#ffffff" : THEME.dim }} debugName={`start-menu-move-stats-${index()}`}>
              {`${displayValue(move.type)}  ${label(props.data.common.accuracy)} ${move.accuracy ?? "—"}  ${label(props.data.common.power)} ${move.power ?? "—"}  ${label(props.data.common.potency)} ${move.potency ?? "—"}`}
            </Text>
            <Text class="text-xs" style={{ posType: 1, insetL: 7, insetT: 19, width: 380, height: 14, lineHeight: 13, textColor: selected() ? "#ffffff" : THEME.dim }} debugName={`start-menu-move-description-${index()}`}>{move.description}</Text>
          </View>
        );
      }}</For>
      <Show when={props.runtime.moves().length === 0}>
        <Text class="text-sm" style={{ posType: 1, insetL: 100, insetT: 100, width: 260, height: 24, lineHeight: 19, textAlign: 1, textColor: THEME.dim }}>{pick(props.data.common.empty, props.lang)}</Text>
      </Show>
    </Panel>
  );
}

function PlayerPage(props: {
  runtime: StartMenuRuntime;
  data: StartMenuData;
  lang: Lang;
  units: () => UnitMeasure;
}) {
  const summary = () => props.runtime.state().player;
  const p = props.data.player;
  const wallet = () => fillTemplate(pick(p.wallet, props.lang), {
    name: summary().name,
    money_formatted: summary().gold.toLocaleString("en-US"),
  });
  const seen = () => fillTemplate(pick(p.seen, props.lang), {
    param: summary().seen,
    all: summary().tuxepediaTotal,
  });
  const caught = () => fillTemplate(pick(p.caught, props.lang), {
    param: summary().caught,
    all: summary().tuxepediaTotal,
  });
  const progress = () => fillTemplate(pick(p.progress, props.lang), { value: summary().tuxepediaProgress });
  const walked = () => fillTemplate(pick(p.walked, props.lang), {
    distance: formatWalkedDistance(summary().steps, props.units()).split(" ")[0]!,
    unit: props.units() === "metric" ? "km" : "mi",
  });
  const battles = () => fillTemplate(pick(p.battles, props.lang), {
    tot: summary().battles.total,
    won: summary().battles.won,
    draw: summary().battles.draw,
    lost: summary().battles.lost,
  });
  return (
    <Panel theme={THEME} style={{ posType: 1, insetL: 35, insetT: 32, width: 410, height: 210 }} debugName="start-menu-player-panel">
      <Text class="text-lg" style={{ posType: 1, insetL: 18, insetT: 14, width: 374, height: 29, lineHeight: 24, textAlign: 1, textColor: THEME.accent }} debugName="start-menu-player-name">{summary().name}</Text>
      <Text class="text-xs" style={{ posType: 1, insetL: 26, insetT: 46, width: 358, height: 17, lineHeight: 15, textColor: THEME.ink }} debugName="start-menu-player-wallet">{wallet()}</Text>
      <Text class="text-xs" style={{ posType: 1, insetL: 26, insetT: 69, width: 358, height: 17, lineHeight: 15, textColor: THEME.ink }} debugName="start-menu-player-progress">{progress()}</Text>
      <Text class="text-xs" style={{ posType: 1, insetL: 26, insetT: 92, width: 358, height: 17, lineHeight: 15, textColor: THEME.ink }} debugName="start-menu-player-seen">{seen()}</Text>
      <Text class="text-xs" style={{ posType: 1, insetL: 26, insetT: 115, width: 358, height: 17, lineHeight: 15, textColor: THEME.ink }} debugName="start-menu-player-caught">{caught()}</Text>
      <Text class="text-xs" style={{ posType: 1, insetL: 26, insetT: 138, width: 358, height: 17, lineHeight: 15, textColor: THEME.ink }} debugName="start-menu-player-playtime">{`${pick(p.playtime, props.lang)}: ${summary().playtime}`}</Text>
      <Show when={summary().steps > 0}>
        <Text class="text-xs" style={{ posType: 1, insetL: 26, insetT: 161, width: 358, height: 17, lineHeight: 15, textColor: THEME.ink }} debugName="start-menu-player-walked">{walked()}</Text>
      </Show>
      <Text class="text-xs" style={{ posType: 1, insetL: 26, insetT: 184, width: 358, height: 17, lineHeight: 15, textColor: THEME.ink }} debugName="start-menu-player-battles">{battles()}</Text>
    </Panel>
  );
}

function ReleaseDialog(props: { runtime: StartMenuRuntime; data: StartMenuData; lang: Lang }) {
  const menu = () => props.runtime.state().partyMenu;
  const name = () => props.runtime.selectedMonster()?.name ?? "";
  const question = () => fillTemplate(pick(props.data.party.releaseConfirmation, props.lang), { name: name().toUpperCase() });
  return (
    <View class="absolute" style={{ posType: 1, insetL: RELEASE_RECT.x, insetT: RELEASE_RECT.y, width: RELEASE_RECT.w, height: RELEASE_RECT.h, bgColor: PANEL_BG, borderWidth: 2, borderColor: THEME.rim }} debugName="start-menu-release-dialog">
      <Text class="text-sm" style={{ posType: 1, insetL: 18, insetT: 17, width: 304, height: 44, lineHeight: 19, textAlign: 1, textColor: THEME.ink }} debugName="start-menu-release-question">{question()}</Text>
      <For each={[props.runtime.labels.no, props.runtime.labels.yes]}>{(answer, index) => {
        const selected = () => index() === menu().releaseCursor;
        return (
          <View class="absolute flex-row justify-center items-center" style={{ posType: 1, insetL: 44 + index() * 132, insetT: 75, width: 120, height: 28, bgColor: selected() ? SELECTED_BG : THEME.paper, borderWidth: 1, borderColor: selected() ? THEME.accent : THEME.border }} debugName={`start-menu-release-answer-${index()}`}>
            <Text class="text-sm" style={{ width: 100, height: 20, lineHeight: 18, textAlign: 1, textColor: selected() ? "#ffffff" : THEME.ink }}>{answer}</Text>
          </View>
        );
      }}</For>
    </View>
  );
}

function ReleaseResultDialog(props: { runtime: StartMenuRuntime; data: StartMenuData; lang: Lang }) {
  const message = () => fillTemplate(pick(props.data.party.released, props.lang), {
    name: props.runtime.state().partyMenu.releasedName ?? "",
  });
  return (
    <View class="absolute flex-row justify-center items-center" style={{ posType: 1, insetL: RELEASE_RECT.x, insetT: RELEASE_RECT.y, width: RELEASE_RECT.w, height: RELEASE_RECT.h, bgColor: PANEL_BG, borderWidth: 2, borderColor: THEME.rim }} debugName="start-menu-release-result">
      <Text class="text-sm" style={{ width: 304, height: 48, lineHeight: 19, textAlign: 1, textColor: THEME.ink }} debugName="start-menu-release-result-text">{message()}</Text>
    </View>
  );
}

export const StartMenuView: Component<{
  runtime: StartMenuRuntime;
  data: StartMenuData;
  lang: Lang;
  catalog: TuxemonSceneCatalog;
  units: () => UnitMeasure;
}> = (props) => {
  const open = () => props.runtime.openSignal();
  const state = () => props.runtime.state();
  const [viewport, setViewport] = createSignal({ w: START_MENU_BASE_W, h: START_MENU_BASE_H });
  onFrame(() => {
    if (!open()) return;
    const live = hostViewport(getOps());
    if (live && (live.w !== viewport().w || live.h !== viewport().h)) setViewport({ w: live.w, h: live.h });
  });
  const canvas = createMemo(() => startMenuCanvas(viewport()));
  const imageCache = createBattleImageCache(open, { maxEntries: 8 });
  const disabledRect = { x: -1, y: -1, w: 0, h: 0 } as const;
  const basePoint = (x: number, y: number) => startMenuBasePoint(canvas(), x, y);

  createGesture({
    region: { rect: () => open() && state().screen === "root"
      ? startMenuViewRect(canvas(), { ...ROOT_ROWS, h: props.runtime.rows().length * ROOT_ROW_H })
      : disabledRect },
    onTap: (contact) => {
      const point = basePoint(contact.x, contact.y);
      const index = Math.floor((point.y - ROOT_ROWS.y) / ROOT_ROW_H);
      if (index >= 0 && index < props.runtime.rows().length) props.runtime.activateIndex(index);
    },
  });
  createGesture({
    region: { rect: () => open() && state().screen === "party" && state().partyMenu.phase === "releaseResult" ? startMenuViewRect(canvas(), RELEASE_RECT) : disabledRect },
    onTap: () => props.runtime.applyAction("confirm"),
  });
  createGesture({
    region: { rect: () => open() && state().screen === "party" && (state().partyMenu.phase === "list" || state().partyMenu.phase === "move") ? startMenuViewRect(canvas(), PARTY_PANEL) : disabledRect },
    onTap: (contact) => {
      const point = basePoint(contact.x, contact.y);
      props.runtime.activateIndex(Math.floor((point.y - PARTY_PANEL.y - PARTY_ROW_TOP) / PARTY_ROW_H));
    },
  });
  createGesture({
    region: { rect: () => open() && state().screen === "party"
      && (state().partyMenu.phase === "action" || state().partyMenu.phase === "equip" || state().partyMenu.phase === "swapItem")
      ? startMenuViewRect(canvas(), PARTY_SIDE) : disabledRect },
    onTap: (contact) => {
      const point = basePoint(contact.x, contact.y);
      props.runtime.activateIndex(Math.floor((point.y - PARTY_SIDE.y - ACTION_TOP) / ACTION_ROW_H));
    },
  });
  createGesture({
    region: { rect: () => open() && state().screen === "party" && state().partyMenu.phase === "sort" ? startMenuViewRect(canvas(), PARTY_SIDE) : disabledRect },
    onTap: (contact) => {
      const point = basePoint(contact.x, contact.y);
      props.runtime.activateIndex(Math.floor((point.y - PARTY_SIDE.y - ACTION_TOP) / 34));
    },
  });
  createGesture({
    region: { rect: () => open() && state().screen === "party" && state().partyMenu.phase === "releaseConfirm" ? startMenuViewRect(canvas(), RELEASE_RECT) : disabledRect },
    onTap: (contact) => {
      const point = basePoint(contact.x, contact.y);
      props.runtime.activateIndex(point.x < RELEASE_RECT.x + RELEASE_RECT.w / 2 ? 0 : 1);
    },
  });
  createGesture({
    region: { rect: () => open() && state().screen === "party" && (state().partyMenu.phase === "detail" || state().partyMenu.phase === "moves") ? startMenuViewRect(canvas(), DETAIL_RECT) : disabledRect },
    axis: "x",
    panSlop: 14,
    onPanEnd: (contact) => {
      const dx = contact.dx / canvas().scale;
      if (dx < -SWIPE_PX) props.runtime.swipe("right");
      else if (dx > SWIPE_PX) props.runtime.swipe("left");
    },
  });
  createGesture({
    region: { rect: () => open() && state().screen !== "root"
      && state().partyMenu.phase !== "releaseConfirm"
      && state().partyMenu.phase !== "releaseResult"
      ? startMenuViewRect(canvas(), BACK_RECT) : disabledRect },
    onTap: () => props.runtime.applyAction("back"),
  });

  const detailPhase = () => state().screen === "party" && state().partyMenu.phase === "detail";
  const movesPhase = () => state().screen === "party" && state().partyMenu.phase === "moves";
  return (
    <Show when={open()}>
      <View class="absolute inset-0" style={{ posType: 1, bgColor: THEME.backdrop }} debugName="start-menu-overlay">
        <View
          class="absolute overflow-hidden"
          style={{
            posType: 1,
            insetL: canvas().left,
            insetT: canvas().top,
            width: START_MENU_BASE_W,
            height: START_MENU_BASE_H,
            scaleX: canvas().scale,
            scaleY: canvas().scale,
            originX: -0.5,
            originY: -0.5,
            bgColor: THEME.backdrop,
          }}
          debugName="start-menu-canvas"
        >
          <Show when={state().screen === "root"}>
            <RootPage runtime={props.runtime} heading={(EXTRA[props.lang] ?? EXTRA.en_US).menu} />
          </Show>
          <Show when={state().screen === "party" && !detailPhase() && !movesPhase()}>
            <PartyList runtime={props.runtime} catalog={props.catalog} cache={imageCache} active={open()} data={props.data} lang={props.lang} />
          </Show>
          <Show when={detailPhase()}>
            <DetailPage runtime={props.runtime} catalog={props.catalog} cache={imageCache} active={open()} data={props.data} lang={props.lang} units={props.units} />
          </Show>
          <Show when={movesPhase()}>
            <MovesPage runtime={props.runtime} catalog={props.catalog} cache={imageCache} active={open()} data={props.data} lang={props.lang} />
          </Show>
          <Show when={state().screen === "player"}>
            <PlayerPage runtime={props.runtime} data={props.data} lang={props.lang} units={props.units} />
          </Show>
          <Show when={state().screen !== "root"
            && state().partyMenu.phase !== "releaseConfirm"
            && state().partyMenu.phase !== "releaseResult"}>
            <View class="absolute flex-row justify-center items-center" style={{ posType: 1, insetL: BACK_RECT.x, insetT: BACK_RECT.y, width: BACK_RECT.w, height: BACK_RECT.h, borderWidth: 1, borderColor: THEME.border, bgColor: SELECTED_BG }} debugName="start-menu-back">
              <Text class="text-xs" style={{ width: 66, height: 16, lineHeight: 14, textAlign: 1, textColor: "#ffffff" }}>{`× ${pick(props.data.common.back, props.lang)}`}</Text>
            </View>
          </Show>
          <Show when={detailPhase() || movesPhase()}>
            <Text class="text-xs" style={{ posType: 1, insetL: 12, insetT: 251, width: 456, height: 16, lineHeight: 14, textColor: THEME.dim }} debugName="start-menu-detail-controls">{(EXTRA[props.lang] ?? EXTRA.en_US).controls}</Text>
          </Show>
          <Show when={state().screen === "party" && state().partyMenu.phase === "releaseConfirm"}>
            <ReleaseDialog runtime={props.runtime} data={props.data} lang={props.lang} />
          </Show>
          <Show when={state().screen === "party" && state().partyMenu.phase === "releaseResult"}>
            <ReleaseResultDialog runtime={props.runtime} data={props.data} lang={props.lang} />
          </Show>
        </View>
      </View>
    </Show>
  );
};


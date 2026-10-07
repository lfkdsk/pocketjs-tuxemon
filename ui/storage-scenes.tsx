import { Show, type Component } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";

import type { TuxemonSceneCatalog } from "../battle/scenes.ts";
import {
  format,
  LOCKER_LIMIT,
  PARTY_LIMIT,
  pcBagKindCount,
  pcBagRows,
  pcBoxView,
  pcItemName,
  pcItemOptions,
  pcLockerItemCount,
  pcLockerKindCount,
  pcLockerRows,
  pcMenuItems,
  pcMoveTargets,
  pcOptions,
  pcPartyEntryLocked,
  pcSelectedBox,
  pcVisibleBoxes,
  TRADE_ANIMATION_TICKS,
  type MonsterShopSceneState,
  type PcMenuItem,
  type PcOption,
  type PcSceneState,
  type StorageMonsterRow,
  type TradeSceneState,
} from "../battle/storage-scenes.ts";
import type { BattleSceneViewProps } from "../vendor/pocket-rpgkit/src/ui/GameView.tsx";
import { Panel } from "../vendor/pocket-rpgkit/src/ui/Panel.tsx";
import { createBattleImageCache, LazyImage } from "../vendor/pocket-rpgkit/src/ui/battle/index.ts";
import { imageSource, SceneCanvas, title, wrapped } from "./journal-scene.tsx";
import { TUXEMON_UI_THEME } from "./tuxemon-theme.ts";

const THEME = TUXEMON_UI_THEME;
const ROW_HEIGHT = 22;
const VISIBLE_ROWS = 8;
const HP_GOOD = "#5fd068";
const HP_LOW = "#e8a33b";
const HP_CRITICAL = "#e2574c";

function windowStart(cursor: number, length: number, rows = VISIBLE_ROWS): number {
  return Math.max(0, Math.min(Math.max(0, length - rows), cursor - Math.floor(rows / 2)));
}

function Row(props: {
  index: number;
  top: number;
  width: number;
  selected: boolean;
  disabled?: boolean;
  label: string;
  detail?: string;
  debugName: string;
}) {
  const color = () => props.selected ? THEME.paper : props.disabled ? THEME.dim : THEME.ink;
  return (
    <View
      class="absolute"
      style={{
        posType: 1,
        insetL: 5,
        insetT: props.top,
        width: props.width,
        height: ROW_HEIGHT - 2,
        ...(props.selected ? { bgColor: THEME.accent } : {}),
      }}
      debugName={props.debugName}
    >
      <Text
        class="text-sm"
        style={{ posType: 1, insetL: 6, insetT: 2, width: props.width - 70, height: 18, lineHeight: 16, textColor: color() }}
      >
        {props.label}
      </Text>
      <Show when={props.detail}>
        <Text
          class="text-xs"
          style={{ posType: 1, insetR: 6, insetT: 3, width: 64, height: 16, lineHeight: 14, textColor: props.selected ? THEME.paper : THEME.dim }}
        >
          {props.detail!}
        </Text>
      </Show>
    </View>
  );
}

function HpBar(props: { row: StorageMonsterRow; left: number; top: number }) {
  const ratio = () => props.row.maxHp > 0 ? Math.max(0, Math.min(1, props.row.hp / props.row.maxHp)) : 0;
  const color = () => ratio() > 0.5 ? HP_GOOD : ratio() > 0.2 ? HP_LOW : HP_CRITICAL;
  return (
    <View
      class="absolute"
      style={{ posType: 1, insetL: props.left, insetT: props.top, width: 52, height: 6, bgColor: THEME.border }}
    >
      <View
        class="absolute"
        style={{ posType: 1, insetL: 1, insetT: 1, width: Math.round(50 * ratio()), height: 4, bgColor: color() }}
      />
    </View>
  );
}

function MonsterRows(props: {
  state: PcSceneState;
  iids: readonly string[];
  cursor: number;
  highlight: boolean;
  locked?: (iid: string) => boolean;
  prefix: string;
}) {
  const start = () => windowStart(props.cursor, props.iids.length);
  return (
    <>
      {props.iids.slice(start(), start() + VISIBLE_ROWS).map((iid, offset) => {
        const index = start() + offset;
        const row = props.state.monsters[iid]!;
        const selected = props.highlight && index === props.cursor;
        const color = selected ? THEME.paper : props.locked?.(iid) ? THEME.dim : THEME.ink;
        return (
          <View
            class="absolute"
            style={{
              posType: 1,
              insetL: 5,
              insetT: 30 + offset * ROW_HEIGHT,
              width: 264,
              height: ROW_HEIGHT - 2,
              ...(selected ? { bgColor: THEME.accent } : {}),
            }}
            debugName={`${props.prefix}-row-${index}`}
          >
            <Text
              class="text-sm"
              style={{ posType: 1, insetL: 6, insetT: 2, width: 140, height: 18, lineHeight: 16, textColor: color }}
            >
              {row.label}
            </Text>
            <Text
              class="text-xs"
              style={{ posType: 1, insetL: 150, insetT: 3, width: 46, height: 16, lineHeight: 14, textColor: selected ? THEME.paper : THEME.dim }}
            >
              {`Lv.${row.level}`}
            </Text>
            <HpBar row={row} left={202} top={7} />
          </View>
        );
      })}
    </>
  );
}

function ItemRows(props: {
  state: PcSceneState;
  slugs: readonly string[];
  cursor: number;
  highlight: boolean;
  prefix: string;
}) {
  const start = () => windowStart(props.cursor, props.slugs.length);
  return (
    <>
      {props.slugs.slice(start(), start() + VISIBLE_ROWS).map((slug, offset) => {
        const index = start() + offset;
        const selected = props.highlight && index === props.cursor;
        const quantity = props.state.phase === "itemBag" || props.state.phase === "itemQuantity" && props.state.quantityMode === "deposit"
          ? props.state.bag[slug] ?? 0
          : props.state.locker[slug] ?? 0;
        return (
          <Row
            index={index}
            top={30 + offset * ROW_HEIGHT}
            width={264}
            selected={selected}
            label={pcItemName(props.state, slug)}
            detail={`x${quantity}`}
            debugName={`${props.prefix}-row-${index}`}
          />
        );
      })}
    </>
  );
}

function ChoicePopup(props: { labels: readonly string[]; cursor: number; top: number; debugName: string }) {
  return (
    <Panel
      theme={THEME}
      style={{ posType: 1, insetL: 292, insetT: props.top, width: 174, height: 14 + props.labels.length * ROW_HEIGHT }}
      debugName={props.debugName}
    >
      {props.labels.map((label, index) => (
        <Row
          index={index}
          top={5 + index * ROW_HEIGHT}
          width={160}
          selected={index === props.cursor}
          label={label}
          debugName={`${props.debugName}-${index}`}
        />
      ))}
    </Panel>
  );
}

function MessageBar(props: { text: string | null; hint: string }) {
  return (
    <Panel theme={THEME} style={{ posType: 1, insetL: 8, insetT: 228, width: 464, height: 38 }} debugName="storage-message">
      <Text
        class="text-xs"
        style={{ posType: 1, insetL: 10, insetT: 3, width: 440, height: 30, lineHeight: 14, textColor: props.text ? THEME.ink : THEME.dim }}
        debugName="storage-message-text"
      >
        {props.text ? wrapped(props.text, 66, 2) : props.hint}
      </Text>
    </Panel>
  );
}

function menuLabel(state: PcSceneState, item: PcMenuItem): string {
  switch (item) {
    case "pickUp": return state.labels.pickUp;
    case "dropOff": return state.labels.dropOff;
    case "itemPickUp": return state.labels.itemPickUp;
    case "itemDropOff": return state.labels.itemDropOff;
    case "logOff": return state.labels.logOff;
  }
}

function optionLabel(state: PcSceneState, option: PcOption, target: string): string {
  switch (option) {
    case "pick": return state.labels.pick;
    case "move": return state.labels.moveTo.replace("{box}", target);
    case "release": return state.labels.release;
    case "cancel": return state.labels.cancel;
  }
}

function pcHint(state: PcSceneState): string {
  const labels = state.labels;
  switch (state.phase) {
    case "menu": return labels.hintMenu;
    case "boxes": return state.mode === "pickUp" ? labels.hintBoxesPickUp : labels.hintBoxesDropOff;
    case "party": return labels.hintParty;
    case "box": return labels.hintOptions;
    case "itemBoxes": return labels.hintItemBoxes;
    case "itemLocker": return labels.hintOptions;
    case "itemBag": return labels.hintItemBag;
    case "itemOptions": return labels.hintSelect;
    case "itemQuantity": return labels.hintQuantity;
    default: return labels.hintSelect;
  }
}

export const TuxemonPcScene: Component<BattleSceneViewProps> = (props) => {
  const state = (): PcSceneState => props.state as unknown as PcSceneState;
  const menuItems = () => pcMenuItems(state());
  const visibleBoxes = () => pcVisibleBoxes(state());
  const itemPhase = () => {
    const phase = state().phase;
    return phase === "itemBoxes" || phase === "itemLocker" || phase === "itemBag"
      || phase === "itemOptions" || phase === "itemQuantity";
  };
  const navigation = () => {
    const current = state();
    if (current.phase === "party") return "party";
    if (current.phase === "menu") return "menu";
    if (itemPhase()) return "itemBoxes";
    return "boxes";
  };
  const detailIids = (): string[] => {
    const current = state();
    if (current.phase === "party" || (current.phase === "boxes" && current.mode === "dropOff")) return current.party;
    const box = current.phase === "menu" ? undefined : pcSelectedBox(current);
    return box ? pcBoxView(current, box) : current.party;
  };
  const detailSlugs = (): string[] => {
    const current = state();
    if (current.phase === "itemLocker" || current.phase === "itemOptions" || current.phase === "itemQuantity") {
      return current.quantityMode === "deposit" ? pcBagRows(current) : pcLockerRows(current);
    }
    if (current.phase === "itemBag") return pcBagRows(current);
    // itemBoxes: preview the locker (pickUp) or bag (dropOff).
    return current.itemMode === "pickUp" ? pcLockerRows(current) : pcBagRows(current);
  };
  const detailTitle = () => {
    const current = state();
    if (itemPhase()) {
      if (current.phase === "itemBag" || (current.phase === "itemBoxes" && current.itemMode === "dropOff")
        || (current.phase === "itemQuantity" && current.quantityMode === "deposit")) {
        return format(current.labels.bagTitle, { kinds: String(pcBagKindCount(current)) });
      }
      return format(current.labels.lockerTitle, {
        kinds: String(pcLockerKindCount(current)),
        max: String(LOCKER_LIMIT),
        items: String(pcLockerItemCount(current)),
      });
    }
    if (current.phase === "party" || current.phase === "menu"
      || (current.phase === "boxes" && current.mode === "dropOff")) {
      return format(current.labels.partyTitle, { party: String(current.party.length), max: String(PARTY_LIMIT) });
    }
    const box = pcSelectedBox(current);
    return box ? `${box.label.toUpperCase()} ${box.monsters.length}/${box.capacity}` : "";
  };
  const detailCursor = () => {
    const current = state();
    if (itemPhase()) return current.itemCursor;
    if (current.phase === "party" || (current.phase === "boxes" && current.mode === "dropOff")) return current.partyCursor;
    return current.monsterCursor;
  };
  const detailHighlight = () => {
    const phase = state().phase;
    if (phase === "itemLocker" || phase === "itemBag" || phase === "itemOptions" || phase === "itemQuantity") return true;
    return phase === "party" || phase === "box" || phase === "options" || phase === "moveTarget"
      || phase === "confirmRelease" || (phase === "boxes" && state().mode === "dropOff");
  };
  const options = () => pcOptions(state());
  const moveTargets = () => pcMoveTargets(state());
  const moveLabel = () => moveTargets().length === 1 ? moveTargets()[0]!.label : "...";
  const releaseQuestion = () => {
    const current = state();
    const box = pcSelectedBox(current);
    const iid = box ? pcBoxView(current, box)[current.monsterCursor] : undefined;
    return iid ? current.labels.releaseConfirm.replace("{name}", current.monsters[iid]!.label) : null;
  };
  const itemOptionLabels = () => pcItemOptions(state()).map((option) =>
    option === "take" ? state().labels.itemTake : option === "disband" ? state().labels.itemDisband : state().labels.cancel);
  const quantitySlug = () => {
    const current = state();
    const rows = current.quantityMode === "deposit" ? pcBagRows(current) : pcLockerRows(current);
    return rows[current.itemCursor];
  };

  return (
    <SceneCanvas {...props} debugName="tux-pc-scene">
      <Text
        class="text-lg"
        style={{ posType: 1, insetL: 14, insetT: 7, width: 200, height: 22, lineHeight: 20, textColor: THEME.accent }}
        debugName="pc-title"
      >
        {state().labels.title}
      </Text>

      <Panel theme={THEME} style={{ posType: 1, insetL: 8, insetT: 32, width: 180, height: 192 }} debugName="pc-nav-panel">
        <Show when={navigation() === "menu"}>
          {menuItems().map((item, index) => (
            <Row
              index={index}
              top={8 + index * ROW_HEIGHT}
              width={166}
              selected={index === state().menuCursor}
              label={menuLabel(state(), item)}
              debugName={`pc-menu-${item}`}
            />
          ))}
        </Show>
        <Show when={navigation() === "boxes"}>
          {visibleBoxes().map((box, index) => (
            <Row
              index={index}
              top={8 + index * ROW_HEIGHT}
              width={166}
              selected={index === state().boxCursor}
              label={box.label}
              detail={`${box.monsters.length}/${box.capacity}`}
              debugName={`pc-box-${box.id}`}
            />
          ))}
        </Show>
        <Show when={navigation() === "itemBoxes"}>
          <Row
            index={0}
            top={8}
            width={166}
            selected={true}
            label={state().labels.lockerBox}
            detail={`${pcLockerKindCount(state())}/30`}
            debugName="pc-item-box-locker"
          />
        </Show>
        <Show when={navigation() === "party"}>
          <Text
            class="text-sm"
            style={{ posType: 1, insetL: 10, insetT: 10, width: 156, height: 40, lineHeight: 16, textColor: THEME.dim }}
          >
            {state().labels.dropOff}
          </Text>
        </Show>
      </Panel>

      <Panel theme={THEME} style={{ posType: 1, insetL: 194, insetT: 32, width: 278, height: 192 }} debugName="pc-detail-panel">
        <Text
          class="text-sm"
          style={{ posType: 1, insetL: 10, insetT: 6, width: 250, height: 18, lineHeight: 16, textColor: THEME.accent }}
          debugName="pc-detail-title"
        >
          {detailTitle()}
        </Text>
        <Show when={!itemPhase()} fallback={
          <ItemRows
            state={state()}
            slugs={detailSlugs()}
            cursor={detailCursor()}
            highlight={detailHighlight()}
            prefix="pc-item"
          />
        }>
          <MonsterRows
            state={state()}
            iids={detailIids()}
            cursor={detailCursor()}
            highlight={detailHighlight()}
            locked={(iid) => pcPartyEntryLocked(state(), iid)}
            prefix="pc-monster"
          />
        </Show>
      </Panel>

      <Show when={state().phase === "options"}>
        <ChoicePopup
          labels={options().map((option) => optionLabel(state(), option, moveLabel()))}
          cursor={state().optionCursor}
          top={60}
          debugName="pc-options"
        />
      </Show>
      <Show when={state().phase === "moveTarget"}>
        <ChoicePopup
          labels={moveTargets().map((box) => box.label)}
          cursor={state().targetCursor}
          top={60}
          debugName="pc-move-targets"
        />
      </Show>
      <Show when={state().phase === "confirmRelease"}>
        <ChoicePopup
          labels={[state().labels.yes, state().labels.no]}
          cursor={state().confirmCursor}
          top={120}
          debugName="pc-release-confirm"
        />
      </Show>
      <Show when={state().phase === "itemOptions"}>
        <ChoicePopup
          labels={itemOptionLabels()}
          cursor={state().itemOptionCursor}
          top={60}
          debugName="pc-item-options"
        />
      </Show>
      <Show when={state().phase === "itemQuantity"}>
        <Panel theme={THEME} style={{ posType: 1, insetL: 292, insetT: 60, width: 174, height: 96 }} debugName="pc-item-quantity">
          <Text
            class="text-sm"
            style={{ posType: 1, insetL: 10, insetT: 8, width: 154, height: 18, lineHeight: 16, textColor: THEME.ink }}
            debugName="pc-item-quantity-name"
          >
            {quantitySlug() ? pcItemName(state(), quantitySlug()!) : ""}
          </Text>
          <Text
            class="text-lg"
            style={{ posType: 1, insetL: 10, insetT: 30, width: 154, height: 24, lineHeight: 22, textColor: THEME.accent }}
            debugName="pc-item-quantity-value"
          >
            {`x${state().quantity} / ${state().quantityMax}`}
          </Text>
          <Text
            class="text-xs"
            style={{ posType: 1, insetL: 10, insetT: 60, width: 154, height: 28, lineHeight: 13, textColor: THEME.dim }}
            debugName="pc-item-quantity-hint"
          >
            {state().labels.quantityHint}
          </Text>
        </Panel>
      </Show>

      <MessageBar
        text={state().phase === "confirmRelease" ? releaseQuestion() : state().message}
        hint={pcHint(state())}
      />
    </SceneCanvas>
  );
};

function MonsterArt(props: {
  catalog: Readonly<TuxemonSceneCatalog>;
  slug: string;
  active: boolean;
  cache: ReturnType<typeof createBattleImageCache>;
  left: number;
  top: number;
  opacity?: number;
  debugName: string;
}) {
  const monster = () => props.catalog.monster(props.slug);
  return (
    <Show when={monster()}>
      {(entry) => (
        <View
          class="absolute overflow-hidden"
          style={{ posType: 1, insetL: props.left, insetT: props.top, width: 128, height: 128, opacity: props.opacity ?? 1 }}
          debugName={props.debugName}
        >
          <LazyImage
            src={(() => {
              if (props.active) props.cache.beginScope();
              return imageSource(entry().art.sheet);
            })()}
            cache={props.cache}
            active={props.active}
            class="absolute"
            style={{
              posType: 1,
              insetL: -entry().art.front[0] * 2,
              insetT: -entry().art.front[1] * 2,
              width: entry().art.sheet.width * 2,
              height: entry().art.sheet.height * 2,
            }}
            debugName={`${props.debugName}-image`}
          />
        </View>
      )}
    </Show>
  );
}

/** Upstream TradingTransition timeline, in 60 Hz reference ticks. */
export function tradeFrame(tick: number): {
  sent: number;
  received: number;
  sentLeft: number;
  receivedLeft: number;
  white: number;
} {
  const center = 176;
  if (tick < 60) return { sent: 1, received: 0, sentLeft: center, receivedLeft: center, white: 0 };
  if (tick < 180) {
    return { sent: 1, received: 0, sentLeft: center, receivedLeft: center, white: (tick - 60) / 120 };
  }
  if (tick < 360) {
    const sentTurn = Math.floor((tick - 180) / 15) % 2 === 0;
    return { sent: sentTurn ? 1 : 0, received: sentTurn ? 0 : 1, sentLeft: 56, receivedLeft: 296, white: 0 };
  }
  if (tick < TRADE_ANIMATION_TICKS) {
    return { sent: 0, received: 1, sentLeft: center, receivedLeft: center, white: 1 - (tick - 360) / 120 };
  }
  return { sent: 0, received: 1, sentLeft: center, receivedLeft: center, white: 0 };
}

export function createTuxemonTradeScene(catalog: Readonly<TuxemonSceneCatalog>): Component<BattleSceneViewProps> {
  return (props) => {
    const cache = createBattleImageCache(() => props.active, { maxEntries: 2 });
    const state = (): TradeSceneState => props.state as unknown as TradeSceneState;
    const frame = () => tradeFrame(state().tick);
    return (
      <SceneCanvas {...props} debugName="tux-trade-scene">
        <View class="absolute" style={{ posType: 1, insetL: 0, insetT: 0, width: 480, height: 272, bgColor: "#000000" }} />
        <MonsterArt
          catalog={catalog}
          slug={state().sent}
          active={props.active}
          cache={cache}
          left={frame().sentLeft}
          top={52}
          opacity={frame().sent}
          debugName="trade-sent"
        />
        <MonsterArt
          catalog={catalog}
          slug={state().received}
          active={props.active}
          cache={cache}
          left={frame().receivedLeft}
          top={52}
          opacity={frame().received}
          debugName="trade-received"
        />
        <View
          class="absolute"
          style={{ posType: 1, insetL: 0, insetT: 0, width: 480, height: 272, bgColor: "#ffffff", opacity: frame().white }}
          debugName="trade-white"
        />
        <Show when={state().phase !== "animate"}>
          <Panel theme={THEME} style={{ posType: 1, insetL: 8, insetT: 212, width: 464, height: 52 }} debugName="trade-message">
            <Text
              class="text-sm"
              style={{ posType: 1, insetL: 10, insetT: 6, width: 440, height: 40, lineHeight: 17, textColor: THEME.ink }}
              debugName="trade-message-text"
            >
              {wrapped(state().message, 54, 2)}
            </Text>
          </Panel>
        </Show>
      </SceneCanvas>
    );
  };
}

export function createTuxemonMonsterShopScene(
  catalog: Readonly<TuxemonSceneCatalog>,
): Component<BattleSceneViewProps> {
  return (props) => {
    const cache = createBattleImageCache(() => props.active, { maxEntries: 2 });
    const state = (): MonsterShopSceneState => props.state as unknown as MonsterShopSceneState;
    const selected = () => state().rows[state().cursor];
    const detail = () => selected() ? catalog.monster(selected()!.slug) : undefined;
    const start = () => windowStart(state().cursor, state().rows.length);
    const question = () => {
      const row = selected();
      return row
        ? state().labels.confirm.replace("{name}", row.label).replace("{price}", String(row.price))
        : null;
    };
    return (
      <SceneCanvas {...props} debugName="tux-monster-shop-scene">
        <Text
          class="text-lg"
          style={{ posType: 1, insetL: 14, insetT: 7, width: 240, height: 22, lineHeight: 20, textColor: THEME.accent }}
          debugName="shop-title"
        >
          {state().labels.title}
        </Text>
        <Text
          class="text-sm"
          style={{ posType: 1, insetL: 330, insetT: 9, width: 140, height: 18, lineHeight: 16, textColor: THEME.ink }}
          debugName="shop-gold"
        >
          {`Money: $${state().gold}`}
        </Text>

        <Panel theme={THEME} style={{ posType: 1, insetL: 8, insetT: 32, width: 210, height: 192 }} debugName="shop-list-panel">
          {state().rows.slice(start(), start() + VISIBLE_ROWS).map((row, offset) => (
            <Row
              index={start() + offset}
              top={8 + offset * ROW_HEIGHT}
              width={196}
              selected={start() + offset === state().cursor}
              disabled={row.price > state().gold}
              label={row.label}
              detail={`$${row.price}`}
              debugName={`shop-row-${start() + offset}`}
            />
          ))}
        </Panel>

        <Panel theme={THEME} style={{ posType: 1, insetL: 224, insetT: 32, width: 248, height: 192 }} debugName="shop-detail-panel">
          <Show when={selected() && detail()}>
            <MonsterArt
              catalog={catalog}
              slug={selected()!.slug}
              active={props.active}
              cache={cache}
              left={58}
              top={0}
              debugName="shop-monster"
            />
            <Text
              class="text-xs"
              style={{ posType: 1, insetL: 10, insetT: 128, width: 226, height: 16, lineHeight: 14, textColor: THEME.dim }}
              debugName="shop-facts"
            >
              {`Lv.${selected()!.level}   ${detail()!.types.map(title).join(" / ")}`}
            </Text>
            <Text
              class="text-xs"
              style={{ posType: 1, insetL: 10, insetT: 145, width: 226, height: 40, lineHeight: 13, textColor: THEME.ink }}
              debugName="shop-description"
            >
              {wrapped(detail()!.description, 36, 3)}
            </Text>
          </Show>
        </Panel>

        <Show when={state().phase === "confirm"}>
          <ChoicePopup
            labels={[state().labels.buy, state().labels.cancel]}
            cursor={state().confirmCursor}
            top={120}
            debugName="shop-confirm"
          />
        </Show>
        <MessageBar
          text={state().phase === "confirm" ? question() : state().message}
          hint="A: buy  B: leave"
        />
      </SceneCanvas>
    );
  };
}

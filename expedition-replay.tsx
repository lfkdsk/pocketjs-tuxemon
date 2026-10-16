// Dedicated web-only PocketJS entry for public expedition journals. The web
// builder emits a separate bundle and pak, so ordinary game startup never
// imports the journal validator, replay model, or expedition artwork.

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { mount } from "@pocketjs/framework";
import { Text, View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";

import battleDbJson from "./data/battle-db.json";
import battleDbZhJson from "./data/battle-db.zh_CN.json";
import type { ArenaAction, ArenaObservation } from "./battle/arena.ts";
import {
  loadExpeditionReplayJournal,
  prepareValidatedExpeditionReplay,
  type ExpeditionReplayFrame,
  type PreparedExpeditionReplay,
} from "./battle/expedition-replay.ts";
import type {
  ExpeditionAction,
  ExpeditionObservation,
  ExpeditionPublicName,
} from "./battle/expedition.ts";
import type { BattleDb, BattleImageRef } from "./importer/battle-schema.ts";
import { detectLang, type Lang } from "./ui/language.ts";
import { fitBounded, marqueeOffset } from "./vendor/pocket-rpgkit/src/ui/list-window.ts";
import {
  createBattleImageCache,
  LazyImage,
  type TileImageSource,
} from "./vendor/pocket-rpgkit/src/ui/battle/index.ts";
import { slotMeasure, TEXT_2XS_SLOT } from "./vendor/pocket-rpgkit/src/ui/text-measure.ts";

const DB = battleDbJson as unknown as BattleDb;
const ZH_DB = battleDbZhJson as unknown as BattleDb;
const lang = detectLang();

const COPY = lang === "zh_CN" ? {
  title: "远征回放",
  loading: "正在加载远征日志…",
  ready: "日志已验证",
  complete: "回放结束",
  error: "无法加载日志",
  play: "播放",
  pause: "暂停",
  step: "前进一步",
  speed: "速度",
  timeline: "时间轴",
  frame: "画面",
  journalStep: "远征步",
  controls: "远征回放控制",
  help: "只读取公开、无种子的版本化 JSON 日志；支持 data:、同源路径和显式 HTTPS 外部地址。",
  route: "区域路线",
  event: "当前事件",
  party: "队伍",
  backpack: "背包",
  emptyBackpack: "背包为空",
  initial: "远征整装待发",
  travel: "移动区域",
  explore: "探索遭遇",
  capture: "捕获尝试",
  battle: "战斗",
  shop: "商店购买",
  heal: "队伍治疗",
  useItem: "使用道具",
  learnMove: "学习招式",
  flee: "离开遭遇",
  end: "远征结束",
  success: "捕获成功",
  failed: "挣脱了",
  shakes: "摇晃",
  consumed: "已消耗",
  retained: "未消耗",
  player: "我方",
  wild: "野生",
  move: "招式",
  swap: "换位",
  item: "道具",
  run: "逃跑",
  level: "等级",
  money: "金币",
  steps: "剩余步数",
  active: "进行中",
  voluntary: "主动结束",
  budget: "步数耗尽",
  defeated: "队伍战败",
  noEncounter: "没有遭遇",
  runNumber: "轮次",
} : {
  title: "Expedition replay",
  loading: "Loading expedition journal…",
  ready: "Journal verified",
  complete: "Replay complete",
  error: "Could not load journal",
  play: "Play",
  pause: "Pause",
  step: "Step",
  speed: "Speed",
  timeline: "Timeline",
  frame: "Frame",
  journalStep: "Expedition step",
  controls: "Expedition replay controls",
  help: "Reads public, seedless versioned JSON journals only: data:, same-origin paths, or explicitly enabled external HTTPS.",
  route: "Area route",
  event: "Current event",
  party: "Party",
  backpack: "Backpack",
  emptyBackpack: "Backpack empty",
  initial: "Expedition ready",
  travel: "Travel",
  explore: "Exploration encounter",
  capture: "Capture attempt",
  battle: "Battle",
  shop: "Shop purchase",
  heal: "Party healed",
  useItem: "Item used",
  learnMove: "Move learned",
  flee: "Encounter left",
  end: "Expedition ended",
  success: "Captured",
  failed: "Broke free",
  shakes: "shakes",
  consumed: "consumed",
  retained: "retained",
  player: "Player",
  wild: "Wild",
  move: "Move",
  swap: "Swap",
  item: "Item",
  run: "Run",
  level: "Lv",
  money: "Gold",
  steps: "Steps left",
  active: "Active",
  voluntary: "Ended voluntarily",
  budget: "Step budget exhausted",
  defeated: "Party defeated",
  noEncounter: "No encounter",
  runNumber: "Run",
};

const AREA_NAMES: Record<string, { en_US: string; zh_CN: string }> = {
  spyder_citypark: { en_US: "City Park", zh_CN: "城市公园" },
  spyder_route1: { en_US: "Route 1", zh_CN: "1号道路" },
  spyder_route2: { en_US: "Route 2", zh_CN: "2号道路" },
  spyder_route3: { en_US: "Route 3", zh_CN: "3号道路" },
  spyder_route3_desert: { en_US: "Route 3 Desert", zh_CN: "3号道路沙漠" },
  spyder_route4: { en_US: "Route 4", zh_CN: "4号道路" },
  spyder_route5: { en_US: "Route 5", zh_CN: "5号道路" },
  spyder_route6: { en_US: "Route 6", zh_CN: "6号道路" },
};

const AREA_POINTS: Record<string, { x: number; y: number; short: string }> = {
  spyder_citypark: { x: 17, y: 29, short: "CP" },
  spyder_route1: { x: 43, y: 49, short: "R1" },
  spyder_route2: { x: 69, y: 29, short: "R2" },
  spyder_route3: { x: 94, y: 50, short: "R3" },
  spyder_route3_desert: { x: 68, y: 78, short: "D3" },
  spyder_route4: { x: 122, y: 72, short: "R4" },
  spyder_route5: { x: 96, y: 99, short: "R5" },
  spyder_route6: { x: 128, y: 111, short: "R6" },
};

const AREA_EDGES: Array<[string, string]> = [
  ["spyder_citypark", "spyder_route1"],
  ["spyder_route1", "spyder_route2"],
  ["spyder_route2", "spyder_route3"],
  ["spyder_route3", "spyder_route3_desert"],
  ["spyder_route3", "spyder_route4"],
  ["spyder_route4", "spyder_route5"],
  ["spyder_route5", "spyder_route6"],
];

const THEME = {
  backdrop: "#071722",
  panel: "#102a38",
  panelAlt: "#163848",
  rim: "#70d7c3",
  ink: "#f6f1d8",
  dim: "#9ab7ba",
  accent: "#f0b84b",
  path: "#42b8a4",
  danger: "#e56b6f",
  hp: "#56cf78",
  hpLow: "#e9a84d",
  track: "#294956",
} as const;

export interface ExpeditionReplayPageState {
  status: "loading" | "ready" | "error";
  frame: number;
  total: number;
  journalStep: number;
  entries: number;
  playing: boolean;
  speed: 1 | 2 | 4;
  error: string | null;
}

export interface ExpeditionReplayPageHook {
  state(): ExpeditionReplayPageState;
  observation(): ExpeditionObservation | null;
  play(): void;
  pause(): void;
  step(): void;
  restart(): void;
  seek(frame: number): void;
  setSpeed(speed: 1 | 2 | 4): void;
}

declare global {
  // eslint-disable-next-line no-var
  var __pocketExpeditionReplay: ExpeditionReplayPageHook | undefined;
}

const browser = globalThis as unknown as {
  document?: Document;
  location?: Location;
  fetch?: typeof fetch;
};
const document = browser.document;
const location = browser.location;

function element(id: string): HTMLElement | null {
  return document?.getElementById(id) ?? null;
}

function button(id: string): HTMLButtonElement | null {
  return element(id) as HTMLButtonElement | null;
}

function range(id: string): HTMLInputElement | null {
  return element(id) as HTMLInputElement | null;
}

if (document) {
  document.title = `${COPY.title} · Pocket Tuxemon`;
  document.documentElement.lang = lang === "zh_CN" ? "zh-CN" : "en";
  document.documentElement.dataset.expeditionReplay = "true";
  const title = element("expedition-replay-title");
  const help = element("expedition-replay-help");
  const step = element("expedition-replay-step");
  const speed = element("expedition-replay-speed-label");
  const timeline = element("expedition-replay-timeline-label");
  const controls = document.querySelector<HTMLElement>(".expedition-replay-row");
  if (title) title.textContent = COPY.title;
  if (help) help.textContent = COPY.help;
  if (step) step.textContent = COPY.step;
  if (speed) speed.textContent = COPY.speed;
  if (timeline) timeline.textContent = COPY.timeline;
  controls?.setAttribute("aria-label", COPY.controls);
}

function localName(value: ExpeditionPublicName | { en_US: string; zh_CN: string }): string {
  return lang === "zh_CN" ? value.zh_CN : value.en_US;
}

function areaName(id: string, fallback: string): string {
  const value = AREA_NAMES[id];
  return value ? (lang === "zh_CN" ? value.zh_CN : value.en_US) : fallback;
}

function itemName(slug: string): string {
  const db = lang === "zh_CN" ? ZH_DB : DB;
  return db.items[slug]?.name ?? slug;
}

function moveName(slug: string): string {
  const db = lang === "zh_CN" ? ZH_DB : DB;
  return db.techniques[slug]?.name ?? slug;
}

function imageSource(ref: BattleImageRef): TileImageSource {
  return { kind: "tile", ref: ref.key, sourceWidth: ref.width, sourceHeight: ref.height };
}

function BoundedLabel(props: {
  text: string;
  width: number;
  height: number;
  tick: number;
  maxRows?: number;
  color?: string;
  left?: number;
  top?: number;
  debugName: string;
}) {
  const layout = createMemo(() => fitBounded(
    props.text,
    props.width,
    props.maxRows ?? 1,
    slotMeasure(TEXT_2XS_SLOT),
  ));
  const offset = () => layout().kind === "marquee" ? marqueeOffset(layout().overflow, props.tick) : 0;
  return (
    <View
      class="absolute overflow-hidden"
      style={{
        posType: 1,
        insetL: props.left ?? 0,
        insetT: props.top ?? 0,
        width: props.width,
        height: props.height,
      }}
      debugName={props.debugName}
    >
      <For each={layout().rows}>{(row, index) => (
        <Text
          class="absolute text-2xs"
          style={{
            posType: 1,
            insetL: layout().kind === "marquee" ? -offset() : 0,
            insetT: index() * 10,
            width: Math.max(props.width, Math.ceil(slotMeasure(TEXT_2XS_SLOT)(row)) + 2),
            height: 10,
            lineHeight: 10,
            textColor: props.color ?? THEME.ink,
          }}
          debugName={`${props.debugName}-row-${index()}`}
        >
          {row}
        </Text>
      )}</For>
    </View>
  );
}

function SpriteCrop(props: {
  slug: string;
  kind: "front" | "menu";
  size: number;
  left: number;
  top: number;
  cache: ReturnType<typeof createBattleImageCache>;
  debugName: string;
}) {
  const monster = () => DB.monsters[props.slug];
  const rect = () => {
    const art = monster()?.art;
    if (!art) return null;
    return props.kind === "front" ? art.front : art.menu[0];
  };
  const scale = () => {
    const row = rect();
    return row ? props.size / row[2] : 1;
  };
  return (
    <Show when={monster() && rect()}>
      <View
        class="absolute overflow-hidden"
        style={{
          posType: 1,
          insetL: props.left,
          insetT: props.top,
          width: props.size,
          height: props.size,
        }}
        debugName={props.debugName}
      >
        <LazyImage
          src={(() => {
            props.cache.beginScope();
            return imageSource(monster()!.art.sheet);
          })()}
          cache={props.cache}
          active
          class="absolute"
          style={{
            posType: 1,
            insetL: -rect()![0] * scale(),
            insetT: -rect()![1] * scale(),
            width: monster()!.art.sheet.width * scale(),
            height: monster()!.art.sheet.height * scale(),
          }}
          debugName={`${props.debugName}-image`}
        />
      </View>
    </Show>
  );
}

function edgeKey(left: string, right: string): string {
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function RouteMap(props: { replay: PreparedExpeditionReplay; frame: ExpeditionReplayFrame; tick: number }) {
  const prefix = () => props.replay.route.slice(0, Math.min(props.frame.journalStep + 1, props.replay.route.length));
  const visited = () => new Set(prefix());
  const walked = () => new Set(prefix().slice(1).map((area, index) => edgeKey(prefix()[index]!, area)));
  return (
    <View
      class="absolute"
      style={{ posType: 1, insetL: 8, insetT: 28, width: 148, height: 126, bgColor: THEME.panel }}
      debugName="expedition-route-panel"
    >
      <Text class="absolute text-xs" style={{ posType: 1, insetL: 7, insetT: 4, width: 134, height: 14, lineHeight: 14, textColor: THEME.rim }}>
        {COPY.route}
      </Text>
      <For each={AREA_EDGES}>{([left, right]) => {
        const a = AREA_POINTS[left]!;
        const b = AREA_POINTS[right]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const selected = () => walked().has(edgeKey(left, right));
        return <View
          class="absolute"
          style={{
            posType: 1,
            insetL: a.x + 3,
            insetT: a.y + 3,
            width: Math.hypot(dx, dy),
            height: selected() ? 3 : 2,
            rotate: Math.atan2(dy, dx) * 180 / Math.PI,
            originX: -0.5,
            bgColor: selected() ? THEME.path : THEME.track,
          }}
          debugName={`expedition-route-edge-${left}-${right}`}
        />;
      }}</For>
      <For each={Object.entries(AREA_POINTS)}>{([id, point]) => {
        const current = () => props.frame.observation.area.id === id;
        return (
          <View
            class="absolute"
            style={{
              posType: 1,
              insetL: point.x,
              insetT: point.y,
              width: current() ? 10 : 8,
              height: current() ? 10 : 8,
              radius: 5,
              bgColor: current() ? THEME.accent : visited().has(id) ? THEME.path : THEME.dim,
            }}
            debugName={`expedition-route-node-${id}`}
          >
            <Text
              class="absolute text-2xs"
              style={{ posType: 1, insetL: -3, insetT: 7, width: 18, height: 10, lineHeight: 10, textColor: THEME.ink }}
            >
              {point.short}
            </Text>
          </View>
        );
      }}</For>
      <BoundedLabel
        text={areaName(props.frame.observation.area.id, props.frame.observation.area.name)}
        width={134}
        height={20}
        tick={props.tick}
        maxRows={2}
        left={7}
        top={105}
        color={THEME.accent}
        debugName="expedition-current-area"
      />
    </View>
  );
}

function actionTitle(action: ExpeditionAction | null): string {
  if (!action) return COPY.initial;
  switch (action.type) {
    case "travel": return COPY.travel;
    case "explore": return COPY.explore;
    case "catch": return COPY.capture;
    case "battle": return COPY.battle;
    case "shop": return COPY.shop;
    case "heal": return COPY.heal;
    case "useItem": return COPY.useItem;
    case "learnMove": return COPY.learnMove;
    case "flee": return COPY.flee;
    case "end": return COPY.end;
  }
}

function previousExpeditionObservation(
  replay: PreparedExpeditionReplay,
  frame: ExpeditionReplayFrame,
): ExpeditionObservation {
  if (frame.journalStep <= 1) return replay.journal.initialObservation;
  return replay.journal.entries[frame.journalStep - 2]!.observation;
}

function previousArenaObservation(
  replay: PreparedExpeditionReplay,
  frame: ExpeditionReplayFrame,
): ArenaObservation | null {
  if (!frame.battle) return null;
  if (frame.battle.index > 0) {
    const transition = frame.observation.lastTransition;
    return transition?.type === "battle"
      ? transition.turns[frame.battle.index - 1]!.observation
      : null;
  }
  return previousExpeditionObservation(replay, frame).encounter?.battle ?? null;
}

function arenaActionLabel(action: ArenaAction, observation: ArenaObservation, own: boolean): string {
  if (action.type === "move") {
    if (own) {
      const party = observation.own.party[observation.own.active[0] ?? 0];
      const move = party?.moves[action.slot];
      if (move) return lang === "zh_CN" ? move.displayName.zh_CN : move.displayName.en_US;
    } else {
      const moves = observation.opponent.active[0]?.revealedMoves ?? [];
      const revealed = moves.at(-1);
      if (revealed) return lang === "zh_CN" ? revealed.displayName.zh_CN : revealed.displayName.en_US;
    }
    return `${COPY.move} ${action.slot + 1}`;
  }
  if (action.type === "swap") return COPY.swap;
  if (action.type === "item") return itemName(action.item);
  return COPY.run;
}

function activeHp(observation: ArenaObservation, own: boolean): number {
  if (!own) return observation.opponent.active[0]?.hpPercent ?? 0;
  const active = observation.own.active[0];
  return active === undefined ? 0 : observation.own.party[active]?.hp.percent ?? 0;
}

function eventSpecies(replay: PreparedExpeditionReplay, frame: ExpeditionReplayFrame): string | null {
  const transition = frame.observation.lastTransition;
  if (transition?.type === "capture") return transition.species.slug;
  if (frame.battle) {
    return frame.battle.turn.observation.opponent.active[0]?.species.slug ??
      previousArenaObservation(replay, frame)?.opponent.active[0]?.species.slug ??
      previousExpeditionObservation(replay, frame).encounter?.species.slug ?? null;
  }
  return frame.observation.encounter?.species.slug ?? null;
}

function eventLines(replay: PreparedExpeditionReplay, frame: ExpeditionReplayFrame): string[] {
  const action = frame.action;
  const observation = frame.observation;
  const transition = observation.lastTransition;
  if (!action) return [`${COPY.runNumber} ${observation.run}`, areaName(observation.area.id, observation.area.name)];
  if (frame.battle) {
    const now = frame.battle.turn.observation;
    const before = previousArenaObservation(replay, frame) ?? now;
    const playerMove = arenaActionLabel(frame.battle.turn.playerAction, before, true);
    const wildMove = arenaActionLabel(frame.battle.turn.opponentAction, now, false);
    return [
      `${COPY.player}: ${playerMove}`,
      `HP ${activeHp(before, true)}→${activeHp(now, true)}%`,
      `${COPY.wild}: ${wildMove}`,
      `HP ${activeHp(before, false)}→${activeHp(now, false)}%`,
    ];
  }
  if (action.type === "travel") return [areaName(observation.area.id, observation.area.name)];
  if (action.type === "explore") return observation.encounter ? [
    localName(observation.encounter.species),
    `${COPY.level} ${observation.encounter.level} · HP ${observation.encounter.hpPercent}%`,
  ] : [COPY.noEncounter];
  if (action.type === "catch" && transition?.type === "capture") return [
    `${localName(transition.item)} · ${transition.shakes} ${COPY.shakes}`,
    transition.success ? COPY.success : COPY.failed,
    transition.consumed ? COPY.consumed : COPY.retained,
  ];
  if (action.type === "shop") return [
    `${itemName(action.item)} ×${action.quantity}`,
    `${COPY.money}: ${observation.money}`,
  ];
  if (action.type === "heal") return [COPY.heal];
  if (action.type === "useItem") {
    return [itemName(action.item), observation.team[action.target]
      ? localName(observation.team[action.target]!.species)
      : `#${action.target + 1}`];
  }
  if (action.type === "learnMove") return [
    moveName(action.move),
    observation.team[action.target] ? localName(observation.team[action.target]!.species) : `#${action.target + 1}`,
  ];
  if (action.type === "flee") return [COPY.flee];
  if (action.type === "end") return [COPY.voluntary];
  return [actionTitle(action)];
}

function EventCard(props: {
  replay: PreparedExpeditionReplay;
  frame: ExpeditionReplayFrame;
  tick: number;
  cache: ReturnType<typeof createBattleImageCache>;
}) {
  const species = () => eventSpecies(props.replay, props.frame);
  const lines = () => eventLines(props.replay, props.frame);
  const title = () => props.frame.battle
    ? `${COPY.battle} · ${props.frame.battle.index + 1}/${props.frame.battle.total}`
    : actionTitle(props.frame.action);
  return (
    <View
      class="absolute"
      style={{ posType: 1, insetL: 164, insetT: 28, width: 160, height: 126, bgColor: THEME.panelAlt }}
      debugName="expedition-event-panel"
    >
      <BoundedLabel text={title()} width={146} height={20} tick={props.tick} maxRows={2}
        left={7} top={4} color={THEME.rim} debugName="expedition-event-title" />
      <Show when={species()}>
        {(slug) => <SpriteCrop slug={slug()} kind="front" size={64} left={5} top={29} cache={props.cache}
          debugName="expedition-event-monster" />}
      </Show>
      <View class="absolute" style={{ posType: 1, insetL: species() ? 73 : 8, insetT: 31, width: species() ? 81 : 144, height: 80 }}>
        <For each={lines()}>{(line, index) => (
          <BoundedLabel text={line} width={species() ? 81 : 144} height={20} tick={props.tick + index() * 13}
            maxRows={2} top={index() * 20} color={index() === 1 ? THEME.accent : THEME.ink}
            debugName={`expedition-event-line-${index()}`} />
        )}</For>
      </View>
      <Show when={props.frame.observation.lastTransition?.type === "capture"}>
        <View class="absolute" style={{ posType: 1, insetL: 7, insetT: 105, width: 66, height: 10 }}>
          <For each={[0, 1, 2, 3]}>{(index) => {
            const transition = props.frame.observation.lastTransition;
            const filled = transition?.type === "capture" && index < transition.shakes;
            return <View class="absolute" style={{ posType: 1, insetL: index * 14, insetT: 0, width: 8, height: 8,
              radius: 4, bgColor: filled ? (transition.success ? THEME.hp : THEME.accent) : THEME.track }} />;
          }}</For>
        </View>
      </Show>
    </View>
  );
}

function hpColor(current: number, maximum: number): string {
  const ratio = maximum > 0 ? current / maximum : 0;
  return ratio > 0.5 ? THEME.hp : ratio > 0.2 ? THEME.hpLow : THEME.danger;
}

function PartyPanel(props: {
  observation: ExpeditionObservation;
  tick: number;
  cache: ReturnType<typeof createBattleImageCache>;
}) {
  return (
    <View class="absolute" style={{ posType: 1, insetL: 332, insetT: 28, width: 140, height: 210, bgColor: THEME.panel }}
      debugName="expedition-party-panel">
      <Text class="absolute text-xs" style={{ posType: 1, insetL: 7, insetT: 4, width: 126, height: 14, lineHeight: 14, textColor: THEME.rim }}>
        {COPY.party} · {props.observation.team.length}/5
      </Text>
      <For each={props.observation.team}>{(member, index) => {
        const y = () => 21 + index() * 36;
        const fill = () => Math.max(0, Math.min(78, Math.round(78 * member.hp.current / member.hp.max)));
        return (
          <View class="absolute" style={{ posType: 1, insetL: 5, insetT: y(), width: 130, height: 34,
            bgColor: index() % 2 === 0 ? THEME.panelAlt : THEME.panel }} debugName={`expedition-party-row-${index()}`}>
            <SpriteCrop slug={member.species.slug} kind="menu" size={24} left={2} top={5} cache={props.cache}
              debugName={`expedition-party-sprite-${index()}`} />
            <BoundedLabel text={localName(member.species)} width={96} height={20} tick={props.tick + index() * 17}
              maxRows={2} left={30} top={0} color={THEME.ink} debugName={`expedition-party-name-${index()}`} />
            <Text class="absolute text-2xs" style={{ posType: 1, insetL: 30, insetT: 20, width: 42, height: 10,
              lineHeight: 10, textColor: THEME.dim }}>{COPY.level} {member.level}</Text>
            <Text class="absolute text-2xs" style={{ posType: 1, insetL: 76, insetT: 20, width: 50, height: 10,
              lineHeight: 10, textColor: THEME.ink }}>{member.hp.current}/{member.hp.max}</Text>
            <View class="absolute" style={{ posType: 1, insetL: 30, insetT: 30, width: 78, height: 3, bgColor: THEME.track }}>
              <View style={{ width: 78, height: 3, bgColor: hpColor(member.hp.current, member.hp.max),
                scaleX: fill() / 78, originX: -0.5 }} debugName={`expedition-party-hp-${index()}`} />
            </View>
            <Show when={member.status}>
              {(status) => <Text class="absolute text-2xs" style={{ posType: 1, insetL: 111, insetT: 29, width: 17,
                height: 10, lineHeight: 10, textColor: THEME.danger }}>{status().slice(0, 2).toUpperCase()}</Text>}
            </Show>
          </View>
        );
      }}</For>
    </View>
  );
}

function endingText(observation: ExpeditionObservation): string {
  if (observation.status !== "ended" || !observation.result) return COPY.active;
  return COPY[observation.result.reason];
}

function InventoryPanel(props: { observation: ExpeditionObservation; tick: number }) {
  const rows = () => props.observation.backpack.map((item) =>
    `${lang === "zh_CN" ? item.zh_CN : item.en_US} ×${item.quantity}`
  );
  return (
    <View class="absolute" style={{ posType: 1, insetL: 8, insetT: 162, width: 316, height: 76, bgColor: THEME.panel }}
      debugName="expedition-inventory-panel">
      <Text class="absolute text-xs" style={{ posType: 1, insetL: 7, insetT: 4, width: 302, height: 14,
        lineHeight: 14, textColor: THEME.rim }}>{COPY.backpack}</Text>
      <Text class="absolute text-2xs" style={{ posType: 1, insetL: 105, insetT: 5, width: 204, height: 10,
        lineHeight: 10, textColor: THEME.accent }}>
        {COPY.money} {props.observation.money} · {COPY.steps} {props.observation.remainingSteps}
      </Text>
      <Show when={rows().length > 0} fallback={
        <Text class="absolute text-xs" style={{ posType: 1, insetL: 8, insetT: 26, width: 180, height: 14,
          lineHeight: 14, textColor: THEME.dim }}>{COPY.emptyBackpack}</Text>
      }>
        <For each={rows().slice(0, 6)}>{(row, index) => (
          <BoundedLabel text={row} width={145} height={12} tick={props.tick + index() * 11}
            left={8 + (index() % 2) * 152} top={23 + Math.floor(index() / 2) * 14}
            color={THEME.ink} debugName={`expedition-backpack-${index()}`} />
        )}</For>
      </Show>
      <BoundedLabel text={endingText(props.observation)} width={300} height={10} tick={props.tick}
        left={8} top={62} color={props.observation.status === "ended" ? THEME.accent : THEME.dim}
        debugName="expedition-ending" />
    </View>
  );
}

function ReplayCanvas(props: {
  replay: PreparedExpeditionReplay;
  frame: ExpeditionReplayFrame;
  tick: number;
}) {
  const cache = createBattleImageCache(() => true, { maxEntries: 8 });
  const progress = () => props.replay.frames.length <= 1
    ? 1
    : props.frame.index / (props.replay.frames.length - 1);
  return (
    <View class="absolute" style={{ posType: 1, insetL: 0, insetT: 0, width: 480, height: 272, bgColor: THEME.backdrop }}
      debugName="expedition-replay-canvas">
      <View class="absolute" style={{ posType: 1, insetL: 0, insetT: 0, width: 480, height: 22, bgColor: THEME.panelAlt }}>
        <Text class="absolute text-sm" style={{ posType: 1, insetL: 8, insetT: 2, width: 200, height: 18,
          lineHeight: 18, textColor: THEME.ink }}>{COPY.title}</Text>
        <Text class="absolute text-xs" style={{ posType: 1, insetL: 210, insetT: 4, width: 262, height: 14,
          lineHeight: 14, textColor: THEME.accent }}>
          {COPY.journalStep} {props.frame.journalStep}/{props.replay.journal.entries.length} · {COPY.runNumber} {props.frame.observation.run}
        </Text>
      </View>
      <RouteMap replay={props.replay} frame={props.frame} tick={props.tick} />
      <EventCard replay={props.replay} frame={props.frame} tick={props.tick} cache={cache} />
      <InventoryPanel observation={props.frame.observation} tick={props.tick} />
      <PartyPanel observation={props.frame.observation} tick={props.tick} cache={cache} />
      <View class="absolute" style={{ posType: 1, insetL: 8, insetT: 246, width: 464, height: 8, bgColor: THEME.track }}
        debugName="expedition-timeline-track">
        <View style={{ width: 464, height: 8, bgColor: THEME.path, scaleX: progress(), originX: -0.5 }}
          debugName="expedition-timeline-fill" />
        <View class="absolute" style={{ posType: 1, insetL: Math.max(0, Math.round(progress() * 456)), insetT: -2,
          width: 8, height: 12, radius: 4, bgColor: THEME.accent }} debugName="expedition-timeline-cursor" />
      </View>
      <Text class="absolute text-2xs" style={{ posType: 1, insetL: 8, insetT: 258, width: 464, height: 10,
        lineHeight: 10, textColor: THEME.dim }}>
        {COPY.frame} {props.frame.index}/{Math.max(0, props.replay.frames.length - 1)} · {areaName(props.frame.observation.area.id, props.frame.observation.area.name)}
      </Text>
    </View>
  );
}

function ReplayApp() {
  const [preparedSignal, setPrepared] = createSignal<PreparedExpeditionReplay | null>(null);
  const [cursorSignal, setCursor] = createSignal(0);
  const [uiTick, setUiTick] = createSignal(0);
  const [canvasMessage, setCanvasMessage] = createSignal(COPY.loading);
  let playing = false;
  let speed: 1 | 2 | 4 = 1;
  let frameTicks = 0;
  let failure: string | null = null;

  const current = createMemo(() => preparedSignal()?.frames[cursorSignal()] ?? null);
  const state = (): ExpeditionReplayPageState => ({
    status: failure !== null ? "error" : preparedSignal() === null ? "loading" : "ready",
    frame: cursorSignal(),
    total: Math.max(0, (preparedSignal()?.frames.length ?? 1) - 1),
    journalStep: current()?.journalStep ?? 0,
    entries: preparedSignal()?.journal.entries.length ?? 0,
    playing,
    speed,
    error: failure,
  });

  const syncControls = (): void => {
    const prepared = preparedSignal();
    const cursor = cursorSignal();
    const complete = prepared !== null && cursor >= prepared.frames.length - 1;
    const play = button("expedition-replay-play");
    const step = button("expedition-replay-step");
    const timeline = range("expedition-replay-timeline");
    const counter = element("expedition-replay-counter");
    const status = element("expedition-replay-status");
    if (play) {
      play.textContent = playing ? COPY.pause : COPY.play;
      play.disabled = prepared === null || failure !== null || complete;
      play.setAttribute("aria-pressed", playing ? "true" : "false");
    }
    if (step) step.disabled = prepared === null || failure !== null || complete;
    if (timeline) {
      timeline.disabled = prepared === null || failure !== null;
      timeline.min = "0";
      timeline.max = String(Math.max(0, (prepared?.frames.length ?? 1) - 1));
      timeline.value = String(cursor);
      timeline.setAttribute("aria-valuetext", `${COPY.frame} ${cursor}`);
    }
    if (counter) counter.textContent = `${COPY.frame} ${cursor} / ${Math.max(0, (prepared?.frames.length ?? 1) - 1)}`;
    if (status) status.textContent = failure !== null
      ? `${COPY.error}: ${failure}`
      : prepared === null ? COPY.loading : complete ? COPY.complete : COPY.ready;
    for (const speedButton of Array.from(
      document?.querySelectorAll<HTMLButtonElement>("[data-expedition-replay-speed]") ?? [],
    )) {
      const selected = speedButton === button(`expedition-replay-speed-${speed}`);
      speedButton.setAttribute("aria-pressed", selected ? "true" : "false");
    }
  };

  const pause = (): void => {
    playing = false;
    frameTicks = 0;
    syncControls();
  };

  const seek = (frame: number): void => {
    const prepared = preparedSignal();
    if (!prepared || !Number.isFinite(frame)) return;
    const next = Math.max(0, Math.min(prepared.frames.length - 1, Math.trunc(frame)));
    setCursor(next);
    if (next >= prepared.frames.length - 1) playing = false;
    frameTicks = 0;
    syncControls();
  };

  const step = (): void => {
    const prepared = preparedSignal();
    if (!prepared || cursorSignal() >= prepared.frames.length - 1) {
      pause();
      return;
    }
    seek(cursorSignal() + 1);
  };

  const play = (): void => {
    const prepared = preparedSignal();
    if (!prepared || failure !== null || cursorSignal() >= prepared.frames.length - 1) return;
    playing = true;
    syncControls();
  };

  const restart = (): void => {
    playing = false;
    seek(0);
  };

  const setSpeed = (next: 1 | 2 | 4): void => {
    speed = next;
    frameTicks = 0;
    syncControls();
  };

  const hook: ExpeditionReplayPageHook = {
    state,
    observation: () => current()?.observation ?? null,
    play,
    pause,
    step,
    restart,
    seek,
    setSpeed,
  };
  globalThis.__pocketExpeditionReplay = hook;
  onCleanup(() => {
    if (globalThis.__pocketExpeditionReplay === hook) delete globalThis.__pocketExpeditionReplay;
  });

  onFrame(() => {
    setUiTick((value) => value + 1);
    if (!playing) return;
    frameTicks += speed;
    if (frameTicks < 60) return;
    frameTicks -= 60;
    step();
  });

  onMount(() => {
    const playButton = button("expedition-replay-play");
    const stepButton = button("expedition-replay-step");
    const timeline = range("expedition-replay-timeline");
    if (playButton) playButton.onclick = () => playing ? pause() : play();
    if (stepButton) stepButton.onclick = () => step();
    if (timeline) timeline.oninput = () => {
      const next = Number(timeline.value);
      pause();
      seek(next);
    };
    for (const value of [1, 2, 4] as const) {
      const speedButton = button(`expedition-replay-speed-${value}`);
      if (speedButton) speedButton.onclick = () => setSpeed(value);
    }
    syncControls();
    if (!location || !browser.fetch) {
      failure = "browser replay APIs are unavailable";
      setCanvasMessage(`${COPY.error}: ${failure}`);
      syncControls();
      return;
    }
    void loadExpeditionReplayJournal(
      location.search,
      location.href,
      (url, init) => browser.fetch!(url, init),
    ).then((journal) => {
      setPrepared(prepareValidatedExpeditionReplay(journal));
      setCursor(0);
      syncControls();
      play();
    }).catch((error: unknown) => {
      failure = error instanceof Error ? error.message : String(error);
      setCanvasMessage(`${COPY.error}: ${failure}`);
      syncControls();
    });
  });

  return (
    <Show
      when={preparedSignal() && current()}
      fallback={<View class="absolute flex items-center justify-center" style={{ posType: 1, insetL: 0, insetT: 0,
        width: 480, height: 272, bgColor: THEME.backdrop }} debugName="expedition-replay-loading">
        <Text class="text-sm text-center" style={{ width: 420, height: 80, lineHeight: 18, textColor: THEME.ink }}>
          {canvasMessage()}
        </Text>
      </View>}
    >
      <ReplayCanvas replay={preparedSignal()!} frame={current()!} tick={uiTick()} />
    </Show>
  );
}

mount(() => <ReplayApp />);

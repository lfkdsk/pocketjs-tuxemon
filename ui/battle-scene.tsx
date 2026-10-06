import { batch, createMemo, createRenderEffect, createSignal, For, untrack } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import type { Component } from "solid-js";

import {
  battlerPresentation,
  CAPTURE_FLIGHT_TICKS,
  CAPTURE_SHAKE_TICKS,
  currentPresentationEvent,
  currentReward,
  REWARD_TICK,
} from "../battle/presentation.ts";
import { battlePaint } from "./battle-paint.ts";
import { battleSceneLabels } from "./battle-scene-locale.ts";
import { battleDisplayName } from "../battle/battle-names.ts";
import { tuxemonRuntimeBattleState } from "../battle/runtime.ts";
import type { BattleEvent, BattleMonster } from "../battle/types.ts";
import type { BattleImageRef } from "../importer/battle-schema.ts";
import type { BattleSceneViewProps } from "../vendor/pocket-rpgkit/src/ui/GameView.tsx";
import { formatUiText } from "../vendor/pocket-rpgkit/src/engine/ui-text.ts";
import { STAT_BAR_UI_TEXT } from "../vendor/pocket-rpgkit/src/ui/battle/text.ts";
import {
  CommandGrid,
  createBattleImageCache,
  LazyImage,
  ListMenu,
  MessageBand,
  barFillWidth,
  type CommandCell,
  type ListMenuRow,
  type TileImageSource,
} from "../vendor/pocket-rpgkit/src/ui/battle/index.ts";
import {
  BATTLE_BASE_HEIGHT,
  BATTLE_BASE_WIDTH,
  BATTLE_RECTS as R,
  battleViewportLayout,
} from "./battle-layout.ts";

type Runtime = ReturnType<typeof tuxemonRuntimeBattleState>;
type MonsterArt = Runtime["visuals"]["monsters"][string];

const UI_THEME = {
  border: "#183746",
  rim: "#79d8c5",
  paper: "#f5f1d7",
  ink: "#102b3a",
  dim: "#537b80",
  accent: "#d27b2c",
  backdrop: "#06141d",
} as const;

const PARTY_SLOTS = [0, 1, 2, 3, 4, 5] as const;

const title = (slug: string): string => slug
  .split("_")
  .map((part) => part ? part[0]!.toUpperCase() + part.slice(1) : part)
  .join(" ");

const monsterName = (monster: Readonly<BattleMonster>): string =>
  monster.nickname ?? battleDisplayName("monster", monster.slug);

const imageSource = (ref: BattleImageRef): TileImageSource => ({
  kind: "tile",
  ref: ref.key,
  sourceWidth: ref.width,
  sourceHeight: ref.height,
});

function eventMessage(state: Runtime, event: BattleEvent | null, monsters: readonly BattleMonster[], tick: number): string {
  const L = battleSceneLabels();
  if (!event) return L.chooseAction;
  const monster = (uid: unknown) => {
    const found = monsters.find((candidate) => candidate.uid === uid);
    return found ? monsterName(found) : L.monsterFallback;
  };
  switch (event.type) {
    case "sendOut": return L.entersBattle(monster(event.monster));
    case "decision": return L.chose(monster(event.user), battleDisplayName("technique", String(event.technique ?? "move")));
    case "technique": {
      if (tick >= 34 && event.hit === false) return L.attackMissed;
      if (tick >= 34 && Number(event.damage) > 0) return L.damage(Number(event.damage));
      return L.used(monster(event.user), battleDisplayName("technique", String(event.technique ?? "move")));
    }
    case "faint": {
      const reward = currentReward(state);
      if (reward && tick >= REWARD_TICK) {
        const winner = reward.winners[0];
        if (winner?.levelsGained) return L.grewLevels(monster(winner.uid), winner.levelsGained);
        if (winner) return L.gainedXp(monster(winner.uid), winner.effectiveExperience);
      }
      return L.fainted(monster(event.monster));
    }
    case "status": return L.status(monster(event.target), title(String(event.status ?? "status")));
    case "item": return L.itemUsed(battleDisplayName("item", String(event.item ?? "item")), monster(event.target));
    case "capture": {
      const landed = tick - CAPTURE_FLIGHT_TICKS;
      const shakes = Math.max(1, Math.trunc(Number(event.shakes) || 1));
      if (landed >= 0 && landed < shakes * CAPTURE_SHAKE_TICKS) {
        const count = Math.min(shakes, Math.floor(landed / CAPTURE_SHAKE_TICKS) + 1);
        return L.shakes(count);
      }
      return event.success
        ? L.captured(monster(event.target))
        : L.brokeFree(monster(event.target));
    }
    case "run": return event.success ? L.gotAway : L.couldntEscape;
    case "swap": return L.entersBattle(monster(event.target));
    case "end": return event.outcome === "won" ? L.victory
      : event.outcome === "lost" ? L.partyDefeated
        : L.battleOver;
    default: return title(event.type);
  }
}

function wrapMessage(message: string, columns: number): [string, string] {
  if (message.length <= columns) return [message, ""];
  const split = message.lastIndexOf(" ", columns);
  const at = split > columns / 2 ? split : columns;
  return [message.slice(0, at).trimEnd(), message.slice(at).trimStart()];
}

function hpColour(current: number, maximum: number): string {
  const ratio = maximum > 0 ? current / maximum : 0;
  return ratio > 0.5 ? "#49c96d" : ratio > 0.2 ? "#f2c94c" : "#ed5b5b";
}

/** Battle-local positioned stat bar. The generic kit StatBar needs an
 * absolute wrapper at each of our three fixed canvas positions; folding that
 * wrapper into the row saves one retained node per bar on the cold scene
 * mount while preserving the exact bar/text geometry. */
function BattleStatBar(props: {
  x: number;
  y: number;
  current: number;
  max: number;
  width: number;
  height: number;
  fill: string;
  track: string;
  showNumbers?: boolean;
  numbersWidth?: number;
  valueTemplate?: string;
  debugName: string;
}) {
  const fillScale = createMemo(() => props.width > 0
    ? barFillWidth(props.current, props.max, props.width) / props.width
    : 0);
  const numberOffset = () => props.showNumbers ? (14 - props.height) / 2 : 0;
  const readout = createMemo(() => formatUiText(
    props.valueTemplate ?? STAT_BAR_UI_TEXT["battle.statValue"],
    { current: Math.max(0, Math.round(props.current)), max: Math.round(props.max) },
  ));
  return (
    <View
      class="absolute"
      style={{
        posType: 1,
        insetL: props.x,
        insetT: props.y + numberOffset(),
        width: props.width,
        height: props.height,
        bgColor: props.track,
      }}
      debugName={props.debugName}
    >
      <View
        style={{
          width: props.width,
          height: props.height,
          bgColor: props.fill,
          scaleX: fillScale(),
          originX: -0.5,
        }}
        debugName={`${props.debugName}-fill`}
      />
      {props.showNumbers ? (
        <Text
          class="absolute text-xs"
          style={{
            posType: 1,
            textColor: UI_THEME.ink,
            lineHeight: 14,
            height: 14,
            insetL: props.width + 6,
            insetT: -numberOffset(),
            ...(props.numbersWidth === undefined ? {} : { width: props.numbersWidth }),
          }}
          debugName={`${props.debugName}-numbers`}
        >
          {readout()}
        </Text>
      ) : null}
    </View>
  );
}

function genderMark(gender: string): string {
  return gender === "male" ? "M" : gender === "female" ? "F" : "-";
}

function experienceProgress(totalExperience: number, level: number): { current: number; max: number } {
  const floor = Math.max(0, level) ** 3;
  const ceiling = Math.max(1, level + 1) ** 3;
  return {
    current: Math.max(0, totalExperience - floor),
    max: Math.max(1, ceiling - floor),
  };
}


/** Root command menu (Fight / Item / …): every entry is a game-chrome slug. */
function rootMenuLabel(entry: Runtime["menu"][number]): string {
  if (entry.kind === "replacement") return battleSceneLabels().swap;
  return battleSceneLabels().rootCommand(entry.slug);
}

/** Submenus (technique / item / capture / party): entries name a database
 *  row, so the label is the localized technique/item/monster name. */
function listMenuLabel(entry: Runtime["menu"][number]): string {
  if (entry.kind === "technique") return battleDisplayName("technique", entry.slug);
  if (entry.kind === "replacement") return battleDisplayName("monster", entry.slug);
  if (entry.kind === "item" || entry.kind === "capture") return battleDisplayName("item", entry.slug);
  return title(entry.slug);
}

function menuDetail(entry: Runtime["menu"][number]): string {
  const L = battleSceneLabels();
  if (entry.quantity !== undefined) return `x${entry.quantity}`;
  if (entry.cooldown > 0) return L.wait(entry.cooldown);
  if (entry.targetSlug) return `#${entry.targetSlot} ${battleDisplayName("monster", entry.targetSlug)}`;
  return "";
}

function menuTitle(mode: Runtime["menuMode"]): string {
  return battleSceneLabels().menuTitle(mode);
}

/** Read-only projection of the serialised battle scene. All scaling is on
 * this 480x272 root so the 960x544 target is the same nearest-neighbour
 * composition at exactly 2x. */
// Publish changed fields through signals. Advancing eventTicks
// leaves the monster art, party, menu and environment dependencies unchanged.
function fieldProjection<T extends object>(initial: T) {
  const value = {} as T;
  let previous = initial;
  const fields = (Object.keys(initial) as (keyof T)[]).map((key) => {
    const [read, write] = createSignal(initial[key]);
    Object.defineProperty(value, key, { enumerable: true, get: read });
    return { key, value: initial[key], write };
  });
  return { value, update(next: T) {
    if (next === previous) return;
    previous = next;
    for (const field of fields) {
      const value = next[field.key];
      if (value !== field.value) {
        field.value = value;
        field.write(() => value);
      }
    }
  } };
}

function samePose(a: ReturnType<typeof battlerPresentation>, b: ReturnType<typeof battlerPresentation>): boolean {
  return a === b || a.offsetX === b.offsetX && a.opacity === b.opacity && a.effect.kind === b.effect.kind &&
    a.effect.startTick === b.effect.startTick && a.effect.duration === b.effect.duration;
}
function sameFields(a: object, b: object): boolean {
  if (a === b) return true;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  for (const key of Object.keys(left)) if (left[key] !== right[key]) return false;
  return true;
}

export const TuxemonBattleScene: Component<BattleSceneViewProps> = (props) => {
  const imageCache = createBattleImageCache(() => props.active);
  // A kept-alive battle subtree can reactivate its image effects in the same
  // batch as the cache-scope effect. Reopen synchronously while deriving an
  // active source so no child can observe the just-ended previous scope.
  const activeImageSource = (ref: BattleImageRef): TileImageSource => {
    if (props.active) imageCache.beginScope();
    return imageSource(ref);
  };
  let previousRuntime = untrack(() => tuxemonRuntimeBattleState(props.state));
  let previousPaint = battlePaint(previousRuntime);
  const fields = fieldProjection(previousRuntime);
  const painted = fieldProjection(previousPaint);
  const runtime = () => fields.value;
  const paint = painted.value;
  createRenderEffect(() => {
    const state = tuxemonRuntimeBattleState(props.state);
    if (state === previousRuntime) return;
    const next = battlePaint(state, previousRuntime, previousPaint);
    previousRuntime = state;
    const prev = previousPaint;
    if (prev) {
      if (sameFields(prev.playerSprite, next.playerSprite)) next.playerSprite = prev.playerSprite;
      if (sameFields(prev.enemySprite, next.enemySprite)) next.enemySprite = prev.enemySprite;
      if (samePose(prev.playerPose, next.playerPose)) next.playerPose = prev.playerPose;
      if (samePose(prev.enemyPose, next.enemyPose)) next.enemyPose = prev.enemyPose;
      if (sameFields(prev.playerTrainer, next.playerTrainer)) next.playerTrainer = prev.playerTrainer;
      if (sameFields(prev.enemyTrainer, next.enemyTrainer)) next.enemyTrainer = prev.enemyTrainer;
      if (sameFields(prev.ball, next.ball)) next.ball = prev.ball;
      const a = prev.animation, b = next.animation;
      if (a.animation === b.animation && a.page === b.page && a.sourceX === b.sourceX && a.sourceY === b.sourceY && a.target === b.target && a.opacity === b.opacity) next.animation = a;
      if (prev.playerIcons.every((icon, i) => icon === next.playerIcons[i])) next.playerIcons = prev.playerIcons;
      if (prev.enemyIcons.every((icon, i) => icon === next.enemyIcons[i])) next.enemyIcons = prev.enemyIcons;
    }
    previousPaint = next;
    batch(() => { fields.update(state); painted.update(next); });
  });
  const player = () => paint.player;
  const enemy = () => paint.enemy;
  const layout = createMemo(() => battleViewportLayout(props.width, props.height));
  const environment = createMemo(() => runtime().visuals.environment);
  const playerArt = createMemo(() => runtime().visuals.monsters[player().slug]!);
  const enemyArt = createMemo(() => runtime().visuals.monsters[enemy().slug]!);
  const allMonsters = createMemo(() => [...runtime().battle.parties[0], ...runtime().battle.parties[1]]);
  const presenting = createMemo(() => currentPresentationEvent(runtime()) !== null);
  const event = createMemo(() => currentPresentationEvent(runtime()));
  const messageTick = createMemo(() => {
    const shown = event();
    if (shown?.type === "technique") return runtime().eventTicks >= 34 ? 34 : 0;
    if (shown?.type === "faint") return runtime().eventTicks >= REWARD_TICK ? REWARD_TICK : 0;
    if (shown?.type === "capture") {
      const landed = runtime().eventTicks - CAPTURE_FLIGHT_TICKS;
      const shakes = Math.max(1, Math.trunc(Number(shown.shakes) || 1));
      return landed >= 0 && landed < shakes * CAPTURE_SHAKE_TICKS
        ? CAPTURE_FLIGHT_TICKS + Math.floor(landed / CAPTURE_SHAKE_TICKS) * CAPTURE_SHAKE_TICKS : 0;
    }
    return 0;
  });
  const message = createMemo(() => {
    const L = battleSceneLabels();
    const result = runtime().battle.result;
    if (presenting()) return eventMessage(runtime(), event(), allMonsters(), messageTick());
    if (result) return result.outcome === "won" ? L.victory
      : result.outcome === "lost" ? L.partyDefeated
        : L.battleEnded;
    return runtime().menuMode === "root" ? L.whatWill(monsterName(player()))
      : runtime().menuMode === "technique" ? L.chooseTechnique
        : runtime().menuMode === "swap" ? L.chooseTuxemon
          : runtime().menuMode === "capture" ? L.chooseCapture
            : L.chooseItem;
  });
  const menuReady = createMemo(() => !presenting() && runtime().battle.awaiting !== null);
  const rootVisible = createMemo(() => menuReady() && runtime().menuMode === "root");
  const listVisible = createMemo(() => menuReady() && runtime().menuMode !== "root");
  // Opacity-hidden menus retain their last content. Publishing a battle turn
  // must not reshape both menus while only the message band is visible.
  const rootEntries = createMemo<Runtime["menu"]>(previous => rootVisible() ? runtime().menu : previous ?? []);
  const rootIndex = createMemo<number>(previous => rootVisible() ? runtime().menuIndex : previous ?? 0);
  const listIndex = createMemo<number>(previous => listVisible() ? runtime().menuIndex : previous ?? 0);
  const listTitle = createMemo<string>(previous => listVisible() ? menuTitle(runtime().menuMode) : previous ?? "Commands");
  const rootStart = createMemo(() => rootIndex() < 4 ? 0 : Math.max(0, rootEntries().length - 4));
  const commandCells = createMemo((): readonly [CommandCell, CommandCell, CommandCell, CommandCell] => {
    const start = rootStart();
    return [0, 1, 2, 3].map((offset) => {
      const entry = rootEntries()[start + offset];
      return entry
        ? { label: rootMenuLabel(entry), disabled: !entry.available }
        : { label: " ", disabled: true };
    }) as unknown as readonly [CommandCell, CommandCell, CommandCell, CommandCell];
  });
  const listRows = createMemo<ListMenuRow[]>(previous => {
    if (!listVisible()) return previous ?? [{ label: " ", detail: " " }, { label: " ", detail: " " }];
    const rows = runtime().menu.map((entry) => ({
      label: listMenuLabel(entry),
      // ListMenu owns fixed Text nodes, but Solid's universal renderer
      // replaces a node structurally when its previous value was "". Keep
      // both visible slots on the non-empty replaceText path while menus
      // switch and while the battle presentation is running.
      detail: menuDetail(entry) || " ",
    }));
    while (rows.length < 2) rows.push({ label: " ", detail: " " });
    return rows;
  });

  const bandLines = createMemo(() => wrapMessage(message(), rootVisible() || listVisible() ? 27 : 58));
  const playerLevel = () => paint.playerLevel;
  const playerXp = createMemo(() => experienceProgress(
    paint.playerExperience,
    playerLevel(),
  ));

  const monsterSlot = (
    monster: () => BattleMonster,
    art: () => MonsterArt,
    side: "front" | "back",
    rect: typeof R.playerMonster,
    debugName: string,
  ) => {
    const source = createMemo(() => art()[side]);
    const pose = () => side === "back" ? paint.playerPose : paint.enemyPose;
    const sprite = () => side === "back" ? paint.playerSprite : paint.enemySprite;
    return (
      <View
        class="absolute overflow-hidden"
        style={{
          posType: 1,
          insetL: rect.x,
          translateX: pose().offsetX,
          insetT: rect.y,
          width: rect.width,
          height: rect.height,
          opacity: pose().opacity,
        }}
        debugName={`${debugName}-clip`}
      >
        <LazyImage
          src={activeImageSource(art().sheet)}
          cache={imageCache}
          active={props.active}
          class="absolute"
          style={{ posType: 1, insetL: -source()[0] * 2, insetT: -source()[1] * 2,
            width: art().sheet.width * 2, height: art().sheet.height * 2,
            translateX: sprite().dx, translateY: sprite().sinkY, opacity: sprite().opacity }}
          debugName={debugName}
        />
      </View>
    );
  };

  const trainerSlot = (side: 0 | 1) => {
    const ref = createMemo(() => runtime().visuals.trainers[side === 0 ? "player" : "opponent"]
      ?? environment().partyIcons.icon_empty!);
    const pose = () => side === 0 ? paint.playerTrainer : paint.enemyTrainer;
    const rect = side === 0 ? R.playerMonster : R.enemyMonster;
    const sourceScale = createMemo(() => side === 0 && ref().rect[3] > 64 ? 1 : 2);
    const sourceX = createMemo(() => side === 1 && ref().rect[2] >= 128 ? 64 : 0);
    return (
      <View
        class="absolute overflow-hidden"
        style={{
          posType: 1,
          insetL: rect.x + (rect.width - 64 * sourceScale()) / 2,
          translateX: pose().offsetX,
          insetT: rect.y,
          width: 64 * sourceScale(),
          height: rect.height,
          opacity: pose().opacity,
        }}
        debugName={`${side === 0 ? "player" : "enemy"}-trainer-clip`}
      >
        <LazyImage
          src={activeImageSource(ref())}
          cache={imageCache}
          active={props.active}
          class="absolute"
          style={{
            posType: 1,
            insetL: 0,
            insetT: 0,
            translateX: -sourceX() * sourceScale(),
            width: ref().width * sourceScale(),
            height: ref().height * sourceScale(),
          }}
          debugName={`${side === 0 ? "player" : "enemy"}-trainer`}
        />
      </View>
    );
  };

  const ball = () => paint.ball;
  const ballRef = createMemo(() => {
    const item = ball().item ? runtime().visuals.items[ball().item!] : undefined;
    return item?.captureSprite ?? environment().partyIcons.icon_alive!;
  });
  const ballSize = createMemo(() => ball().kind === "capture" ? 32 : 16);

  const animation = () => paint.animation;
  const animationPage = createMemo(() => animation().page ?? environment().partyIcons.icon_empty!);
  const animationRect = createMemo(() => runtime().battle.parties[0].some((monster) => monster.uid === animation().target)
    ? R.playerMonster : R.enemyMonster);

  // Presentation visibility changes every few reference ticks. Keep these
  // nodes mounted and switch only their opacity/image so steady battle frames
  // never pay renderer lifecycle work.

  const island = (side: "player" | "enemy") => {
    const rect = side === "player" ? R.playerIsland : R.enemyIsland;
    const sourceX = side === "player" ? 0 : -192;
    return (
      <View class="absolute overflow-hidden" style={{ posType: 1, insetL: rect.x, insetT: rect.y, width: rect.width, height: rect.height }}>
        <LazyImage
          src={activeImageSource(environment().island)}
          cache={imageCache}
          active={props.active}
          class="absolute"
          style={{ posType: 1, insetL: sourceX, insetT: 0, width: environment().island.width * 2, height: environment().island.height * 2 }}
          debugName={`${side}-island`}
        />
      </View>
    );
  };

  const hud = (side: 0 | 1) => {
    const monster = side === 0 ? player : enemy;
    const shownHp = () => side === 0 ? paint.playerHp : paint.enemyHp;
    const shownLevel = () => side === 0 ? paint.playerLevel : paint.enemyLevel;
    const shownMaxHp = () => side === 0 ? paint.playerMaxHp : paint.enemyMaxHp;
    const rect = side === 0 ? R.playerHud : R.enemyHud;
    const image = createMemo(() => side === 0 ? environment().hud.player! : environment().hud.opponent!);
    const hp = side === 0 ? R.playerHp : R.enemyHp;
    const status = side === 0 ? R.playerStatus : R.enemyStatus;
    const icon = createMemo(() => monster().status ? runtime().visuals.statusIcons[monster().status!.slug] : undefined);
    const statusRef = createMemo(() => icon() ?? environment().partyIcons.icon_empty!);
    const label = createMemo(() => `${monsterName(monster())}  Lv${shownLevel()} ${genderMark(monster().gender)}`);
    return (
      <>
        <LazyImage
          src={activeImageSource(image())}
          cache={imageCache}
          active={props.active}
          class="absolute"
          style={{ posType: 1, insetL: rect.x, insetT: rect.y, width: image().width * 2, height: image().height * 2 }}
          debugName={`${side === 0 ? "player" : "enemy"}-hud-frame`}
        />
        <Text
          class="text-xs"
          style={{
            posType: 1,
            insetL: side === 0 ? 298 : 30,
            insetT: side === 0 ? 108 : 6,
            width: side === 0 ? 170 : 180,
            height: 14,
            lineHeight: 13,
            textColor: UI_THEME.ink,
          }}
          debugName={`${side === 0 ? "player" : "enemy"}-hud-name`}
        >
          {label()}
        </Text>
        <BattleStatBar
          x={hp.x}
          y={hp.y}
          current={shownHp()}
          max={shownMaxHp()}
          width={hp.width}
          height={hp.height}
          fill={hpColour(shownHp(), shownMaxHp())}
          track="#263b43"
          showNumbers={side === 0}
          numbersWidth={BATTLE_BASE_WIDTH - hp.x - hp.width - 6}
          valueTemplate={props.uiText?.["battle.statValue"]}
          debugName={`${side === 0 ? "player" : "enemy"}-hp`}
        />
        <LazyImage
          src={activeImageSource(statusRef())}
          cache={imageCache}
          active={props.active}
          class="absolute"
          style={{
            posType: 1,
            insetL: status.x,
            insetT: status.y,
            width: statusRef().width * 2,
            height: statusRef().height * 2,
            opacity: icon() ? 1 : 0,
          }}
          debugName={`${side === 0 ? "player" : "enemy"}-status`}
        />
      </>
    );
  };

  const partyTray = (side: 0 | 1) => {
    const rect = side === 0 ? R.playerTray : R.enemyTray;
    const ref = createMemo(() => side === 0 ? environment().hud.playerTray! : environment().hud.opponentTray!);
    return (
      <>
        <LazyImage
          src={activeImageSource(ref())}
          cache={imageCache}
          active={props.active}
          class="absolute"
          style={{ posType: 1, insetL: rect.x, insetT: rect.y, width: ref().width * 2, height: ref().height * 2 }}
          debugName={`${side === 0 ? "player" : "enemy"}-party-tray`}
        />
        <For each={PARTY_SLOTS}>
          {(slot) => {
            const icon = createMemo(() => (side === 0 ? paint.playerIcons : paint.enemyIcons)[slot]!);
            return (
              <LazyImage
                src={activeImageSource(icon())}
                cache={imageCache}
                active={props.active}
                class="absolute"
                style={{
                  posType: 1,
                  insetL: rect.x + 16 + slot * 16,
                  insetT: rect.y,
                  width: icon().width * 2,
                  height: icon().height * 2,
                }}
                debugName={`${side === 0 ? "player" : "enemy"}-party-${slot}`}
              />
            );
          }}
        </For>
      </>
    );
  };

  return (
    <View
      class="absolute overflow-hidden"
      style={{ posType: 1, insetL: 0, insetT: 0, width: props.width, height: props.height, bgColor: UI_THEME.backdrop }}
      debugName="tux-battle-scene"
    >
      <View
        class="absolute overflow-hidden"
        style={{
          posType: 1,
          insetL: layout().left,
          insetT: layout().top,
          width: BATTLE_BASE_WIDTH,
          height: BATTLE_BASE_HEIGHT,
          scaleX: layout().scale,
          scaleY: layout().scale,
          originX: -0.5,
          originY: -0.5,
          bgColor: UI_THEME.backdrop,
        }}
        debugName="tux-battle-canvas"
      >
        <LazyImage
          src={activeImageSource(environment().background)}
          cache={imageCache}
          active={props.active}
          class="absolute"
          style={{ posType: 1, insetL: R.background.x, insetT: R.background.y, width: R.background.width, height: R.background.height }}
          debugName="battle-background"
        />
        {island("enemy")}
        {island("player")}
        {trainerSlot(1)}
        {trainerSlot(0)}
        {monsterSlot(enemy, enemyArt, "front", R.enemyMonster, "enemy-monster")}
        {monsterSlot(player, playerArt, "back", R.playerMonster, "player-monster")}
        <View
          class="absolute overflow-hidden"
          style={{
            posType: 1,
            insetL: animationRect().x,
            insetT: animationRect().y,
            width: animationRect().width,
            height: animationRect().height,
            opacity: animation().opacity,
          }}
          debugName="battle-animation-clip"
        >
          <LazyImage
            src={activeImageSource(animationPage())}
            cache={imageCache}
            active={props.active}
            class="absolute"
            style={{ posType: 1, insetL: 0, insetT: 0,
              translateX: (128 - (animation().page?.contentWidth ?? 8) * 2) / 2 - animation().sourceX * 2,
              translateY: (128 - (animation().page?.contentHeight ?? 8) * 2) / 2 - animation().sourceY * 2,
              width: animationPage().width * 2, height: animationPage().height * 2 }}
            debugName="battle-animation"
          />
        </View>
        <LazyImage
          src={activeImageSource(ballRef())}
          cache={imageCache}
          active={props.active}
          class="absolute"
          style={{
            posType: 1,
            insetL: ball().x + ball().shake,
            insetT: ball().y,
            width: ballSize(),
            height: ballSize(),
            opacity: ball().opacity,
          }}
          debugName="battle-ball"
        />
        {hud(1)}
        {hud(0)}
        {partyTray(1)}
        {partyTray(0)}
        <BattleStatBar
          x={R.playerXp.x}
          y={R.playerXp.y}
          current={playerXp().current}
          max={playerXp().max}
          width={R.playerXp.width}
          height={R.playerXp.height}
          fill="#4faee8"
          track="#263b43"
          debugName="player-xp"
        />
        <MessageBand
          lines={bandLines()}
          legend={presenting() ? battleSceneLabels().messageOk : " "}
          width={rootVisible() || listVisible() ? R.message.width : BATTLE_BASE_WIDTH}
          theme={UI_THEME}
          style={{ insetL: 0, insetT: R.message.y }}
          debugName="battle-message"
        />
        <CommandGrid
          cells={commandCells()}
          index={Math.max(0, rootIndex() - rootStart())}
          theme={UI_THEME}
          style={{ insetL: R.menu.x, insetT: R.menu.y + 4, opacity: rootVisible() ? 1 : 0 }}
          debugName="battle-commands"
        />
        <ListMenu
          title={listTitle()}
          rows={listRows()}
          index={listIndex()}
          visibleRows={2}
          width={232}
          labelMax={18}
          theme={UI_THEME}
          style={{ insetL: R.menu.x, insetT: R.menu.y + 3, opacity: listVisible() ? 1 : 0 }}
          debugName="battle-list"
        />
      </View>
    </View>
  );
};

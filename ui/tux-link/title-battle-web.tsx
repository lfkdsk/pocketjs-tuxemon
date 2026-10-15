// Web-only title Battle composition. The portable title overlay stays in the
// desktop/PSP graph unchanged; tools/web.ts swaps this module in only for the
// network-capable Web manifest.

import {
  For,
  Show,
  createMemo,
  createSignal,
  onCleanup,
  type Accessor,
  type Component,
} from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { getOps, hostViewport } from "@pocketjs/framework/host";
import { BTN } from "@pocketjs/framework/input";
import { onFrame } from "@pocketjs/framework/lifecycle";

import type { ArenaAction } from "../../battle/arena.ts";
import type { TuxPublicObservation } from "../../battle/tux-link-wire.ts";
import type { SessionOwningOverlayConfig } from "../game-overlay.tsx";
import type { Lang } from "../language.ts";
import {
  TITLE_BATTLE_BASE_H,
  TITLE_BATTLE_BASE_W,
  createTitleBattleOverlay as createPortableTitleBattleOverlay,
  titleBattleCanvas,
} from "../title-battle.tsx";
import type {
  TitleBattleOptions,
  TitleBattleRuntime,
} from "../title-battle-runtime.ts";
import { TUXEMON_UI_THEME } from "../tuxemon-theme.ts";
import {
  installPocketAuthCommandHandler,
  loadTicket,
  pageInvite,
  pageInviteConsumed,
  pageInviteEnd,
  pageLogin,
  peekPocketInvite,
} from "./auth-store.ts";
import {
  TuxLinkClient,
  tuxLinkReplayPageUrl,
  type TuxLinkClientState,
  type TuxLinkRuntimeConfig,
} from "./client.ts";
import { tuxLinkBattleViewModel } from "./presentation.ts";

const TITLE_BACKGROUND = "assets/battle/gfx/ui/combat/grass_background.png";
const MODE_RECTS = [
  { x: 124, y: 103, w: 232, h: 34 },
  { x: 124, y: 145, w: 232, h: 34 },
] as const;
const PRIMARY_RECT = { x: 136, y: 164, w: 208, h: 36 } as const;
const BACK_RECT = { x: 20, y: 229, w: 92, h: 28 } as const;
const ACTION_RECTS = Array.from({ length: 5 }, (_, index) => ({
  x: 247,
  y: 66 + index * 31,
  w: 210,
  h: 27,
}));
const ACTION_WINDOW = ACTION_RECTS.length;

const STRINGS = {
  en_US: {
    heading: "BATTLE",
    modePrompt: "Choose a battle mode",
    local: "Local Battle",
    link: "Link Battle",
    linkHeading: "LINK BATTLE",
    create: "Create match",
    signIn: "Sign in with GitHub on the page",
    signInHelp: "A Wander ticket is shared with Link Battle.",
    authenticating: "Finishing secure sign-in…",
    authFailed: "Sign-in could not issue a battle ticket.",
    creating: "Creating a private match…",
    connecting: "Connecting to the match…",
    waiting: "Invite ready — waiting for your opponent",
    reconnecting: "Connection lost — reconnecting…",
    submitted: "Action locked — waiting for your opponent",
    unavailable: "Link Battle is unavailable",
    decision: "Choose an action",
    back: "Back",
    confirm: "Confirm",
    round: "Round",
    you: "YOU",
    opponent: "OPPONENT",
    victory: "Victory!",
    defeat: "Defeat",
    draw: "Draw",
    watchReplay: "Watch replay",
    replayReady: "Trusted server replay link available.",
    replayUnavailable: "No trusted replay link was provided.",
    resultHelp: "Return to Battle modes",
    move: "Move",
    swap: "Switch",
    item: "Item",
    run: "Run",
  },
  zh_CN: {
    heading: "对战",
    modePrompt: "请选择对战模式",
    local: "本地对战",
    link: "联机对战",
    linkHeading: "联机对战",
    create: "创建对局",
    signIn: "请在网页上使用 GitHub 登录",
    signInHelp: "联机对战与 Wander 共用登录票据。",
    authenticating: "正在安全登录…",
    authFailed: "登录服务未能签发对战票据。",
    creating: "正在创建私人对局…",
    connecting: "正在连接对局…",
    waiting: "邀请已就绪，等待对手加入",
    reconnecting: "连接中断，正在重连…",
    submitted: "行动已锁定，等待对手",
    unavailable: "联机对战暂不可用",
    decision: "请选择行动",
    back: "返回",
    confirm: "确认",
    round: "回合",
    you: "我方",
    opponent: "对手",
    victory: "胜利！",
    defeat: "战败",
    draw: "平局",
    watchReplay: "观看回放",
    replayReady: "可信服务器回放链接已就绪。",
    replayUnavailable: "服务器未提供可信回放链接。",
    resultHelp: "返回对战模式",
    move: "招式",
    swap: "更换精灵",
    item: "道具",
    run: "逃跑",
  },
} as const;

type LinkAuthState = "ready" | "missing" | "authenticating" | "failed";
type WebLayer = "base" | "mode" | "link";

declare global {
  // Written into the generated Web entry. It is absent from every portable
  // entry and null when the builder received no service URL.
  // eslint-disable-next-line no-var
  var __pocketTuxLinkBuildConfig: TuxLinkRuntimeConfig | null | undefined;
  // eslint-disable-next-line no-var
  var __pocketWeb: boolean | undefined;
}

function runtimeConfig(): TuxLinkRuntimeConfig | null {
  if (globalThis.__pocketWeb !== true) return null;
  const value = globalThis.__pocketTuxLinkBuildConfig;
  if (!value || typeof value !== "object") return null;
  return typeof value.httpBase === "string" && typeof value.wsBase === "string" &&
      typeof value.trustedReplayBase === "string"
    ? value
    : null;
}

function viewRect(
  canvas: { scale: number; left: number; top: number },
  rect: { x: number; y: number; w: number; h: number },
) {
  return {
    x: canvas.left + rect.x * canvas.scale,
    y: canvas.top + rect.y * canvas.scale,
    w: rect.w * canvas.scale,
    h: rect.h * canvas.scale,
  };
}

function localized(value: { en_US: string; zh_CN: string }, lang: Lang): string {
  return value[lang];
}

export function tuxLinkActionLabel(
  observation: TuxPublicObservation,
  action: ArenaAction,
  lang: Lang,
): string {
  const t = STRINGS[lang];
  if (action.type === "move") {
    const actor = observation.own.party.find((monster) => monster.party === observation.actingParty)
      ?? observation.own.party.find((monster) => monster.active);
    const move = actor?.moves.find((candidate) => candidate.slot === action.slot);
    return move ? localized(move.displayName, lang) : `${t.move} ${action.slot + 1}`;
  }
  if (action.type === "swap") {
    const monster = observation.own.party.find((candidate) => candidate.party === action.party);
    return monster ? `${t.swap}: ${localized(monster.species.displayName, lang)}` : t.swap;
  }
  if (action.type === "item") return `${t.item}: ${action.item.replaceAll("_", " ")}`;
  return t.run;
}

export interface TuxLinkTitleController {
  readonly lang: Lang;
  readonly layer: Accessor<WebLayer>;
  readonly modeIndex: Accessor<number>;
  readonly authState: Accessor<LinkAuthState>;
  readonly clientState: Accessor<TuxLinkClientState>;
  readonly available: Accessor<boolean>;
  openMode(): void;
  selectMode(index: number): void;
  choosePrimary(): void;
  chooseAction(index: number): void;
  back(): void;
}

export interface PocketTuxLinkHook {
  state(): {
    lang: Lang;
    layer: WebLayer;
    available: boolean;
    auth: LinkAuthState;
    phase: TuxLinkClientState["phase"];
    connectionEpoch: number | null;
    turnRevision: number | null;
    deadlineAtMs: number | null;
    actionIndex: number;
    selfSubmitted: boolean;
    legalActions: ArenaAction[];
    actingMoves: Array<{ slot: number; slug: string }>;
    opponentRefs: string[];
    replayAvailable: boolean;
    opponentSpecies: string[];
  };
}

declare global {
  // Read-only browser acceptance hook. It deliberately omits match ids,
  // tickets and invitation secrets.
  // eslint-disable-next-line no-var
  var __pocketTuxLink: PocketTuxLinkHook | undefined;
}

/** Same export as the portable overlay. main.tsx therefore keeps one stable
 * composition seam while the generated Web entry swaps only its import. */
export function createTitleBattleOverlay(options: TitleBattleOptions): SessionOwningOverlayConfig & {
  runtimeRef: { current: TitleBattleRuntime | null };
} {
  const portable = createPortableTitleBattleOverlay(options);
  return {
    runtimeRef: portable.runtimeRef,
    ownsSession: portable.ownsSession,
    create(host) {
      const portableRuntime = portable.create(host);
      const title = portable.runtimeRef.current;
      if (!title) throw new Error("Tux Link: portable title runtime was not created");

      const config = runtimeConfig();
      const [layer, setLayer] = createSignal<WebLayer>("base");
      const [modeIndex, setModeIndex] = createSignal(0);
      const [available, setAvailable] = createSignal(false);
      const [authState, setAuthState] = createSignal<LinkAuthState>(loadTicket() ? "ready" : "missing");
      const [clientState, setClientState] = createSignal<TuxLinkClientState>(null as never);
      let alive = true;
      let ticket = loadTicket();

      const client = new TuxLinkClient({
        config,
        onChange: setClientState,
        onInviteCreated(match) {
          pageInvite(match.invite, Math.max(0, Math.ceil((match.expiresAtMs - Date.now()) / 1_000)));
        },
        onInviteConsumed: pageInviteConsumed,
      });
      setClientState(client.state());

      const restoreAuthCommand = installPocketAuthCommandHandler({
        onSignout() {
          ticket = null;
          setAuthState("missing");
          client.leave();
        },
        onInviteEnd() {
          // Closing the page-owned share box does not abandon the match; it
          // only forgets the displayed invitation.
        },
      });

      if (config) {
        void client.probe().then((ready) => {
          if (alive) setAvailable(ready);
        });
      }

      const battleRow = (): number => title.titleRows().indexOf("battle");
      const battleSelected = (): boolean => {
        const state = title.state();
        return available() && state.screen === "title" && title.titleRows()[state.titleIndex] === "battle";
      };
      const openMode = (): void => {
        if (!available()) return;
        setModeIndex(0);
        setLayer("mode");
      };

      const startWithTicket = (value: string): void => {
        ticket = value;
        setAuthState("ready");
        pageLogin("GitHub");
        const invite = peekPocketInvite();
        if (!client.enter(value, invite)) setAuthState("failed");
      };

      const openLink = (): void => {
        setLayer("link");
        const stored = ticket ?? loadTicket();
        if (stored) {
          startWithTicket(stored);
          return;
        }
        // The frozen Battle service can verify a shared Wander ticket but has
        // no public OAuth-to-ticket endpoint. Do not use Wander /ws/v4 here:
        // that path registers a world session and can evict another device.
        setAuthState("missing");
      };

      const originalSelectTitle = title.selectTitle;
      const interceptedSelectTitle = (index: number): void => {
        if (available() && title.state().screen === "title" && title.titleRows()[index] === "battle") {
          openMode();
          return;
        }
        originalSelectTitle(index);
      };
      title.selectTitle = interceptedSelectTitle;
      const titleHook = globalThis.__pocketTitleBattle;
      const originalHookSelect = titleHook?.selectTitle;
      if (titleHook) titleHook.selectTitle = title.selectTitle;

      const leaveLink = (): void => {
        client.leave();
        pageInviteEnd();
        setLayer("mode");
        setModeIndex(1);
      };

      const choosePrimary = (): void => {
        const state = client.state();
        if (authState() !== "ready") return;
        if (state.phase === "idle") void client.createMatch();
        else if (state.phase === "decision") client.submitSelected();
        else if (state.phase === "ended" && state.replayUrl) {
          const location = (globalThis as unknown as { location?: Location }).location;
          if (location) location.assign(tuxLinkReplayPageUrl(state.replayUrl, location.href));
        } else if (state.phase === "ended" || state.phase === "error") leaveLink();
      };

      const selectMode = (index: number): void => {
        if (index !== 0 && index !== 1) return;
        setModeIndex(index);
        if (index === 0) {
          setLayer("base");
          originalSelectTitle(battleRow());
        } else {
          openLink();
        }
      };

      const back = (): void => {
        if (layer() === "link") {
          leaveLink();
        } else if (layer() === "mode") {
          setLayer("base");
        }
      };

      const chooseAction = (index: number): void => {
        if (client.selectAction(index)) client.submitSelected();
      };

      const controller: TuxLinkTitleController = {
        lang: options.lang,
        layer,
        modeIndex,
        authState,
        clientState,
        available,
        openMode,
        selectMode,
        choosePrimary,
        chooseAction,
        back,
      };
      const linkHook: PocketTuxLinkHook = {
        state: () => {
          const state = client.state();
          const observation = state.observation;
          const acting = observation?.own.party.find((monster) => monster.party === observation.actingParty);
          return {
            lang: options.lang,
            layer: layer(),
            available: available(),
            auth: authState(),
            phase: state.phase,
            connectionEpoch: state.connectionEpoch,
            turnRevision: state.turnRevision,
            deadlineAtMs: state.deadlineAtMs,
            actionIndex: state.actionIndex,
            selfSubmitted: state.selfSubmitted,
            legalActions: observation?.legalActions.map((action) => ({ ...action })) ?? [],
            actingMoves: acting?.moves.map((move) => ({ slot: move.slot, slug: move.slug })) ?? [],
            opponentRefs: observation?.opponent.active.map((monster) => monster.publicId) ?? [],
            replayAvailable: state.replayUrl !== null,
            opponentSpecies: observation?.opponent.active.map((monster) => monster.species.slug) ?? [],
          };
        },
      };
      globalThis.__pocketTuxLink = linkHook;

      onCleanup(() => {
        alive = false;
        client.leave();
        restoreAuthCommand();
        if (title.selectTitle === interceptedSelectTitle) title.selectTitle = originalSelectTitle;
        if (titleHook && titleHook.selectTitle === interceptedSelectTitle && originalHookSelect) {
          titleHook.selectTitle = originalHookSelect;
        }
        if (globalThis.__pocketTuxLink === linkHook) delete globalThis.__pocketTuxLink;
      });

      return {
        step(buttons, pressed) {
          client.tick();
          if (layer() === "base") {
            if ((pressed & BTN.CIRCLE) !== 0 && battleSelected()) {
              openMode();
              return { consumed: true };
            }
            return portableRuntime.step(buttons, pressed);
          }

          if (layer() === "mode") {
            if ((pressed & (BTN.UP | BTN.DOWN)) !== 0) setModeIndex((index) => index === 0 ? 1 : 0);
            else if ((pressed & BTN.CIRCLE) !== 0) selectMode(modeIndex());
            else if ((pressed & BTN.CROSS) !== 0) back();
            return { consumed: true };
          }

          const state = client.state();
          if (state.phase === "decision") {
            if ((pressed & BTN.UP) !== 0) client.moveAction(-1);
            else if ((pressed & BTN.DOWN) !== 0) client.moveAction(1);
            else if ((pressed & BTN.CIRCLE) !== 0) client.submitSelected();
          } else if ((pressed & BTN.CIRCLE) !== 0) {
            choosePrimary();
          }
          if ((pressed & BTN.CROSS) !== 0 && state.phase !== "decision" && state.phase !== "submitted") back();
          return { consumed: true };
        },
        isOpen: () => layer() !== "base" || portableRuntime.isOpen(),
        render() {
          return (
            <Show when={layer() !== "base"} fallback={portableRuntime.render()}>
              <TuxLinkTitleView controller={controller} />
            </Show>
          );
        },
      };
    },
  };
}

const TuxLinkTitleView: Component<{ controller: TuxLinkTitleController }> = (props) => {
  const controller = props.controller;
  const t = () => STRINGS[controller.lang];
  const state = controller.clientState;
  const [viewport, setViewport] = createSignal({ w: TITLE_BATTLE_BASE_W, h: TITLE_BATTLE_BASE_H });
  onFrame(() => {
    const next = hostViewport(getOps());
    if (next && (next.w !== viewport().w || next.h !== viewport().h)) setViewport({ w: next.w, h: next.h });
  });
  const canvas = createMemo(() => titleBattleCanvas(viewport()));
  const disabledRect = { x: -1, y: -1, w: 0, h: 0 } as const;
  const observation = () => state().observation;
  const viewModel = createMemo(() => {
    const current = observation();
    return current ? tuxLinkBattleViewModel(current, state().presentation, controller.lang) : null;
  });
  const actions = createMemo(() => observation()?.legalActions ?? []);
  const actionWindowStart = createMemo(() => {
    const selected = state().actionIndex;
    return Math.max(0, Math.min(selected - Math.floor(ACTION_WINDOW / 2), actions().length - ACTION_WINDOW));
  });
  const visibleActions = createMemo(() => actions().slice(actionWindowStart(), actionWindowStart() + ACTION_WINDOW));

  MODE_RECTS.forEach((rect, index) => createGesture({
    region: { rect: () => controller.layer() === "mode" ? viewRect(canvas(), rect) : disabledRect },
    onTap: () => controller.selectMode(index),
  }));
  createGesture({
    region: { rect: () => controller.layer() === "link" &&
      (state().phase === "idle" || state().phase === "ended" || state().phase === "error")
      ? viewRect(canvas(), PRIMARY_RECT)
      : disabledRect },
    onTap: controller.choosePrimary,
  });
  ACTION_RECTS.forEach((rect, index) => createGesture({
    region: { rect: () => controller.layer() === "link" && state().phase === "decision" && visibleActions()[index]
      ? viewRect(canvas(), rect)
      : disabledRect },
    onTap: () => controller.chooseAction(actionWindowStart() + index),
  }));
  createGesture({
    region: { rect: () => controller.layer() !== "base" && state().phase !== "decision" && state().phase !== "submitted"
      ? viewRect(canvas(), BACK_RECT)
      : disabledRect },
    onTap: controller.back,
  });

  const statusText = (): string => {
    if (controller.authState() === "missing") return t().signIn;
    if (controller.authState() === "authenticating") return t().authenticating;
    if (controller.authState() === "failed") return t().authFailed;
    switch (state().phase) {
      case "creating": return t().creating;
      case "connecting": return t().connecting;
      case "waiting": return t().waiting;
      case "reconnecting": return t().reconnecting;
      case "submitted": return t().submitted;
      case "decision": return viewModel()?.message ?? t().decision;
      case "error": return t().unavailable;
      default: return t().create;
    }
  };

  const resultText = (): string => {
    const winner = state().result?.winner;
    return winner === "self" ? t().victory : winner === "opponent" ? t().defeat : t().draw;
  };

  return (
    <View class="absolute inset-0" style={{ posType: 1, bgColor: "#030c12" }} debugName="tux-link-overlay">
      <View
        class="absolute overflow-hidden"
        style={{
          posType: 1,
          insetL: canvas().left,
          insetT: canvas().top,
          width: TITLE_BATTLE_BASE_W,
          height: TITLE_BATTLE_BASE_H,
          scaleX: canvas().scale,
          scaleY: canvas().scale,
          originX: -0.5,
          originY: -0.5,
          bgColor: "#071923",
        }}
        debugName="tux-link-canvas"
      >
        <Image class="absolute" src={TITLE_BACKGROUND} style={{ posType: 1, insetL: 0, insetT: 0, width: 480, height: 240, opacity: 0.54 }} />
        <View class="absolute" style={{ posType: 1, insetL: 0, insetT: 0, width: 480, height: 272, bgColor: "#061722c8" }} />

        <Show when={controller.layer() === "mode"}>
          <View class="absolute" style={{ posType: 1, insetL: 105, insetT: 44, width: 270, height: 171, borderWidth: 2, borderColor: TUXEMON_UI_THEME.rim, bgColor: "#071923ef" }} />
          <Text class="text-lg" style={{ posType: 1, insetL: 125, insetT: 59, width: 230, height: 30, lineHeight: 24, textAlign: 1, textColor: TUXEMON_UI_THEME.accent }} debugName="tux-link-mode-heading">
            {t().heading}
          </Text>
          <Text class="text-xs" style={{ posType: 1, insetL: 125, insetT: 84, width: 230, height: 16, lineHeight: 14, textAlign: 1, textColor: TUXEMON_UI_THEME.dim }}>
            {t().modePrompt}
          </Text>
          <For each={[t().local, t().link]}>{(label, index) => {
            const rect = MODE_RECTS[index()]!;
            const selected = () => controller.modeIndex() === index();
            return (
              <View class="absolute flex-row items-center" style={{ posType: 1, insetL: rect.x, insetT: rect.y, width: rect.w, height: rect.h, borderWidth: selected() ? 2 : 1, borderColor: selected() ? TUXEMON_UI_THEME.accent : TUXEMON_UI_THEME.border, bgColor: selected() ? "#145064" : "#0a2633" }} debugName={`tux-link-mode-${index() === 0 ? "local" : "link"}`}>
                <Text class="text-sm" style={{ marginL: 15, width: 198, height: 20, lineHeight: 18, textColor: selected() ? "#ffffff" : TUXEMON_UI_THEME.ink }}>{label}</Text>
              </View>
            );
          }}</For>
        </Show>

        <Show when={controller.layer() === "link"}>
          <Text class="text-lg" style={{ posType: 1, insetL: 20, insetT: 13, width: 440, height: 28, lineHeight: 23, textAlign: 1, textColor: TUXEMON_UI_THEME.accent }} debugName="tux-link-heading">
            {t().linkHeading}
          </Text>

          <Show when={state().phase === "decision" || state().phase === "submitted"} fallback={
            <View class="absolute" style={{ posType: 1, insetL: 82, insetT: 62, width: 316, height: 158, borderWidth: 2, borderColor: TUXEMON_UI_THEME.rim, bgColor: "#071923f2" }} debugName="tux-link-status-panel">
              <Show when={state().phase === "ended"} fallback={
                <>
                  <Text class="text-sm" style={{ posType: 1, insetL: 22, insetT: 29, width: 272, height: 44, lineHeight: 19, textAlign: 1, textColor: TUXEMON_UI_THEME.ink }} debugName="tux-link-status">{statusText()}</Text>
                  <Show when={controller.authState() === "missing"}>
                    <Text class="text-xs" style={{ posType: 1, insetL: 22, insetT: 78, width: 272, height: 34, lineHeight: 15, textAlign: 1, textColor: TUXEMON_UI_THEME.dim }}>{t().signInHelp}</Text>
                  </Show>
                  <Show when={controller.authState() === "ready" && state().phase === "idle"}>
                    <View class="absolute flex-row justify-center items-center" style={{ posType: 1, insetL: PRIMARY_RECT.x - 82, insetT: PRIMARY_RECT.y - 62, width: PRIMARY_RECT.w, height: PRIMARY_RECT.h, borderWidth: 2, borderColor: TUXEMON_UI_THEME.accent, bgColor: "#145064" }} debugName="tux-link-create">
                      <Text class="text-sm" style={{ width: 180, height: 20, lineHeight: 18, textAlign: 1, textColor: "#ffffff" }}>{t().create}</Text>
                    </View>
                  </Show>
                </>
              }>
                <Text class="text-lg" style={{ posType: 1, insetL: 22, insetT: 22, width: 272, height: 31, lineHeight: 25, textAlign: 1, textColor: TUXEMON_UI_THEME.accent }} debugName="tux-link-result">{resultText()}</Text>
                <Text class="text-xs" style={{ posType: 1, insetL: 22, insetT: 63, width: 272, height: 31, lineHeight: 15, textAlign: 1, textColor: TUXEMON_UI_THEME.dim }} debugName={state().replayUrl ? "tux-link-replay-ready" : "tux-link-replay-unavailable"}>{state().replayUrl ? t().replayReady : t().replayUnavailable}</Text>
                <View class="absolute flex-row justify-center items-center" style={{ posType: 1, insetL: PRIMARY_RECT.x - 82, insetT: PRIMARY_RECT.y - 62, width: PRIMARY_RECT.w, height: PRIMARY_RECT.h, borderWidth: 2, borderColor: TUXEMON_UI_THEME.accent, bgColor: "#145064" }}>
                  <Text class="text-sm" style={{ width: 180, height: 20, lineHeight: 18, textAlign: 1, textColor: "#ffffff" }}>{state().replayUrl ? t().watchReplay : t().resultHelp}</Text>
                </View>
              </Show>
            </View>
          }>
            <View class="absolute" style={{ posType: 1, insetL: 14, insetT: 43, width: 218, height: 91, borderWidth: 1, borderColor: TUXEMON_UI_THEME.rim, bgColor: "#071923ee" }}>
              <Text class="text-xs" style={{ posType: 1, insetL: 9, insetT: 7, width: 196, height: 16, lineHeight: 14, textColor: "#ffb17a" }}>{t().opponent}</Text>
              <For each={viewModel()?.opponent ?? []}>{(monster, index) => (
                <View class="absolute" style={{ posType: 1, insetL: 9, insetT: 27 + index() * 28, width: 196, height: 24, bgColor: "#0a2633" }} debugName={`tux-link-opponent-${monster.key}`}>
                  <Text class="text-xs" style={{ posType: 1, insetL: 7, insetT: 4, width: 121, height: 16, lineHeight: 14, textColor: TUXEMON_UI_THEME.ink }}>{`${monster.name}  Lv.${monster.level}`}</Text>
                  <Text class="text-xs" style={{ posType: 1, insetR: 7, insetT: 4, width: 54, height: 16, lineHeight: 14, textAlign: 2, textColor: "#ffcf72" }}>{`${Math.round(monster.hpPercent)}%`}</Text>
                </View>
              )}</For>
            </View>
            <View class="absolute" style={{ posType: 1, insetL: 14, insetT: 143, width: 218, height: 78, borderWidth: 1, borderColor: TUXEMON_UI_THEME.rim, bgColor: "#071923ee" }}>
              <Text class="text-xs" style={{ posType: 1, insetL: 9, insetT: 7, width: 196, height: 16, lineHeight: 14, textColor: TUXEMON_UI_THEME.accent }}>{t().you}</Text>
              <For each={viewModel()?.own ?? []}>{(monster) => (
                <View class="absolute" style={{ posType: 1, insetL: 9, insetT: 29, width: 196, height: 28, bgColor: "#0a2633" }} debugName={`tux-link-own-${monster.key}`}>
                  <Text class="text-xs" style={{ posType: 1, insetL: 7, insetT: 5, width: 121, height: 16, lineHeight: 14, textColor: TUXEMON_UI_THEME.ink }}>{`${monster.name}  Lv.${monster.level}`}</Text>
                  <Text class="text-xs" style={{ posType: 1, insetR: 7, insetT: 5, width: 54, height: 16, lineHeight: 14, textAlign: 2, textColor: "#8df0a8" }}>{`${Math.round(monster.hpPercent)}%`}</Text>
                </View>
              )}</For>
            </View>
            <View class="absolute" style={{ posType: 1, insetL: 241, insetT: 43, width: 225, height: 178, borderWidth: 1, borderColor: TUXEMON_UI_THEME.rim, bgColor: "#071923ee" }}>
              <Text class="text-xs" style={{ posType: 1, insetL: 8, insetT: 6, width: 205, height: 16, lineHeight: 14, textAlign: 1, textColor: TUXEMON_UI_THEME.dim }}>{`${t().round} ${observation()?.round ?? 0}`}</Text>
              <For each={visibleActions()}>{(action, index) => {
                const absoluteIndex = () => actionWindowStart() + index();
                const selected = () => state().actionIndex === absoluteIndex();
                const rect = ACTION_RECTS[index()]!;
                return (
                  <View class="absolute flex-row items-center" style={{ posType: 1, insetL: rect.x - 241, insetT: rect.y - 43, width: rect.w, height: rect.h, borderWidth: selected() ? 2 : 1, borderColor: selected() ? TUXEMON_UI_THEME.accent : TUXEMON_UI_THEME.border, bgColor: selected() ? "#145064" : "#0a2633" }} debugName={`tux-link-action-${absoluteIndex()}`}>
                    <Text class="text-xs" style={{ marginL: 10, width: 188, height: 17, lineHeight: 14, textColor: selected() ? "#ffffff" : TUXEMON_UI_THEME.ink }}>{observation() ? tuxLinkActionLabel(observation()!, action, controller.lang) : ""}</Text>
                  </View>
                );
              }}</For>
            </View>
            <Text class="text-xs" style={{ posType: 1, insetL: 16, insetT: 230, width: 448, height: 28, lineHeight: 14, textAlign: 1, textColor: TUXEMON_UI_THEME.ink }} debugName="tux-link-battle-status">{statusText()}</Text>
          </Show>

          <Show when={state().phase !== "decision" && state().phase !== "submitted"}>
            <View class="absolute flex-row items-center" style={{ posType: 1, insetL: BACK_RECT.x, insetT: BACK_RECT.y, width: BACK_RECT.w, height: BACK_RECT.h, borderWidth: 1, borderColor: TUXEMON_UI_THEME.border, bgColor: "#0a2633" }} debugName="tux-link-back">
              <Text class="text-xs" style={{ marginL: 14, width: 65, height: 17, lineHeight: 14, textColor: TUXEMON_UI_THEME.dim }}>{`×  ${t().back}`}</Text>
            </View>
          </Show>
        </Show>

        <Show when={controller.layer() === "mode"}>
          <View class="absolute flex-row items-center" style={{ posType: 1, insetL: BACK_RECT.x, insetT: BACK_RECT.y, width: BACK_RECT.w, height: BACK_RECT.h, borderWidth: 1, borderColor: TUXEMON_UI_THEME.border, bgColor: "#0a2633" }}>
            <Text class="text-xs" style={{ marginL: 14, width: 65, height: 17, lineHeight: 14, textColor: TUXEMON_UI_THEME.dim }}>{`×  ${t().back}`}</Text>
          </View>
        </Show>
      </View>
    </View>
  );
};

// Dedicated web-only PocketJS entry for Arena tapes. tools/web.ts emits this
// as a separate bundle and page, so ordinary game startup never loads it.

import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { mount } from "@pocketjs/framework";
import { Text, View } from "@pocketjs/framework/components";
import { fsHost } from "@pocketjs/framework/fs";
import { onFrame } from "@pocketjs/framework/lifecycle";

import {
  advanceArenaReplay,
  arenaReplayRuntimeState,
  loadArenaReplayDocument,
  prepareArenaReplay,
  type PreparedArenaReplay,
} from "./battle/arena-replay.ts";
import type { ArenaBattle } from "./battle/arena.ts";
import type { RuntimeBattleState } from "./battle/runtime.ts";
import {
  SERVER_DATA_DIGEST,
  SERVER_ENGINE_REVISION,
} from "./battle/server-runtime.ts";
import type { LinkTerminalOverride } from "./battle/tux-link-replay.ts";
import type { JsonValue } from "./vendor/pocket-rpgkit/src/engine/types.ts";
import { TuxemonBattleScene } from "./ui/battle-scene.tsx";
import { setBattleSceneLang } from "./ui/battle-scene-locale.ts";
import { createGameEntryReaders } from "./ui/entry-readers.ts";
import { detectLang } from "./ui/language.ts";
import { zhData } from "./ui/zh-data.ts";

const host = fsHost();
const requestedLang = zhData.available ? detectLang() : "en_US";
const readers = requestedLang === "zh_CN" ? createGameEntryReaders(host) : null;
const localized = readers
  ? zhData.load((entry) => readers.readText?.(entry) ?? readers.read(entry))
  : null;
const lang = localized ? requestedLang : "en_US";
setBattleSceneLang(lang);

const COPY = lang === "zh_CN" ? {
  loading: "正在加载对战录带…",
  play: "播放",
  pause: "暂停",
  step: "前进一步",
  speed: "速度",
  turn: "回合",
  ready: "录带已验证",
  complete: "回放结束",
  authoritativeAbandoned: "权威赛果：对局已中止。",
  authoritativeForfeit: (side: number) => `权威赛果：第 ${side} 方因对手弃权获胜。`,
  controls: "对战回放控制",
  error: "无法加载录带",
  browserUnavailable: "浏览器回放接口不可用。",
  incompatible: "回放无效、来源不可信，或与此固定版本播放器不兼容。",
  playerMismatch: "播放器页面与其固定引擎身份不匹配。",
  help: "只读取版本化 JSON 录带或 Link 回放；外部权威赛果必须来自可信 HTTPS 地址。",
  title: "对战回放",
} : {
  loading: "Loading battle tape…",
  play: "Play",
  pause: "Pause",
  step: "Step",
  speed: "Speed",
  turn: "Turn",
  ready: "Tape verified",
  complete: "Replay complete",
  authoritativeAbandoned: "Authoritative result: match abandoned.",
  authoritativeForfeit: (side: number) => `Authoritative result: Side ${side} wins by forfeit.`,
  controls: "Battle replay controls",
  error: "Could not load tape",
  browserUnavailable: "Browser replay APIs are unavailable.",
  incompatible: "The replay is invalid, untrusted, or incompatible with this immutable player.",
  playerMismatch: "The player page does not match its immutable engine identity.",
  help: "Reads versioned JSON tapes or Link replays; authoritative external results require trusted HTTPS.",
  title: "Battle replay",
};

export interface ArenaReplayPageState {
  status: "loading" | "ready" | "error";
  turn: number;
  total: number;
  playing: boolean;
  speed: 1 | 2 | 4;
  terminalHash: string | null;
  authoritativeResult: string | null;
  error: string | null;
}

export interface ArenaReplayPageHook {
  state(): ArenaReplayPageState;
  play(): void;
  pause(): void;
  step(): void;
  restart(): void;
  setSpeed(speed: 1 | 2 | 4): void;
}

declare global {
  // eslint-disable-next-line no-var
  var __pocketArenaReplay: ArenaReplayPageHook | undefined;
}

const browser = globalThis as unknown as {
  document?: Document;
  location?: Location;
  fetch?: typeof fetch;
};
const document = browser.document;
const location = browser.location;

interface EmbeddedReplayBuildConfig {
  trustedReplayBase: string | null;
}

function embeddedReplayBuildConfig(): EmbeddedReplayBuildConfig {
  const text = document?.getElementById("pocket-game")?.textContent;
  if (!text) throw new Error("missing player config");
  const value = JSON.parse(text) as Record<string, unknown>;
  const release = value.replayRelease;
  if (typeof release !== "object" || release === null || Array.isArray(release)) {
    throw new Error("missing replay release identity");
  }
  const identity = release as Record<string, unknown>;
  if (identity.engineRevision !== SERVER_ENGINE_REVISION || identity.dataDigest !== SERVER_DATA_DIGEST) {
    throw new Error("replay release identity mismatch");
  }
  const trustedReplayBase = value.trustedReplayBase;
  if (trustedReplayBase === null) return { trustedReplayBase: null };
  if (typeof trustedReplayBase !== "string" || trustedReplayBase !== trustedReplayBase.trim() ||
    /[\u0000-\u0020\u007f\\]/.test(trustedReplayBase)) {
    throw new Error("invalid trusted replay base");
  }
  const base = new URL(trustedReplayBase);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash ||
    !base.pathname.endsWith("/")) {
    throw new Error("invalid trusted replay base");
  }
  return { trustedReplayBase: base.href };
}

function terminalOverrideText(override: LinkTerminalOverride): string {
  return override.reason === "abandoned"
    ? COPY.authoritativeAbandoned
    : COPY.authoritativeForfeit(override.winner + 1);
}

function element(id: string): HTMLElement | null {
  return document?.getElementById(id) ?? null;
}

function button(id: string): HTMLButtonElement | null {
  return element(id) as HTMLButtonElement | null;
}

if (document) {
  document.title = `${COPY.title} · Pocket Tuxemon`;
  document.documentElement.lang = lang === "zh_CN" ? "zh-CN" : "en";
  document.documentElement.dataset.arenaReplay = "true";
  const title = element("arena-replay-title");
  const help = element("arena-replay-help");
  const step = element("arena-replay-step");
  const speed = element("arena-replay-speed-label");
  const controls = document.querySelector<HTMLElement>(".arena-replay-row");
  if (title) title.textContent = COPY.title;
  if (help) help.textContent = COPY.help;
  if (step) step.textContent = COPY.step;
  if (speed) speed.textContent = COPY.speed;
  controls?.setAttribute("aria-label", COPY.controls);
}

function ReplayApp() {
  const [runtime, setRuntime] = createSignal<RuntimeBattleState | null>(null);
  const [canvasMessage, setCanvasMessage] = createSignal(COPY.loading);
  const [authoritativeResult, setAuthoritativeResult] = createSignal<string | null>(null);
  let prepared: PreparedArenaReplay | null = null;
  let battle: ArenaBattle | null = null;
  let terminalOverride: LinkTerminalOverride | null = null;
  let turn = 0;
  let playing = false;
  let speed: 1 | 2 | 4 = 1;
  let frameTicks = 0;
  let failure: string | null = null;

  const state = (): ArenaReplayPageState => ({
    status: failure !== null ? "error" : prepared === null ? "loading" : "ready",
    turn,
    total: prepared?.tape.actions.length ?? 0,
    playing,
    speed,
    terminalHash: prepared?.terminalHash ?? null,
    authoritativeResult: authoritativeResult(),
    error: failure,
  });

  const syncControls = (): void => {
    const play = button("arena-replay-play");
    const step = button("arena-replay-step");
    const counter = element("arena-replay-counter");
    const status = element("arena-replay-status");
    const complete = prepared !== null && turn >= prepared.tape.actions.length;
    if (play) {
      play.textContent = playing ? COPY.pause : COPY.play;
      play.disabled = prepared === null || failure !== null || complete;
      play.setAttribute("aria-pressed", playing ? "true" : "false");
    }
    if (step) step.disabled = prepared === null || failure !== null || complete;
    if (counter) counter.textContent = `${COPY.turn} ${turn} / ${prepared?.tape.actions.length ?? 0}`;
    if (status) {
      status.textContent = failure !== null
        ? `${COPY.error}: ${failure}`
        : prepared === null ? COPY.loading : complete ? authoritativeResult() ?? COPY.complete : COPY.ready;
    }
    for (const speedButton of Array.from(
      document?.querySelectorAll<HTMLButtonElement>("[data-arena-replay-speed]") ?? [],
    )) {
      const selected = speedButton === button(`arena-replay-speed-${speed}`);
      speedButton.setAttribute("aria-pressed", selected ? "true" : "false");
    }
  };

  const publish = (): void => {
    if (!battle) return;
    const complete = prepared !== null && turn >= prepared.tape.actions.length;
    setAuthoritativeResult(complete && terminalOverride ? terminalOverrideText(terminalOverride) : null);
    setRuntime(arenaReplayRuntimeState(battle));
    setCanvasMessage("");
    syncControls();
  };

  const pause = (): void => {
    playing = false;
    frameTicks = 0;
    syncControls();
  };

  const step = (): void => {
    if (!prepared || !battle || turn >= prepared.tape.actions.length) {
      pause();
      return;
    }
    battle = advanceArenaReplay(battle, prepared.tape, turn);
    turn++;
    publish();
    if (turn >= prepared.tape.actions.length) pause();
  };

  const play = (): void => {
    if (!prepared || failure !== null || turn >= prepared.tape.actions.length) return;
    playing = true;
    syncControls();
  };

  const restart = (): void => {
    if (!prepared) return;
    battle = prepareArenaReplay(prepared.tape).initial;
    turn = battle.turn;
    playing = false;
    frameTicks = 0;
    publish();
  };

  const setSpeed = (next: 1 | 2 | 4): void => {
    speed = next;
    frameTicks = 0;
    syncControls();
  };

  const hook: ArenaReplayPageHook = { state, play, pause, step, restart, setSpeed };
  globalThis.__pocketArenaReplay = hook;
  onCleanup(() => {
    if (globalThis.__pocketArenaReplay === hook) delete globalThis.__pocketArenaReplay;
  });

  onFrame(() => {
    if (!playing) return;
    frameTicks += speed;
    if (frameTicks < 60) return;
    frameTicks -= 60;
    step();
  });

  onMount(() => {
    const playButton = button("arena-replay-play");
    const stepButton = button("arena-replay-step");
    const speedButtons = [1, 2, 4] as const;
    if (playButton) playButton.onclick = () => playing ? pause() : play();
    if (stepButton) stepButton.onclick = () => step();
    for (const value of speedButtons) {
      const speedButton = button(`arena-replay-speed-${value}`);
      if (speedButton) speedButton.onclick = () => setSpeed(value);
    }
    syncControls();
    if (!location || !browser.fetch) {
      failure = COPY.browserUnavailable;
      setCanvasMessage(`${COPY.error}: ${failure}`);
      syncControls();
      return;
    }
    let buildConfig: EmbeddedReplayBuildConfig;
    try {
      buildConfig = embeddedReplayBuildConfig();
    } catch (error) {
      console.error("battle replay build identity rejected", error);
      failure = COPY.playerMismatch;
      setCanvasMessage(`${COPY.error}: ${failure}`);
      syncControls();
      return;
    }
    void loadArenaReplayDocument(
      location.search,
      location.href,
      (url, init) => browser.fetch!(url, init),
      {
        expectedIdentity: {
          engineRevision: SERVER_ENGINE_REVISION,
          dataDigest: SERVER_DATA_DIGEST,
        },
        trustedReplayBase: buildConfig.trustedReplayBase ?? "https://invalid.invalid/replays/",
      },
    ).then((loaded) => {
      if (loaded.kind !== "raw" && buildConfig.trustedReplayBase === null) {
        throw new Error("Link replay player has no trusted replay base");
      }
      terminalOverride = loaded.kind === "raw" ? null : loaded.terminalOverride;
      prepared = prepareArenaReplay(loaded.tape);
      battle = prepared.initial;
      turn = battle.turn;
      publish();
      play();
    }).catch((error: unknown) => {
      console.error("battle replay document rejected", error);
      failure = COPY.incompatible;
      setCanvasMessage(`${COPY.error}: ${failure}`);
      syncControls();
    });
  });

  return (
    <Show
      when={runtime()}
      fallback={<View
          class="absolute flex items-center justify-center bg-slate-950"
          style={{ posType: 1, insetL: 0, insetT: 0, width: 480, height: 272 }}
          debugName="arena-replay-loading"
        >
          <Text
            class="text-sm text-white text-center"
            style={{ width: 420, height: 80, lineHeight: 18 }}
            debugName="arena-replay-loading-text"
          >
            {canvasMessage()}
          </Text>
        </View>}
    >
      {(value) => <>
        <TuxemonBattleScene
          state={value() as unknown as JsonValue}
          width={480}
          height={272}
          active
        />
        <Show when={authoritativeResult()}>
          {(message) => <View
            class="absolute flex items-center justify-center"
            style={{ posType: 1, insetL: 34, insetT: 92, width: 412, height: 88, borderWidth: 2, borderColor: "#73e5ef", bgColor: "#071923ee" }}
            debugName="arena-replay-authoritative-result"
          >
            <Text
              class="text-sm text-white text-center"
              style={{ width: 370, height: 52, lineHeight: 20 }}
            >
              {message()}
            </Text>
          </View>}
        </Show>
      </>}
    </Show>
  );
}

mount(() => <ReplayApp />);

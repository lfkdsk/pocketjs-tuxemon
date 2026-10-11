// Title-screen Adventure/Battle state machine. A title match runs through
// the production Tuxemon battle reducer, but owns a fresh extension state and
// restores the exact campaign snapshot before any completion can commit.

import { createSignal, onCleanup, type Accessor } from "solid-js";
import { BTN } from "@pocketjs/framework/input";
import type {
  BattleCompletion,
  BattleRules,
  BattleStart,
} from "../vendor/pocket-rpgkit/src/engine/battle.ts";
import type {
  ExtensionCommandContext,
  ExtensionOptions,
  ExtensionReadContext,
} from "../vendor/pocket-rpgkit/src/engine/extensions.ts";
import type { SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { JsonValue } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import type {
  GameViewDemoRuntime,
  GameViewSessionHost,
} from "../vendor/pocket-rpgkit/src/ui/demo-contract.ts";
import { nextRandom, type RngState } from "../battle/core.ts";
import type { Lang } from "./language.ts";
import type { TitleBattleData } from "./feature-modes-data.ts";

const TITLE_MARKER = "pocket-tuxemon/title-battle/v1";
const TITLE_FIBER = "pocket-tuxemon:title-battle";

type JsonRecord = Record<string, JsonValue>;

function record(value: JsonValue): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function marked(value: JsonValue): boolean {
  return record(value)?.titleBattleMode === TITLE_MARKER;
}

/** BattleRules adapter that suppresses only title-match completion. The
 * overlay observes it on the next host frame and restores the campaign; all
 * authored campaign battles delegate byte-for-byte to the base rules. */
export interface TitleBattleRules extends BattleRules {
  startTitle(
    ext: JsonValue,
    setup: JsonValue,
    seed: number,
    context: ExtensionReadContext,
  ): BattleStart | null;
  titleCompletion(state: JsonValue): BattleCompletion | null;
  isTitleState(state: JsonValue): boolean;
}

export function createTitleBattleRules(base: BattleRules): TitleBattleRules {
  const mark = (value: JsonValue): JsonValue => ({
    ...(record(value) ?? {}),
    titleBattleMode: TITLE_MARKER,
  });
  return {
    immutableState: base.immutableState,
    start: (...args) => base.start(...args),
    startTitle(ext, setup, seed, context) {
      const started = base.start(ext, setup, seed, context);
      return started === null ? null : { ...started, state: mark(started.state) };
    },
    step(state, input, ticks) {
      const next = base.step(state, input, ticks);
      return marked(state) ? mark(next) : next;
    },
    done(state) {
      return marked(state) ? null : base.done(state);
    },
    titleCompletion(state) {
      return marked(state) ? base.done(state) : null;
    },
    isTitleState: marked,
  };
}

export type TitleBattleScreen = "closed" | "title" | "difficulty" | "battle" | "result";
export type TitleBattleResult = "win" | "lose" | "escape" | "draw";

export interface TitleBattleState {
  screen: TitleBattleScreen;
  titleIndex: number;
  difficultyIndex: number;
  result: TitleBattleResult | null;
  battleCount: number;
}

export type TitleBattleAction = "up" | "down" | "confirm" | "back";

export interface TitleBattleOptions {
  data: TitleBattleData;
  lang: Lang;
  rules: TitleBattleRules;
  extensions: Pick<ExtensionOptions, "initial" | "commands">;
  initiallyOpen: boolean;
}

export interface TitleBattleRuntime {
  step: GameViewDemoRuntime["step"];
  isOpen: GameViewDemoRuntime["isOpen"];
  /** True only while the production battle scene owns reducer input. */
  ownsSession(): boolean;
  state: Accessor<TitleBattleState>;
  applyAction(action: TitleBattleAction): void;
  selectTitle(index: number): void;
  selectDifficulty(index: number): void;
  data: TitleBattleData;
  lang: Lang;
}

export interface PocketTitleBattleHook {
  state(): TitleBattleState;
  act(action: TitleBattleAction): void;
  selectTitle(index: number): void;
  selectDifficulty(index: number): void;
}

declare global {
  // eslint-disable-next-line no-var
  var __pocketTitleBattle: PocketTitleBattleHook | undefined;
}

function titleSeed(state: Readonly<SessionState>, difficulty: number, battleCount: number): number {
  // The campaign cursor is sampled, never advanced. Knuth's ratio and two
  // odd constants separate difficulty/retry streams without wall time.
  return (
    (state.sw.rng >>> 0)
    ^ Math.imul(difficulty + 1, 0x9e3779b1)
    ^ Math.imul(battleCount + 1, 0x85ebca6b)
  ) >>> 0;
}

function spawnTitleParties(
  options: TitleBattleOptions,
  difficultyIndex: number,
  campaign: Readonly<SessionState>,
  battleCount: number,
): { ext: JsonValue; seed: number } {
  const difficulty = options.data.difficulties[difficultyIndex];
  if (!difficulty) throw new Error(`title battle: unknown difficulty index ${difficultyIndex}`);
  const randomMonster = options.extensions.commands?.["tux.random_monster"];
  if (!randomMonster) throw new Error("title battle: tux.random_monster is not registered");
  const rng: RngState = { rng: titleSeed(campaign, difficultyIndex, battleCount), rngDraws: 0 };
  let ext = options.extensions.initial ?? null;
  const context = (character: "player" | "professor"): ExtensionCommandContext => ({
    ext,
    switches: {},
    variables: {},
    items: {},
    gold: 0,
    playerName: "Player",
    random: () => nextRandom(rng),
  });
  for (const character of [options.data.player, options.data.opponent] as const) {
    for (let slot = 0; slot < difficulty.partySize; slot++) {
      const result = randomMonster(context(character), {
        level: difficulty.level,
        character,
        candidates: difficulty.candidates,
      });
      if (result?.ext !== undefined) ext = result.ext;
    }
  }
  return { ext, seed: Math.floor(nextRandom(rng) * 4294967296) >>> 0 };
}

function titleBattleState(
  campaign: Readonly<SessionState>,
  start: BattleStart,
): SessionState {
  return {
    ...campaign,
    ext: start.ext,
    scene: {
      kind: "battle",
      fiber: TITLE_FIBER,
      state: start.state,
      pausedTicks: 0,
    },
  };
}

export function createTitleBattleRuntime(
  options: TitleBattleOptions,
  host: GameViewSessionHost,
): TitleBattleRuntime {
  const [state, setState] = createSignal<TitleBattleState>({
    screen: options.initiallyOpen ? "title" : "closed",
    titleIndex: 0,
    difficultyIndex: 0,
    result: null,
    battleCount: 0,
  });
  let campaign: SessionState | null = null;

  const begin = (): void => {
    const current = state();
    if (current.screen !== "difficulty") return;
    campaign = host.getState();
    const spawned = spawnTitleParties(
      options,
      current.difficultyIndex,
      campaign,
      current.battleCount,
    );
    const context: ExtensionReadContext = {
      ext: spawned.ext,
      switches: {},
      variables: {},
      items: {},
      gold: 0,
      playerName: "Player",
    };
    const started = options.rules.startTitle(spawned.ext, {
      kind: "trainer",
      opponent: options.data.opponent,
      environment: options.data.environment,
    }, spawned.seed, context);
    if (started === null) throw new Error("title battle: imported party did not start a legal battle");
    host.replaceState(titleBattleState(campaign, started), 0);
    setState({ ...current, screen: "battle", result: null, battleCount: current.battleCount + 1 });
  };

  const applyAction = (action: TitleBattleAction): void => {
    const current = state();
    if (current.screen === "closed" || current.screen === "battle") return;
    if (current.screen === "title") {
      if (action === "up" || action === "down") {
        setState({ ...current, titleIndex: current.titleIndex === 0 ? 1 : 0 });
      } else if (action === "confirm") {
        if (current.titleIndex === 0) setState({ ...current, screen: "closed" });
        else setState({ ...current, screen: "difficulty", difficultyIndex: 0 });
      }
      return;
    }
    if (current.screen === "difficulty") {
      if (action === "back") {
        setState({ ...current, screen: "title", titleIndex: 1 });
      } else if (action === "up") {
        setState({
          ...current,
          difficultyIndex: (current.difficultyIndex + options.data.difficulties.length - 1)
            % options.data.difficulties.length,
        });
      } else if (action === "down") {
        setState({
          ...current,
          difficultyIndex: (current.difficultyIndex + 1) % options.data.difficulties.length,
        });
      } else if (action === "confirm") {
        begin();
      }
      return;
    }
    // Result acknowledgement always returns to the title menu. Both buttons
    // are accepted so controller, keyboard and touch share one path.
    if (action === "confirm" || action === "back") {
      setState({ ...current, screen: "title", titleIndex: 1 });
    }
  };

  const selectTitle = (index: number): void => {
    if (state().screen !== "title" || (index !== 0 && index !== 1)) return;
    setState((current) => ({ ...current, titleIndex: index }));
    applyAction("confirm");
  };
  const selectDifficulty = (index: number): void => {
    if (state().screen !== "difficulty" || !options.data.difficulties[index]) return;
    setState((current) => ({ ...current, difficultyIndex: index }));
    begin();
  };

  const step: GameViewDemoRuntime["step"] = (_buttons, pressed) => {
    const current = state();
    if (current.screen === "closed") return { consumed: false };
    if (current.screen === "battle") {
      const live = host.getState();
      const scene = live.scene;
      if (scene?.kind !== "battle" || !options.rules.isTitleState(scene.state)) {
        throw new Error("title battle: temporary battle scene was replaced unexpectedly");
      }
      const completion = options.rules.titleCompletion(scene.state);
      if (completion === null) return { consumed: false };
      if (campaign === null) throw new Error("title battle: missing campaign restore point");
      host.replaceState(campaign, 0);
      campaign = null;
      setState({ ...current, screen: "result", result: completion.result });
      return { consumed: true, stateChanged: true };
    }
    let action: TitleBattleAction | null = null;
    if (pressed & BTN.UP) action = "up";
    else if (pressed & BTN.DOWN) action = "down";
    else if (pressed & BTN.CIRCLE) action = "confirm";
    else if (pressed & BTN.CROSS) action = "back";
    if (action !== null) applyAction(action);
    return { consumed: true };
  };

  const hook: PocketTitleBattleHook = { state, act: applyAction, selectTitle, selectDifficulty };
  globalThis.__pocketTitleBattle = hook;
  onCleanup(() => {
    if (globalThis.__pocketTitleBattle === hook) delete globalThis.__pocketTitleBattle;
  });

  return {
    step,
    isOpen: () => {
      const screen = state().screen;
      return screen !== "closed" && screen !== "battle";
    },
    ownsSession: () => state().screen === "battle",
    state,
    applyAction,
    selectTitle,
    selectDifficulty,
    data: options.data,
    lang: options.lang,
  };
}

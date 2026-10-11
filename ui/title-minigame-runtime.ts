// Deterministic, session-independent runtime for Tuxemon's title-screen
// guessing game. The upstream mode uses process-global random; this port uses
// a content-derived seed carried by feature-modes.json and never reads or
// advances the campaign RNG. Score, streak and questions live only here.

import { isCjk, paginateText } from "../vendor/pocket-rpgkit/src/engine/text-break.ts";
import { nextRandom, type RngState } from "../battle/core.ts";
import type { TuxemonSceneCatalog } from "../battle/scenes.ts";
import type {
  TitleMinigameData,
  TitleMinigameDifficulty,
} from "./feature-modes-data.ts";

export const MINIGAME_DESCRIPTION_WIDTH = 360;
export const MINIGAME_DESCRIPTION_ROWS = 4;

export interface TitleMinigameQuestion {
  target: string;
  options: string[];
  description: string;
  descriptionPages: string[][];
  descriptionPage: number;
}

export interface TitleMinigameState extends RngState {
  difficultyIndex: number;
  selectedIndex: number;
  score: number;
  streak: number;
  rounds: number;
  wrong: boolean;
  question: TitleMinigameQuestion;
}

function difficultyAt(
  data: Readonly<TitleMinigameData>,
  index: number,
): Readonly<TitleMinigameDifficulty> {
  const difficulty = data.difficulties[index];
  if (!difficulty) throw new Error(`title minigame: unknown difficulty index ${index}`);
  return difficulty;
}

/** Conservative 12 px text measure. It feeds the kit's mixed Latin/CJK line
 * breaker without touching host font state, so headless rules and production
 * paginate identically and every row fits the 360 px clue panel. */
export function minigameTextWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    const cp = character.codePointAt(0)!;
    if (character === " " || character === "\t") width += 4;
    else if (isCjk(cp)) width += 12;
    else if (/[ilI1'.,:;!|]/.test(character)) width += 4;
    else if (/[mwMW@%&#]/.test(character)) width += 9;
    else width += 7;
  }
  return width;
}

export function minigameDescriptionPages(description: string): string[][] {
  return paginateText(
    description,
    MINIGAME_DESCRIPTION_WIDTH,
    MINIGAME_DESCRIPTION_ROWS,
    minigameTextWidth,
  );
}

function drawIndex(rng: RngState, length: number): number {
  if (!Number.isInteger(length) || length < 1) {
    throw new Error("title minigame: cannot draw from an empty pool");
  }
  return Math.floor(nextRandom(rng) * length);
}

function question(
  data: Readonly<TitleMinigameData>,
  catalog: Readonly<TuxemonSceneCatalog>,
  difficulty: Readonly<TitleMinigameDifficulty>,
  rng: RngState,
): TitleMinigameQuestion {
  if (data.monsters.length < difficulty.choices) {
    throw new Error(`title minigame: ${difficulty.id} needs ${difficulty.choices} distinct monsters`);
  }
  const target = data.monsters[drawIndex(rng, data.monsters.length)]!;
  const remaining = [...data.monsters];
  const options: string[] = [];
  for (let index = 0; index < difficulty.choices; index++) {
    options.push(remaining.splice(drawIndex(rng, remaining.length), 1)[0]!);
  }
  // Upstream random.sample may omit the target; one additional randint then
  // replaces a distractor. Sampling without replacement means the target is
  // consequently present exactly once.
  if (!options.includes(target)) options[drawIndex(rng, options.length)] = target;

  const monster = catalog.monster(target);
  if (!monster) throw new Error(`title minigame: monster '${target}' is not packaged`);
  for (const slug of options) {
    if (!catalog.monster(slug)) throw new Error(`title minigame: option '${slug}' is not packaged`);
  }
  const description = monster.description;
  return {
    target,
    options,
    description,
    descriptionPages: minigameDescriptionPages(description),
    descriptionPage: 0,
  };
}

function seededRng(data: Readonly<TitleMinigameData>, difficultyIndex: number): RngState {
  // Separate the three repeatable streams using the same avalanche constant
  // as the title Battle mode. The imported content hash remains the only seed
  // source, so a campaign save can neither affect nor be affected by play.
  return {
    rng: (data.seed ^ Math.imul(difficultyIndex + 1, 0x9e3779b1)) >>> 0,
    rngDraws: 0,
  };
}

export function startTitleMinigame(
  data: Readonly<TitleMinigameData>,
  catalog: Readonly<TuxemonSceneCatalog>,
  difficultyIndex: number,
): TitleMinigameState {
  const difficulty = difficultyAt(data, difficultyIndex);
  const rng = seededRng(data, difficultyIndex);
  return {
    difficultyIndex,
    selectedIndex: 0,
    score: 0,
    streak: 0,
    rounds: 0,
    wrong: false,
    question: question(data, catalog, difficulty, rng),
    ...rng,
  };
}

export function moveTitleMinigameSelection(
  state: Readonly<TitleMinigameState>,
  delta: number,
): TitleMinigameState {
  const length = state.question.options.length;
  return {
    ...state,
    selectedIndex: ((state.selectedIndex + delta) % length + length) % length,
  };
}

export function turnTitleMinigamePage(
  state: Readonly<TitleMinigameState>,
  delta: number,
): TitleMinigameState {
  const pages = state.question.descriptionPages.length;
  return {
    ...state,
    question: {
      ...state.question,
      descriptionPage: ((state.question.descriptionPage + delta) % pages + pages) % pages,
    },
  };
}

export function dismissTitleMinigameWrong(
  state: Readonly<TitleMinigameState>,
): TitleMinigameState {
  return state.wrong ? { ...state, wrong: false } : { ...state };
}

export function answerTitleMinigame(
  data: Readonly<TitleMinigameData>,
  catalog: Readonly<TuxemonSceneCatalog>,
  state: Readonly<TitleMinigameState>,
  optionIndex: number,
): TitleMinigameState {
  const selected = state.question.options[optionIndex];
  if (selected === undefined) throw new Error(`title minigame: unknown option index ${optionIndex}`);
  if (selected !== state.question.target) {
    // Upstream keeps the same question after its generic_wrong dialog.
    return { ...state, selectedIndex: optionIndex, streak: 0, wrong: true };
  }

  const difficulty = difficultyAt(data, state.difficultyIndex);
  const rng: RngState = { rng: state.rng, rngDraws: state.rngDraws };
  return {
    difficultyIndex: state.difficultyIndex,
    selectedIndex: 0,
    score: state.score + difficulty.points,
    streak: state.streak + 1,
    rounds: state.rounds + 1,
    wrong: false,
    question: question(data, catalog, difficulty, rng),
    ...rng,
  };
}

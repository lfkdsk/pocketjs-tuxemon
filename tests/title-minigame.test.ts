import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TUXEMON_BATTLE_DB, TUXEMON_SCENE_CATALOG } from "../battle/game.ts";
import type { TuxemonSceneCatalog } from "../battle/scenes.ts";
import { validateBattleDb } from "../importer/battle-schema.ts";
import featureModesJson from "../data/feature-modes.json";
import type { FeatureModesRuntimeData, TitleMinigameData } from "../ui/feature-modes-data.ts";
import {
  answerTitleMinigame,
  dismissTitleMinigameWrong,
  minigameDescriptionPages,
  startTitleMinigame,
} from "../ui/title-minigame-runtime.ts";

const DATA = (featureModesJson as unknown as FeatureModesRuntimeData).titleMinigame;
const ZH_DB = validateBattleDb(JSON.parse(
  readFileSync(join(import.meta.dir, "../data/battle-db.zh_CN.json"), "utf8"),
));
const ZH_CATALOG: TuxemonSceneCatalog = {
  index: [],
  monster: (slug) => ZH_DB.monsters[slug],
};

function answerCorrect(
  data: Readonly<TitleMinigameData>,
  catalog: Readonly<TuxemonSceneCatalog>,
  state: ReturnType<typeof startTitleMinigame>,
) {
  const index = state.question.options.indexOf(state.question.target);
  if (index < 0) throw new Error("fixture question omitted its target");
  return answerTitleMinigame(data, catalog, state, index);
}

function withoutWhitespace(text: string): string {
  return text.replace(/\s/gu, "");
}

describe("title-screen Guess the Monster", () => {
  test("every deterministic real-data round contains exactly one correct answer", () => {
    for (const [difficultyIndex, difficulty] of DATA.difficulties.entries()) {
      let state = startTitleMinigame(DATA, TUXEMON_SCENE_CATALOG, difficultyIndex);
      for (let round = 0; round < 128; round++) {
        expect(state.question.options).toHaveLength(difficulty.choices);
        expect(new Set(state.question.options).size).toBe(difficulty.choices);
        expect(state.question.options.filter((slug) => slug === state.question.target)).toHaveLength(1);
        expect(DATA.monsters).toContain(state.question.target);
        state = answerCorrect(DATA, TUXEMON_SCENE_CATALOG, state);
      }
    }
  });

  test("difficulty score deltas are 1 2 3", () => {
    expect(DATA.difficulties.map((difficulty) => difficulty.points)).toEqual([1, 2, 3]);
    for (const [difficultyIndex, points] of [1, 2, 3].entries()) {
      const initial = startTitleMinigame(DATA, TUXEMON_SCENE_CATALOG, difficultyIndex);
      const next = answerCorrect(DATA, TUXEMON_SCENE_CATALOG, initial);
      expect(next.score - initial.score).toBe(points);
      expect(next.streak).toBe(1);
      expect(next.rounds).toBe(1);
    }
  });

  test("wrong answer clears the streak and shows generic_wrong without replacing the round", () => {
    let state = startTitleMinigame(DATA, TUXEMON_SCENE_CATALOG, 1);
    for (let round = 0; round < 4; round++) state = answerCorrect(DATA, TUXEMON_SCENE_CATALOG, state);
    const question = structuredClone(state.question);
    const score = state.score;
    const wrongIndex = state.question.options.findIndex((slug) => slug !== state.question.target);
    const wrong = answerTitleMinigame(DATA, TUXEMON_SCENE_CATALOG, state, wrongIndex);

    expect(DATA.wrong).toEqual({ en_US: "Wrong!", zh_CN: "猜错了！" });
    expect(wrong.wrong).toBeTrue();
    expect(wrong.streak).toBe(0);
    expect(wrong.score).toBe(score);
    expect(wrong.question).toEqual(question);
    expect(dismissTitleMinigameWrong(wrong)).toMatchObject({ wrong: false, streak: 0 });
  });

  test("streak bonus begins at ten without changing the score table", () => {
    let state = startTitleMinigame(DATA, TUXEMON_SCENE_CATALOG, 2);
    for (let round = 0; round < 9; round++) state = answerCorrect(DATA, TUXEMON_SCENE_CATALOG, state);
    expect(state.streak).toBe(9);
    expect(state.score).toBe(27);
    state = answerCorrect(DATA, TUXEMON_SCENE_CATALOG, state);
    expect(state.streak).toBe(10);
    expect(state.score).toBe(30);
    expect(DATA.streakBonus).toEqual({
      en_US: "Streak Bonus! You're on fire!",
      zh_CN: "连击加成！你势不可挡！",
    });
  });

  test("content seed and action sequence reproduce exactly without campaign RNG", () => {
    const play = () => {
      let state = startTitleMinigame(DATA, TUXEMON_SCENE_CATALOG, 0);
      const transcript = [];
      for (let round = 0; round < 32; round++) {
        transcript.push(structuredClone(state.question));
        state = answerCorrect(DATA, TUXEMON_SCENE_CATALOG, state);
      }
      return { transcript, rng: state.rng, draws: state.rngDraws, score: state.score };
    };
    expect(DATA.seed).toBe(176815842);
    expect(play()).toEqual(play());
  });

  test("hard descriptions paginate every real English and Chinese character without ellipsis", () => {
    for (const catalog of [TUXEMON_SCENE_CATALOG, ZH_CATALOG]) {
      const descriptions = DATA.monsters.map((slug) => catalog.monster(slug)!.description);
      const longest = descriptions.reduce((a, b) => a.length >= b.length ? a : b);
      const pages = minigameDescriptionPages(longest);
      expect(pages.every((page) => page.length > 0 && page.length <= 4)).toBeTrue();
      expect(withoutWhitespace(pages.flat().join(""))).toBe(withoutWhitespace(longest));
      expect(pages.flat().join("\n")).not.toContain("…");

      const extended = new Array(4).fill(longest).join(" ");
      const extendedPages = minigameDescriptionPages(extended);
      expect(extendedPages.length).toBeGreaterThan(1);
      expect(withoutWhitespace(extendedPages.flat().join(""))).toBe(withoutWhitespace(extended));
      expect(extendedPages.flat().join("\n")).not.toContain("…");
    }
  });

  test("easy and normal use art while hard uses only the localized description clue", () => {
    expect(DATA.difficulties.map(({ clue, choices }) => ({ clue, choices }))).toEqual([
      { clue: "image", choices: 3 },
      { clue: "image", choices: 5 },
      { clue: "description", choices: 5 },
    ]);
    const hardEn = startTitleMinigame(DATA, TUXEMON_SCENE_CATALOG, 2);
    const hardZh = startTitleMinigame(DATA, ZH_CATALOG, 2);
    expect(hardEn.question.target).toBe(hardZh.question.target);
    expect(hardEn.question.description).toBe(TUXEMON_BATTLE_DB.monsters[hardEn.question.target]!.description);
    expect(hardZh.question.description).toBe(ZH_DB.monsters[hardZh.question.target]!.description);
  });
});

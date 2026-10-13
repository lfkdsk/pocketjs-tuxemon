import { describe, expect, test } from "bun:test";

import {
  appendExpeditionJournal,
  startExpeditionJournal,
  type ExpeditionJournal,
} from "../battle/expedition-journal.ts";
import {
  loadExpeditionReplayJournal,
  parseExpeditionReplayJournal,
  prepareExpeditionReplay,
  resolveExpeditionReplaySource,
  type ExpeditionReplayResponse,
} from "../battle/expedition-replay.ts";
import {
  applyExpeditionAction,
  createExpedition,
  legalExpeditionActions,
  observeExpedition,
  type Expedition,
  type ExpeditionAction,
} from "../battle/expedition.ts";
import { canonicalJson } from "../vendor/pocket-rpgkit/src/engine/save.ts";

const SEED = "0123456789abcdef".repeat(4);
const BASE = "https://game.example/pocket-tuxemon/expedition-replay.html";

function apply(expedition: Expedition, action: ExpeditionAction): Expedition {
  const result = applyExpeditionAction(expedition, action);
  if (!result.ok) throw new Error(result.error);
  return result.expedition;
}

function fixture(): ExpeditionJournal {
  let expedition = createExpedition({
    seed: SEED,
    rules: { cycle: "ranked", stepBudget: 8, startingArea: "spyder_route1" },
  });
  let journal = startExpeditionJournal({
    cycle: expedition.rules.cycle,
    stepBudget: expedition.rules.stepBudget,
    levelCap: expedition.rules.levelCap,
    startingArea: expedition.area,
  }, observeExpedition(expedition));
  const accept = (action: ExpeditionAction) => {
    expedition = apply(expedition, action);
    journal = appendExpeditionJournal(journal, action, observeExpedition(expedition));
  };

  accept(legalExpeditionActions(expedition).find((action) =>
    action.type === "travel" && action.area === "spyder_citypark")!);
  accept(legalExpeditionActions(expedition).find((action) => action.type === "explore")!);
  accept(legalExpeditionActions(expedition).find((action) =>
    action.type === "battle" && action.mode === "auto")!);
  if (!expedition.ended) {
    accept(legalExpeditionActions(expedition).find((action) => action.type === "end")!);
  }
  return journal;
}

function response(
  body: string,
  overrides: Partial<ExpeditionReplayResponse> = {},
): ExpeditionReplayResponse {
  return {
    ok: true,
    status: 200,
    url: "https://game.example/pocket-tuxemon/journal.json",
    headers: { get: (name) => name.toLowerCase() === "content-type" ? "application/json" : null },
    body: new Blob([body]).stream(),
    ...overrides,
  };
}

describe("expedition web replay", () => {
  test("loads only bounded JSON from data, same-origin, or explicit external HTTPS sources", async () => {
    const journal = fixture();
    const json = JSON.stringify(journal);
    const data = `data:application/json,${encodeURIComponent(json)}`;
    expect(resolveExpeditionReplaySource(
      `?expeditionReplay=${encodeURIComponent(data)}`,
      BASE,
    )).toEqual({ kind: "inline", json });
    expect(resolveExpeditionReplaySource("?expeditionReplay=journals/run.json", BASE)).toEqual({
      kind: "url",
      url: "https://game.example/pocket-tuxemon/journals/run.json",
      external: false,
    });
    expect(() => resolveExpeditionReplaySource(
      "?expeditionReplay=https%3A%2F%2Fother.example%2Frun.json",
      BASE,
    )).toThrow("expeditionReplayExternal=1");
    expect(resolveExpeditionReplaySource(
      "?expeditionReplay=https%3A%2F%2Fother.example%2Frun.json&expeditionReplayExternal=1",
      BASE,
    )).toEqual({ kind: "url", url: "https://other.example/run.json", external: true });
    expect(() => resolveExpeditionReplaySource(
      `?expeditionReplay=${encodeURIComponent("javascript:globalThis.pwned=true")}`,
      BASE,
    )).toThrow();

    const calls: Array<{ url: string; credentials: string }> = [];
    const loaded = await loadExpeditionReplayJournal(
      "?expeditionReplay=journal.json",
      BASE,
      async (url, init) => {
        calls.push({ url, credentials: init.credentials });
        return response(json);
      },
    );
    expect(calls).toEqual([{
      url: "https://game.example/pocket-tuxemon/journal.json",
      credentials: "same-origin",
    }]);
    expect(canonicalJson(loaded)).toBe(canonicalJson(parseExpeditionReplayJournal(json)));
  });

  test("validates the whole journal and expands public battle decisions into visual frames", () => {
    const journal = fixture();
    const replay = prepareExpeditionReplay(JSON.parse(JSON.stringify(journal)));
    const battleEntry = replay.journal.entries.find((entry) => entry.observation.lastTransition?.type === "battle");
    if (battleEntry?.observation.lastTransition?.type !== "battle") {
      throw new Error("fixture has no public battle receipt");
    }
    const battleFrames = replay.frames.filter((frame) => frame.journalStep === battleEntry.step);
    expect(battleFrames).toHaveLength(battleEntry.observation.lastTransition.turns.length);
    expect(battleFrames.map((frame) => frame.battle?.turn.observation.turn)).toEqual(
      battleEntry.observation.lastTransition.turns.map((turn) => turn.observation.turn),
    );
    expect(replay.frames.map((frame) => frame.index)).toEqual(
      replay.frames.map((_, index) => index),
    );
    expect(replay.route).toEqual([
      replay.journal.initialObservation.area.id,
      ...replay.journal.entries.map((entry) => entry.observation.area.id),
    ]);
    expect(canonicalJson(replay.frames.at(-1)!.observation))
      .toBe(canonicalJson(replay.journal.entries.at(-1)!.observation));
  });

  test("never treats journal fields as script or markup", () => {
    const malicious = JSON.parse(JSON.stringify(fixture())) as Record<string, unknown>;
    malicious.script = "globalThis.__expeditionReplayExecuted = true";
    expect(() => parseExpeditionReplayJournal(JSON.stringify(malicious)))
      .toThrow("object fields do not match");
  });
});

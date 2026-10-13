/** Web-only expedition journal playback helpers.
 *
 * This module stays outside the production game entry graph. It validates a
 * complete public journal before presenting frame zero and expands automatic
 * battles into their public, post-decision Arena observations.
 */

import {
  ExpeditionJournalError,
  MAX_EXPEDITION_JOURNAL_BYTES,
  validateExpeditionJournal,
  type ValidatedExpeditionJournal,
  type ValidatedExpeditionJournalEntry,
} from "./expedition-journal.ts";
import type {
  ExpeditionAction,
  ExpeditionObservation,
  ExpeditionPublicBattleTurn,
} from "./expedition.ts";
import {
  ReplaySourceError,
  assertReplayJsonSize,
  loadReplayJsonText,
  resolveReplayJsonSource,
  type ReplayJsonFetch,
  type ReplayJsonResponse,
  type ReplayJsonSource,
  type ReplayJsonSourcePolicy,
} from "./replay-source.ts";

export const EXPEDITION_REPLAY_MAX_BYTES = MAX_EXPEDITION_JOURNAL_BYTES;

export type ExpeditionReplaySource = ReplayJsonSource;
export type ExpeditionReplayResponse = ReplayJsonResponse;
export type ExpeditionReplayFetch = ReplayJsonFetch;

export interface ExpeditionReplayFrame {
  /** Zero-based visual cursor. Frame zero is the initial observation. */
  index: number;
  /** One-based journal step, or zero for the initial observation. */
  journalStep: number;
  action: ExpeditionAction | null;
  observation: ExpeditionObservation;
  /** Present when this visual frame is one decision inside a battle action. */
  battle: null | {
    turn: ExpeditionPublicBattleTurn;
    index: number;
    total: number;
  };
}

export interface PreparedExpeditionReplay {
  journal: ValidatedExpeditionJournal;
  frames: ExpeditionReplayFrame[];
  /** Area after frame zero and after each accepted journal action. */
  route: string[];
}

const EXPEDITION_SOURCE_POLICY: ReplayJsonSourcePolicy = {
  sourceParam: "expeditionReplay",
  externalParam: "expeditionReplayExternal",
  maxBytes: EXPEDITION_REPLAY_MAX_BYTES,
  errorPrefix: "expedition replay",
};

function replayError(message: string): never {
  throw new ExpeditionJournalError(`expedition replay: ${message}`);
}

/** Resolve data:, same-origin, or explicitly enabled external HTTPS input. */
export function resolveExpeditionReplaySource(search: string, baseUrl: string): ExpeditionReplaySource {
  try {
    return resolveReplayJsonSource(search, baseUrl, EXPEDITION_SOURCE_POLICY, "journal");
  } catch (error) {
    if (error instanceof ReplaySourceError) throw new ExpeditionJournalError(error.message);
    throw error;
  }
}

export function parseExpeditionReplayJournal(text: string): ValidatedExpeditionJournal {
  try {
    assertReplayJsonSize(text, EXPEDITION_SOURCE_POLICY, "journal");
  } catch (error) {
    if (error instanceof ReplaySourceError) throw new ExpeditionJournalError(error.message);
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    replayError("source is not valid JSON");
  }
  const checked = validateExpeditionJournal(value);
  if (!checked.ok) replayError(checked.error);
  return checked.journal;
}

export async function loadExpeditionReplayJournal(
  search: string,
  baseUrl: string,
  fetcher: ExpeditionReplayFetch,
): Promise<ValidatedExpeditionJournal> {
  try {
    return parseExpeditionReplayJournal(await loadReplayJsonText(
      search,
      baseUrl,
      fetcher,
      EXPEDITION_SOURCE_POLICY,
      "journal",
    ));
  } catch (error) {
    if (error instanceof ReplaySourceError) throw new ExpeditionJournalError(error.message);
    throw error;
  }
}

function entryFrames(entry: ValidatedExpeditionJournalEntry): ExpeditionReplayFrame[] {
  const transition = entry.observation.lastTransition;
  if (transition?.type !== "battle") {
    return [{
      index: -1,
      journalStep: entry.step,
      action: entry.action,
      observation: entry.observation,
      battle: null,
    }];
  }
  return transition.turns.map((turn, index) => ({
    index: -1,
    journalStep: entry.step,
    action: entry.action,
    observation: entry.observation,
    battle: { turn, index, total: transition.turns.length },
  }));
}

/** Build the bounded visual timeline from already public observations. */
export function prepareExpeditionReplay(value: unknown): PreparedExpeditionReplay {
  const checked = validateExpeditionJournal(value);
  if (!checked.ok) throw new ExpeditionJournalError(`expedition replay: ${checked.error}`);
  const journal = checked.journal;
  const frames: ExpeditionReplayFrame[] = [{
    index: 0,
    journalStep: 0,
    action: null,
    observation: journal.initialObservation,
    battle: null,
  }];
  for (const entry of journal.entries) frames.push(...entryFrames(entry));
  for (const [index, frame] of frames.entries()) frame.index = index;
  return {
    journal,
    frames,
    route: [journal.initialObservation.area.id, ...journal.entries.map((entry) => entry.observation.area.id)],
  };
}

export function expeditionReplayTerminalFrame(replay: PreparedExpeditionReplay): ExpeditionReplayFrame {
  const frame = replay.frames.at(-1);
  if (!frame) replayError("timeline has no initial frame");
  return frame;
}

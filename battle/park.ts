/** Saved Eclipse Park statistics. Upstream keeps one ParkSession on the
 * client: `start` activates it without resetting prior statistics and `stop`
 * only deactivates it before opening the summary. Keeping this payload sparse
 * means projects and legacy saves that never visit the park pay no cost. */
export interface ParkSessionState {
  active: boolean;
  /** Sparse one-shot handoff from `stop` to the blocking settlement scene.
   * The scene consumes it at start so overlapping exit guards cannot show the
   * same summary twice. */
  summaryPending?: true;
  sightings: Record<string, number>;
  failedAttempts: number;
  successfulCaptures: number;
  /** Upstream only archives successful encounters. `turnsRemaining` starts at
   *  30 and, in the pinned source, is never decremented by a caller. */
  history: Array<{ monster: string; turnsRemaining: number }>;
}

export const PARK_ENCOUNTER_TURNS = 30;

export function emptyParkSession(active = false): ParkSessionState {
  return {
    active,
    sightings: {},
    failedAttempts: 0,
    successfulCaptures: 0,
    history: [],
  };
}

/** Mirrors ParkSession.activate_session(): activation preserves accumulated
 * tracker/history data instead of resetting it. */
export function activateParkSession(
  current: Readonly<ParkSessionState> | undefined,
): ParkSessionState {
  if (!current) return emptyParkSession(true);
  const { summaryPending: _summaryPending, ...rest } = current;
  return { ...rest, active: true };
}

/** Mirrors ParkSession.deactivate_session(). */
export function deactivateParkSession(
  current: Readonly<ParkSessionState> | undefined,
): ParkSessionState {
  if (!current) return { ...emptyParkSession(false), summaryPending: true };
  if (current.active || current.summaryPending) {
    return { ...current, active: false, summaryPending: true };
  }
  return { ...current, active: false };
}

export function recordParkSighting(
  current: Readonly<ParkSessionState>,
  monster: string,
): ParkSessionState {
  if (!current.active) return current as ParkSessionState;
  return {
    ...current,
    sightings: {
      ...current.sightings,
      [monster]: (current.sightings[monster] ?? 0) + 1,
    },
  };
}

export function recordParkCapture(
  current: Readonly<ParkSessionState>,
  monster: string,
  success: boolean,
  turnsRemaining = PARK_ENCOUNTER_TURNS,
): ParkSessionState {
  if (!current.active) return current as ParkSessionState;
  if (!success) return { ...current, failedAttempts: current.failedAttempts + 1 };
  return {
    ...current,
    successfulCaptures: current.successfulCaptures + 1,
    history: [...current.history, { monster, turnsRemaining }],
  };
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const nonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function parkSessionProblem(value: unknown): string | null {
  const state = record(value);
  if (!state || typeof state.active !== "boolean") return "parkSession.active must be boolean";
  if (state.summaryPending !== undefined && state.summaryPending !== true) {
    return "parkSession.summaryPending must be true when present";
  }
  if (!nonNegativeInteger(state.failedAttempts)) {
    return "parkSession.failedAttempts must be a non-negative safe integer";
  }
  if (!nonNegativeInteger(state.successfulCaptures)) {
    return "parkSession.successfulCaptures must be a non-negative safe integer";
  }
  const sightings = record(state.sightings);
  if (!sightings || !Object.entries(sightings).every(([monster, count]) =>
    monster.length > 0 && nonNegativeInteger(count) && count > 0)) {
    return "parkSession.sightings must map monster slugs to positive safe integers";
  }
  if (!Array.isArray(state.history)) return "parkSession.history must be an array";
  for (let index = 0; index < state.history.length; index++) {
    const entry = record(state.history[index]);
    if (!entry || typeof entry.monster !== "string" || entry.monster.length === 0
      || !nonNegativeInteger(entry.turnsRemaining)) {
      return `parkSession.history[${index}] is invalid`;
    }
  }
  return null;
}

export interface ParkSummary {
  uniqueSeen: number;
  attempts: number;
  failedAttempts: number;
  successfulCaptures: number;
  successRate: number;
  sightings: Array<{ monster: string; count: number }>;
  highlights: Array<{ monster: string; averageTurnsRemaining: number }>;
}

export function parkSummary(session: Readonly<ParkSessionState>): ParkSummary {
  const attempts = session.failedAttempts + session.successfulCaptures;
  const byMonster = new Map<string, number[]>();
  for (const entry of session.history) {
    const values = byMonster.get(entry.monster) ?? [];
    values.push(entry.turnsRemaining);
    byMonster.set(entry.monster, values);
  }
  return {
    uniqueSeen: Object.keys(session.sightings).length,
    attempts,
    failedAttempts: session.failedAttempts,
    successfulCaptures: session.successfulCaptures,
    successRate: attempts === 0 ? 0 : session.successfulCaptures / attempts,
    sightings: Object.entries(session.sightings)
      .map(([monster, count]) => ({ monster, count }))
      .sort((a, b) => b.count - a.count || a.monster.localeCompare(b.monster))
      .slice(0, 5),
    highlights: [...byMonster.entries()]
      .map(([monster, turns]) => ({
        monster,
        averageTurnsRemaining: turns.reduce((sum, value) => sum + value, 0) / turns.length,
      }))
      .sort((a, b) => b.averageTurnsRemaining - a.averageTurnsRemaining || a.monster.localeCompare(b.monster)),
  };
}

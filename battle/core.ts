/**
 * Deterministic, JSON-only turn runner shared by the Tuxemon rules.
 *
 * The caller owns immutable reducer semantics: clone the state once, then let
 * this module advance that draft until it needs another player decision.  No
 * clock or wall-time value is consulted here, so battle results cannot vary
 * with the host refresh rate.
 */

export interface RngState {
  /** mulberry32 cursor (unsigned 32-bit). */
  rng: number;
  /** Number of values consumed since the battle stream was seeded. */
  rngDraws: number;
}

/** Bit-identical to Pocket RPG Kit's interpreter RNG and the Python oracle. */
export function nextRandom(state: RngState): number {
  const cursor = (state.rng + 0x6d2b79f5) | 0;
  state.rng = cursor >>> 0;
  let value = Math.imul(cursor ^ (cursor >>> 15), cursor | 1);
  value = (value + Math.imul(value ^ (value >>> 7), value | 61)) ^ value;
  state.rngDraws++;
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

export function randomChoice<T>(state: RngState, values: readonly T[]): T {
  if (values.length === 0) throw new Error("battle: cannot choose from an empty list");
  return values[Math.floor(nextRandom(state) * values.length)]!;
}

export function randomIntInclusive(state: RngState, min: number, max: number): number {
  if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
    throw new Error(`battle: invalid randint range ${min}..${max}`);
  }
  return min + Math.floor(nextRandom(state) * (max - min + 1));
}

export type BattlePhase =
  | "housekeeping"
  | "decision"
  | "action"
  | "postAction"
  | "resolve"
  | "ended";

export type BattleOutcome = "won" | "lost" | "draw" | "ran" | "captured";

export type ActionKind = "technique" | "status" | "item" | "capture" | "run" | "swap";

export interface BattleAction {
  kind: ActionKind;
  /** Monster uid; null is Tuxemon's status-tick action. */
  user: number | null;
  target: number;
  ref: string;
  moveIndex?: number;
  /** Dedicated Park capture marker. Failed captures rewrite the wild
   * monster's queued action to the empty flavour technique. */
  parkCapture?: true;
  /** One of upstream ParkEffect's six idle narration keys. */
  parkFlavor?: string;
  /** EnqueuedAction.sub_priority, consumed even when sorting ignores it. */
  subPriority: number;
}

export interface PendingBattleAction {
  turn: number;
  action: BattleAction;
}

export interface BattleDecision {
  side: 0;
  uid: number;
  kind: "technique" | "replacement";
}

export interface BattleEvent {
  type: string;
  turn: number;
  [key: string]: unknown;
}

export interface BattleCoreState<Monster> extends RngState {
  turn: number;
  phase: BattlePhase;
  /** Side 0 is the human player; side 1 is the opponent. */
  parties: [Monster[], Monster[]];
  /** Active uid order. Tuxemon inserts the AI side before the player side. */
  field: number[];
  queue: BattleAction[];
  pending: PendingBattleAction[];
  hitRolls: Record<string, number>;
  decisionQueue: number[];
  awaiting: BattleDecision | null;
  outcome: BattleOutcome | null;
  events: BattleEvent[];
}

export interface BattleCoreRules<Monster, State extends BattleCoreState<Monster>> {
  uid(monster: Monster): number;
  side(state: State, uid: number): 0 | 1;
  monster(state: State, uid: number): Monster;
  fainted(monster: Monster): boolean;
  /** Fill empty positions, AI first. Human replacement policy belongs to rules/UI. */
  fillPositions(state: State): void;
  /** Cooldowns and ON_DECISION hooks. */
  onDecisionStart(state: State, uid: number): void;
  skipsDecision(state: State, uid: number): boolean;
  decideAi(state: State, uid: number): Omit<BattleAction, "subPriority">;
  playerAction(
    state: State,
    uid: number,
    choice: number,
  ): Omit<BattleAction, "subPriority">;
  sortKey(state: State, action: BattleAction): readonly [number, number, number];
  perform(state: State, action: BattleAction): void;
  /** CHECK_PARTY_HP, queue pruning, rewards, and removal from the field. */
  checkParty(state: State): void;
  /** Queue status ticks in field order. */
  queuePostActions(state: State): void;
  /** Called exactly once after the outcome is fixed. */
  finish(state: State): void;
}

export function enqueueAction<State extends RngState & { queue: BattleAction[] }>(
  state: State,
  action: Omit<BattleAction, "subPriority">,
): BattleAction {
  const queued = { ...action, subPriority: nextRandom(state) };
  state.queue.push(queued);
  return queued;
}

export function makePendingAction<State extends RngState>(
  state: State,
  action: Omit<BattleAction, "subPriority">,
): BattleAction {
  return { ...action, subPriority: nextRandom(state) };
}

function sortQueue<Monster, State extends BattleCoreState<Monster>>(
  state: State,
  rules: BattleCoreRules<Monster, State>,
): void {
  // Array.sort is stable in ES2019+. Python sorts ascending and pop()s the
  // last entry, so an exact key tie deliberately executes last-enqueued first.
  state.queue.sort((a, b) => {
    const ak = rules.sortKey(state, a);
    const bk = rules.sortKey(state, b);
    return ak[0] - bk[0] || ak[1] - bk[1] || ak[2] - bk[2];
  });
}

function remainingSides<Monster, State extends BattleCoreState<Monster>>(
  state: State,
  rules: BattleCoreRules<Monster, State>,
): (0 | 1)[] {
  return ([0, 1] as const).filter((side) =>
    state.parties[side].some((monster) => !rules.fainted(monster)),
  );
}

export function endBattle<Monster, State extends BattleCoreState<Monster>>(
  state: State,
  rules: BattleCoreRules<Monster, State>,
  outcome: BattleOutcome,
): State {
  if (state.phase === "ended") return state;
  state.outcome = outcome;
  state.phase = "ended";
  state.awaiting = null;
  state.decisionQueue = [];
  state.queue = [];
  state.pending = [];
  state.events.push({ type: "end", turn: state.turn, outcome });
  rules.finish(state);
  return state;
}

function finishIfDecided<Monster, State extends BattleCoreState<Monster>>(
  state: State,
  rules: BattleCoreRules<Monster, State>,
): boolean {
  const remaining = remainingSides(state, rules);
  if (remaining.length > 1) return false;
  const outcome = remaining.length === 0 ? "draw" : remaining[0] === 0 ? "won" : "lost";
  endBattle(state, rules, outcome);
  return true;
}

function cleanAndReleasePending<Monster, State extends BattleCoreState<Monster>>(
  state: State,
  rules: BattleCoreRules<Monster, State>,
): void {
  state.pending = state.pending.filter(({ turn, action }) => {
    if (turn < state.turn) return false;
    if (action.user !== null && rules.fainted(rules.monster(state, action.user))) return false;
    return !rules.fainted(rules.monster(state, action.target));
  });
  const due = state.pending.filter(({ turn }) => turn === state.turn);
  state.pending = state.pending.filter(({ turn }) => turn !== state.turn);
  for (const entry of due) state.queue.push(entry.action);
}

function drain<Monster, State extends BattleCoreState<Monster>>(
  state: State,
  rules: BattleCoreRules<Monster, State>,
): void {
  const ended = (): boolean => state.phase === "ended";
  sortQueue(state, rules);
  while (state.queue.length > 0) {
    const action = state.queue.pop()!;
    rules.perform(state, action);
    if (ended()) return;
    sortQueue(state, rules);
    rules.checkParty(state);
    if (ended()) return;
  }
}

/** Advance a mutable draft to its next player decision or terminal state. */
export function advanceBattle<Monster, State extends BattleCoreState<Monster>>(
  state: State,
  rules: BattleCoreRules<Monster, State>,
): State {
  for (let guard = 0; guard < 100_000; guard++) {
    switch (state.phase) {
      case "housekeeping": {
        state.turn++;
        cleanAndReleasePending(state, rules);
        rules.fillPositions(state);
        state.hitRolls = {};
        for (const uid of state.field) state.hitRolls[String(uid)] = nextRandom(state);
        state.events.push({ type: "round", turn: state.turn, hit: { ...state.hitRolls } });
        state.decisionQueue = [];
        for (const uid of state.field) {
          rules.onDecisionStart(state, uid);
          if (rules.skipsDecision(state, uid)) continue;
          if (rules.side(state, uid) === 1) {
            enqueueAction(state, rules.decideAi(state, uid));
          } else {
            state.decisionQueue.push(uid);
          }
        }
        state.phase = "decision";
        const uid = state.decisionQueue[0];
        if (uid !== undefined) {
          state.awaiting = { side: 0, uid, kind: "technique" };
          return state;
        }
        state.phase = "action";
        break;
      }
      case "decision":
        return state;
      case "action":
        // PRE_ACTION checks for a winner before queued actions execute. Status
        // pre-checks can faint their user while decisions are being gathered.
        if (finishIfDecided(state, rules)) return state;
        drain(state, rules);
        if (state.outcome !== null) return state;
        state.phase = "postAction";
        break;
      case "postAction":
        if (remainingSides(state, rules).length > 1) rules.queuePostActions(state);
        drain(state, rules);
        if (state.outcome !== null) return state;
        state.phase = "resolve";
        break;
      case "resolve":
        if (finishIfDecided(state, rules)) return state;
        state.phase = "housekeeping";
        break;
      case "ended":
        return state;
    }
  }
  throw new Error("battle: phase machine exceeded its safety bound");
}

/** Submit one menu choice to a mutable draft and run to the next boundary. */
export function submitAction<Monster, State extends BattleCoreState<Monster>>(
  state: State,
  rules: BattleCoreRules<Monster, State>,
  action: Omit<BattleAction, "subPriority">,
): State {
  const awaiting = state.awaiting;
  if (!awaiting || awaiting.kind !== "technique") {
    throw new Error("battle: no action decision is pending");
  }
  if (action.user !== awaiting.uid) {
    throw new Error(`battle: action belongs to ${String(action.user)}, awaiting ${awaiting.uid}`);
  }
  enqueueAction(state, action);
  state.decisionQueue.shift();
  state.awaiting = null;
  const uid = state.decisionQueue[0];
  if (uid !== undefined) {
    state.awaiting = { side: 0, uid, kind: "technique" };
    return state;
  }
  state.phase = "action";
  return advanceBattle(state, rules);
}

/** Submit one technique-menu choice to a mutable draft. */
export function submitDecision<Monster, State extends BattleCoreState<Monster>>(
  state: State,
  rules: BattleCoreRules<Monster, State>,
  choice: number,
): State {
  const awaiting = state.awaiting;
  if (!awaiting || awaiting.kind !== "technique") {
    throw new Error("battle: no technique decision is pending");
  }
  return submitAction(state, rules, rules.playerAction(state, awaiting.uid, choice));
}

// Tuxemon step trackers (upstream tuxemon/step_tracker.py), per character.
//
// A tracker counts down as its character walks. Milestones fire once when
// the countdown reaches or passes them and stay "triggered" until an event
// marks them shown. The `step_tracker` condition is true while a milestone
// is triggered and not yet shown.
//
// Tuxemon opts into the kit hook's signed displacement context. Each ordinary
// step, transfer or direct placement feeds dx + dy, matching upstream: steps
// up or left wind the countdown back instead of always counting down.

export interface StepTrackerState {
  countdown: number;
  initialCountdown: number;
  /** Upstream's insertion order is kept for milestone evaluation. */
  milestones: number[];
  /** Triggered milestones (canonical number string) -> shown. */
  status: Record<string, boolean>;
  /** Sparse: present only for auto-resetting trackers. */
  autoReset?: true;
  /** Sparse: completed auto-reset cycles. */
  cycleCount?: number;
}

/** character -> tracker id -> tracker. */
export type StepTrackers = Record<string, Record<string, StepTrackerState>>;

export interface StepTrackerSpec {
  countdown: number;
  milestones: number[];
  autoReset: boolean;
  initialCountdown?: number;
}

const key = (milestone: number) => String(milestone);

/** Upstream add_tracker keeps an existing tracker untouched. */
export function addStepTracker(
  trackers: Readonly<StepTrackers> | undefined,
  character: string,
  id: string,
  spec: Readonly<StepTrackerSpec>,
): StepTrackers | undefined {
  if (trackers?.[character]?.[id]) return undefined;
  const tracker: StepTrackerState = {
    countdown: spec.countdown,
    initialCountdown: spec.initialCountdown ?? spec.countdown,
    milestones: [...spec.milestones],
    status: {},
    ...(spec.autoReset ? { autoReset: true as const } : {}),
  };
  return { ...trackers, [character]: { ...trackers?.[character], [id]: tracker } };
}

/** Returns undefined when the tracker does not exist (upstream warns and stops).
 *  Empty character maps are pruned so unused saves stay sparse. */
export function removeStepTracker(
  trackers: Readonly<StepTrackers> | undefined,
  character: string,
  id: string,
): StepTrackers | undefined {
  const owned = trackers?.[character];
  if (!owned?.[id]) return undefined;
  const { [id]: _removed, ...rest } = owned;
  const { [character]: _owner, ...others } = trackers!;
  return Object.keys(rest).length ? { ...others, [character]: rest } : others;
}

/** Upstream show_milestone_dialogue: only a triggered, unshown milestone changes. */
export function markMilestoneShown(
  trackers: Readonly<StepTrackers> | undefined,
  character: string,
  id: string,
  milestone: number,
): StepTrackers | undefined {
  const tracker = trackers?.[character]?.[id];
  if (!tracker || tracker.status[key(milestone)] !== false) return undefined;
  return {
    ...trackers,
    [character]: {
      ...trackers![character],
      [id]: { ...tracker, status: { ...tracker.status, [key(milestone)]: true } },
    },
  };
}

/** Condition `step_tracker`: milestone triggered and not shown. */
export function milestonePending(
  trackers: Readonly<StepTrackers> | undefined,
  character: string,
  id: string,
  milestone: number,
): boolean {
  return trackers?.[character]?.[id]?.status[key(milestone)] === false;
}

/** StepTracker.update_steps for a positive movement. */
export function advanceStepTracker(tracker: Readonly<StepTrackerState>, movement: number): StepTrackerState {
  let countdown = tracker.countdown;
  let status = tracker.status;
  let cycleCount = tracker.cycleCount;
  const trigger = (milestone: number) => {
    if (key(milestone) in status) return;
    status = { ...status, [key(milestone)]: false };
  };
  const range = (start: number, end: number) => {
    for (const milestone of tracker.milestones) {
      if (end <= milestone && milestone <= start) trigger(milestone);
    }
  };
  if (movement <= 0) {
    countdown += Math.abs(movement);
    return { ...tracker, countdown };
  }
  while (movement > 0) {
    if (movement >= countdown) {
      const previous = countdown;
      movement -= countdown;
      countdown = 0;
      range(previous, countdown);
      if (!tracker.autoReset) break;
      countdown = tracker.initialCountdown;
      status = {};
      cycleCount = (cycleCount ?? 0) + 1;
    } else {
      const previous = countdown;
      countdown -= movement;
      range(previous, countdown);
      movement = 0;
    }
  }
  for (const milestone of tracker.milestones) {
    if (countdown <= milestone) trigger(milestone);
  }
  return {
    ...tracker,
    countdown,
    status,
    ...(cycleCount === undefined ? {} : { cycleCount }),
  };
}

/** One step for every tracker of `character`; undefined when it has none. */
export function stepCharacterTrackers(
  trackers: Readonly<StepTrackers> | undefined,
  character: string,
  movement = 1,
): StepTrackers | undefined {
  const owned = trackers?.[character];
  if (!owned) return undefined;
  const next: Record<string, StepTrackerState> = {};
  for (const [id, tracker] of Object.entries(owned)) next[id] = advanceStepTracker(tracker, movement);
  return { ...trackers, [character]: next };
}

/** Save-boundary validation; returns a problem description or null. */
export function stepTrackersProblem(value: unknown): string | null {
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (!isRecord(value)) return "stepTrackers must be an object";
  for (const [character, owned] of Object.entries(value)) {
    if (!character || !isRecord(owned) || !Object.keys(owned).length) {
      return `stepTrackers.${character} must be a non-empty object`;
    }
    for (const [id, raw] of Object.entries(owned)) {
      const where = `stepTrackers.${character}.${id}`;
      if (!id || !isRecord(raw)) return `${where} must be an object`;
      if (!finite(raw.countdown) || !finite(raw.initialCountdown)) return `${where} countdowns must be finite`;
      if (!Array.isArray(raw.milestones) || !raw.milestones.every(finite)) return `${where}.milestones must be numbers`;
      if (!isRecord(raw.status) || !Object.values(raw.status).every((v) => typeof v === "boolean")) {
        return `${where}.status must map milestones to booleans`;
      }
      if (raw.autoReset !== undefined && raw.autoReset !== true) return `${where}.autoReset must be true when present`;
      if (raw.cycleCount !== undefined && (!Number.isSafeInteger(raw.cycleCount) || (raw.cycleCount as number) < 1)) {
        return `${where}.cycleCount must be a positive integer when present`;
      }
    }
  }
  return null;
}

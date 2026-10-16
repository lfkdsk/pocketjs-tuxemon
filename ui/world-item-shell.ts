// Live-world bridge for Bag items. Item eligibility and effects stay in the
// pure battle/world-items reducer; this module supplies map-facing facts and
// applies the small set of typed directives that genuinely belong to the
// running RPG Kit session.

import { effectiveEventAppearance, eventKey } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";
import type { SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { GameEvent } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import type { GameViewSessionHost } from "../vendor/pocket-rpgkit/src/ui/demo-contract.ts";
import type {
  WorldItemContext,
  WorldItemDirective,
  WorldItemFishingConfig,
} from "../battle/world-items.ts";
import { featureText, type WorldItemMapData } from "./feature-modes-data.ts";
import type { Lang } from "./language.ts";

const DX = [0, -1, 0, 1] as const;
const DY = [1, 0, -1, 0] as const;
const FISHING_FIBER = "menu:item:fishing";

interface FacingEvent {
  event: GameEvent;
  id: string;
  labels: string[];
}

function facingCell(state: Readonly<SessionState>): { x: number; y: number } {
  return {
    x: state.move.tx + DX[state.move.facing]!,
    y: state.move.ty + DY[state.move.facing]!,
  };
}

function facingEvent(host: GameViewSessionHost, state: Readonly<SessionState>): FacingEvent | null {
  const cell = facingCell(state);
  const actor = Object.values(state.chars.chars).find((candidate) =>
    candidate.tx === cell.x && candidate.ty === cell.y
  );
  if (!actor) return null;
  const event = host.session.maps.get(state.mapId)?.events?.find((candidate) => candidate.id === actor.id);
  const page = event?.pages[actor.pageIndex];
  if (!event || !page) return null;
  const appearance = effectiveEventAppearance(
    { pageIndex: actor.pageIndex, sprite: page.sprite ?? null },
    state.interp.eventAppearances?.[eventKey(state.mapId, event.id)],
  );
  const labels = new Set<string>([event.id]);
  if (event.name) labels.add(event.name);
  if (appearance.sprite) {
    labels.add(appearance.sprite);
    labels.add(appearance.sprite.split(/[./]/).at(-1) ?? appearance.sprite);
  }
  if (event.id.startsWith("npc_")) labels.add(event.id.slice(4));
  return { event, id: event.id, labels: [...labels] };
}

function fishingRules(
  data: Readonly<WorldItemMapData>,
  lang: Lang,
): Record<string, WorldItemFishingConfig> {
  return Object.fromEntries(Object.entries(data.fishing).map(([slug, config]) => [slug, {
    ...config,
    failure: featureText(config.failure, lang),
  }]));
}

/** Derive field-item predicates from the exact active map/cell/event. */
export function liveWorldItemContext(
  host: GameViewSessionHost,
  data: Readonly<WorldItemMapData>,
  lang: Lang,
): WorldItemContext {
  const state = host.getState();
  const map = host.session.maps.get(state.mapId);
  const cell = facingCell(state);
  const index = map && cell.x >= 0 && cell.y >= 0 && cell.x < map.width && cell.y < map.height
    ? cell.y * map.width + cell.x
    : -1;
  const surfable = index >= 0 && (data.surfable[state.mapId]?.includes(index) ?? false);
  const faced = facingEvent(host, state);
  return {
    ...(surfable ? { facingTile: ["water", "surfable"] } : {}),
    ...(faced ? { facingSprite: faced.labels } : {}),
    faintPointCharacter: "player",
    fishing: fishingRules(data, lang),
  };
}

export interface WorldItemDirectiveApplication {
  applied: number;
  rejected: WorldItemDirective["type"][];
}

function eraseFacingEvent(
  host: GameViewSessionHost,
  state: SessionState,
  expected: string | null,
): SessionState | null {
  const faced = facingEvent(host, state);
  if (!faced || (expected && !faced.labels.includes(expected))) return null;
  const slug = faced.id.startsWith("npc_") ? faced.id.slice(4) : faced.id;
  const variables = {
    ...state.sw.variables,
    [`local.npc.${slug}`]: 0,
    [`v.${slug}`]: 1,
  };
  const sw = { ...state.sw, variables };
  return {
    ...state,
    sw,
    interp: {
      ...state.interp,
      sw,
      erased: { ...state.interp.erased, [eventKey(state.mapId, faced.id)]: true },
    },
  };
}

function queueFishingBattle(
  state: SessionState,
  directive: Extract<WorldItemDirective, { type: "fishing" }>,
): SessionState | null {
  if (state.scene !== null || state.interp.main !== null) return null;
  const setup = {
    kind: "wild",
    species: directive.species,
    level: directive.level,
    experienceModifier: directive.experienceModifier,
    moneyModifier: 0,
    environment: directive.environment,
    inside: false,
  } as const;
  const battleCommand = {
    op: "battle",
    setup,
    onWin: null,
    onLose: null,
    onEscape: null,
  } as const;
  const fiber = {
    key: FISHING_FIBER,
    pageIndex: -1,
    parallel: false,
    stack: [{ prog: [battleCommand], pc: 0, unit: true as const }],
    mode: "external" as const,
    since: state.interp.frame,
    erase: false,
  } as unknown as (typeof state.interp)["main"];
  return {
    ...state,
    interp: {
      ...state.interp,
      main: fiber,
      pendingBattles: [
        ...state.interp.pendingBattles,
        { fiber: FISHING_FIBER, setup },
      ],
    },
  };
}

/** Apply every directive in order and publish one atomic host replacement. */
export function applyWorldItemDirectives(
  host: GameViewSessionHost,
  directives: readonly WorldItemDirective[],
): WorldItemDirectiveApplication {
  let state = host.getState();
  let applied = 0;
  const rejected: WorldItemDirective["type"][] = [];
  for (const directive of directives) {
    let next: SessionState | null = null;
    if (directive.type === "teleport") {
      next = {
        ...state,
        interp: {
          ...state.interp,
          pendingTransfer: {
            fiber: "menu:item:teleport",
            map: directive.map,
            x: directive.x,
            y: directive.y,
            dir: "keep",
            fadeFrames: 0,
          },
        },
      };
    } else if (directive.type === "remove-facing-entity") {
      next = eraseFacingEvent(host, state, directive.facingSprite);
    } else {
      next = queueFishingBattle(state, directive);
    }
    if (next) {
      state = next;
      applied++;
    } else {
      rejected.push(directive.type);
    }
  }
  if (applied > 0) host.replaceState(state, host.heldButtons());
  return { applied, rejected };
}

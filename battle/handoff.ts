import type { HandoffCapabilityResolver } from "../vendor/pocket-rpgkit/src/engine/session.ts";

/** Trusted WorldOpening capability used by generated water-edge lanes. The
 * upstream swimming enum is imported as `v.swimming`: 2 means the player is
 * currently surfing, while 1 (and an absent value) keeps solid water
 * blocking. Pure session state makes live play, tapes and rewind agree. */
export const TUXEMON_HANDOFF_CAPABILITY: HandoffCapabilityResolver = (capability, state) =>
  capability === "surf" && state.sw.variables["v.swimming"] === 2;

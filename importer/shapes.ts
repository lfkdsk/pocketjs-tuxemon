// Classify a Tuxemon event by guard shape so the importer can select the
// corresponding Pocket RPG Kit trigger.

import { loadAllFileEvents, type TuxEvent } from "./source.ts";

/** Trigger class of one event, from its conditions + behaviours. */
export function triggerClass(ev: TuxEvent): string {
  const has = (op: string, type: string, pred?: (a: string[]) => boolean) =>
    ev.conds.some((c) => c.op === op && c.type === type && (!pred || pred(c.args)));
  const player = (a: string[]) => a[0] === "player";
  if (ev.behavs.some((b) => b.type === "talk")) return "talk";
  if (has("is", "button_pressed")) {
    if (has("is", "char_facing_tile", player)) return "action:facingTile";
    if (has("is", "char_at", player)) return "action:standingOn";
    if (has("is", "char_facing_char")) return "action:facingChar";
    return "action:other";
  }
  if (has("is", "char_at", player)) {
    if (has("is", "char_moved", player)) return "touch:step";
    if (has("is", "char_facing", player)) return "touch:facing";
    return "touch:on";
  }
  // `check_char_parameter player,moving,1` is a map-wide live guard, not a
  // spatial trigger. Keep it on an automatic page so the engine's native
  // playerMoving condition observes every committed interpolation tick.
  if (has("is", "check_char_parameter", (a) => a[0] === "player" && a[1] === "moving")) {
    return "guard";
  }
  if (has("is", "char_at")) return "npcAt";
  if (has("not", "char_exists") && ev.acts.some((a) => a.type === "create_npc")) return "spawn";
  if (has("is", "char_facing_tile", player)) return "facingTile:noButton";
  return "guard";
}

function norm(ev: TuxEvent): string {
  return ev.conds
    .map((c) => {
      const a = c.args.map((x, i) => (c.type === "variable_set" ? x.replace(/:.*/, ":V") : i === 0 ? x : "#"));
      if (c.type === "char_exists" || c.type === "char_defeated" || c.type === "battle_outcome") a[a.length - 1] = "X";
      return `${c.op} ${c.type}${c.args.length ? " " + (c.type === "char_facing" ? c.args.join(",") : a[0] === "player" ? "player" : "_") : ""}`;
    })
    .sort()
    .join(" & ");
}

if (import.meta.main) main();

function main(): void {
const events = loadAllFileEvents();
const byClass = new Map<string, TuxEvent[]>();
for (const ev of events) {
  const k = triggerClass(ev);
  (byClass.get(k) ?? byClass.set(k, []).get(k)!).push(ev);
}
const classes = [...byClass.entries()]
  .sort((a, b) => b[1].length - a[1].length)
  .map(([k, evs]) => {
    const shapes = new Map<string, number>();
    for (const ev of evs) shapes.set(norm(ev), (shapes.get(norm(ev)) ?? 0) + 1);
    const area = evs.filter((e) => e.w * e.h > 1);
    return {
      class: k,
      events: evs.length,
      multiCellArea: area.length,
      cellsInAreas: area.reduce((n, e) => n + e.w * e.h, 0),
      topShapes: [...shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
      example: evs[0] && `${evs[0].source} "${evs[0].name}"`,
    };
  });
console.log(JSON.stringify({ events: events.length, classes }, null, 1));
}

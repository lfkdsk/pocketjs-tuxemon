// R2 positive fixture: a materializable `update_time player` event in an
// ISOLATED source tree, run through the real buildProject/convertActions.
//
// The real source's two map-bound `update_time player` events sit behind a
// folded `current_state TeleporterState` guard and are lowered to destination
// entry hooks; the third now runs in the validated out-of-map title Battle
// mode. This isolated fixture continues to pin the ordinary imported
// tux.update_time ext command shape.
//
// The importer reads TUXEMON_SRC at module load (importer/source.ts), so the
// fixture build runs in a subprocess with its own TUXEMON_SRC. bun test shares
// process.env across the files in this process, so mutating it here (even with
// a synchronous restore) leaks into sibling files that read TUXEMON_SRC lazily
// (importer/terrain.ts). The child gets an isolated env; the parent's
// process.env is never touched.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Command, Project } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import type { CoverageReport } from "../importer/coverage.ts";

const FIXTURE_SRC = resolve(import.meta.dir, "fixtures/time-weather-source");

const proc = Bun.spawn({
  cmd: ["bun", "run", resolve(import.meta.dir, "fixtures/build-fixture-project.ts")],
  env: { ...process.env, TUXEMON_SRC: FIXTURE_SRC },
  stdout: "pipe",
  stderr: "pipe",
});
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
  proc.exited,
]);
if (exitCode !== 0) {
  throw new Error(`fixture project build failed (exit ${exitCode}):\n${stderr}`);
}
const { project, coverage } = JSON.parse(stdout) as {
  project: Project;
  coverage: CoverageReport;
};

type ExtCommand = Extract<Command, { op: "ext" }>;

/** Every ext command in a page's command tree (if/choices/battle nested). */
function collectExtCommands(commands: readonly Command[], out: ExtCommand[]): void {
  for (const command of commands) {
    if (command.op === "ext") out.push(command);
    else if (command.op === "if") {
      collectExtCommands(command.then, out);
      collectExtCommands(command.else ?? [], out);
    } else if (command.op === "choices") {
      for (const option of command.options) collectExtCommands(option.commands, out);
      collectExtCommands(command.cancel?.commands ?? [], out);
    } else if (command.op === "battle") {
      collectExtCommands(command.onWin ?? [], out);
      collectExtCommands(command.onLose ?? [], out);
      collectExtCommands(command.onEscape ?? [], out);
    }
  }
}

function projectExtCommands(project: Project, call: string): ExtCommand[] {
  const out: ExtCommand[] = [];
  for (const map of project.maps) {
    for (const event of map.events ?? []) {
      for (const page of event.pages) collectExtCommands(page.commands, out);
    }
  }
  return out.filter((command) => command.call === call);
}

const rows = [
  ...coverage.actions.rows,
  ...coverage.conditions.rows,
];
const updateTimeRow = rows.find((candidate) => candidate.type === "update_time");

describe("R2: update_time imports through a materializable fixture event", () => {
  test("the fixture event becomes a tux.update_time ext command (full shape)", () => {
    const commands = projectExtCommands(project, "tux.update_time");
    expect(commands).toHaveLength(1);
    // Full command shape, not just a subset of args.
    expect(commands[0]).toEqual({
      op: "ext",
      call: "tux.update_time",
      args: { character: "player" },
    });
  });

  test("the fixture event materializes as an action-trigger page", () => {
    const pages = project.maps
      .flatMap((map) => map.events ?? [])
      .filter((event) => event.pages.some((page) =>
        page.commands.some((command) =>
          command.op === "ext" && command.call === "tux.update_time")))
      .flatMap((event) => event.pages);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.trigger).toBe("action");
  });

  test("update_time coverage is Native once the saved clock handler is present", () => {
    expect(updateTimeRow).toBeDefined();
    expect(updateTimeRow!.total).toBe(1);
    expect(updateTimeRow!.native).toBe(1);
    expect(updateTimeRow!.placeholder).toBe(0);
    expect(updateTimeRow!.dropped).toBe(0);
    expect(updateTimeRow!.reasons.native?.[0]).toContain("tux.update_time");
    expect(updateTimeRow!.reasons.native?.[0]).toContain("saved deterministic calendar");
  });
});

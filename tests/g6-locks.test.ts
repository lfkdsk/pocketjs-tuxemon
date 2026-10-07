import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { materializeShardedProject } from "../tools/generated-project.ts";
import { verifyProjectLocks } from "../tools/verify-g6-locks.ts";

const ROOT = resolve(import.meta.dir, "..");

test("every G6 lockInput page dynamically releases or transfers", () => {
  const project = materializeShardedProject(ROOT);
  const report = verifyProjectLocks(project);
  expect(report.format).toBe("pocket-tuxemon/g6-lock-check/v2");
  // D1 materializes the maple_bedroom "Stop 27Apr" date event (previously
  // dropped by the time_is date const-false fold), adding one lockInput page.
  // COV-B materializes the spyder_candy_town plague-confiscation event (its
  // is party_infected ...,all guard used to fold false), adding one more.
  // Surf's independently coalesced shoreline pages no longer split eight
  // existing locked source areas; every remaining lock still releases.
  // The cathedral "Heal Cannot Afford" event on the seven healing centers
  // (its money_is(variable) guard used to fold false) adds one lockInput
  // page per center.
  expect(report.lockCommands).toBe(343);
  expect(report.dynamicChecks).toBe(343);
  expect(report.pages).toBe(338);
  expect(report.outcomes).toMatchObject({ unresolved: 0, error: 0 });
  expect(report.failures).toEqual([]);
  expect(report.exceptions).toEqual([]);

  for (const [map, name] of [
    ["route1", "gym time"],
    ["taba_ba_br_3", "there he is"],
    ["taba_ba_main", "im here"],
    ["taba_ba_main", "time to face the master"],
    ["taba_ba_br_1", "get acolyte"],
  ] as const) {
    const row = report.rows.find((candidate) => candidate.map === map && candidate.name === name);
    expect(row, `${map}: ${name}`).toBeDefined();
    expect(row!.outcome, `${map}: ${name}`).toBe("unlocked");
    expect(row!.checks.every((check) => check.lockedAt >= 0 && check.resolvedAt >= check.lockedAt)).toBeTrue();
  }
}, 60_000);

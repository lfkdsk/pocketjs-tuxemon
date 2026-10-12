// Player preferences are installation state, not reducer state. Exercise the
// production project, extension codec, and save snapshot path so Options can
// never silently become part of a portable campaign save.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { createTuxemonExtensions } from "../battle/extension.ts";
import {
  createTuxemonSessionOptions,
  TUXEMON_BATTLE_DB,
  TUXEMON_CAMPAIGN_MONSTER_IDS,
} from "../battle/game.ts";
import {
  canonicalJson,
  createSessionSnapshot,
} from "../vendor/pocket-rpgkit/src/engine/save.ts";
import {
  createSession,
  startSession,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { readShardedProject } from "../tools/generated-project.ts";
import {
  createSettingsController,
  decodeSettings,
  type SettingsStore,
} from "../ui/settings.ts";

const ROOT = resolve(import.meta.dir, "..");

describe("Options save separation", () => {
  test("a production save is byte-identical after preferences change and has no settings fields", () => {
    const writes: string[] = [];
    const store: SettingsStore = {
      channel: "desktop",
      read: () => null,
      write: (text) => { writes.push(text); },
    };
    const settings = createSettingsController(store);
    const { project, repository } = readShardedProject(ROOT);
    const extensions = createTuxemonExtensions(TUXEMON_BATTLE_DB, {
      campaignMonsterIds: TUXEMON_CAMPAIGN_MONSTER_IDS,
      hemisphere: () => settings.get().hemisphere,
    });
    const session = createSession(project, 60, createTuxemonSessionOptions(
      project,
      project.worldTraversal ?? "legacy-transfer",
      { maps: repository, extensions },
    ));
    const state = startSession(project, session);
    const before = canonicalJson(createSessionSnapshot(session, state, 0));

    expect(settings.update((current) => ({
      ...current,
      musicMuted: true,
      musicVolume: 70,
      soundVolume: 90,
      units: "imperial",
      hemisphere: "southern",
      controls: { ...current.controls, primary: "back", back: "primary" },
    }))).toBe(true);
    expect(writes).toHaveLength(1);
    expect(decodeSettings(writes[0]!)).toEqual(settings.get());

    const after = canonicalJson(createSessionSnapshot(session, state, 0));
    expect(after).toBe(before);
    for (const field of [
      "controls",
      "musicMuted",
      "musicVolume",
      "soundVolume",
      "units",
      "hemisphere",
      "screenScale",
    ]) {
      expect(after).not.toContain(`\"${field}\"`);
    }
    repository.releaseExcept([]);
  });
});

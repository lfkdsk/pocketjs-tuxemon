// Replay the complete maintained campaign in the production German data.
//
// The source tapes were authored against English text. German pagination can
// need a different confirm edge, so transcribeTape keeps both reducers on the
// same 230,322-frame timeline while changing confirm only inside text boxes.
// It compares the complete language-neutral state after every closed box, at
// a fixed cadence, at each campaign boundary, and at the terminal frame.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createProductionTuxemonBattle } from "../battle/production.ts";
import { createTuxemonSessionOptions } from "../battle/game.ts";
import { createTuxemonTextTokens } from "../battle/text-tokens.ts";
import type { BattleNames } from "../battle/battle-names.ts";
import type { GameLang } from "../battle/extension.ts";
import type { BattleRuntimeShell } from "../importer/battle-schema.ts";
import { canonicalJson } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import {
  createSession,
  startSession,
  type Session,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { loadTape, ROOT } from "./bake-chapters.ts";
import { readShardedProject } from "./generated-project.ts";
import {
  neutralDigest,
  neutralSummary,
  productionPaginator,
  sha256,
  transcribeTape,
} from "./zh-tape.ts";

const TARGET_LANG = "de_DE" as const;

function expect(label: string, condition: boolean): asserts condition {
  if (!condition) throw new Error(`German mainline: ${label}`);
}

function suffix(lang: GameLang): string {
  return lang === "en_US" ? "" : `.${lang}`;
}

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(join(ROOT, relative), "utf8")) as T;
}

function productionSession(lang: GameLang, worldTraversal: ReturnType<typeof loadTape>["worldTraversal"]): {
  session: Session;
  state: SessionState;
} {
  const localized = readShardedProject(ROOT, lang);
  const langSuffix = suffix(lang);
  const battleShell = readJson<BattleRuntimeShell>(`dist/battle-runtime-shell${langSuffix}.json`);
  const battleNames = readJson<BattleNames>(`data/battle-names${langSuffix}.json`);
  const battle = createProductionTuxemonBattle(
    {
      read: (entry) => new Uint8Array(readFileSync(join(ROOT, "dist", entry))),
    },
    battleShell,
    { battleNames },
    lang,
  );
  const textTokens = createTuxemonTextTokens(lang, {
    mapDescriptions: readJson<Record<string, string>>(`dist/map-descriptions${langSuffix}.json`),
    monthNames: readJson<string[]>(`data/month-names${langSuffix}.json`),
    battleNames,
  });
  const session = createSession(localized.project, 60, createTuxemonSessionOptions(
    localized.project,
    worldTraversal,
    {
      maps: localized.repository,
      extensions: battle.extensions,
      battle: battle.rules,
      scenes: battle.scenes,
      textTokens,
      paginateText: productionPaginator(ROOT),
    },
  ));
  return { session, state: startSession(localized.project, session) };
}

const tape = loadTape();
const boundaries = [
  tape.gb6.frames,
  tape.j1.combinedFrames,
  tape.j2.combinedFrames,
  tape.j3.combinedFrames,
  tape.j4.combinedFrames,
];
const english = productionSession("en_US", tape.worldTraversal);
const german = productionSession(TARGET_LANG, tape.worldTraversal);
const started = performance.now();
const replay = transcribeTape({
  source: tape.combined,
  sourceSession: english.session,
  sourceStart: english.state,
  targetSession: german.session,
  targetStart: german.state,
  captureAt: boundaries,
});

const englishStateSha256 = createHash("sha256")
  .update(canonicalJson(replay.terminal.source))
  .digest("hex");
const germanStateSha256 = createHash("sha256")
  .update(canonicalJson(replay.terminal.target))
  .digest("hex");
const englishNeutralSha256 = neutralDigest(replay.terminal.source);
const germanNeutralSha256 = neutralDigest(replay.terminal.target);
const germanTapeSha256 = sha256(JSON.stringify(replay.masks));

expect("campaign frame count changed", tape.combined.length === 230322);
expect("English production replay changed the frozen terminal state",
  englishStateSha256 === tape.j4.terminalStateSha256);
expect("German terminal state differs from English beyond localized words",
  germanNeutralSha256 === englishNeutralSha256);
expect("German terminal map changed",
  replay.terminal.target.mapId === tape.j4.map);
expect("German terminal position changed",
  replay.terminal.target.move.tx === tape.j4.position[0]
    && replay.terminal.target.move.ty === tape.j4.position[1]);
expect("German replay did not retain the complete timeline",
  replay.terminal.target.frame === replay.terminal.source.frame);
expect("not every campaign boundary was compared", replay.captures.size === boundaries.length);

console.log("GERMAN MAINLINE PASS " + JSON.stringify({
  lang: TARGET_LANG,
  frames: tape.combined.length,
  endpoint: `${replay.terminal.target.mapId}@${replay.terminal.target.move.tx},${replay.terminal.target.move.ty}`,
  englishStateSha256,
  germanStateSha256,
  neutralStateSha256: germanNeutralSha256,
  germanTapeSha256,
  edits: replay.edits.length,
  dialogs: replay.stats,
  terminal: neutralSummary(replay.terminal.target),
  elapsedMs: Number((performance.now() - started).toFixed(1)),
}));

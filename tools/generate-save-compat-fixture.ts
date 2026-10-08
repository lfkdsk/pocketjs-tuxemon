// Generate a byte-exact browser save fixture from the checkout that runs this
// tool. Run it only after `bun run import`; source revisions and content
// identities are discovered from that checkout rather than supplied by hand.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { FIXED_INITIAL_CIVIL_TIME } from "../battle/time-weather.ts";
import { canonicalJson } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import {
  startSession,
  stepSession,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import {
  browserSaveStore,
  loadSlot,
  saveBlockReason,
  saveSlot,
  takeSaveSnapshot,
  type SlotStore,
  type StorageLike,
} from "../ui/save-game.ts";
import {
  createGameSession,
  GB6_PATH,
  input,
  loadGb6Tape,
  ROOT,
} from "./save-resume.ts";

function usage(): never {
  throw new Error(
    "usage: TUXEMON_SRC=<checkout> bun tools/generate-save-compat-fixture.ts "
      + "<output-dir> [minimum-save-frame=20] [minimum-continuation-frames=240]",
  );
}

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function gitHead(path: string): string {
  return execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function memorySlots(): SlotStore {
  const values = new Map<string, string>();
  const storage: StorageLike = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
  return { channel: "browser", store: browserSaveStore(storage) };
}

const outputArg = process.argv[2];
if (!outputArg) usage();
const tuxemonSource = process.env.TUXEMON_SRC;
if (!tuxemonSource) throw new Error("TUXEMON_SRC must name the pinned Tuxemon checkout");
const minimumSaveFrame = positiveInteger(process.argv[3], 20, "minimum-save-frame");
const minimumContinuationFrames = positiveInteger(
  process.argv[4],
  240,
  "minimum-continuation-frames",
);

const tapeBytes = readFileSync(GB6_PATH);
const tape = loadGb6Tape();
const { project, session } = createGameSession(FIXED_INITIAL_CIVIL_TIME, tape.worldTraversal);
if (session.content === null) throw new Error("generated project has no content identity");

const slots = memorySlots();
let state: SessionState = startSession(project, session);
let previous = 0;
let saved: {
  frame: number;
  timelineFrame: number;
  held: number;
  map: string;
  position: [number, number];
  stateSha256: string;
  envelope: string;
} | null = null;
let continuation: {
  frame: number;
  map: string;
  position: [number, number];
  stateSha256: string;
} | null = null;

for (let index = 0; index < tape.masks.length; index++) {
  const mask = tape.masks[index]!;
  state = stepSession(session, state, input(mask, previous));
  previous = mask;
  const frame = index + 1;

  if (saved === null && frame >= minimumSaveFrame && saveBlockReason(state) === null) {
    const snapshot = takeSaveSnapshot(session, state, mask);
    saveSlot(slots, 1, snapshot, session.content);
    const envelope = slots.store.read(1);
    if (envelope === null) throw new Error("browser slot was not written");
    const decoded = loadSlot(slots, 1, session.content);
    if (canonicalJson(decoded) !== canonicalJson(snapshot)) {
      throw new Error("browser slot did not decode to its source snapshot");
    }
    saved = {
      frame,
      timelineFrame: state.frame,
      held: mask,
      map: state.mapId,
      position: [state.move.tx, state.move.ty],
      stateSha256: sha256(canonicalJson(state)),
      envelope,
    };
    continue;
  }

  if (
    saved !== null
    && frame >= saved.frame + minimumContinuationFrames
    && saveBlockReason(state) === null
  ) {
    continuation = {
      frame,
      map: state.mapId,
      position: [state.move.tx, state.move.ty],
      stateSha256: sha256(canonicalJson(state)),
    };
    break;
  }
}

if (saved === null) throw new Error("journey has no recoverable save frame after the requested minimum");
if (continuation === null) throw new Error("journey has no recoverable continuation frame after the requested span");

const output = resolve(outputArg);
mkdirSync(output, { recursive: true });
const metadata = {
  format: "pocket-tuxemon-save-compat/v1",
  source: {
    game: gitHead(ROOT),
    kit: gitHead(resolve(ROOT, "vendor/pocket-rpgkit")),
    pocketjs: gitHead(resolve(ROOT, "vendor/pocket-rpgkit/vendor/pocketjs")),
    tuxemon: gitHead(tuxemonSource),
  },
  content: {
    manifest: session.content.manifest,
    schema: session.content.schema,
  },
  tape: {
    path: "data/gb6-mainline-journey.json",
    sha256: sha256(tapeBytes),
  },
  save: {
    frame: saved.frame,
    timelineFrame: saved.timelineFrame,
    held: saved.held,
    map: saved.map,
    position: saved.position,
    stateSha256: saved.stateSha256,
    envelopeSha256: sha256(saved.envelope),
  },
  continuation: {
    frames: continuation.frame - saved.frame,
    targetFrame: continuation.frame,
    map: continuation.map,
    position: continuation.position,
    stateSha256: continuation.stateSha256,
  },
};

writeFileSync(resolve(output, "slot-1.json"), saved.envelope);
writeFileSync(resolve(output, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(JSON.stringify(metadata, null, 2));

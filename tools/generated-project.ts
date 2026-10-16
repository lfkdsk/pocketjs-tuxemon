// Node/Bun-side access to the generated inline parity oracle and the
// production ProjectShell + per-map files. Runtime hosts use the equivalent
// byte source in main.tsx (data.fs on desktop, pak elsewhere).

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  assertShellManifestFresh,
  createJsonMapRepository,
} from "../vendor/pocket-rpgkit/src/engine/map-repository.ts";
import type {
  MapRepository,
  Project,
  ProjectShell,
} from "../vendor/pocket-rpgkit/src/engine/types.ts";
import type { GameLang } from "../battle/extension.ts";

export interface GeneratedShardedProject {
  project: ProjectShell;
  repository: MapRepository;
}

export function readInlineProject(root: string): Project {
  return JSON.parse(readFileSync(join(resolve(root), "dist/project.json"), "utf8")) as Project;
}

export function readShardedProject(root: string, lang: GameLang = "en_US"): GeneratedShardedProject {
  const absolute = resolve(root);
  const suffix = lang === "en_US" ? "" : `.${lang}`;
  const project = JSON.parse(
    readFileSync(join(absolute, `dist/project-shell${suffix}.json`), "utf8"),
  ) as ProjectShell;
  // The runtime trusts the shell's declared mapManifestHash, so every
  // tool/test that feeds a disk-read shell to the runtime verifies the
  // declaration here instead of recomputing it per session.
  assertShellManifestFresh(project);
  const repository = createJsonMapRepository(project.mapIndex, {
    read: (entry) => new Uint8Array(readFileSync(join(absolute, "dist", entry))),
  });
  return { project, repository };
}

/** Rebuild an inline view by reading the generated shards. Corpus-wide static
 * verification uses this instead of bypassing the production artifacts. */
export function materializeShardedProject(root: string): Project {
  const { project, repository } = readShardedProject(root);
  const maps = project.mapIndex.map(({ id }) => repository.acquire(id));
  repository.releaseExcept([]);
  const {
    mapIndex: _mapIndex,
    mapManifestHash: _mapManifestHash,
    mapSchemaHash: _mapSchemaHash,
    ...globals
  } = project;
  return { ...globals, maps };
}

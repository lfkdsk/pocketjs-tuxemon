// Content-addressed, migratable retention for build artifacts. The source is
// copied once into a store named by its sha256; each retain site is a hardlink
// to that store entry (falling back to a relative symlink across filesystems).
// No absolute paths are retained, so the whole evidence tree can be moved or
// archived without breaking — the previous layout symlinked every segment's
// assets.pak at an absolute path inside the build worktree, which silently
// followed later rebuilds and made the retained evidence non-portable.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export interface RetainResult {
  sha256: string;
  bytes: number;
  /** The content-addressed store entry (a real file named by its hash). */
  stored: string;
}

/** Retain `source` at `linkPath` as a migratable, content-addressed artifact.
 *  The store entry `<storeDir>/<sha256><ext>` is a real copy of the source;
 *  `linkPath` is a hardlink to it (or a relative symlink when hardlinking is
 *  impossible, e.g. across filesystems). Whatever was at `linkPath` before
 *  (including an absolute symlink from an older tool version) is replaced. */
export function retainArtifact(source: string, linkPath: string, storeDir: string, ext = ""): RetainResult {
  const hash = sha256File(source);
  mkdirSync(storeDir, { recursive: true });
  const stored = join(storeDir, `${hash}${ext}`);
  if (!existsSync(stored)) copyFileSync(source, stored);
  mkdirSync(dirname(linkPath), { recursive: true });
  rmSync(linkPath, { force: true });
  try {
    linkSync(stored, linkPath);
  } catch {
    // Cross-filesystem (or a filesystem without hardlinks): a relative
    // symlink keeps the tree migratable as a unit.
    symlinkSync(relative(dirname(linkPath), stored), linkPath);
  }
  return { sha256: hash, bytes: statSync(stored).size, stored };
}

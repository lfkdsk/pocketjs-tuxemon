// Tests for the content-addressed, migratable artifact retention
// (tools/psp-retain.ts). The previous layout symlinked every segment's
// assets.pak at an absolute path inside the build worktree, which made the
// retained evidence non-portable and let it silently follow later rebuilds.
// The retain helper must instead keep a sha256-named store copy and a
// hardlink (or relative symlink) at the retain site, with no absolute path.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

import { retainArtifact, sha256File } from "../tools/psp-retain.ts";
import { ROOT } from "../tools/psp-segment.ts";

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

const TMP = join(ROOT, ".psp-test-tmp");
const dirs: string[] = [];
beforeAll(() => mkdirSync(TMP, { recursive: true }));
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  rmSync(TMP, { recursive: true, force: true });
});

function makeTree(): { root: string; source: string } {
  const root = mkdtempSync(join(TMP, "retain-"));
  dirs.push(root);
  const source = join(root, "source.pak");
  writeFileSync(source, new TextEncoder().encode("FAKE-ASSETS-PAK"));
  return { root, source };
}

describe("content-addressed artifact retention", () => {
  test("the store entry is a real file named by the source sha256", () => {
    const { root, source } = makeTree();
    const store = join(root, "assets");
    const link = join(root, "01-seg", "assets.pak");
    const r = retainArtifact(source, link, store, ".pak");
    expect(r.sha256).toBe(sha256File(source));
    expect(r.bytes).toBe(15);
    const stored = join(store, `${r.sha256}.pak`);
    expect(existsSync(stored)).toBe(true);
    expect(lstatSync(stored).isFile()).toBe(true);
    expect(sha256File(stored)).toBe(r.sha256);
  });

  test("the retain site is a hardlink or relative symlink, never an absolute one", () => {
    const { root, source } = makeTree();
    const link = join(root, "01-seg", "assets.pak");
    retainArtifact(source, link, join(root, "assets"), ".pak");
    const st = lstatSync(link);
    if (st.isSymbolicLink()) {
      const target = readlinkSync(link);
      expect(target.startsWith("/")).toBe(false);
    } else {
      expect(st.isFile()).toBe(true);
      expect(st.nlink).toBeGreaterThanOrEqual(2);
    }
    expect(sha256File(link)).toBe(sha256File(source));
  });

  test("the retained copy survives the source being removed or replaced", () => {
    const { root, source } = makeTree();
    const link = join(root, "01-seg", "assets.pak");
    const r = retainArtifact(source, link, join(root, "assets"), ".pak");
    // A later rebuild replaces the source in place; the retained evidence
    // must keep the original bytes (this is the bug the absolute symlink had).
    writeFileSync(source, new TextEncoder().encode("DIFFERENT-BUILD-PAK"));
    expect(sha256File(link)).toBe(r.sha256);
    rmSync(source);
    expect(sha256File(link)).toBe(r.sha256);
  });

  test("re-replacing an old absolute symlink leaves a migratable link", () => {
    const { root, source } = makeTree();
    const link = join(root, "01-seg", "assets.pak");
    // Simulate the pre-fix layout: an absolute symlink into a build tree.
    mkdirSync(dirname(link), { recursive: true });
    rmSync(link, { force: true });
    symlinkSync("/some/build/worktree/dist/psp/assets.pak", link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    const r = retainArtifact(source, link, join(root, "assets"), ".pak");
    expect(sha256File(link)).toBe(r.sha256);
    const st = lstatSync(link);
    if (st.isSymbolicLink()) {
      expect(readlinkSync(link).startsWith("/")).toBe(false);
    }
  });

  test("a second retain of the same content reuses the store entry", () => {
    const { root, source } = makeTree();
    const store = join(root, "assets");
    const a = join(root, "01-seg", "assets.pak");
    const b = join(root, "02-seg", "assets.pak");
    const ra = retainArtifact(source, a, store, ".pak");
    const rb = retainArtifact(source, b, store, ".pak");
    expect(ra.stored).toBe(rb.stored);
    expect(sha256File(a)).toBe(sha256File(b));
  });
});

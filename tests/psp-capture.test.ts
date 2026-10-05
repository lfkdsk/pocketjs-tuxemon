// Tests for the psp-capture verify gate's source-provenance checks
// (tools/psp-capture.ts): a receipt from a dirty worktree, a receipt whose
// commit drifted by artifact-affecting paths, or a receipt without a source
// commit must fail; a receipt at HEAD or drifted only by docs/reports/CI
// must pass. Pure function tests — no PPSSPP, no captures on disk.

import { describe, expect, test } from "bun:test";

import { isNonArtifactPath, sourceCleanlinessIssues } from "../tools/psp-capture.ts";

const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OLD = "fedcba9876543210fedcba9876543210fedcba9876";

function cleanSource(commit = HEAD) {
  return { commit, diffSha256: EMPTY, changedFiles: {} };
}

describe("psp-capture source cleanliness", () => {
  test("a receipt at HEAD with an empty diff passes", () => {
    expect(sourceCleanlinessIssues(cleanSource(), HEAD, [])).toEqual([]);
  });

  test("a receipt without a source commit fails", () => {
    expect(sourceCleanlinessIssues(undefined, HEAD, []).join(" ")).toMatch(/source commit/);
    expect(sourceCleanlinessIssues({}, HEAD, []).join(" ")).toMatch(/source commit/);
  });

  test("a receipt with a non-empty source diff fails (dirty worktree)", () => {
    // The fix-6 blocker: the 05/06 captures carried a non-empty diffSha256
    // (uncommitted tools/psp-segment.ts at capture time) and still passed.
    const dirty = {
      commit: HEAD,
      diffSha256: "67f87d1d58ee" + "ab".repeat(26),
      changedFiles: { "tools/psp-segment.ts": "cf2322e8893f" + "0".repeat(52) },
    };
    const issues = sourceCleanlinessIssues(dirty, HEAD, []);
    expect(issues.join(" ")).toMatch(/dirty worktree/);
  });

  test("a receipt with changed files but an empty diff fails", () => {
    // Untracked files show up in changedFiles but not in `git diff HEAD`;
    // the gate must still reject the dirty capture.
    const dirty = { commit: HEAD, diffSha256: EMPTY, changedFiles: { "tools/stray.ts": "deadbeef" } };
    expect(sourceCleanlinessIssues(dirty, HEAD, []).join(" ")).toMatch(/dirty worktree/);
  });

  test("a receipt whose commit drifted only by non-artifact paths passes", () => {
    const drift = ["docs/status.md", "findings/PSP-EMU.md", "reports/psp-mainline/metrics.json",
      "README.md", ".github/workflows/ci.yml", "LICENSE"];
    expect(sourceCleanlinessIssues(cleanSource(OLD), HEAD, drift)).toEqual([]);
  });

  test("a receipt whose commit drifted by artifact-affecting paths fails", () => {
    const drift = ["tools/psp-mainline.ts", "tests/psp-mainline.test.ts"];
    const issues = sourceCleanlinessIssues(cleanSource(OLD), HEAD, drift);
    expect(issues.join(" ")).toMatch(/artifact-affecting/);
    expect(issues.join(" ")).toMatch(/tools\/psp-mainline\.ts/);
  });

  test("a submodule pointer drift fails", () => {
    // A vendor pointer change is a gitlink path in git diff; it changes the
    // runtime the PRX was built against, so it is artifact-affecting.
    const issues = sourceCleanlinessIssues(cleanSource(OLD), HEAD, ["vendor/pocket-rpgkit"]);
    expect(issues.join(" ")).toMatch(/artifact-affecting/);
  });

  test("non-artifact path classification", () => {
    expect(isNonArtifactPath("docs/status.md")).toBe(true);
    expect(isNonArtifactPath("findings/PSP-EMU.md")).toBe(true);
    expect(isNonArtifactPath("reports/psp-mainline/metrics.json")).toBe(true);
    expect(isNonArtifactPath(".github/workflows/ci.yml")).toBe(true);
    expect(isNonArtifactPath("README.md")).toBe(true);
    expect(isNonArtifactPath("LICENSE")).toBe(true);
    expect(isNonArtifactPath("tools/psp.ts")).toBe(false);
    expect(isNonArtifactPath("ui/main.tsx")).toBe(false);
    expect(isNonArtifactPath("vendor/pocket-rpgkit")).toBe(false);
    // licenses/ (lowercase) is bundled into the PSP output, so it affects artifacts.
    expect(isNonArtifactPath("licenses/AUDIO-ATTRIBUTIONS.md")).toBe(false);
    expect(isNonArtifactPath("package.json")).toBe(false);
  });
});

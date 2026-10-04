// CJK subset coverage: the committed Noto Sans CJK subset and charset must
// cover every character the zh_CN build displays (dist/zh-text.txt, written
// by the importer, plus the zh shells bundled into the app). Runs the kit's
// offline --check.

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

// A CJK character (CJK unified ideographs, CJK punctuation, full-width forms).
const isCjk = (ch: string) => /[㐀-鿿豈-﫿　-〿＀-￯]/.test(ch);

/** Every CJK character in a UTF-8 text. */
function cjkChars(text: string): Set<string> {
  const out = new Set<string>();
  for (const ch of text) if (isCjk(ch)) out.add(ch);
  return out;
}

/** CJK characters in every game-source string literal (battle UI, save
 *  footer, etc.) — text the game draws itself, not via the catalog. */
function gameSourceCjk(): Set<string> {
  const out = new Set<string>();
  const scanFile = (path: string) => {
    const text = readFileSync(path, "utf8");
    for (const m of text.matchAll(/"([^"]*[㐀-鿿][^"]*)"/g)) {
      for (const ch of cjkChars(m[1]!)) out.add(ch);
    }
  };
  const scanDir = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) scanDir(p);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) scanFile(p);
    }
  };
  scanDir(join(ROOT, "ui"));
  scanDir(join(ROOT, "battle"));
  if (existsSync(join(ROOT, "main.tsx"))) scanFile(join(ROOT, "main.tsx"));
  return out;
}

describe.skipIf(!existsSync(join(ROOT, "dist/zh-text.txt")))("CJK font subset", () => {
  test("the committed subset covers every zh_CN character (--check)", () => {
    // The kit's check is offline: it reads fonts.json, the charset, the
    // subset otf and the license, and verifies the scan text is covered.
    let out = "";
    try {
      out = execFileSync(
        "bun",
        ["vendor/pocket-rpgkit/tools/cjk-font.ts", "--app=.", "--scan=dist/zh-text.txt", "--check"],
        { cwd: ROOT, encoding: "utf8" },
      );
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; status?: number };
      throw new Error(`cjk-font --check exited ${e.status}: ${e.stdout ?? ""} ${e.stderr ?? ""}`);
    }
    expect(out).toContain("covered");
  }, 30_000);

  // The {x:map_desc} resolver reads dist/map-descriptions.zh_CN.json and the
  // battle UI / {x:monster_0_name} token read data/battle-names.zh_CN.json;
  // both are bundled into the JS via ui/zh-data.ts, so the baker's module
  // scan never sees them. They must be in the charset explicitly.
  test("every runtime-displayed Chinese table is inside the charset", () => {
    const charset = new Set([...readFileSync(join(ROOT, "fonts/cjk-charset.txt"), "utf8")]);
    const tables: [string, string][] = [
      ["dist/map-descriptions.zh_CN.json", join(ROOT, "dist/map-descriptions.zh_CN.json")],
      ["data/battle-names.zh_CN.json", join(ROOT, "data/battle-names.zh_CN.json")],
    ];
    for (const [label, path] of tables) {
      if (!existsSync(path)) continue; // dist not cooked yet
      const missing = [...cjkChars(readFileSync(path, "utf8"))].filter((ch) => !charset.has(ch));
      expect({ label, missing }).toEqual({ label, missing: [] });
    }
  });

  test("every game-drawn Chinese string literal is inside the charset", () => {
    const charset = new Set([...readFileSync(join(ROOT, "fonts/cjk-charset.txt"), "utf8")]);
    const missing = [...gameSourceCjk()].filter((ch) => !charset.has(ch));
    expect(missing).toEqual([]);
  });
});

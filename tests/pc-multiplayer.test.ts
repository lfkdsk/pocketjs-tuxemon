import { afterEach, describe, expect, test } from "bun:test";

import {
  buildProject,
  G6_IMPORT_OPTIONS,
  setImportLang,
} from "../importer/project.ts";

function objectNodes(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const child of value) objectNodes(child, out);
  } else if (value !== null && typeof value === "object") {
    const node = value as Record<string, unknown>;
    out.push(node);
    for (const child of Object.values(node)) objectNodes(child, out);
  }
  return out;
}

function importedPcLabels(lang: "en_US" | "zh_CN"): Record<string, unknown> {
  setImportLang(lang);
  const result = buildProject(["spyder_bedroom"], G6_IMPORT_OPTIONS);
  const scene = objectNodes(result.project).find(
    (node) => node.op === "scene" && node.id === "tux.pc",
  );
  if (!scene) throw new Error(`${lang} spyder_bedroom did not import its access_pc scene`);
  const args = scene.args as Record<string, unknown>;
  return args.labels as Record<string, unknown>;
}

afterEach(() => setImportLang("en_US"));

describe("upstream PC Multiplayer placeholder", () => {
  test("real en_US and zh_CN PO text is carried by imported access_pc scenes", () => {
    expect(importedPcLabels("en_US")).toMatchObject({
      multiplayer: "Multiplayer",
      notImplemented: "This feature is not yet implemented.",
    });
    expect(importedPcLabels("zh_CN")).toMatchObject({
      multiplayer: "多人游戏",
      notImplemented: "该特性尚未实现。",
    });
  });

  test("all ten authored access_pc actions are Native in the production import", () => {
    const result = buildProject([
      "cotton_cathedral",
      "healing_center",
      "spyder_healing_center",
      "bedroom_test",
      "sphalian_center",
      "player_house_bedroom",
      "spyder_bedroom",
      "spyder_paper_rival_bedroom",
      "spyder_timber_cafe",
      "spyder_candy_cafe",
    ], G6_IMPORT_OPTIONS);
    expect(result.report.coverage.actions.rows.find((row) => row.type === "access_pc"))
      .toMatchObject({
        total: 10,
        native: 10,
        degraded: 0,
        placeholder: 0,
        dropped: 0,
      });
  });
});

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  importExpeditionShops,
  type ExpeditionShop,
} from "../importer/expedition-shops.ts";
import { TUXEMON_SRC } from "../importer/source.ts";

function shop(catalog: readonly ExpeditionShop[], slug: string): ExpeditionShop {
  const result = catalog.find((entry) => entry.slug === slug);
  if (!result) throw new Error(`missing imported economy '${slug}'`);
  return result;
}

function validEconomy(slug: string, items: unknown[] = []): Record<string, unknown> {
  return {
    slug,
    background: "gfx/ui/item/item_menu_bg.png",
    resale_multiplier: 0.5,
    items,
    monsters: [],
  };
}

function withEconomies(
  documents: Readonly<Record<string, unknown>>,
  check: (root: string) => void,
): void {
  const root = mkdtempSync(join(import.meta.dir, ".expedition-shops-"));
  const economyRoot = join(root, "mods/tuxemon/db/economy");
  mkdirSync(economyRoot, { recursive: true });
  try {
    for (const [file, document] of Object.entries(documents)) {
      writeFileSync(join(economyRoot, file), JSON.stringify(document));
    }
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("expedition economy importer", () => {
  test("projects real purchase, resale, stock, and daytime conditions", () => {
    const catalog = importExpeditionShops(TUXEMON_SRC);
    expect(catalog).toHaveLength(14);
    expect(catalog.reduce((count, entry) => count + entry.items.length, 0)).toBe(75);
    const cotton = shop(catalog, "spyder_cotton_scoop");
    expect(cotton.items.find((item) => item.slug === "potion")).toEqual({
      slug: "potion",
      price: 100,
      cost: 50,
    });
    expect(cotton.items.find((item) => item.slug === "tuxeball")).toEqual({
      slug: "tuxeball",
      price: 100,
      cost: 50,
    });

    const tech = shop(catalog, "spyder_cotton_tech");
    expect(tech.items.find((item) => item.slug === "tm_avalanche")).toEqual({
      slug: "tm_avalanche",
      price: 2_000,
      cost: 400,
      stock: 1,
    });

    const flower = shop(catalog, "spyder_flower_scoop");
    expect(flower.items.find((item) => item.slug === "tuxeball_diurnal")?.variables).toEqual([
      { key: "daytime", value: "true" },
    ]);
    expect(flower.items.find((item) => item.slug === "tuxeball_nocturnal")?.variables).toEqual([
      { key: "daytime", value: "false" },
    ]);
  });

  test("is canonically sorted, deterministic, and JSON round-trippable", () => {
    const first = importExpeditionShops(TUXEMON_SRC);
    const second = importExpeditionShops(TUXEMON_SRC);
    expect(second).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);

    const shopSlugs = first.map((entry) => entry.slug);
    expect(shopSlugs).toEqual([...shopSlugs].sort());
    for (const entry of first) {
      const itemSlugs = entry.items.map((item) => item.slug);
      expect(itemSlugs).toEqual([...itemSlugs].sort());
    }
  });

  test("strictly rejects invalid integers, fields, and duplicates", () => {
    const good = { slug: "potion", price: 100, cost: 50 };
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [validEconomy("fractional", [{ ...good, price: 1.5 }]), /price must be a non-negative safe integer/],
      [validEconomy("negative_stock", [{ ...good, inventory: -2 }]), /inventory must be a non-negative safe integer/],
      [validEconomy("unknown", [{ ...good, surprise: true }]), /surprise is not a supported field/],
      [validEconomy("duplicate_item", [good, good]), /repeats item slug 'potion'/],
      [validEconomy("duplicate_condition", [{
        ...good,
        variables: [{ key: "daytime", value: "true" }, { key: "daytime", value: "false" }],
      }]), /repeats condition 'daytime'/],
    ];
    for (const [document, error] of cases) {
      withEconomies({ "invalid.yaml": document }, (root) => {
        expect(() => importExpeditionShops(root)).toThrow(error);
      });
    }

    withEconomies({
      "first.yaml": validEconomy("same"),
      "second.yaml": validEconomy("same"),
    }, (root) => {
      expect(() => importExpeditionShops(root)).toThrow("duplicate economy slug 'same'");
    });
  });
});

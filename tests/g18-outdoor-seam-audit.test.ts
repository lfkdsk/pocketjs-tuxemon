import { describe, expect, test } from "bun:test";

import { buildOutdoorSeamAuditReport } from "../tools/audit-outdoor-seams.ts";

const report = buildOutdoorSeamAuditReport();
const legacyById = new Map(report.whollyLegacy.map((row) => [row.portalId, row] as const));

function legacy(portalId: string) {
  const row = legacyById.get(portalId);
  if (!row) throw new Error(`missing outdoor seam audit row ${portalId}`);
  return row;
}

describe("G18 outdoor seam audit", () => {
  test("builds the real project census and has no promote-now legacy row", () => {
    expect(report.counts).toMatchObject({
      outdoorToOutdoorPortalActions: 348,
      rawCoordinatePreservingPortalIds: 258,
      runtimeSeamlessPortalIds: 292,
      partialPortalIds: 34,
      partialSeamlessCells: 137,
      partialLegacyCells: 0,
      whollyLegacyPortalIds: 56,
      whollyLegacyByCategory: {
        "portal-only": 5,
        "linked-gap": 19,
        "rejected-contact": 4,
        "outdoor-nonseam-or-story": 28,
      },
    });

    const promoteNow = report.whollyLegacy.filter((row) => row.recommendation !== "keep-fade");
    expect(promoteNow).toEqual([]);
    expect(report.whollyLegacy.every((row) => row.assessment.startsWith("keep fade:"))).toBeTrue();
  });

  test("classifies interior rivergoto dispatch before linked-gap geometry", () => {
    const riverRows = report.whollyLegacy.filter((row) =>
      row.assessment.includes("interior river-captain destination dispatch")
    );
    expect(riverRows).toHaveLength(20);
    expect(new Set(riverRows.map((row) => row.category))).toEqual(
      new Set(["outdoor-nonseam-or-story"]),
    );

    // This source/target pair has a world-layout gap. If gap classification
    // runs before the event's rivergoto story fingerprint, this assertion is
    // the first one to fail.
    const spyderGapStory = legacy("spyder_flower_city:tmx:spyder_flower_city.tmx:461:a1");
    expect(spyderGapStory.category).toBe("outdoor-nonseam-or-story");
    expect(spyderGapStory.recommendation).toBe("keep-fade");
    expect(spyderGapStory.assessment).toContain("rivergoto:leather_town");

    // A physical, outward normal-world gap must not be swept into the story
    // group merely because Spyder's former gap rows moved there.
    const physicalGap = legacy("dryadsgrove:tmx:dryadsgrove.tmx:43:a0");
    expect(physicalGap.category).toBe("linked-gap");
    expect(physicalGap.assessment).toContain("40 tiles apart");
  });

  test("pins specific review reasons for every retained legacy family", () => {
    const inwardClassic = legacy("classic_route_2:tmx:classic_route_2.tmx:285:a0");
    expect(inwardClassic.category).toBe("portal-only");
    expect(inwardClassic.assessment).toContain("guards and faces right into Classic Route 2");
    expect(legacy("route1_sanglorian:tmx:route1_sanglorian.tmx:129:a0").assessment)
      .toContain("skips four solid preview rows");
    expect(legacy("routea:tmx:routea.tmx:45:a0").assessment)
      .toContain("both continuous edge cells are non-Surf collision");

    expect(legacy("dryadsgrove:tmx:dryadsgrove.tmx:45:a0").assessment)
      .toContain("meet only at one corner");
    expect(legacy("flower_city:tmx:flower_city.tmx:220:a0").assessment)
      .toContain("41-tile vertical gap");
    expect(legacy("flower_city:tmx:flower_city.tmx:222:a0").assessment)
      .toContain("rotating corner transfer");

    const previewOverlap = legacy("route1:tmx:route1.tmx:23:a0");
    expect(previewOverlap.category).toBe("rejected-contact");
    expect(previewOverlap.assessment).toContain("forbidden 16-column map overlap");
    expect(legacy("route1:tmx:route1.tmx:32:a0").assessment)
      .toContain("four-row virtual overlap");
    expect(legacy("timber_town:tmx:timber_town.tmx:202:a0").assessment)
      .toContain("perpendicular river bend");
    expect(legacy("flower_city:tmx:flower_city.tmx:203:a0").assessment)
      .toContain("object 201 at the true east-edge opening");

    const obsolete = [
      "the authored world placements have a gap",
      "needs a kit-level surface-aware proof",
      "no accepted adjacent world seam connects these endpoints",
    ];
    for (const { assessment } of report.whollyLegacy) {
      for (const text of obsolete) expect(assessment.includes(text)).toBeFalse();
    }
  });
});

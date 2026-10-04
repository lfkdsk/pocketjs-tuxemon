// Production-path tests for the {v:}/{x:} dialog tokens: each template kind
// opens from its REAL imported event on the REAL generated map, through the
// PRODUCTION bundle (dist/main — main.tsx's GameView mount with its
// textTokens prop) and the kit's expandTextTokens. The driver plants a save
// at the event's doorstep, loads it through the real save menu, and triggers
// the event with real button input; the expanded text is read back from the
// live session state. These tests go red if main.tsx's `textTokens={...}`
// wiring is removed or the resolver is replaced with an identity function
// (the tokens then render literally or as "???").
//
// Complements tests/text-tokens-production.test.ts, which exercises the same
// events one layer down (kit session + resolver, no bundle).
//
// Skips only when the production bundle has not been built (local dev); CI
// builds it before running tests.

import { describe, expect, test } from "bun:test";
import { bundleIsBuilt, driveDialog } from "../tools/dialog-token-drive.ts";
import { DIALOG_SHOTS } from "../tools/dialog-token-shots.ts";

const describeIfBuilt = bundleIsBuilt() ? describe : describe.skip;

describeIfBuilt("dialog tokens expand through the production GameView bundle", () => {
  for (const shot of DIALOG_SHOTS) {
    test(`${shot.slug} (${shot.lang}, ${shot.eventId})`, async () => {
      const { text } = await driveDialog(shot, { width: 480, height: 272 });
      // The token resolved to its real value.
      expect(text).toContain(shot.expect);
      // No unanswered token and no raw template syntax leaked to the screen.
      expect(text).not.toContain("???");
      expect(text).not.toContain("{x:");
      expect(text).not.toContain("{v:");
      expect(text).not.toContain("${{");
    });
  }
});

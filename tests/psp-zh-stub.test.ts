// The English-only PSP build swaps ui/zh-data.ts for tools/psp-stubs/
// zh-data.ts. It must neither advertise nor try to load Chinese startup
// documents, so a forced Chinese request still becomes an English boot.

import { expect, test } from "bun:test";
import { zhData } from "../tools/psp-stubs/zh-data.ts";

test("the PSP zh-data stub reports Chinese data unavailable", () => {
  expect(zhData.available).toBe(false);
  expect(zhData.current()).toBeNull();
  expect(zhData.load(() => { throw new Error("must not read"); })).toBeNull();
});

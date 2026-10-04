// The English-only PSP build swaps ui/zh-data.ts for tools/psp-stubs/
// zh-data.ts. Consumers read `zhData.<field>` while their modules load, so
// the stub must be an object (fields null), never null itself; main.tsx
// then boots in English because the zh_CN project is absent.

import { expect, test } from "bun:test";
import { zhData } from "../tools/psp-stubs/zh-data.ts";

test("the PSP zh-data stub is an object whose data fields are null", () => {
  expect(zhData).not.toBeNull();
  expect(typeof zhData).toBe("object");
  expect(zhData).toEqual({ project: null, battleShell: null, names: null, mapDescriptions: null, monthNames: null });
});

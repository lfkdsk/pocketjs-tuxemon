import { describe, expect, test } from "bun:test";
import { instrumentStartupModules } from "../tools/profile-startup-modules.ts";

describe("startup module profiler", () => {
  test("marks each readable Bun module and the end of the IIFE", () => {
    const input = `(() => {
  // src/first.ts
  const first = 1;
  // src/second.tsx
  globalThis.frame = () => first;
})();
`;
    const result = instrumentStartupModules(input);
    expect(result.modules).toEqual(["src/first.ts", "src/second.tsx"]);
    expect(result.source).toContain(
      '// src/first.ts\n  globalThis.__startupModuleEvalMark("src/first.ts");\n  const first = 1;',
    );
    expect(result.source).toContain(
      'globalThis.__startupModuleEvalMark("__end__");\n})();',
    );
  });

  test("rejects minified or repeatedly instrumented input", () => {
    expect(() => instrumentStartupModules("(()=>{globalThis.frame=()=>1})()"))
      .toThrow("no readable Bun module boundaries");
    expect(() =>
      instrumentStartupModules(`(() => {
  // src/main.ts
  globalThis.__startupModuleEvalMark("src/main.ts");
})();`),
    ).toThrow("already instrumented");
  });
});

# Arena server runtime

`index.mjs` is the committed, browser-targeted ARENA-1 server artifact. It is
the only file a Worker or Durable Object should load at runtime; TypeScript
consumers get its contract from `index.d.mts`.

Rebuild it from the repository root with:

```sh
bun tools/build-server-runtime.ts
```

The build bundles and minifies `battle/server-runtime.ts`, replacing only the
shared `battle/battle-names.ts` edge with the pure
`battle/server-battle-names.ts` implementation. The builder rejects UI,
assets, Node/Bun host modules, and unbundled imports. Do not edit `index.mjs`
by hand; its byte-for-byte rebuild and the alias boundary are tests.

The ordinary game entry graph is deliberately untouched. Server and shared
Arena implementations are exercised against the same deterministic action
tapes and per-window state hashes in `tests/server-runtime.test.ts`.

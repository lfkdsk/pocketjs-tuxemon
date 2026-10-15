# NET-TUX-LINK-D: Web Link Battle client

## Verdict

The Web-only client is implemented and passes its strict mock-service,
browser, mutation, portability, and repository gates. It is deliberately
reported as **BLOCKED**, rather than PASS, because the frozen service cannot
currently be exercised by an ordinary browser end to end:

1. it accepts an existing Wander ticket but exposes no side-effect-free public
   OAuth-token-to-ticket exchange;
2. its public responses do not implement browser CORS/preflight and its origin
   guard rejects an HTTP loopback `wrangler dev` request before origin matching;
3. Wire v1 reserves but does not advertise replay delivery, has no replay URL
   in `ended`, and the service has no public replay route.

The client does not work around these gaps by using Wander `/ws/v4`. That route
owns a live Wander world session and can evict another device, so using it as a
credential exchange would introduce an unrelated side effect.

## Delivered client

- `battle/tux-link-wire.ts` freezes the Wire v1 client surface: exact-key
  decoding, `wireV = 1`, Arena version matching, required capability-bit
  negotiation, a 1,024-byte outbound-frame bound, strict public observations,
  and sanitized presentation events. Unknown/private nested fields fail closed.
- `ui/tux-link/client.ts` implements bounded capability probing, idempotent
  create/join, fragment-safe invite redemption, WebSocket hello/submit, a local
  generation plus server `connectionEpoch`, reconnect backoff, stale-frame
  rejection, and one outstanding submit request per decision.
- `ui/tux-link/presentation.ts` derives the battle view only from the
  recipient's public observation. Sanitized presentation is an animation queue,
  never an interactive-state projection.
- `ui/tux-link/auth-store.ts` reuses the persisted Wander ticket key, removes
  malformed tickets, consumes page OAuth envelopes at most once without
  persisting the OAuth token, and hands invite/login/logout state across the
  page boundary. Until the service adds a safe exchange endpoint, a user with
  no existing ticket stays on the bilingual sign-in-needed state.
- `ui/tux-link/title-battle-web.tsx` intercepts the existing **Battle / 对战**
  row only after a successful capability probe. Web then shows nested **Local
  Battle / 本地对战** and **Link Battle / 联机对战** choices; the title root keeps
  its existing row count. All game input is read from the component library's
  BTN mask, so keyboard, touch, and browser gamepad share the same path.
- The result page shows the authoritative winner/reason and a bilingual
  replay-unavailable message. It does not synthesize a replay URL that Wire v1
  never supplied.
- `tools/tux-link-config.ts` accepts `--tux-battle-url` or
  `TUX_BATTLE_BASE_URL`, derives HTTP, WebSocket, and trusted replay bases,
  preserves path prefixes and explicit ports, rejects userinfo/query/fragment,
  accepts plain HTTP only for loopback, and requires paired optional GitHub page
  metadata. No deployment URL or credential is committed.
- `tools/tux-link-web-entry.ts` transforms exactly one portable title-overlay
  import into the Web composition and prepends the parsed config. `tools/web.ts`
  writes this temporary entry (and optional page config), builds, then removes
  both in `finally`.
- `pocket.web.json` uses the generated Web entry and requires `net.http` and
  `net.socket`. The unchanged `main.tsx` and `pocket.json` remain the desktop/PSP
  entry and network-free capability contract.
- `tools/verify-tux-link-web.ts` provides a schema-strict in-process Wire v1
  service and drives two isolated Chrome profiles through create, invite,
  admission, reconnect, four simultaneous decisions, and terminal result.

The status list marks this feature Partial and links to this report and browser
verifier.

## Frozen-service blockers

The frozen service source handles only capabilities, match creation, the battle
WebSocket, and internal routes. A create-route preflight is rejected before the
POST handler, unknown public paths fall through to 404, and public JSON replies
do not add access-control headers. Its `trustedRequest` also requires the
request URL itself to be HTTPS, which rejects the ordinary loopback HTTP URL
used by local Workers development.

A direct local probe of the frozen service produced:

```text
GET /tux/v1/capabilities
200 {"service":"tux-battle","enabled":true,"wireV":1,"arenaV":1,"caps":1,"requiredCaps":1}

OPTIONS /tux/v1/matches
405 {"ok":false,"reason":"method not allowed"}

POST /tux/v1/matches over loopback HTTP with the configured Origin
403 {"ok":false,"reason":"origin"}

GET /tux/v1/oauth-ticket
404 not found

GET /tux/v1/replays/example
404 not found
```

The protocol also marks `REPLAY_URL_V1` as reserved/not advertised and defines
`ended` with only `type`, `v`, `turnRevision`, `result`, and `observation`.
Consequently, a real two-browser match against the frozen local service and a
trusted result-page replay link cannot be claimed. A follow-up proposal has
already been filed for browser auth, CORS/local HTTPS, and replay delivery.

## Client acceptance

### Unit and protocol tests

`bun test tests/tux-link-*.test.ts`:

```text
33 pass
0 fail
180 expect() calls
Ran 33 tests across 5 files.
```

The focused suite covers:

- missing config and incompatible/disabled/old-wire/Arena-mismatch/missing-bit
  capability documents;
- strict frame keys, nested private-field rejection, action bounds, invite
  grammar, and UTF-8 frame size;
- existing-ticket reuse, malformed-ticket cleanup, single-consumption OAuth
  envelopes, page command ownership, and invite lifetime;
- request IDs, no credentials in URLs, duplicate-submit fencing, stale
  generations, connection epochs, and reconnect;
- byte-identical opponent-pending observations, separate sanitized resolution,
  duplicate species public refs, and no invented replay URL;
- distinct portable/Web manifests and exact generated-entry composition.

### Two-browser acceptance

The configured build used an HTTP loopback battle base plus non-secret example
OAuth page metadata. The strict mock verifier passed with:

```json
{
  "capabilities": 2,
  "creates": 1,
  "sockets": 3,
  "connectionEpochs": [2, 1],
  "submitsPerDecision": [1, 1, 1, 1],
  "keyboardCircleMask": 8192,
  "touchDownCircleMasks": [64, 8192],
  "gamepadDownCircleMasks": [64, 8192],
  "opponentPendingServerFrames": "1->1",
  "opponentPendingUnchanged": true,
  "duplicateSpeciesCreatorRefs": ["p_Asees_B0", "p_Asees_B1"],
  "joinerRef": "p_Bsees_A0"
}
```

This is two independent browser storage/profile contexts, not two tabs sharing
one storage namespace. It exercises desktop and phone viewports, keyboard,
CDP touch events, the Web player's synthetic physical-gamepad method, invite
sharing/redemption, a forced disconnect and reconnect, pending secrecy, public
identity across a duplicate-species swap, terminal rendering, and return to
the Battle mode menu.

The verifier also proved that a no-config Web build keeps Link unavailable. An
initial verifier invocation against that intentional no-config build timed out
waiting for capability availability; rebuilding with the explicit loopback
configuration made the same verifier pass.

### Visual acceptance

All four committed captures were opened at 3× and inspected for cropping,
overlap, focus state, readable bilingual text, distinct party/public identities,
and terminal layout. They use the actual browser framebuffer rather than a
component-only renderer.

| Frame | Size | SHA-256 |
| --- | ---: | --- |
| English decision | 960×544 | `f99543f908dacbe21253df0cc6e1ee7af1e8eb7116d68f8688ee3397cdf8abe0` |
| Chinese decision | 480×272 | `4b6a8d3573acd462a4ea9956c90bc91f44b89177226b39d3abf943174b97f973` |
| English result | 960×544 | `14303cc84d7e256a0587ae3737a60340dd7de359fbd44331ea5fa11417a29e0c` |
| Chinese result | 480×272 | `9c457d69f904541e43100d6e488fc4f125340c3b8c9edc07276fd40707fe60cc` |

Semantic pixel checks found 105 sampled framebuffer colors and pinned the
selected action to RGBA `[20,80,100,255]`, the unselected action to
`[10,38,51,255]`, the panel to `[33,42,45,255]`, and the backdrop to
`[17,34,37,255]`.

## Mutation strength

Each mutation was made only in its own isolated worktree. All four required
mutations turned a green assertion red:

| Mutation | Red evidence |
| --- | --- |
| Missing config still exposes a fallback service | Build-isolation test expected `__pocketTuxLinkBuildConfig = null` and received the injected fallback URL. |
| Pending frame leaks the opponent action | Browser verifier failed: `opponent-pending action changed the other browser's public frame`. |
| Double click sends a second submit | Client test expected the second `submitSelected()` result to be `false` and received `true`. |
| Portable entry imports Link UI | Build-isolation test failed: `expected exactly one title overlay import in main.tsx`. |

No mutation was made in the delivery worktree.

## Build isolation and size receipt

The portable source entry and manifest have no diff from the base revision.
The portable manifest requires only `text.glyphs.baked` and `input.buttons`;
the Web manifest additionally requires `net.http` and `net.socket`. A binary
scan of the rebuilt desktop/PSP payloads found none of `Link Battle`, `联机对战`,
`__pocketTuxLink`, or `/tux/v1/`.

Nine executable/data payloads compare byte-for-byte with the captured base:

| Artifact | SHA-256 |
| --- | --- |
| desktop `main.js` | `9e9ecd2d3f1c492df86295f0e9af9d3fbee61361b628821030c85b0cab4f1e06` |
| desktop `main.pak` | `a01077d863aeead8cca34586ab56f5d8480dd5a0598ac87147e6605cb9280b5a` |
| PSP `AUDIO-ATTRIBUTIONS.md` | `95476b249ba871d77dd16a69a717539ae0a59494d6cdc5bd1b1cf197fd1f49b7` |
| PSP `EBOOT.PBP` | `fd61dd72f3f19cbe269ff2018553ee5ad238ed6d42d07ee512f064c728698d89` |
| PSP `assets.pak` | `a593e31889354a1ad63fd3c541401b3e1f3328bd0936c134e1cf72d30925b9ed` |
| PSP `pocket-tuxemon.js` | `306d9cf68cdba6ab2452eeb3406f80c4405555d05d66d14d66c3d84a56f9f90b` |
| PSP `pocket-tuxemon.pak` | `600ffede6c36076596d25e71f02a64fed6d8ad2615ed68d3ed9896a7dee4b17d` |
| PSP `pocket-tuxemon.prx` | `5a3ab2d68b4748990bf3ba775b07ea9046608d29d3f8f7b008bd1a6b2f2608d9` |
| PSP `veil-logo.raw` | `5219ec9b8504bcc9c536e9c95d4ced3f7034bf2c913301fdb53227d609774280` |

The PSP `build-receipt.json` changes only its truthful `.source` provenance
from the base revision/dirty-file list to the committed client revision/clean
tree. Removing `.source` makes the receipts byte-identical, and every artifact
hash recorded inside remains identical.

Bundle accounting:

| Build | Discovered JS | Minified startup JS | Ordinary pak |
| --- | ---: | ---: | ---: |
| Portable | 2,870,646 B | 1,390,247 B | 81,689,584 B |
| Web, no service config | 2,979,729 B | 1,439,174 B | 97,049,200 B |
| Web, explicit service config | 2,979,872 B | 1,439,296 B | 97,049,200 B |

The full Web-only composition is +109,226 B discovered / +49,049 B minified
over portable JS. Embedding deployment-time service metadata adds only 143 B /
122 B over the no-config Web bundle and adds zero pak bytes. Both Web builds
keep the same 6,648,028-byte startup chunk set and 22,933,518 deferred bytes
across 352 chunks. Building the separate battle and expedition replay entries
left the ordinary game JS and pak byte-identical within each Web build.

## Repository and CI gates

Preparation and static gates:

- PSP snapshot preparation: 8 snapshots generated.
- Two direct imports: identical output and clean tracked tree.
- Two isolated imports: 5,077 files, 68,960,530 bytes, SHA-256
  `3c5a935486adb7a545c3bb2e8a0ef99cdaa15bd6d395f5bbe4b2cbdf1cd051ff`.
- `bunx tsc --noEmit`: exit 0.
- localization audit: 11/11 checks; CJK subset: all 2,644 fallback characters
  covered.
- ordinary build, Web build, WebAssembly build, PSP toolchain bootstrap, full
  PSP build, and CI's `build:psp --skip-assets`: exit 0.
- The exact five CI test partitions passed 55 + 12 + 361 + 749 + 764 = 1,941
  tests, 0 failures, 0 skips. A monolithic attempt exceeded the local command
  wrapper's five-minute ceiling; running CI's memory-bounded partitions produced
  complete summaries for every test file.
- `git diff --check`, public-hygiene scan, lockfile guard, and submodule status:
  clean; `bun.lock` is unchanged.

Every CI journey command passed:

| Gate | Result |
| --- | --- |
| GB6 | 116,107 frames; terminal `748f84174b32011c4419588650a41d6c57c31c79d3f9e772fcc72b25c3bf9b80` |
| J1 | 128,961 combined frames; terminal `c0b36ae2112df49774377c30e728d03a929fba771746bf54cb14e684742a8a87` |
| J2 | 193,755 combined frames; terminal `b40b13672d7fd34db52e7607ebcf600f5740fe54c2b0915c7ff60bdb392b763d` |
| J3 | 211,745 combined frames; terminal `49307027321e7f51ab1a8c81e48ca615cd70d636c289f4170e63fc408b1774bf` |
| J4 | 230,322 combined frames; terminal `1977c1b0f3bd1bba2c4e5ad82332599c4fc72f0acd84d9437868976fbfb5c736` |
| Golden synchronization | 11 checkpoints |
| Defeat/recovery | first and late loss paths passed |
| Input locks | 343/343 dynamic checks; 0 unresolved/errors |
| Freeze scan | 263 maps; 0 permanent locks/fibers/errors |
| Chapters | 20 chapters and thumbnails byte-identical |
| Chinese tape/demo | 230,322-frame tape and all 20 chapter jumps passed |
| English demo | 230,322-frame paginated tape and all suffixes passed |
| Save/resume | 5 save points, including noon transition, reached pinned terminals |
| Preview coverage | 21 states; 0 mainline event rejections |
| Built-world replay | 242 checkpoints across 230,322 frames |

Every local Web job command passed after the appropriate no-config or configured
build: opening journey, Chinese opening (13/13 assertions), demo controls,
Arena replay, expedition replay, keyboard/touch double battles, streamed audio,
chunk loading, and the Link verifier. The chunk gate covered instant and delayed
English/Chinese journeys, frame freezing during blocked loads, verified Cache
Storage, zero warm-cache chunk requests, and zero duplicate/failed requests.

## Scope left for the service/replay follow-up

- Add a public, rate-limited, side-effect-free OAuth-to-ticket exchange (or have
  the OAuth callback return the same opaque ticket format) without touching a
  Wander world socket.
- Add explicit browser CORS/preflight behavior and a supported local HTTPS or
  loopback development policy while keeping the exact production Origin check.
- Add the frozen replay capability/frame/route and trusted HTTPS URL delivery;
  then replace the current unavailable message with an actual safe link.
- Repeat the same two-browser full-match verifier against the real local gateway
  and Battle Worker. Until then, strict mock acceptance proves the client but
  cannot substitute for the required deployed-stack acceptance.

subagent 使用：4 个 / protocol、architecture、auth/test、browser/input；最近只复用了 2 个做只读交叉核对 / 节省了时间

BLOCKED

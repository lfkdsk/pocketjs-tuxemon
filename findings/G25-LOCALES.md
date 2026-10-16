# G25-LOCALES: German, French, Spanish, Italian and Portuguese

## Result

Pocket Tuxemon now imports and ships the upstream `de_DE`, `fr_FR`, `es_ES`,
`it_IT` and `pt_BR` catalogs beside English and Simplified Chinese. The five
catalogs are partial, so every missing, empty, fuzzy, placeholder-incompatible
or authored-newline-incompatible row visibly falls back to English. The
importer records the exact translated, rejected and fallback keys for each
locale instead of presenting partial catalogs as complete translations.

The languages are selectable from Options and at startup on Web and desktop;
PSP selects one locale while building its target-specific package. Web locale
payloads are partitioned so an English boot downloads none of the five new
catalogs and a localized boot downloads only the chosen locale bootstrap plus
map shards on demand.

Production captures cover title, first imported dialogue, battle commands,
Bag/item description and Options at 480x272 and 960x544 for every new locale.
All 50 image oracles passed, every rendered scalar was present in the final
font atlas, and item descriptions wrapped without dropping text. A German
replay completed the entire 230,322-frame campaign with the same
language-neutral terminal state as English.

## Upstream coverage audit

The audit follows the data this port actually consumes: dialogue and choices,
menus and system prompts, map and item copy, monster and technique names and
descriptions, and battle text. The importer touched 4,699 distinct keys. Of
those, 4,321 have an English source string and form the coverage denominator;
the remaining 378 source-less metadata keys are reported separately rather
than counted as translation failures.

`Valid` means a non-empty, non-fuzzy upstream row whose runtime placeholders
and authored newline shape match English. An unchanged-English row can still
be structurally valid, so its count is shown separately to make the audit
honest.

| Upstream locale | Valid | Exact coverage | Invalid | Fuzzy | Unchanged English |
| --- | ---: | ---: | ---: | ---: | ---: |
| cs_CZ | 391 | 9.05% | 1 | 0 | 241 |
| de_DE | 876 | 20.27% | 2 | 0 | 283 |
| eo | 301 | 6.97% | 1 | 1 | 229 |
| es_ES | 1,049 | 24.28% | 8 | 6 | 257 |
| es_MX | 788 | 18.24% | 2 | 9 | 248 |
| fi | 387 | 8.96% | 0 | 0 | 236 |
| fr_FR | 1,615 | 37.38% | 12 | 32 | 344 |
| it_IT | 1,062 | 24.58% | 4 | 0 | 295 |
| ja | 257 | 5.95% | 0 | 0 | 0 |
| nb_NO | 343 | 7.94% | 1 | 7 | 241 |
| pl | 555 | 12.84% | 3 | 60 | 251 |
| pt_BR | 872 | 20.18% | 2 | 0 | 263 |
| raw upstream zh_CN | 1,709 | 39.55% | 77 | 0 | 3 |

The product's reviewed and supplemented `zh_CN` merge remains complete at
4,321/4,321 used English-backed keys with zero fallback. It is distinct from
the raw upstream row in the table.

The five requested Latin locales were selected because they are the most
useful non-English set for players and each has meaningful authored dialogue,
monster and UI coverage. `es_ES` wins over the overlapping `es_MX` catalog on
both exact coverage and fewer fuzzy rows. Czech, Esperanto, Finnish,
Norwegian and Polish remain below 13% exact used-key coverage and would add
mostly English-facing choices. They remain import-audited but are not exposed
as product languages.

Japanese is not included in this release. Its exact coverage is 5.95%, with
only 32/1,626 authored dialogue keys, 0/393 monster descriptions and 1/113
feature/UI keys translated. Shipping it would therefore show an overwhelmingly
English game while also requiring Japanese-specific glyph forms, packaging
and line-breaking validation that the existing Simplified Chinese fallback
does not establish.

The player-facing distribution behind that decision is:

| Locale | Dialogues | Choices | Monster names | Monster descriptions | Feature/UI |
| --- | ---: | ---: | ---: | ---: | ---: |
| de_DE | 213/1,626 | 42/95 | 232/393 | 128/393 | 38/113 |
| fr_FR | 533/1,626 | 40/95 | 232/393 | 222/393 | 37/113 |
| es_ES | 394/1,626 | 37/95 | 227/393 | 63/393 | 35/113 |
| it_IT | 365/1,626 | 40/95 | 231/393 | 140/393 | 37/113 |
| pt_BR | 234/1,626 | 38/95 | 232/393 | 89/393 | 38/113 |
| ja | 32/1,626 | 26/95 | 231/393 | 0/393 | 1/113 |

## Import, validation and fallback

One deterministic import pass parses each selected PO catalog with the same
last-entry-wins rule, then emits locale-specific project, map, battle, name
and feature-mode data. The generated `dist/l10n-report.<locale>.json` files
list target, translated, fallback, invalid and fuzzy keys, plus missing-key
categories. Repeating the complete import in two isolated roots produced
5,077 files and 69,577,033 bytes in each root, with aggregate SHA-256
`bb6a32fdd5c16cdbe860fdeca0012539f0746935688fa74f240742bb43e218c3`.

| Shipped locale | Translated | English fallback | Invalid | Fuzzy |
| --- | ---: | ---: | ---: | ---: |
| de_DE | 876 | 3,445 | 2 | 0 |
| fr_FR | 1,615 | 2,706 | 12 | 32 |
| es_ES | 1,049 | 3,272 | 8 | 6 |
| it_IT | 1,062 | 3,259 | 4 | 0 |
| pt_BR | 872 | 3,449 | 2 | 0 |

Placeholder comparison preserves multiplicity, not just membership, and the
authored newline pattern must match English. Rejected rows remain in the
report and resolve through the same English fallback path as missing rows.
Tests exercise real rejected upstream entries, including `player_wallet`, so
fallback cannot silently stop being observable.

## Selection, detection and saves

The in-game Options panel exposes English, Simplified Chinese, German, French,
Spanish, Italian and Brazilian Portuguese. A saved Web or desktop preference
survives restart. Web startup resolves locale in this order: explicit build or
test override, `?lang=`, saved choice, browser preferences, then English.
Browser aliases such as `de-AT`, `fr-CA`, `es-MX`, `it-CH` and `pt-PT`
canonicalize to their supported product locale, while the page/storage code
for Brazilian Portuguese is schema-valid `pt-br` and the internal catalog id
remains `pt_BR`.

Desktop accepts `--lang en|zh|de|fr|es|it|pt-BR`. PSP accepts
`--lang=<en|zh|de|fr|es|it|pt-BR>` and keeps exactly one localized map and
battle bank. PSP has no mounted persistence channel, so locale is an explicit
build-time choice there rather than an in-game persisted setting.

Save payloads record all seven locales. An older save with no language field
keeps the historical English behavior; an explicit unknown language fails
closed instead of silently loading mixed-language content.

## Fonts, wrapping and visual acceptance

The selected locales use the project's OFL-licensed Inter regular and bold
faces. A generated `fonts/latin-charset.txt` inventory is built from the real
localized payloads and participates in atlas compilation. Static face checks
and the final runtime-atlas check cover every inventory scalar, including
accented upper/lowercase Latin, `ß` and `ẞ`. The existing Noto Sans CJK subset
was also refreshed from 2,644 to 2,645 characters after the Chinese text
inventory exposed U+5378; its license and provenance remain documented beside
the font.

Every locale rendered five real game surfaces at both target viewports. The
acceptance test compares exact PNG/RGBA oracles, requires semantic text rather
than inserted ellipses, measures Bag description lines against the real atlas
advance widths, checks meaningful panel palette regions, and verifies every
drawn scalar against the final regular atlas. Missing-glyph count was zero.

German contact sheets, viewed at 3x:

- [480x272: title, dialogue, battle, Bag and Options](G25-LOCALES-shots/locale-de_DE-480x272.3x.png)
- [960x544: title, dialogue, battle, Bag and Options](G25-LOCALES-shots/locale-de_DE-960x544.3x.png)

French contact sheets, viewed at 3x:

- [480x272: title, dialogue, battle, Bag and Options](G25-LOCALES-shots/locale-fr_FR-480x272.3x.png)
- [960x544: title, dialogue, battle, Bag and Options](G25-LOCALES-shots/locale-fr_FR-960x544.3x.png)

The contact sheets were inspected at full size: accented copy is legible,
long item descriptions wrap inside the detail panel, and no title, dialogue,
battle, Bag or Options label is clipped. English visible in the first dialogue
and battle commands is the expected observable fallback, not a missing locale
load.

## Complete German campaign

The German verifier transcribes only the confirm edges required by translated
dialogue pagination in memory; it does not edit the maintained source tape.
It then checks language-neutral reducer state at campaign boundaries and at
the endpoint.

| Measurement | Result |
| --- | --- |
| Frames | 230,322 |
| Endpoint | `spyder_datacenter@7,4` |
| Text boxes / choices | 657 / 62 |
| Language-neutral checks | 724 |
| Source tape edits | 0 |
| English state SHA-256 | `1977c1b0f3bd1bba2c4e5ad82332599c4fc72f0acd84d9437868976fbfb5c736` |
| German state SHA-256 | `a1d21ae0d74551709891c858ac127dbc473b770632ccbce3b97f1a93c1b41f17` |
| Shared language-neutral SHA-256 | `24b04b14722cf293f9e3d9f760238e3506bfadbc2029d848abeb60ccf34e2e04` |
| Derived German tape SHA-256 | `0c421cae53d0f78f3536e4194c55dfa48bf17a10db28c6b66ae13db5be77fcbb` |

The localized full replay therefore reaches the same map, position, party,
inventory, story state and campaign endpoint as English.

## Web package impact

The final source pak is 136,356,304 bytes. The ordinary page publishes a
6,586,991-byte gzip English startup pack and 2,124 deferred chunks totaling
29,315,968 compressed bytes. Only 284 shared chunks are marked for bounded
background fetching; locale map banks remain demand-loaded. The ordinary
game runtime JavaScript is 1,444,290 bytes and the shared player is 85,182
bytes.

| Essential startup component | Baseline | Seven-locale build | Delta |
| --- | ---: | ---: | ---: |
| Startup pak | 6,648,028 | 6,586,991 | -61,037 (-0.918%) |
| Game runtime JavaScript | 1,441,960 | 1,444,290 | +2,330 (+0.162%) |
| Shared player JavaScript | 84,991 | 85,182 | +191 (+0.225%) |
| **Combined** | **8,174,979** | **8,116,463** | **-58,516 (-0.716%)** |

An English boot has no locale bootstrap. A localized boot fetches only the
chosen bootstrap before demand-loading that locale's maps:

| Locale | Locale bootstrap | Effective boot bytes |
| --- | ---: | ---: |
| English | 0 | 6,586,991 |
| Simplified Chinese | 220,173 | 6,807,164 |
| German | 209,998 | 6,796,989 |
| French | 211,384 | 6,798,375 |
| Spanish | 208,194 | 6,795,185 |
| Italian | 208,806 | 6,795,797 |
| Brazilian Portuguese | 209,046 | 6,796,037 |

The production chunk verifier passed 11 assertions with immediate and
150 ms-delayed delivery. Delayed English requested 291 unique content files,
all required/background requests settled without duplicate or failed
requests, and a warm reload requested zero content files. This verifies the
locale partition without reinstating the old all-chunks-at-start behavior.

## PSP package and memory impact

Comparable packages were built from the same target configuration. The
German build keeps one locale rather than carrying every catalog.

| Build | External assets | Embedded pak | `app.pocket` |
| --- | ---: | ---: | ---: |
| Baseline English | 68,148,752 | 1,175,664 | 9,203,128 |
| Current English | 68,828,784 | 1,181,392 | 9,221,992 |
| Current German | 69,123,712 | 1,298,208 | 9,343,128 |

German versus current English adds 294,928 external bytes (+0.428%), 116,816
embedded-pak bytes (+9.888%) and 121,136 `app.pocket` bytes (+1.314%). The
combined startup sidecars (`embedded pak + app.pocket`) grow from 10,403,384
to 10,641,336 bytes: +237,952 bytes (+2.287%).

The same 3,000-frame emulator window measured:

| Build | Arena capacity/high-water | QuickJS peak | Failed requests |
| --- | ---: | ---: | ---: |
| Baseline English | 42,295,808 | 28,541,787 | 0 |
| Current English | 42,294,528 | 28,559,007 | 0 |
| Current German | 42,173,440 | 28,486,294 | 0 |

Current English is +17,220 QuickJS bytes (+0.060%) versus baseline; German is
-72,713 bytes (-0.255%) versus current English. All three runs reach an arena
tail-free value of zero after frame 3,000, including the unmodified baseline,
with no failed QuickJS request. This is a shared retained-host ceiling rather
than a locale-only regression, so comparisons stop at the common frame.

The final clean English release at the delivered revision contains 68,828,784
external bytes, a 1,181,392-byte embedded pak, a 9,167,048-byte `app.pocket`
and 1,392,339 bytes of minified runtime source.

## Mutation proofs

Both critical validators were exercised against isolated copies, never the
delivery tree:

- removing U+1E9E `ẞ` from the Latin font inventory failed both source-face
  and runtime-atlas coverage with `Inter-Regular.ttf missing: ẞ` and
  `slot 0 missing U+1e9e`;
- bypassing fallback for a real French placeholder mismatch made the locale
  validation fail on `player_wallet`.

The checks therefore detect both missing glyph coverage and an importer that
accepts runtime-unsafe translations.

## Verification

The PSP journey snapshots were regenerated before the acceptance run. Two
complete imports produced identical console output and left the repository
clean. The component Wasm, game bundle and TypeScript build passed. The six CI
test groups completed 2,007 tests with 0 failures and 0 skips, including the
browser-export visual group.

Every journey matrix command passed: GB6, J1 through J4, the complete German
campaign, golden synchronization, defeat/recovery, lock and frozen-map
checks, chapters, Chinese and English tape/demo checks, save/resume, neighbour
preview coverage and built-bundle replay. All Web CI journeys passed with
zero console or audio errors. `verify:web:chunks`, `verify:web:lang`, the
rebased `verify:web:link` gate and `verify:psp:save` passed; the save verifier
covered slot round-trip, legacy raw JSON, autosave restart and visible
read-only failure. The final default PSP release package also built
successfully from the pinned upstream source.

## Limits

The five new catalogs are deliberately reported as Partial: English fallback
is frequent at current upstream coverage. PSP locale choice is fixed per
package because that host exposes no persistent locale channel. Japanese and
the lower-coverage upstream locales remain audited but unshipped for the
coverage and font/layout reasons above.

Subagent use: 3 read-only agents audited locale coverage, font/visual behavior
and runtime integration; they shortened independent review, while the main
agent performed integration, isolated mutations, visual inspection, package
measurements and every acceptance gate.

## Fix 1: bounded CI memory and importer timing

### Locale visual memory

The locale visual suite does not launch Chrome. It memoizes ten captures
(five locales at two viewports), and each capture boots five independent
production worlds for title, dialogue, battle, Bag and Options. Those 50
boots each read and evaluate the 120,652,736-byte production pak and the
runtime bundle in a fresh Wasm world. The 50 retained RGBA frames themselves
total only 65,280,000 bytes (62.3 MiB); repeated pak, bundle and world
allocation is the dominant churn. The `no DevTools endpoint` and `Chrome
exited (code 3)` lines in the combined log came from deliberate fake-launcher
cases in `headless-chrome-cleanup.test.ts`, not leaked locale Chrome children.

All measurements below ran the real CI file selection in a user systemd
cgroup with `MemoryMax=14G`. Peak RSS includes descendants and was sampled
from `MemoryCurrent`, then checked against the completed unit's peak. Before
the final split, locale visuals passed alone, but both old rest ranges reached
the cap and were killed with exit 137 even after locale visuals were removed
from `rest (a-l)`:

| Before split | Result | Peak bytes | Peak GiB |
| --- | --- | ---: | ---: |
| Locale production visuals alone | 5 pass | 9,058,820,096 | 8.437 |
| Old rest (a-l), locale excluded | OOM, exit 137 | 15,032,291,328 | 14.000 |
| Old rest (m-z) | OOM, exit 137 | 15,032,385,536 | 14.000 |

CI now gives the 50-production-boot suite its own process and routes every
remaining test into five bounded alphabetical ranges. No visual code or
oracle changed: all 50 exact PNG/RGBA goldens and their semantic assertions
remain, and the locale leg completed 1,860 assertions. The final peaks were:

| Final CI partition | Test result | Peak bytes | Peak GiB |
| --- | --- | ---: | ---: |
| importer | 55 pass | 2,910,552,064 | 2.711 |
| replays | 12 pass | 1,575,534,592 | 1.467 |
| locks, battle data and terrain | 361 pass | 1,266,778,112 | 1.180 |
| browser UI visuals | 9 pass | 281,366,528 | 0.262 |
| locale production visuals | 5 pass | 9,026,781,184 | 8.407 |
| rest (a-d) | 395 pass | 9,105,199,104 | 8.480 |
| rest (e-l) | 361 pass | 11,471,609,856 | 10.684 |
| rest (m-r) | 250 pass | 3,166,556,160 | 2.949 |
| rest (s-t) | 365 pass | 8,586,899,456 | 7.997 |
| rest (u-z) | 193 pass | 6,806,446,080 | 6.339 |

The highest final partition is 10.684 GiB, leaving 3.316 GiB below the
enforced cap. A routing audit found 201 test files selected exactly once:
201 unique, zero duplicates, zero missing and zero extra. The workflow and CI
documentation both describe the ten legs and the rest-range exclusions.

### Eclipse Park import timing

The timeout was not caused by the new locale imports: the English
`buildProject` call does not build the five Latin locale banks. The failing
test instead performed a second 263-map import solely to repeat the
`park_experience` coverage assertion. The preceding four-Park-map test already
receives corpus-seeded coverage; an unselected or newly authored action is
reported as dropped, so its `total: 8, native: 8, degraded: 0, placeholder: 0,
dropped: 0` assertion is corpus-wide.

The redundant test took 1,936.60 ms locally and made one assertion; GitHub's
observed run took 5,599 ms and exceeded Bun's default 5-second timeout. The
coverage assertion now lives with the real four-map lowering checks, whose
complete body took 184.39 ms and made three assertions. No timeout was raised
and no assertion was relaxed.

### Fix verification

Two imports were byte-stable and left the repository clean. Wasm and game
builds, TypeScript, localization checks and CJK coverage passed. The ten
14 GiB test partitions completed 2,006 tests with zero failures and zero
skips. GB6, J1 through J4 and the German complete journey reached their pinned
terminal states; defeat/recovery, 20 chapter suffixes, five save/resume points
and the built game's 242 checkpoints also passed.

The deployable Web build passed Link/replay, immediate and delayed chunk
delivery, warm-cache, language switching and all 13 Chinese rendering checks.
The default PSP release built, and the real PPSSPP save matrix passed slot
round-trip, legacy raw JSON, autosave restart/continue and visible read-only
failure. No Chrome or PPSSPP process remained after the run. This CI-only fix
does not change a player feature, so the feature status table needs no update.

Subagent use: 2 read-only agents traced locale allocation and Chrome-log
provenance, and audited Eclipse import coverage semantics; parallel analysis
shortened diagnosis, while the main agent reproduced both failures, applied
the fixes and ran every acceptance gate.

PASS

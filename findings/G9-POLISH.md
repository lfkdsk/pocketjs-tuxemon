# G9-POLISH：天气层级、水路无缝、Zhu 可重复

## 结论

- 天气粒子现在是 `GameView` 的可选世界 overlay：世界与粒子先合成，随后才是昼夜 tint / flash、HUD、对话框和转场 fade。雨夜由真实昼夜 tint 同时覆盖地形和粒子，不再由粒子自己近似夜间透明度；未启用的项目不挂节点或 frame hook。
- 9 个水路出口的 62 条 lane 全部由导入器从固定地形和 `surfable` 标签自动证明并生成。只有 `v.swimming === 2` 时才能开始 8 拍原子跨图；未冲浪时仍按旧行为阻挡。能力只能来自可信 `WorldOpening`，只放宽目标格的 solid 位，不能绕过 source exit、target entry、event body、bounds、方向、拓扑或 portal provenance。
- Zhu 的精确上游 reset 页在三个原有 clear 后被一次性消费；同一地图会话可连续购买，真实存读档后还能继续购买，每次扣 50、只改一次口味并给出原有提示。
- schema 变更是附加的：当前 identity 为 `9435a3b7…`，直接前代 `138048a5…` 仍能打开、恢复和继续运行。当前 main 生成的真实浏览器 slot 在本构建加载、续跑 257 帧并以新 identity 重存。
- GB6、J1–J4 的 canonical 终态哈希与 main 完全一致，所以逐字段差异为 **0**；无需重录主线。
- 游戏仓本机 CI 的所有 job 命令、组件仓 typecheck/完整测试、两档截图、变异测试、严格零分配和 QuickJS 交错性能均通过。结论为 **PASS**。

## 基线与交付版本

- 游戏 main：`c38f8e725f410b85f7be16d7b748811de4aa0298`。
- 游戏实现与状态文档树：`cbfb861fe76911b9406e22ca0ec10aa665ffbbf8`（本报告是其后的文档提交）。
- 组件仓 main：`eecc637ec3c32497d4c0afe240a927fb572c66af`。
- 组件仓交付分支 `g9-polish`：`65280e9bd09647ec76d03ba660d08aafa20bc531`。
- PocketJS：`862040bd77edc49b1f815beff63952b6616a14c6`，无改动。
- Tuxemon：`9e6258ff726b786040a267e8bdbbf037b560285e`。
- 两仓提交作者均为 `lfkdsk <lfkdsk@gmail.com>`；本批提交消息已检查，无额外协作者尾注；未 push。

## 上游语义对照

### 天气与昼夜

上游 `mods/tuxemon/db/weather/weathers.yaml:22-79` 定义 10 种天气的 slug、温度、风力和空 modifier 列表，没有天气粒子绘制或其 UI 层级。上游共享 Spyder 事件用 `set_layer` 表达昼夜遮色（`mods/tuxemon/maps/spyder.yaml:84-92` 及 `:122-132`）。因此粒子 profile 本来就是本移植的表现策略；本次不改天气状态语义，只让粒子遵守“世界先被昼夜效果覆盖、UI 与 fade 最后覆盖”的自然合成关系。

### 冲浪

上游在 `mods/tuxemon/maps/spyder.yaml:2-9` 仅当 `swimming:yes` 时把 `surfable` moverate 改为 1，在 `:100-107` 离开冲浪时恢复为 0；四个方向的入水事件位于 `:133-175`，离水事件位于 `:177-184`，游泳外观和海洋环境位于 `:207-228`。动作实现只更新已经带该 surface label 的格（`tuxemon/event/actions/update_tile_properties.py:14-40`、`tuxemon/map/terrain.py:32-47`）。本移植的能力 gate 因而绑定已导入的实时游泳状态，而不是永久把水面改成可走。

### Zhu

上游 Zhu 冷/暖口味页分别执行 `change_taste` 并置 done（`mods/tuxemon/maps/spyder_dojo1.yaml:349-356`、`:391-398`）；Taste 页选择怪物和口味后扣 50（`:381-390`）；Reset 页在 `zhu_taste_done:null` 时清三个交易变量（`:373-380`）。`change_taste` 排除当前口味和 tasteless、按 rarity 取新口味、重算 stats 并显示旧/新口味（`tuxemon/event/actions/change_taste.py:75-121`）。实现保留这些可见行为，只补偿两个事件调度器 guard 取样时机的差异。

## 1. 天气粒子层级

### 实现

- 组件仓新增只读 `GameWorldOverlayProps` / `GameView.worldOverlay`（`vendor/pocket-rpgkit/src/ui/GameView.tsx:879-886`、`:953-958`）。实际 JSX 顺序是 world → overlay → screen tint/effects → HUD → dialog → fade（`:2208-2265`）。省略 prop 时只走一次挂载条件，不创建节点或 frame hook。
- 游戏把 `WeatherOverlay` 接到该 slot（`main.tsx:339-404`），删除粒子自己的夜间 alpha 缩放；粒子与地形一起接受真实 daylight tint。
- frame handler 继续复用固定节点池和稳定 buffer；`verify:weather-alloc` 的 steady 与真实 indoor→outdoor activation 两段都严格为 `57/57 diff=0`，字节差也是 0。

### 真实地图、截图与像素断言

`tools/render-weather-shots.ts:29-42` 从真实 G6 tape 的 bedroom / Paper Town checkpoint、Paper Town 对话帧和跨图 fade 帧取样；`:127-167` 为 480×272、960×544 生成日间、22:00 夜间、对话、5/9 fade 和全黑 fade。

- 两档 `rain-outdoor-night`、`rain-dialog`、`rain-transfer-fade`、`rain-transfer-black` 均以 3× nearest-neighbour 打开肉眼核对：夜雨仍可读但与地形同色调；雨不污染对话纸面；中间 fade 在雨上；全黑 fade 无漏粒子。
- `tests/weather-visual.test.ts:147-170` 证明昼夜 tint 覆盖粒子且雪/雾仍可读；`:173-208` 在两档视口证明对话内部 region diff 为 0、全黑 fade 的非黑像素为 0、中间 fade 下仍有雨。
- 最终聚焦测试命令输出：`bun test ...weather-visual...` 所在五文件批次为 `53 pass / 0 fail / 30199 assertions`。

### 变异辨识力

在隔离的组件仓 detached worktree 中故意把 `WorldOverlay` 从 screen effects 前挪到 `ScreenFadeLayer` 后，重建真实 `r2-ui` bundle。`bun test tests/r2-ui-sim.test.ts` 得到 `9 pass / 1 fail`；唯一失败为层级顺序断言，收到索引 `[137,40308,38387,38536,40233]`，overlay 确实晚于 tint/dialog/fade。临时副本随后删除。

## 2. 9 个水路出口无缝

### 组件能力与 fail-closed 边界

- `WorldOpening.movementCapability?: string` 是可选且可信的布局字段（`vendor/pocket-rpgkit/src/engine/types.ts:907-921`），不在可伪造的 transfer handoff 里。
- 新 schema `9435a3b7…` 的 changelog 明确为 additive；旧文档没有字段时继续走普通 target-solid 检查（`vendor/pocket-rpgkit/src/data/CHANGELOG.md:42`）。
- handoff 先验证 portal、地图、位置、方向和拓扑，再查 capability。capability 存在但 callback 缺失/false 时严格拒绝，不会回退普通 `canEnter`（`vendor/pocket-rpgkit/src/engine/session.ts:2641-2677`）。
- capability 通过后只用 `canEnterIgnoringTerrainSolid`；bounds、body 和 target entry mask 仍必须通过（`vendor/pocket-rpgkit/src/engine/passability.ts:289-303`），source exit 在 session 中独立检查。live、attract 和 refold 共用同一个 callback。
- 游戏 callback 只接受 `capability === "surf" && v.swimming === 2`（`battle/handoff.ts:3-8`）。

### 自动导入与 census

导入器先读取每格 `surfable` membership，再对 source/target 水格、切线连续性、source exit 与 target entry 做固定地形证明（`importer/project.ts:5664-5752`）。只有整段 opening 的每条 lane 都通过才生成 `movementCapability:"surf"`（`:5752-5802`），随后把 opening span 和各 cell transfer 改为连续落点（`:5817-5833`）。无地图 allowlist，也未手改导入产物。

| Source object | Target | lanes |
| --- | --- | ---: |
| `classic_route_3` #285 | `classic_route_4` | 8 |
| `classic_route_4` #285 | `classic_stormpeak_city` | 7 |
| `classic_route_4` #286 | `classic_route_3` | 8 |
| `classic_stormpeak_city` #290 | `classic_route_4` | 7 |
| `spyder_candy_town` #100 | `spyder_routec` | 8 |
| `spyder_paper_town` #217 | `spyder_routec` | 4 |
| `spyder_routec` #155 | `spyder_candy_town` | 8 |
| `spyder_routec` #156 | `spyder_paper_town` | 4 |
| `spyder_routec` #275 | `spyder_candy_port` | 8 |

合计 9 个 portal / 62 lanes。新审计为：348 户外 portal actions、258 原生 coordinate-preserving、292 runtime seamless portal IDs、34 partial promotions / 137 seamless lanes / 0 legacy lanes、56 wholly legacy（5 portal-only、33 linked-gap、4 rejected-contact、14 story/non-seam），见 `reports/outdoor-seam-audit.json:5-19`。

### 行为、截图与变异

- `tests/world-seam-promotions.test.ts:239-314` 逐条执行 62 lane：未冲浪连续 60 帧与 legacy canonical state 相同；冲浪中无 fade，handoff phase 精确为 0..7，连续落点正确，`leftMap` 存在。
- `:349-390` 从真实导入的 Route C → Candy Town 水路检查邻图 NPC preview，并在 commit 后钉住源图 NPC freeze。
- 横向截图是从 Candy Town 岸边用真实 Surfboard interaction 进入 Route C（`tools/world-seam-capture-plan.ts:34-46`），两档各 phase 0..7 + landing；manifest 钉住 `movementCapability=surf`、`swimming=2`、swimmer 外观、无 fade/scene、两图驻留。两张 contact sheet 以及 phase 0/3/7/landing 均以 3× 肉眼核对：水面连续、相机/玩家无跳变、邻图预览与 NPC 正常。
- `tests/world-seam-visual.test.ts:144-166` 证明世界 y 不跳、落在 `spyder_routec (0,14)`、所有帧保持 surf 状态，且 PNG/hash/视口/contact sheet 均一致。
- 隔离变异把 capability resolver 固定为 false 后运行水路真实地图测试，结果 `5 pass / 2 fail`；准确杀死“62 lane 原子跨越”和“preview / NPC freeze”两项。
- 最终聚焦批次里水路七项全部通过；组件合约聚焦批次总体 `88 pass / 0 fail / 1105 assertions`。

## 3. Zhu 口味服务可重复

### 实现

全局 parallel 调度、普通 null variable 语义都未改。导入器只识别精确 source 指纹：`spyder_dojo1.yaml`、`Talk Zhu Reset`、无 behavior、唯一 `zhu_taste_done:null` guard、三个动作逐字匹配（`importer/project.ts:4337-4360`）。在那三个原有 clear 后附加 `v.zhu_taste_done=0`，消费 reset guard（`:4667-4675`）。这保持上游同帧预取 hand-off，同时避免 reset 页每帧抢先清空下一次选择。

### 真实地图、存读档与变异

`tests/dojo-real-map.test.ts:209-258` 直接跑真实导入的 `spyder_dojo1`：

1. 首次 cold：Soft → Mild，1000 → 950；
2. 同会话再次购买：Mild → Bland，950 → 900；
3. 通过游戏真实 save code 保存并在新 session 恢复，再买：Bland → Dry，900 → 850；
4. 三次都重算 base stats，英文旧/新口味提示和三组菜单完全一致，最终 reset 变量已关闭。

同文件的中文 warm 测试继续证明名字与两种口味均为当前语言。聚焦文件为 `16 pass / 0 fail`；包含在最终 `53 pass / 0 fail` 批次中。

隔离变异删除附加 reset 后运行同一真实地图文件，得到 `15 pass / 1 fail`；唯一失败复现第二次交易没有后续选择，因此测试确实辨识本缺陷。

## 存档兼容与生成稳定性

- schema 只增加可选 opening 字段：`9435a3b7…`；`138048a5…` 位于兼容链首项，组件 schema 测试覆盖每代真实 fixture。
- 当前英文/中文 map manifest 分别为 `300693bb2544fd063701e53806673ffa07f4646ccf6ae5abba7d1e1d3117909c` 与 `e25a0297aa522258a2285e074199ec259c5eb8eccee4ab338f239ff290f04377`。
- `tests/fixtures/save-compat/main-c38f8e72/` 是在 main 隔离 checkout 中由真实浏览器 slot 生成：manifest `e097077e…`、schema `138048a5…`、frame 26、Paper Scoop (4,8)。交付构建原样恢复，续跑 257 帧到 frame 283 / 同一位置 / state `5c40d03f…`，随后只以当前 identity 重存；伪造或相邻混配 identity 仍拒绝。
- `tests/g-persist-import.test.ts` 最终三个持续 fixture 与所有拒绝边界共 `9 pass / 0 fail`（含在 53 项聚焦批次中）。
- `bun run import` 连跑两次，生成文件无 diff；`verify:g6:determinism`、coverage、l10n 和 CJK checks 均通过。`bun.lock` SHA-256 仍为 `8ccfa9937302846daca5f829c3ef706f1cfa7d3e521c2fad9076842f6ab306e2`。

## 主线终态

五段都在当前构建从 frame zero 重放；与 main 的 canonical 终态 SHA-256 完全相等，所以逐字段比较没有差异：

| Segment | terminal state |
| --- | --- |
| GB6 | `fa4a55f281b94f8c2eeb3f157d432c33746ef97cd7fa7463b4ca9edc4a7184a0` |
| J1 | `e3f4a709c341a7ec617ad12da78d179f99c5e5ca99ad31cb135ec2dbf333ac71` |
| J2 | `fd8b882da71fcd5c9202458037cc1e90e5886e185613d5d0d3573d6bffc9245f` |
| J3 | `590452dceb93dfe0a2a88016610e602a6bc6f5334da6fa7b35c550f1f1f2548d` |
| J4 | `3fedbe7d848623d3f80b687f087a30f0e647ff4aa064cf0986ede38629719232` |

两条 defeat/recovery tape 也通过。地图、章节、主线 tape 和 checkpoint 文件无需重录。

## QuickJS 性能

测量期间没有并行跑测试或子代理，所有样本绑定 CPU 7。代码树测完后只做了提交消息卫生重写和状态文档提交；运行时代码与最终交付相同。

### 游戏冷启动

规格里历史 cold-start tape 已不存在，且给出的 `a5e82cc…` 也不再匹配当前 main。用当前 main 和当前 harness 重建最小 startup tape，并先测得 main 与本分支相同状态 `8446fbfd8da7061c3b62e10f70fc0e87262d87466d1122c9c8ad0cb8edca6990`，再以该值交错测。顺序为 main → branch → branch → main，两档各两轮，共 16 个 fresh QuickJS 进程；全部 exit 0 且低于 250 ms。

| viewport | main samples ms | branch samples ms | median main | median branch | delta |
| --- | --- | --- | ---: | ---: | ---: |
| 480×272 | 223.301, 210.418, 209.855, 223.001 | 214.194, 224.629, 214.905, 224.423 | 216.709 | 219.664 | +1.36% |
| 960×544 | 223.950, 210.849, 209.093, 225.410 | 208.737, 209.907, 212.045, 223.891 | 217.399 | 210.976 | −2.95% |

### 组件未使用能力的帧成本

`tools/pr1-quickjs-bench.sh` 先跑三轮全场景 ABBA。末轮 main 槽结束时 load 升到 12.59，因此保留原始结果但把唯一越过 3% 的必测 idle 场景做低争用 focused 复测：复测前 CPU 7 五秒平均 93.32% idle，五轮、10 个相邻配对。

| prescribed unused-feature scenario | first broad pass | focused / final judgement |
| --- | ---: | ---: |
| `sunstoneIdle` | +3.46% | **−1.79% median**（mean +0.44%，min −6.71%，max +24.68%） |
| `sunstoneWalk` | +0.07% | 通过（≤3%，无需复测） |
| `streamedRoam`（wander auto） | +1.35% | 通过（≤3%，无需复测） |

补充场景首次结果：`sunstoneControlWalk +1.44%`、`battleScene +5.68%`；后者不属于“不使用新能力”的三项门槛，并与同轮末槽 contention 一起保留，不用来掩盖 idle 结果。focused 每轮配对差为 `[-0.41,-3.09] [-4.97,+1.03] [-1.50,-4.19] [-6.71,-2.08] [+24.68,+1.65]`，中位数抗住单个 +24.68% 离群。三项规定场景最终均 ≤3%。

bundle isolation 同步实测并钉住：Meadow `627259` B、Sunstone `1003435` B、WAV fixture `795667` B。

## 全门禁

### 游戏仓（逐个本机执行 CI job 命令）

| Job / command group | 结果 |
| --- | --- |
| import、`bunx tsc --noEmit`、`verify:g6:determinism`、l10n、CJK | PASS；两次导入稳定 |
| tests: importer | 53 pass / 0 fail |
| tests: replays | 12 pass / 0 fail |
| tests: locks / battle data / terrain | 22 pass / 0 fail |
| tests: rest a–l，单进程 | 592 pass / 0 fail |
| tests: rest m–z，单进程 | 548 pass / 0 fail |
| GB6、J1、J2、J3、J4 mainline | PASS；哈希见上 |
| golden sync、failure tapes、locks、frozen、chapters、zh tape/demo、en demo、save | 全部 PASS |
| `verify:preview:coverage` | 21 states，mainline 0 rejected |
| `verify:bootworld:replay` | 233 checkpoints / 206830 frames |
| `bun run web`、English web journey、zh opening、demo、三首音轨 | 全部 PASS，0 console errors |
| PSP snapshots / CI `build:psp --skip-assets` / 完整 `build:psp` | 8 snapshots；三项均 PASS |
| `verify:weather-alloc` | steady 57/57 diff=0；activation 57/57 diff=0 |

### 组件仓

- `bunx tsc --noEmit`：exit 0。
- 252 个测试文件按 a–f / g–l / m–r / s–z 单进程分组覆盖同一全集：`4118 pass / 0 fail`。一次单进程全量超过宿主命令 5 分钟上限，分组不是规避失败而是覆盖相同文件全集。
- 最终聚焦 `r2-ui-sim + seamless-handoff + schema-compat`：`88 pass / 0 fail / 1105 assertions`。
- schema canonical hash、compatible fixture、attract/refold capability、fail-closed blockers、bundle isolation 均包含在上述门禁。

## 提交

组件仓（按合入顺序）：

- `03646fdf feat(ui): add world overlay presentation slot`
- `57d95cba feat(engine): gate seamless openings by movement capability`
- `53027241 fix(engine): require opening movement capability`
- `3464ad19 test: remeasure world overlay bundle cost`
- `65280e9b docs: record additive opening schema compatibility`

游戏仓（按合入顺序）：

- `f234e9e7 feat(ui): composite weather beneath screen effects`
- `6d1e7f5f feat(importer): make Surf world exits seamless`
- `7acb1cdc test: capture seamless Surf crossing`
- `e37d1337 fix(importer): keep Zhu taste service repeatable`
- `af1f4938 build: refresh Zhu service import`
- `a8cf6c7a chore: update RPG Kit polish runtime`
- `af2d6847 test: refresh seamless warp spawn distribution`
- `ce86dddb test: continue the current main save on polished build`
- `cbfb861f docs: record polished weather and water behavior`

合入顺序：先合组件仓 5 个提交，再让游戏仓子模块指向 `65280e9b`，再合游戏仓提交。PocketJS 不需要变更。

subagent 使用：3 个 / weather 只读研究、surf 隔离变异、Zhu 隔离变异 / 明显省时

PASS

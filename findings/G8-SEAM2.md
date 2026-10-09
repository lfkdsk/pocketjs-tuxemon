# G8-SEAM2：剩余户外出入口的无缝衔接

## 结论

- **50 个 funnel lane 全部升级为无缝。** 25 个 fixed-destination 宽口（Classic 区 3 格宽的城镇/道路出口）上游把每条 lane 都汇到一个固定落点；两侧地图在 `.world` 里本来就边贴边、切线坐标连续，所以现在每条 lane 都直接落到自己旁边的邻图格子。75 条 lane 全部通过最终 cooked-terrain 通行证明，0 条留在淡入淡出。运行时无缝 portal ID 数仍是 283（这 25 个 ID 原来已部分无缝，现在完整无缝）。
- **其余 65 个 wholly-legacy portal 逐个复核，没有一个能在不移动地图、不改剧情语义的前提下做成无缝**，原因按类见下表；`reports/outdoor-seam-audit.json` 每条都有机器可读理由（新增"surf-only"判定）。
- 主线 tape 不经过任何被改的入口：GB6/J1–J4 终态哈希全部不变，无需重录。
- 地图内容变了，所以存档内容身份从 `ec6bf29b…` 变为 `6322d4d6…`。按既有做法加入审核过的兼容对，并提交当前 main（`bbeef6b4`）生成的真实存档；它在本分支上能加载、重存并沿主线 tape 继续。另用 main 构建在 Aerolume 西口边上存档，在本分支加载后走过原 funnel lane：8 拍无缝落到 (39,16)；同一存档在 main 上淡入淡出 10 帧落到固定点 (39,17)。
- 组件仓与 PocketJS 无改动（schema 不变 `5eecc57a…`）。

- 门禁全部通过（全量 `bun test` 在高负载下有 3 个超时，单独重跑全过）。QuickJS 冷启动与 world-cache 交错测没有可测回退。不过共享机上 world-cache 的 50 ms 单帧绝对门在 main 与本分支上都会间歇失败，详见"性能"。

## 基线

- 游戏 main：`bbeef6b4`；组件仓 `ae1e6a33`；PocketJS `862040bd`；Tuxemon `9e6258ff`。
- 审计单位与 G-SEAM 一致：source/target 都在户外布局里的 TMX `transition_teleport`，共 348 个 portal ID。

| Census | main | 本分支 |
| --- | ---: | ---: |
| 运行时无缝 portal IDs | 283 | 283 |
| fixed-destination 宽口里无缝的 lane | 25 | **75** |
| fixed-destination 宽口里仍淡入淡出的 funnel lane | 50 | **0** |
| wholly legacy portal IDs | 65 | 65 |

## 逐类评估

判定标准（几何上可以安全做成无缝）：两图在布局中共享正长度边；source lane 的切线坐标 + 布局偏移 = 目标落点；source 内侧能走到边格、边格不挡外出、目标边格可从反方向进入（运行时 `tryStartSeamlessHandoff` 用**不可变地形**证明，`vendor/pocket-rpgkit/src/engine/session.ts:2631-2639`）；事件没有剧情/选择/战斗语义。

### 1. funnel lane（50 条，25 个宽口）→ **全部升级**

数据：对 25 个宽口的每条 lane 计算连续目标格，检查 inner step / exit / enter 与 `transferCellIsWalkable`，75/75 全通过（脚本输出每条 lane 都是 `IXE`）。事件形状全部是 `is char_at` + `is char_facing <外向>` → `transition_teleport` + `char_face <外向>`，没有剧情。上游 funnel 只是"一个宽事件只能写一个落点"的限制：玩家淡出时被横向挪一格。直接落到邻格就是 `.world` 本身的几何。

实现（`importer/project.ts`）：
- `planPartialSeamPromotions`（:5168）逐 lane 证明，取一段连续 lane（开口 span 仍是单区间），连续 lane 段之外的 lane 保留原淡入淡出与固定落点。
- `laneCommands`（:3989）按 source 格改写该 portal 的顶层 transfer：证明过的 lane 落到连续邻格并保留 handoff 标记，其他 lane 去掉标记走旧时间线。
- areas 模式下，只属于这一页的宽矩形按格拆成 1×1 事件（:4551）：第一格保留原矩形 id `eNNN_rMMM`，其余格为 `eNNN_rMMM_dx_dy`，地图上别的区域事件**不重编号**。areas=false 时本来就一格一事件（:4287）。
- 规划提前到地图转换之前；转换后逐条核对每条计划 lane 确实按格发出，否则导入直接失败（:5601），不会静默降级。
- 运行时解析器仍要求落点等于连续格，任何偏差都会 fail closed 回到旧淡入淡出。

### 2. portal-only（14）→ 保留

| Portal | 理由 |
| --- | --- |
| `spyder_candy_town` #100、`spyder_routec` #155/#156/#275、`spyder_paper_town` #217 | 全部 lane 都是 Surf 水面（两侧 `surfable`）。lane 坐标本身连续，但运行时用不可变地形证明，水面在该次地图访问打开之前是实心，handoff 必然被拒（session.ts:2631-2639）。要做需要组件仓新增"surface-aware"跨越能力（附加 schema），已提 follow-up |
| `classic_route_4` #285、`classic_stormpeak_city` #290 | 同上，Route 4 整张图是水面，Classic 区没有游泳开关 |
| `classic_route_3` #285、`classic_route_4` #286 | 水面，而且目标在同侧边（`(20,0)`→north edge，疑似上游笔误），落点语义不是相邻对边 |
| `route1_sanglorian` #129/#130/#160 | 两图在布局上边贴边且 x 对齐，但 Route 1 第 0–3 行是整行实心（画着 Sanglorian 的预览，`route1.tmx` object 15），上游落点在第 4 行。直接跨会落在实心格；要无缝需要"虚拟邻接"（4 行重叠），属于布局改动 |
| `routea` #45 | 源格 (13,39) 与目标 (13,0) 都是碰撞格（已核对 passage proof），真正的 2 格通道 #44/#56 早已无缝；这是死重复 |
| `classic_route_2` #285 | 西边出口，但守卫和尾随 `char_face` 都是 `right`（朝回地图内）。上游向西走出边界不会触发它，只有站在边格原地转向右才触发（淡出到 Steamshore）。另外 7 个 Classic 西口都是 `left`，所以很可能是笔误；但 `right` 是合法取值，修成 `left` 会改掉上游可观察行为、新造一个上游没有的跨越，规则也只会命中这一个事件。与 Route 3 的非法值 `bottom` 修复不同，本批不做 |

额外核对：Steamshore 东口 #287 现在三条 lane 都无缝落到 Route 2 (0,2..4) 并朝右。实测不会被 #285 弹回：落地后空闲 200 帧不动；继续按右正常东行；回到边格朝左无事；只有在边格原地转右才淡出回 Steamshore (39,3)，与 main 的旧行为一致，也没有无限往返（脚本见"证据"）。

### 3. linked-gap（33）→ 保留

两图矩形之间没有共享边，实测都不是 1 格的笔误：
- normal 世界的 xero"河道"网络（19 个：dryadsgrove↔taba_town、dryadsgrove↔leather_town、leather_town↔flower_city、flower_city↔timber_town）：间距 40 行/列以上或只角接触，多数还要转 90°；源格是 `surfable=0` 水面（上游视为碰撞）；`leather_town` #105/#106 的目标 `flower_city (59,0)` 已越界。
- Spyder 渡船（14 个）：船长对话设置 `rivergoto`，再由地图级事件传送（`spyder_flower_city.tmx` object 441/461）。事件坐标只是占位，是剧情传送。

### 4. rejected-contact（4）→ 保留

`route1` #23/#25 ↔ `taba_town` #80/#81：两图东西相邻、行对齐，但触发格各在地图内 8 列处。两边各画了 8 列对方道路的预览并以墙收尾（`route1.tmx` object 12、`taba_town.tmx` object 105），落点差 16 列。直接跨会落进预览墙里；要无缝需要 16 列重叠的虚拟邻接。

### 5. non-seam / story（14）→ 保留

6 个 Spyder 渡船同图/跨图传送（剧情）；`route1` #32/#85/#86 → Sanglorian（同第 2 类的 4 行预览边）；`timber_town` #202/#204 ↔ `tunnel` #109/#111（水面河道，转 90°，真正的道路接缝 #172–175 ↔ #92–96 早已无缝）；`flower_city` #203（地图内部、面朝墙，#201 才是已无缝的真出口）。

### 6. direction-only（10）→ 不属于旧淡入淡出

TMX 里没有 portal。上游地图边界是硬墙（`tuxemon/map/transition.py`、`movement.py`），`edges` 属性只夹相机。不过 Eclipse 的 YAML 事件里有约 30 个 portal 与其中 6 条接缝、5 个 `unsupported-contact` 及 `spyder_candy_port↔spyder_diamond_hill` 精确对齐。导入器目前有意只用 TMX 事件做拓扑证据（`importer/world.ts`），超出本批类别，已提 follow-up。注意 lion_low↔park、park↔route7、park_south↔route7 不能开：会绕过付费 safari 入口。

## 测试与截图

- `tests/world-seam-promotions.test.ts`：Aerolume y=16/17/18 三条 lane 真实按左走 phase 0..7、无 fade、各落到 (39,y)、`leftMap` 冻结；Hearthrock 北口 x=32/34 竖向跨越；Route C 水面开口保持旧落点且没有 handoff 标记；areas=false 与 areas=true 都按格发出、落点逐格连续；原有存读档前后一致与邻图预览/NPC 冻结测试改为在 y=17 上继续跑。
- `tests/world-layout.test.ts`：所有 handoff 标记都是 1×1 lane 事件，并且能被运行时解析器接受；计数 75/0。
- 截图 `docs/screenshots/world-seam/`：横向样本改为原 funnel lane `classic_aerolume_city (1,16) → classic_route_5 (39,16)`，480×272 与 960×544 各 phase 0..7 + landing。manifest 逐帧断言无 fade/scene、两图同时驻留、玩家每拍 2 px、相机不跳。`tests/world-seam-visual.test.ts` 新增语义断言：全程玩家世界 y 不变（没有横向挪到 y=17），落点是 `classic_route_5 (39,16)`。3 倍放大肉眼核对 phase 0/4/7/landing：无黑屏、无淡出、无错位，玩家与相机连续移动；画面下方黑带是 20 格高世界之外的空白（与 G-SEAM 的旧截图相同），不是转场黑屏，非黑像素约 70%。

## 存档兼容

- schema 不变；只有地图 manifest 变（`ec6bf29b…` → `6322d4d6…`）。`data/save-compat.ts` 加入审核过的 `{ec6bf29b…, 5eecc57a…}`，旧兼容对全保留（附加，不清空）。
- `tests/fixtures/save-compat/main-bbeef6b4/`：在 `bbeef6b4` 的独立 checkout 上按 README 的命令生成的真实浏览器存档，`continuationPrefix` 与前一个 fixture 相同（同一主线 tape）。`tests/g-persist-import.test.ts` 四个 fixture 全部加载并以新身份重存，最新一个沿当前 tape 续跑到记录的位置与状态。
- 主线外的额外核对：main 构建在 `classic_aerolume_city (3,16)` 存档，在本分支加载后按左：handoff `sourceY 16 → targetY 16`、phase 0..7、0 帧 fade，落到 `classic_route_5 (39,16)`，并以新身份重存。同一存档在 main 上：10 帧 fade，落到 (39,17)。

## 主线

被改的地图都不在 Spyder 主线上（Classic 区）。主线 tape、钉值与章节数据都没有改动，以下都与 main 相同：GB6 `f5b2c7ba…`（115,842 帧）、J1 `eb88bb0e…`、J2 `87533320…`、J3 `e35a7501…`、J4 `f8361bb0…`（206,830 帧）；两条战败路径 `b24ac763…` / `c785e53d…`。因此不需要重录，也没有逐字段差异要解释。

## 门禁

| 门禁 | 结果 |
| --- | --- |
| `bun run import` ×2 | 两次 15 个生成文件哈希一致（IMPORT-STABLE）；导入后工作树干净 |
| `bunx tsc --noEmit` | exit 0 |
| `bun run build` / `build:wasm` | PASS |
| `bun run test` | 1173 pass / 3 fail / 1176（656.7 s，负载 10–29）。3 个失败都是超时：`g6-locks`（60 s）与 `terrain` 两条（20 s/5 s）。`bun test tests/g6-locks.test.ts tests/terrain.test.ts` 单独重跑 9 pass / 0 fail |
| `verify:gb6:mainline` | PASS `f5b2c7ba…` |
| `verify:j1..j4:mainline` | PASS `eb88bb0e…` / `87533320…` / `e35a7501…` / `f8361bb0…` |
| `verify:gb6:failures` | PASS `b24ac763…` / `c785e53d…` |
| `verify:chapters` | PASS 20 chapters / 206,830 帧 |
| `verify:save` | PASS 5 points |
| `verify:bootworld:replay` | PASS 233 checkpoints |
| `bun run web` / `verify:web:zh` | PASS / 13 of 13 |
| `bun run build:psp` | PASS（两条既有 Rust warning） |
| 另跑 CI journey 组其余项 | `verify:preview:coverage` PASS（mainline 0 rejected）；`verify:goldens:sync` PASS 11；`verify:g6:locks` 343/343；`verify:g6:frozen` 0 permanent locks；`verify:zh:tape` OK；`verify:en:demo` OK |

预览覆盖：新增的 50 个 lane 事件不画任何东西，hidden 从 7,012 变为 7,062，previewed 1,158 与 rejected 5 不变；`docs/status.md` 已同步。

## 性能（QuickJS，交错测）

main 与本分支各自在独立 checkout、真实子模块、独立 bench root 中构建。桌面包：JS 2,681,981 → 2,682,149 B（+168 B），pak 55,711,840 → 55,756,736 B（+44,896 B，+0.08%，来自 Classic 地图分片里的逐格 lane 事件）。world-cache 路线覆盖布局里全部 67 张户外图，其中 15 张是 `classic_*`，所以被改的地图都在测量范围内。全部 pin 在 CPU 14；同机还有其他任务在跑 QuickJS bench 与 traecli，1 分钟负载 8.7–25。

**world-cache**（三轮 ABBA，共 12 个进程，`G6_BUDGET_MS/G6_STARTUP_MS/G6_PROFILE_FRAMES` 均未设置）。480×272 world-stress-render：

| run | 变体 | render qjs_cpu mean / p95 | cross-map mean / p95 | 退出 |
| --- | --- | --- | --- | --- |
| 1 | main | 2.897 / 14.290 | 2.936 / 9.013 | 0 |
| 2 | branch | 4.328 / 21.017 | 4.533 / 16.761 | 101：candy_town 一帧 58.7 ms（负载尖峰） |
| 3 | branch | 2.671 / 12.986 | 2.671 / 8.694 | 0 |
| 4 | main | 2.682 / 13.585 | 2.690 / 8.859 | 0 |
| 5 | main | 2.738 / 13.664 | 2.808 / 9.604 | 0 |
| 6 | branch | 2.803 / 13.847 | 2.917 / 9.625 | 101：960 档 NPC refs 第二遍最大 24 > 第一遍 21 |
| 7 | branch | 2.753 / 13.622 | 2.846 / 9.270 | 101：routec 一帧 51.6 ms |
| 8 | main | 2.786 / 14.209 | 2.762 / 8.832 | 0 |
| 9 | main | 2.725 / 13.619 | 2.754 / 9.192 | 101：paper_town 一帧 55.9 ms |
| 10 | branch | 2.986 / 15.084 | 3.065 / 9.672 | 101：routec 一帧 50.6 ms |
| 11 | branch | 3.881 / 18.539 | 4.231 / 15.036 | 101：dryadsgrove 一帧 65.2 ms（负载升到 25） |
| 12 | main | 2.945 / 14.885 | 2.989 / 10.227 | 101：candy_town 一帧 51.5 ms |

- 去掉两次负载尖峰中的 run 2、11 后：render mean 本分支 2.803 / main 2.795 ms（+0.3%），p95 13.89 / 14.04 ms（−1.1%）；cross-map mean 2.875 / 2.823 ms（+1.8%）。960×544 render mean-of-mean 3.330 / 3.352 ms。
- 所有跑完第二遍的进程 `WORLD_PLATEAU` 的 nodes/textures/ground/upper/animated/npc 增长都是 0，heap 增长低于 128 KiB slack。
- 失败都是**未改动的 Spyder 地图**上的单帧尖峰，或 NPC refs 抖动。这个抖动 main 也有：run 5 的 960 档两遍是 24→21，只是方向相反才没触发。
- 本分支 6 次里有 5 次没过绝对门，main 6 次里 2 次。均值与 p95 没有差异，失败帧也不在被改地图上，我判断是共享机噪声，而不是回退。复审若在低负载机器上复测，以那次结果为准。

**冷启动**（`startup-journey.json`，`G6_FAST_BENCH=1 G6_HASH_EVERY=10 G6_SKIP_MAP_BENCH=1`）。规格给的 `G6_STATE_SHA256=a5e82cc…` 已不匹配当前 main：main 自己跑出来就是 `0923ec51…`（run 1 原样失败，保留在记录里），本分支得到同一个状态，说明首帧剧情状态没有变化。之后用 `0923ec51…` 跑了三轮 ABBA。第三轮按 `docs/verification.md` 允许的诊断方式设置 `G6_STARTUP_MS=5000`，只为保留全部样本做归因，不把超 250 ms 的样本算作通过。合并 run 5–16 的全部样本：

| 变体 | 视口 | n | 中位数 | 均值 | 最小 / 最大 | >250 ms |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| main | 480×272 | 26 | 239.4 | 247.6 | 222.7 / 338.8 | 9 |
| branch | 480×272 | 23 | 229.8 | 248.2 | 221.2 / 387.0 | 6 |
| main | 960×544 | 26 | 242.6 | 251.6 | 219.6 / 340.7 | 8 |
| branch | 960×544 | 20 | 230.8 | 236.4 | 221.5 / 278.3 | 3 |

没有回退：本分支中位数略低，两边都有共享机离群。启动只读 `spyder_bedroom` 与项目 shell，这次改动不触及它们。

原始日志：`/var/tmp/fleet/3863/perf/{wc,cold}-<n>-<variant>.log`，批次时间与 `uptime` 在 `/var/tmp/fleet/3863/perf{,2,3}.log`。

## 三仓

- 游戏仓：本分支（基于 `bbeef6b4`），提交见下。
- 组件仓 / PocketJS：无改动，子模块指针不变（`ae1e6a33` / `862040bd`）；schema 不变，没有 breaking generation。

## 提交

- `2803dd09 feat(importer): cross every proven lane of fixed-destination seam openings`
- `52989b71 test: walk every funnel lane of a fixed-destination seam opening`
- `93ebc440 test: capture a formerly funnelled seam lane crossing`
- `3ab33b54 test: pin the funnelled lane's row and continuous landing in the seam capture`
- `0ab09d65 feat(save): accept saves from the build before the seam lane promotion`
- `ca870fba chore: audit lane-mapped seam openings and name the surf-only ones`
- `f3f09ae6 docs: describe lane-by-lane seam crossings and the remaining legacy portals`
- `1990f3c9 docs: count the per-lane seam events in the preview coverage`

## follow-up（已提 proposal，未实现）

1. Eclipse 等地图 YAML portal 对齐的接缝（约 30 个 portal、6 条 direction-only 接缝、5 个 unsupported-contact、candy_port↔diamond_hill）。
2. 组件仓 surface-aware 跨越（9 个 surf-only 水面开口，Spyder Route C 是主线外最大的一组）。

subagent 使用：2 个 / 一个只读核对 65 个 legacy portal 的几何与上游语义（放置、间距、源 XML、direction-only 的上游边界行为），一个只读整理测试/截图/重录/存档 fixture 工具链 / 明显省时：几何核对与工具调研和主线程的导入器实现并行；子代理结论中的关键几何（routea、route1 顶部 4 行、放置坐标）由主线程用 passage proof 脚本复核，重门禁与性能测量只在主线程串行跑。

PASS

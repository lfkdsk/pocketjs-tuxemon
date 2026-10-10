# G10-PARK：Eclipse 公园 `park_experience`

## 结论

- Tuxemon 上游的 8 个 `park_experience` 调用现已全部 Native：入口的
  `start` 激活可存档的公园会话，7 个 `stop` 都会停用会话、清除
  `park_out`、只打开一次结算页，再让原地图的传送、回收公园球和移除计步器继续执行。
- 真实 Eclipse Park 随机遇敌现在进入专用 Ball / Food / Doll / Run 交互。
  Park Ball 使用上游捕获公式并消耗库存；失败、成功、主动逃跑和遇敌先逃走均有独立结果；
  sightings、失败数、成功数和成功捕获 history 都随存档、读档和倒带保持确定性。
- 入口仍完全由原地图事件驱动：500 gold、25 个 Park Ball、500 步、100 步提醒和
  计步耗尽离场均未手写成另一套流程。英文、中文、键盘/手柄和缩放触摸均可用，
  8 张生产截图在两档分辨率通过 golden、全文和语义像素断言，并以 3 倍图肉眼核对。
- 当前 main 的真实存档可原样加载并继续；组件 schema、RPG Kit 与 PocketJS 均未改。
  GB6 和 J1–J4 终态与 main 完全一致。全套本机 CI、Web、PSP、变异和 QuickJS
  交错性能门禁全部通过，结论为 **PASS**。

## 基线与交付版本

- 游戏 main：`c6d57a6272d8426e190c49c94512dc5cf58a5220`。
- 游戏实现与状态文档树：`a825d87fac9941cd4fb01106e02e9239dbb980bf`
  （本报告是其后的文档提交）。
- Pocket RPG Kit：`65280e9bd09647ec76d03ba660d08aafa20bc531`，无改动。
- PocketJS：`862040bd77edc49b1f815beff63952b6616a14c6`，无改动。
- Tuxemon：`9e6258ff726b786040a267e8bdbbf037b560285e`。
- 所有提交作者均为 `lfkdsk <lfkdsk@gmail.com>`，未 push；`bun.lock` 未改。

## 上游语义对照

### 会话、入口与离场

上游 `tuxemon/event/actions/park_experience.py:33-54` 对 `start` 只调用
`activate_session()`；`stop` 先 `deactivate_session()`、删除 `park_out`，再压入阻塞的
`ParkState`，等它关闭后动作才结束。`tuxemon/park_tracker.py:81-137` 进一步证明
activate 不会清空 client-lifetime tracker/history；只有显式 `reset_session()` 才清空。

真实入口 `mods/tuxemon/maps/eclipse_park_entrance.yaml:54-62` 依次扣 500 gold、发 25 个
`tuxeball_park`、创建 `steps_park` 的 500 / `[100,0]` tracker，然后执行
`park_experience start`。主园区的主动离开路径在
`mods/tuxemon/maps/eclipse_park.yaml:234-245`，耗尽计步器路径在 `:266-272`；其它逃生
路径位于同文件 `:384-386`、`eclipse_park_south.yaml:183-189`、`:253-255` 和
`eclipse_park_cave.yaml:30-36`、`:76-78`。因此源数据是 **1 start + 7 stop**，限制是
500 步而不是墙钟时间。

### 公园遇敌与捕获

- `tuxemon/states/park_menu.py:32-40` 定义 Ball / Food / Doll / Run；`:68-74` 要求活跃
  Park session 并在每次遇敌登记 sighting，`:94-129` 绘制四项菜单及禁用状态。
- `tuxemon/states/park_menu.py:145-151` 在投球前先做逃跑检查，所以怪物先逃走时不消耗球；
  `:131-133` 的 Run 无普通战斗逃跑判定。
- `tuxemon/park_tracker.py:181-236` 给每次遇敌 30 回合，基础逃跑率 5%，base speed
  大于 80 时为 10%，回合耗尽自动逃跑。
- `tuxemon/core/effects/park.py:85-105` 复用 status/device/shake 捕获公式；`:107-133`
  在失败时记 failed attempt，在成功时加入队伍、登记图鉴、记 successful capture 并归档遇敌。
- `tuxemon/states/park.py:43-112` 的结算包含独特 sightings、总尝试、成功、失败、成功率、
  高频 sightings 和 history highlights。本移植保留同一组可见统计。
- 公园球的唯一专用数据是 `mods/tuxemon/db/item/tuxeball_park.yaml:1-21` 的
  `park capture`。Food / Doll 在上游菜单中存在，但 pinned 数据没有对应 park effect，且
  attraction/aggression 仍被上游标为 placeholder（`tuxemon/park_tracker.py:217-223`）；因此
  两项保留可见但禁用，不伪造尚不存在的玩法。

## 自动导入与持久状态

`importer/project.ts:4131-4145` 把合法 start/stop 降为 `tux.park_experience`；stop 后追加
清 `park_out` 和阻塞的 `tux.parkSummary` scene。全语料覆盖结果是：

| action | total | Native | Degraded | Placeholder | Dropped |
| --- | ---: | ---: | ---: | ---: | ---: |
| `park_experience` | 8 | 8 | 0 | 0 | 0 |

没有地图 allowlist 或手改导入产物。`battle/park.ts:1-79` 实现稀疏的 Park session：旧存档
和从未到访公园的状态完全没有该字段；首次 start 才创建它，再次 start 保留累计统计。
`:89-152` 对所有计数和 history 严格验证，并生成稳定排序、最多五项的结算摘要。
`summaryPending?: true` 是一次性 stop→scene handoff；`battle/scenes.ts:270-308` 在 scene
启动时立即消费它，因此相邻 exit guard 不会叠出两张结算页。

`battle/extension.ts:2111-2122` 注册 start/stop 命令。真实 Eclipse 遇敌没有显式
environment，`battle/runtime.ts:1128-1140` 因而从已保存的 map environment 继承
`park` / `night_park`，只在活跃 Park session 中启用专用 battle profile，同时登记 sighting、
30 回合和 5%/10% 逃跑率。`:471-494` 生成四格菜单；`:1272-1327` 实现先逃走、
Park Ball 捕获、统计和无条件 Run。普通战斗仍不能使用 Park Ball。

Park dependency closure 由导入器自动扩展，最终生成数据为 269 monsters、245 techniques、
114 items、13 elements、12 tastes、35 statuses、22 encounters、205 NPCs、10 environments、
213 trainer parties / 611 trainer monster slots、283 battle slots、286 random encounter uses 和
17 wild encounter uses；Eclipse Park 的 Pairagrim、日/夜环境、公园球和 UI 美术都来自 pinned source。

## 玩家入口与界面

Spyder 主线不会经过 Eclipse Park。玩家可用 **SELECT → Map warp →
`eclipse_park_entrance`** 到达安全出生点 `(4,3)`；Web 等价链接为
`?map=eclipse_park_entrance&x=4&y=3`。到接待台面朝下并接受 500-gold 入场，才会得到
25 个 Park Ball、启动 tracker 并传入内园。直接 warp 到 `eclipse_park` 只适合浏览地图，
不会伪造一个完整会话。说明已写入 `README.md:373-389`，状态表在
`docs/status.md:92` 标为 Done，导入命令表在 `docs/importer.md:108-110`。

`ui/battle-scene.tsx:219-225` 显示 Park Ball 数量，英文与中文完整显示 Ball / Food /
Doll / Run、遇敌提示、捕获/挣脱/逃走叙述。`battle/scenes.ts:240-267` 保存 JSON-safe 的
双语结算模板，`ui/park-scene.tsx:45-154` 绘制统计、sightings、highlights 和全宽触摸关闭键；
生产入口在 `main.tsx:367-372` 注册。

## 真实地图、存读档、倒带与变异

`tests/park-session.test.ts` 不重建假的地图事件：它从真实导入的 `eclipse_park` 读取
`e018_encounters_8_r001`（`(13,3)`、`4×3`、playerTouch、`eclipse_park` table、1%），
固定 saved RNG cursor 459 后得到 level-6 Pairagrim。60/30/20 Hz 都完成相同捕获：
Park Ball 25→24、production `battle_last_result` captured code 7、Pairagrim 入队并进 caught、
session 得到一次 sighting / capture / history。每档都通过真实 snapshot restore；完整捕获
倒带回公园菜单，再按同一 input refold，keyframe 与 from-zero 两条路径字节一致。

同文件还覆盖失败投球（球被消耗、failure +1）、怪物先逃走（不消耗球）、主动 Run（必定退出）、
严格 state validation 以及英文/中文 JSON round-trip 结算。聚焦结果为
`10 pass / 0 fail / 121 assertions`。

`tests/step-tracker.test.ts:180-370` 从真实入口 Pay event 开始，证明 25 个球、tracker、传送、
四方向移动、跨南园传送、存读档、倒带/refold 和 60/30/20 Hz 一致；100 步提示只显示一次。
tracker 到 0 时先出现结算，关闭后才按原地图事件回入口 `(5,4)` 并移除 tracker 和临时球。

在隔离副本中做了两项变异：

- 删除 map environment 继承，真实 Park flow 准确出现 2 项失败；
- 禁用 capture accounting，统计相关测试准确出现 2 项失败；
- 恢复未变异代码后同一聚焦集 `10/10` 全绿。

变异没有在交付 worktree 中改代码。

## 双语截图与肉眼核对

`tests/park-visual.test.ts:101-217` 对生产 bundle 串行启动 English / zh_CN × 480×272 /
960×544，分别捕获 encounter 和 summary，共 8 张 golden。测试逐字检查所有 HUD、四格命令、
完整结算文字，明确拒绝 `…` / `...` 截断；还检查选中 Park Ball、禁用项、菜单纸面、结算标题、
关闭按钮的语义像素，以及两档视口的 scaled-touch close。结果为
`4 pass / 0 fail / 106 assertions`。

四张 English/中文 encounter/summary contact sheet 把 480×272 与 960×544 都放大 3 倍；
逐张打开核对后确认 Pairagrim/Nut 美术、日间 Park 背景、文字、禁用态、两栏统计和触摸按钮
均可读、无裁切、无空白或错位。四个 touch-close probe 全部成功。

## 存档兼容

本功能只给游戏 extension state 增加可选稀疏字段，没有改 RPG Kit schema；schema identity
仍为 `9435a3b7f420c7e7876a7d211e8b2842bdc60e483c54c60cd550d7f5effc7d1c`。
Park session 自身在真实捕获和 tracker 测试中完成 snapshot restore、倒带和 refold。

另在 main 的隔离 checkout 中生成未手改的真实 slot：frame 26、
`spyder_paper_scoop (4,8)`，envelope SHA-256
`351f0d0d97211a755fbfd53d0902ea54d1980a8632d8351684ded3e185b72576`，旧 content manifest
`300693bb2544fd063701e53806673ffa07f4646ccf6ae5abba7d1e1d3117909c`。交付构建原样加载它，
沿当前 tape 再跑 257 帧到 frame 283 / 同位置，canonical state SHA-256
`5c40d03f6bd42b6278914cf9874a8074a8e3c07cde04910cd0c1ae4b30bfc0fd`；重存只使用当前
identity，伪造或混配 identity 仍拒绝。完整兼容聚焦结果为
`9 pass / 0 fail / 178 assertions`。

## 主线终态

Eclipse Park 不在 Spyder mainline。五段都在交付构建从 frame zero 重放，canonical 终态与
main 完全一致，所以逐字段差异为 **0**，无需重录：

| Segment | terminal state SHA-256 |
| --- | --- |
| GB6 | `fa4a55f281b94f8c2eeb3f157d432c33746ef97cd7fa7463b4ca9edc4a7184a0` |
| J1 | `e3f4a709c341a7ec617ad12da78d179f99c5e5ca99ad31cb135ec2dbf333ac71` |
| J2 | `fd8b882da71fcd5c9202458037cc1e90e5886e185613d5d0d3573d6bffc9245f` |
| J3 | `590452dceb93dfe0a2a88016610e602a6bc6f5334da6fa7b35c550f1f1f2548d` |
| J4 | `3fedbe7d848623d3f80b687f087a30f0e647ff4aa064cf0986ede38629719232` |

两条 battle defeat/recovery tape、章节、中文 tape/demo、英文 demo、save journey 和
206,830-frame built-world 的 233 个 checkpoints 也全部通过。

## QuickJS 性能

所有样本使用 PocketJS desktop host 的真实 QuickJS，绑定 CPU 7；测量时没有并行测试或
subagent 命令。main→branch→branch→main 做两轮交错。

### 冷启动

规格中的历史 expected hash `a5e82cc…` 已对当前 main 失效；main 和本分支实际都生成
`8446fbfd8da7061c3b62e10f70fc0e87262d87466d1122c9c8ad0cb8edca6990`，证明稀疏 Park
state 不改变 fresh startup。每边 12 个 fresh process：

| metric | main | branch | delta |
| --- | ---: | ---: | ---: |
| startup mean | 213.432 ms | 214.328 ms | +0.420% |
| startup median | 212.805 ms | 212.541 ms | −0.124% |
| startup min / max | 207.106 / 224.748 ms | 207.080 / 229.156 ms | — |
| first-frame CPU mean | 2.271 ms | 2.291 ms | +0.888% |

全部低于 250 ms startup / 50 ms frame 门槛。

### 3,500-frame 真实 G6 replay

每边四个 fresh process，全部到达 state
`8253ccefb8054a93070f2062c74e6c3b528e3e123d65a0fbd6b175e57008f9d2`：

| metric mean | main | branch | delta |
| --- | ---: | ---: | ---: |
| replay QuickJS+core CPU | 4370.139 ms | 4463.683 ms | +2.141% |
| all-frame p95 | 2.3215 ms | 2.36925 ms | +2.057% |
| battle-steady p95 | 0.5105 ms | 0.4945 ms | −3.134% |
| battle-entry CPU | 15.984 ms | 15.45675 ms | −3.299% |

最慢 branch frame 为 26.839 ms，低于 50 ms。

### Park 专用场景

三个 fresh QuickJS process 各测一次真实 encounter mount + 120 steady frames，再测 settlement
mount + 120 steady frames；50 ms mount 与 steady assertions 均通过：

| scene | mount QuickJS+core mean | steady p95 mean | worst steady | structural max |
| --- | ---: | ---: | ---: | ---: |
| Park encounter | 8.740 ms | 0.138 ms | 0.215 ms | 0 |
| settlement | 3.373 ms | 1.963 ms | 5.353 ms | 72 |

结构变化数保留为诊断数据；任务门槛是帧时间，最坏 settlement steady frame 仍只有 5.353 ms。

## 全门禁

### 生成、编译与测试

- `bun run import` 连跑两次无 diff；determinism 为 4,780 files / 67,437,448 bytes / SHA-256
  `26d9d138d6a90d3fd15c98fa58d148d2abac0702c84134e9041406b87038457b`。
- `bunx tsc --noEmit`、l10n、CJK、`bun run build`、`bun run build:wasm` 全部 exit 0。
- CI test 五组：importer `53 pass`；replays `12 pass`；locks/battle/terrain `22 pass`；
  rest a–l `592 pass / 107971 assertions`；rest m–z `562 pass / 50509 assertions`；均 0 fail。
- freeze scan 执行 263 maps：0 permanent locks、0 blocking fibers、0 errors。

### Journey、Web 与 PSP

- `verify:gb6:mainline`、J1–J4 mainline、golden sync、failure tapes、locks、frozen、chapters、
  zh tape/demo、en demo、save、preview coverage 和 bootworld replay 全部 PASS。
- `bun run web`、English Web journey、zh opening、demo controls、三首 imported music 均 PASS，
  0 console errors。
- PSP snapshots 重新生成；CI 的 `bun run build:psp --skip-assets` 和完整 PSP 构建均 PASS。
- 最终 `git diff --check`（HEAD 与全提交区间）和 `bunx tsc --noEmit` 再跑均 exit 0；
  report 前 worktree clean。

## 提交

| Commit | Change |
| --- | --- |
| `b5a1b3c8` | preserve Eclipse Park sessions in the importer |
| `77849f57` | add the Park capture runtime and UI mode |
| `2d72cf17` | exercise real Eclipse sessions, rates, saves and rewind |
| `f14fdeea` | pin bilingual production visuals |
| `20faac04` | load and continue the latest published slot |
| `e8178d11` | explain player access and feature status |
| `047f40e7` | register the Park settlement in lock scans |
| `3a7de24b` | pin the expanded battle runtime slice |
| `a825d87f` | register the Park settlement in freeze scans |

组件仓和 PocketJS 不需要提交或合入顺序；只需合并以上游戏仓提交和本报告。

subagent 使用：4 个 / 上游语义、运行时与导入架构、测试与 CI/性能、UI 与文档并行核查 / 明显省时

PASS

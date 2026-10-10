# G10-PARK：Eclipse 公园 `park_experience`

## 结论

- 复审指出的四项阻断均已修复：投球前的 positive flee 检查现在只消耗一次随机数并保持同一遭遇；捕获失败会把野怪已排队动作改成 `empty`，玩家怪兽不受伤；两项规定的 flee 变异都能被测试杀死；全部分支提交已通过 rebase 去除 `Co-authored-by` 尾注且作者保持不变。
- 次要差异也已对齐：成功率显示一位小数，捕获 highlights 保留上游首次出现顺序且不再截断；失败后的六种英文/中文 Park 风味文字进入真实 battle presentation。
- 原交付能力未回退：8 个 `park_experience` 调用仍全部 Native，真实 Eclipse Park 入口、捕获、计步离场、结算、存读档、倒带、双语与触屏路径均通过；当前 main 的真实存档可加载并继续，GB6 与 J1–J4 终态不变。
- 完整导入、类型检查、1,243 项测试、全部 journey、Web、PSP、双语画面和真实 QuickJS 交错性能门禁均通过，结论为 **PASS**。

## 基线与交付版本

- 游戏 main：`c6d57a6272d8426e190c49c94512dc5cf58a5220`。
- 游戏实现与测试树：`88e2ec587dde0128ff6b92e669083c3b9da7adf9`（本报告是其后的文档提交）。
- Pocket RPG Kit：`65280e9bd09647ec76d03ba660d08aafa20bc531`，无改动。
- PocketJS：`862040bd77edc49b1f815beff63952b6616a14c6`，无改动。
- Tuxemon：`9e6258ff726b786040a267e8bdbbf037b560285e`。
- 所有提交作者均为 `lfkdsk <lfkdsk@gmail.com>`；未 push，`bun.lock` 未改。

## 复审修复：原因、修法与证据

### F1：投球前 flee 检查保持遭遇

上游 `tuxemon/states/park_menu.py:145-151` 在 flee 判定为真时只写日志，随后返回菜单；它不投球、不扣球，也不结束遭遇。上游 `tuxemon/park_tracker.py:207-215` 与 `:229-236` 给每次遭遇 30 回合，base speed 大于 80 时 flee rate 为 10%，否则为 5%。

旧移植在 positive check 后调用 `endBattle("ran")`，把日志分支误作成功逃跑。`battle/runtime.ts:1268-1293` 现在先 clone battle：回合为零时直接短路且不抽 RNG；否则只抽一次 flee roll。positive check 仅保存推进后的 RNG，保留 decision phase、null outcome、25 个 Park Ball、事件、双方队伍和四项菜单；negative check 才提交 Park Ball。`battle/runtime.ts:1127-1136` 明确实现 `speed > 80 ? 0.1 : 0.05`。玩家主动选择 Run 仍按上游无条件离开，见 `battle/runtime.ts:1294-1310`。

`tests/park-session.test.ts:458-492` 同时钉住高速 10%、低速 5%、positive check 的一次 RNG、遭遇不结束、不扣球、不新增事件、不改野怪与菜单，以及零回合不抽 RNG。

### F2：捕获失败改写为空动作

上游 `tuxemon/core/effects/park.py:97-120` 在捕获失败时从六种风味技巧中选一项，并把目标野怪已排队动作改写成 `Technique.create("empty")`；`tuxemon/combat/action_queue.py:208-215` 保留原 action target。公园里失败投球因此不会让玩家怪兽受伤。

`battle/core.ts:51-64` 给 Park capture 与风味键增加可序列化标记。`battle/tuxemon.ts:824-864` 只在失败的 Park capture 上抽取六种风味，逐项保留队列位置与 target，把该野怪的排队动作改成 `empty` 并删除原 move index；成功捕获不会额外消耗风味 RNG。`battle/tuxemon.ts:1305-1326` 把风味随 technique event 传给 presentation。`ui/battle-scene.tsx:82-91` 与 `ui/battle-scene-locale.ts:59-77,125-143` 显示六种完整英文/中文叙述。

`tests/park-session.test.ts:494-520` 证明失败会扣一球并计一次 failure，但玩家 HP 等于满血、野怪 technique 为 `empty`、damage 为 0，且风味属于六个上游键之一。

### F3：flee 测试有牙

两项规定变异均在隔离副本执行，未修改交付 worktree：

- 删除投球前 flee guard 后，`bun test tests/park-session.test.ts` 变红；原本应停在 RNG draw 5 的遭遇继续执行到 draw 12。
- 对调高速/低速的 `0.1` 与 `0.05` 后，同一测试变红；高速 Pairagrim 期望 `0.1`，实际得到 `0.05`。

恢复未变异代码后聚焦测试与完整测试均全绿。第一项同时证明测试不是只看 flee rate 常量，第二项证明两个 rate 分支都被真正辨识。

### F4：提交尾注

以 `origin/main` 为基线对全部 14 个分支提交执行 `git rebase --exec`，每个提交只保留原 subject，并对 amend 显式设置 `core.hooksPath=/dev/null`。rebase 前后的 tree 均为 `0b2a61cc43495774a44cb05fab4bbe3beb8f8e5d`，代码字节未变；全部 author 仍为 `lfkdsk <lfkdsk@gmail.com>`。

最终要求的命令 `git log origin/main..HEAD --format=%B | grep -i co-authored` 无输出并返回 1，说明范围内没有任何 `Co-authored-by` 尾注。

### 显示精度与完整 highlights

`ui/park-scene.tsx:45-48` 用 `toFixed(1)` 显示百分比，双语生产画面均钉住 `60.0%`。`battle/park.ts:127-150` 的 highlights 按 history 第一次插入顺序输出全部物种，不再排序或 `.slice(0, 5)`；常见 sightings 的 top-five 规则保持不变。`tests/park-session.test.ts:115-131` 用六个不同物种证明第六项不会丢失。

## 原功能完整性

### 自动导入与会话

`importer/project.ts:4131-4145` 把合法 start/stop 导成 `tux.park_experience`；全语料仍为 8/8 Native、0 Degraded、0 Placeholder、0 Dropped。入口事件继续按源数据扣 500 gold、发 25 个 Park Ball、创建 500 步 tracker；7 条 stop 路径继续先停用会话、清 `park_out`、打开一次阻塞结算，再执行原地图传送和回收球。

Park 状态仍是可选稀疏 extension 字段，未改 RPG Kit schema。未到访公园的旧存档没有额外热路径；session 的 sightings、失败、成功与 capture history 均随 snapshot、存档和倒带保存。

### 玩家入口

Spyder 主线不会经过 Eclipse Park。玩家使用 **SELECT → Map warp → `eclipse_park_entrance`** 到安全出生点 `(4,3)`，在接待台面朝下接受 500-gold 入场，随后取得 Park Ball 与 tracker 并进入内园。Web 等价链接是 `?map=eclipse_park_entrance&x=4&y=3`。说明位于 `README.md:373-389`，`docs/status.md:92` 保持 Done，导入命令表位于 `docs/importer.md:108-110`。

## 测试、画面与兼容

### 真实地图、存读档与倒带

`tests/park-session.test.ts` 从真实导入的 `eclipse_park` event 与 encounter table 触发 level-6 Pairagrim，而不是重建假的地图事件。60/30/20 Hz 均完成相同捕获：球 25→24、production result code 为 captured、Pairagrim 入队并进入 caught、session 写入 sighting/capture/history；三档都通过 snapshot restore。完整捕获可倒带回 Park 菜单，再按相同 input refold，keyframe 与 from-zero 路径字节一致。

同文件还覆盖 start/stop 严格验证、失败投球、positive flee no-op、零回合短路、主动 Run、完整 highlights，以及英文/中文 JSON round-trip 结算。`tests/step-tracker.test.ts:180-370` 继续从真实入口 Pay event 证明 25 个球、500 步、100 步提示、跨园区传送、耗尽离场、存读档、倒带/refold 与多 hz 一致。

### 双语截图与肉眼核对

`tests/park-visual.test.ts:131-183` 逐字钉住英文/中文 `60.0%` 与完整结算文字，并拒绝省略号截断；`:185-210` 对标题、选中 Park Ball、禁用选项、菜单纸面和关闭按钮做语义像素断言。English / zh_CN × 480×272 / 960×544 的四张刷新后 settlement golden 均字节匹配。

四张 settlement golden 都以 3 倍打开肉眼检查：一位小数清晰，两栏统计、highlight 与触摸按钮无裁切、重叠、空白或错位。CJK 子集检查覆盖 2,482 个字符，新增中文风味没有缺字。

### 当前 main 存档与主线终态

在 main 隔离 checkout 生成的真实 slot（frame 26、`spyder_paper_scoop (4,8)`）可由交付构建原样加载，再沿当前 tape 继续到 frame 283；重存使用当前 identity，伪造或混配 identity 仍拒绝。schema identity 仍为 `9435a3b7f420c7e7876a7d211e8b2842bdc60e483c54c60cd550d7f5effc7d1c`。

五段主线从 frame zero 重放，canonical 终态与 main 完全一致，逐字段差异为 0：

| Segment | terminal state SHA-256 |
| --- | --- |
| GB6 | `fa4a55f281b94f8c2eeb3f157d432c33746ef97cd7fa7463b4ca9edc4a7184a0` |
| J1 | `e3f4a709c341a7ec617ad12da78d179f99c5e5ca99ad31cb135ec2dbf333ac71` |
| J2 | `fd8b882da71fcd5c9202458037cc1e90e5886e185613d5d0d3573d6bffc9245f` |
| J3 | `590452dceb93dfe0a2a88016610e602a6bc6f5334da6fa7b35c550f1f1f2548d` |
| J4 | `3fedbe7d848623d3f80b687f087a30f0e647ff4aa064cf0986ede38629719232` |

两条 battle defeat/recovery tape、章节、中文 tape/demo、英文 demo、save journey，以及 206,830-frame built-world 的 233 个 checkpoints 也全部通过。

## QuickJS 性能

所有数据来自 PocketJS desktop host 的真实 QuickJS。没有本任务测试或 subagent 与测量并行；main→branch→branch→main 交错取样。首轮冷启动窗口受外部持续 CPU 负载污染而作废，以下为重跑的完整交错窗口；只按与 main 的相对回退判定，不声称所有样本低于 250 ms。

### 冷启动

每边 12 个 fresh process；24 份 canonical state 都是 `8446fbfd8da7061c3b62e10f70fc0e87262d87466d1122c9c8ad0cb8edca6990`：

| metric | main | branch | delta |
| --- | ---: | ---: | ---: |
| startup mean | 235.309 ms | 237.177 ms | +0.794% |
| startup median | 234.156 ms | 235.349 ms | +0.510% |
| startup min / max | 231.978 / 247.531 ms | 231.652 / 251.546 ms | — |
| first-frame QuickJS mean | 2.399 ms | 2.450 ms | +2.126% |

相对回退均低于 3%。

### 3,500-frame G6 replay

每边四个 fresh process，8 份最终状态均为 `8253ccefb8054a93070f2062c74e6c3b528e3e123d65a0fbd6b175e57008f9d2`：

| metric mean | main | branch | delta |
| --- | ---: | ---: | ---: |
| replay QuickJS+core CPU | 4418.143 ms | 4381.500 ms | −0.829% |
| all-frame p95 | 2.2978 ms | 2.3115 ms | +0.598% |
| battle-steady p95 | 0.4903 ms | 0.4773 ms | −2.652% |
| battle-entry CPU | 15.524 ms | 14.592 ms | −6.002% |

最慢 branch frame 为 31.720 ms。

### Park 专用场景

三个 fresh QuickJS process 分别测 encounter mount + 120 steady frames，再测 settlement mount + 120 steady frames；50 ms mount/steady assertion 三次均通过：

| scene | mount mean / max | worst p95 | worst steady frame |
| --- | ---: | ---: | ---: |
| Park encounter | 8.717 / 9.072 ms | 0.143 ms | 0.222 ms |
| settlement | 3.348 / 3.382 ms | 1.975 ms | 5.467 ms |

## 全门禁

### 生成、编译与测试

- `bun run import` 连跑两次无 diff；determinism 为 4,780 files / 67,437,448 bytes / SHA-256 `26d9d138d6a90d3fd15c98fa58d148d2abac0702c84134e9041406b87038457b`。
- `bunx tsc --noEmit`、l10n 11/11、CJK 2,482 covered、`bun run build`、`bun run build:wasm` 全部 exit 0；Wasm 为 360,011 bytes。
- 完整 `bun run test`：`1243 pass / 0 fail / 232410 assertions`，141 files，414.57 s。
- CI test 五组：importer 53、replays 12、locks/battle/terrain 22、rest a–l 592、rest m–z 564，全部 0 fail。
- freeze scan 执行 263 maps：0 permanent locks、0 blocking fibers、0 errors。

### Journey、Web 与 PSP

- 16 项 journey/verification 命令全部通过，包括 GB6、J1–J4、failure tapes、locks、frozen、chapters、zh tape/demo、en demo、save、preview coverage 与 bootworld replay。
- `bun run web`、English Web journey、zh opening、demo controls、三首 imported music 全部 PASS，0 console errors。
- PSP snapshots 已刷新；CI 的 `bun run build:psp --skip-assets` 与完整 PSP 构建均 PASS。
- 四张刷新后 Park settlement golden、最终 `git diff --check`、最终 `bunx tsc --noEmit`、作者与 footer 审计全部通过；worktree clean。

subagent 使用：3 个 / 上游语义、测试辨识力、CI与交付审计 / 明显省时。

PASS

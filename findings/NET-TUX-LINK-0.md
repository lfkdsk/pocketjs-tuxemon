# NET-TUX-LINK-0：网页版联机对战设计与可行性验证

## 结论

可行。ARENA-1 的纯 TypeScript 对战内核可以在 Cloudflare Workers / Durable Objects
中直接运行；推荐把源码权威保留在游戏仓，并在在线服务仓以固定 revision 引用，部署为
**独立 Battle Worker + 每场比赛一个 SQLite `TuxBattleDO`**。现有在线 Worker 继续负责
GitHub 登录、轻量能力发现和入口限流，通过 service binding 接入 Battle Worker；不要把战斗
状态塞进 Wander 的 `RoomDO`，也不要让普通 `/health`、登录或 `/ws/v4` 请求求值三份战斗数据。

v1 队伍使用服务器生成的 G12 `normal` 租借配方（3v3、Lv20、双方同一 246 只候选池，
各自确定性抽取）。客户端存档、seed、队伍记录和 provenance 都不作为权威输入。双方经
GitHub 登录后，用单次、短时、高熵邀请码占据两个 seat；好友关系不是 v1 前置条件。

客户端复用现有标题 `Battle` 行，在 Web 且服务器宣告 `tux-battle/v1` 时增加
`Local / Link` 二级选择。实时画面复用 `TuxemonBattleScene` 的布局与素材，但必须新增只吃
`observe()` 和脱敏 presentation 的 online adapter；完整 `ArenaBattle` 永不下发。赛后把
版本化 `LinkReplayEnvelope` 交给与其 engine/data revision 匹配的现有 replay scene 播放。

验证基线：游戏仓 `0acfaed6`，在线服务 `4e96936`，Wander 客户端 `47bf5d6`。
临时原型只用于本地 workerd 测量，没有提交、部署或访问生产数据。

## 1. 引擎位置与 Workers 可行性

### 1.1 为什么放在专用 Durable Object

`battle/arena.ts:10-13,206-209` 在运行时导入英文数据库、中文数据库和完整
`feature-modes.json`，并在模块求值时验证两份数据库；`battle/arena-team.ts:9,155`
还会再次验证英文库。三份原始输入分别为 1,651,996、1,647,358、131,213 bytes，合计
3,430,567 bytes。内核本身只使用标准 JS API；真实 Wrangler browser/workerd 打包没有
出现 Node 或 Bun runtime import。

因此采用以下边界：

1. 游戏仓继续拥有 `battle/**` 和经 importer 生成的数据；在线服务以 gitlink 或等价的固定
   revision 引用，不复制一份会漂移的引擎。
2. 新增独立 Battle Worker 配置，只导出 `TuxBattleDO` 和轻量转发 handler；在线服务通过
   service binding 转发 `/tux/v1/**`。
3. `arena.ts` 在 DO 第一次真正创建/恢复比赛时动态导入。网关 Worker 不导入战斗数据库，
   从而隔离 bundle/global evaluation、部署版本、故障域与 telemetry；现有服务按付费档预算
   （`pocket-online-server/README.md:574-596`），独立部署并非基于“现网只有免费档
   10 ms”的假设。
4. 一个随机 `matchId` 对应一个 DO；不要复用已有 `RoomDO`。后者是 20 Hz 世界房间、带
   玩家 AOI 与持续广播，而回合制比赛只应在消息、alarm 或恢复时唤醒。
5. match 元数据固定 `engineRevision`、数据 digest、`ARENA_VERSION` 和 wire version；旧局
   不能在不同数据库 revision 上静默续跑。

`ArenaBattle` 是普通可序列化状态，且已有同时提交、私有 observation、默认动作、终局、
tape/replay 和 hash 边界（`battle/arena.ts:108-125,601-712,803-816`），适合 DO 的单线程
事务模型。

### 1.2 打包实测

命令为固定版本 Wrangler 的 `deploy --dry-run --minify --outdir ...`；`Total Upload` 是
官方定义的未压缩 bundle 大小。原型只导入 Arena 运行时与数据，没有 UI、地图、图片、pak、
音频或 build tools。

| 入口 | 未压缩 bytes | Wrangler | gzip（诊断） | 说明 |
|---|---:|---:|---:|---|
| 现有在线服务 | 518,313 | 506.17 KiB | 159.93 KiB | 对照组 |
| 专用 Arena Worker | 2,198,871 | 2,147.33 KiB | 287.05 KiB | 推荐部署形状 |
| 在线服务与 Arena 合并 | 2,717,609 | 2,653.92 KiB | 446.65 KiB | 仅用于量增量 |

合并包比对照增加 2,199,296 bytes；专用包和合并包分别是当前 64 MiB 上限的 3.28% 和
4.05%。Cloudflare 文档在 2026-10-14 列出：Worker 未压缩包 64 MiB、isolate 内存
128 MB、global-scope startup 1 s；普通 Worker 免费/付费 HTTP CPU 分别为 10 ms 与默认
30 s，而 SQLite Durable Object 每个 HTTP request、WebSocket message 或 Alarm 默认有 30 s
active CPU。gzip 没有平台大小上限，只作为传输/诊断信息，不参与 64 MiB 判断。
来源：

- <https://developers.cloudflare.com/workers/platform/limits/#worker-size>
- <https://developers.cloudflare.com/workers/platform/limits/#cpu-time>
- <https://developers.cloudflare.com/workers/platform/limits/#memory>
- <https://developers.cloudflare.com/workers/platform/limits/#worker-startup-time>
- <https://developers.cloudflare.com/durable-objects/platform/limits/>

结论是体积没有阻断项；但必须保持“轻网关、重计算只在 DO”。

### 1.3 workerd CPU、冷启动与确定性实测

最小原型用 Wrangler 3.99.0 启动真实本地 workerd 和 SQLite DO。每局由服务器固定 seed，
双方均走 `observe -> defaultAction -> submit side 0 -> submit side 1`，直到 knockout 或
2,048 decision-window 上限。计时区间没有 `await`，所以表中的 CPU-path 是同步 JS elapsed
的本地代理；workerd 计时粒度约 1 ms，它不是 Cloudflare 账单中的生产 `cpuTime`。
该固定 Wrangler 版本把请求的 2026-10-01 compatibility date 回退到其支持的
2024-12-18；这组数反映现有服务工具链，而不是当前云端 runtime。实现任务必须先升级或明确
固定部署 Wrangler/runtime，再在同一版本上重跑。

12 次完全重启、每次同一 16 回合 fixture 的结果：

| 指标 | p50 | p95 | 说明 |
|---|---:|---:|---|
| Wrangler + workerd ready wall | 844.65 ms | 883.96 ms | 含 CLI/runtime 启动，不等同 global-scope CPU |
| 首个 DO 请求 wall | 434.51 ms | 463.94 ms | 含本地 HTTP/DO 调度 |
| 同 isolate 热请求 wall | 98.18 ms | 100.00 ms | 含本地 HTTP/DO 调度 |
| Arena 动态 import/数据校验 | 77 ms | 80 ms | DO 内冷加载 |
| 冷路径完整局 CPU-path | 13 ms | 17 ms | 16 回合 |
| 热路径完整局 CPU-path | 5 ms | 6 ms | 16 回合 |

这些 wall/动态 import 数字都不测量平台定义的 global-scope parse/execute，因此**没有验证**
1 s startup gate。实现任务必须以真实 `wrangler versions upload/deploy` 返回的
`startup_time_ms` 作上线门禁；dry-run 和本地 ready 都不能代替平台部署校验。

32 个不同 seed 的热路径完整局结果：

| 指标 | p50 | p95 | max | 备注 |
|---|---:|---:|---:|---|
| decision windows / 局 | 16 | 2,048 | 2,048 | 2/32 局命中上限 |
| 纯 observe/default/submit pair | 0 ms | 1 ms | 3 ms | 4,686 个回合样本，均值 0.447 ms |
| JSON checkpoint 序列化 | 6 ms | 10 ms | 19 ms | 均值 5.240 ms |
| 上述两段合计 / 回合 | 6 ms | 11 ms | 20 ms | 不含真实 storage I/O |
| 完整局 CPU-path | 3 ms | 11,999 ms | 14,522 ms | 长局造成重尾 |

两套 percentile 的分母不同：前三个回合耗时汇总 4,686 个 decision windows，其中两场长局
贡献 4,096 个并支配 pooled p50；“完整局”则是 32 个 match totals 的分布。完整局计时包含
init、每回合 engine、每回合完整 JSON checkpoint 序列化和终局 `tape()` 构造，不含真正
SQLite I/O、tape bytes 序列化、终态 hash 或 HTTP/DO 调度，所以不会与 pooled p50 作逐项相乘。

普通局很轻，但 `core.events` 与 Arena `actions` 都持续增长；16 回合 fixture 的最大 checkpoint/
tape 为 20,761/998 bytes，2,048 回合长局则达 1,940,046/106,662 bytes。SQLite DO 单个
key+value、string/BLOB/row 上限是 2 MB，故**不得把完整长局 JSON 存成单行或单个 storage
value**。实现必须：

- 每个 accepted action 在 ACK 前事务性保存，包括单边私有 `pending`；
- 把 meta、pending、snapshot manifest/chunks、idempotency 和 result 分表/分行，单行设明显
  低于 2 MB 的应用上限；编码可把 `core.events`/`actions` 无损分页，但恢复必须按原索引重组
  完整 `ArenaBattle`，保留绝对 `revealEventCursor`，使现有 `stateHash` 与 replay 仍可比较；
- 语义 compaction 仅是 profiling 后的可选优化，不是 v1 前置。若以后删除历史 events，必须
  升 checkpoint schema，定义 event-base 游标及新的 canonical semantic hash，并证明 live 与
  replay 在完全相同的 compaction boundary 等价；不能拿现有完整状态 hash 比 compact state；
- 禁止对外提供“一次请求自动跑完整局”或任意客户端 replay CPU endpoint；每个网络消息/
  alarm 最多推进一个 decision window；
- 不逐回合 canonicalize/hash 整份增长状态，hash 只用于终局或抽样审计。

### 1.4 内存实测

通过 workerd inspector 的 `Runtime.getHeapUsage` 在请求前后取样；未强制 GC，因此请求后值
包含尚未回收对象，是保守快照：

| 场景 | used heap | reserved heap | 相对请求前 used |
|---|---:|---:|---:|
| 请求前 | 11,849,588 B | 12,931,072 B | — |
| 冷加载 + 1 局普通 16 回合 | 16,407,072 B | 19,746,816 B | +4,557,484 B |
| 冷加载 + 16 局（含一局 2,048 回合） | 19,286,848 B | 40,333,312 B | +7,437,260 B |

V8 heap 快照未见接近 128 MB 的红旗，但它不含全部 runtime/external/Wasm 分配，不能单凭此
宣告 isolate 总内存可行。实现验收必须补真实平台 memory telemetry 和并发多个 DO isolate
的压力测试；本表只证明当前 JS heap 样本有余量。

同一 seed 在 Bun 与 workerd 均得到 16 回合、winner 1、`knockout`，终态 hash 都是
`46e0f46785ff506a962d5fcb0659ff4873493427009533b12580e3159b3084e1`，证明这一 fixture
跨运行时确定。实现任务应扩大成每回合 hash fixture，并覆盖双打、swap、status 和 turn-limit。

### 1.5 可选裁剪方案

现状已能部署；若真实 startup gate 或成本不达标，再做构建期裁剪，而不是手改数据库：

1. importer 生成版本化 `arena-server-db.json`，只保留 reducer、spawn、team validation
   的传递闭包，并在构建期完成 schema 校验。
2. 服务器 observation 只发稳定 slug；中文/英文 display name 由客户端本地数据库解析，
   可去掉约 1.65 MB 原始中文 JSON。此项改变 observation contract，需升版本。
3. 从 `feature-modes.json` 只 cook 五个 G12 recipe。
4. 把通用 canonical JSON/SHA 与 battle pure runtime 从大模块中抽出，但继续由游戏仓测试
   同一份语义。

## 2. 队伍来源与防作弊

| 方案 | 防作弊能力 | 现有基础 | v1 判断 |
|---|---|---|---|
| (a) 服务器租借/轮抽 | 强；服务器拥有候选、seed、pick 状态和最终 snapshot | 租借生成已有；pick/ban 状态机与 UI 尚无 | 租借可用，轮抽后置 |
| (b) G12 Battle 配方 | 强；是 (a) 的现成、可复现内容规则 | 五档真实导入，Arena 已按 domain-separated seed 生成 | **推荐 `normal`** |
| (c) 自带存档 + 统一等级 + `validateTeam` | 只能证明输入自洽；不能证明属于该账号或真实获得 | 重建器完整，但普通离线存档没有权威来历 | v1 禁用 |

G12 的五档及候选规模由真实 `battle_menu.yaml` 导入测试固定：1v1/Lv10/240、
2v2/Lv15/243、3v3/Lv20/246、4v4/Lv25/247、5v5/Lv30/249
（`tests/feature-modes-import.test.ts:128-147`）。Arena 对双方使用同一 recipe，但以
`team:0` / `team:1` domain seed 各自抽取（`battle/arena.ts:296-333`）。网络服务必须生成
并锁定 64-hex match seed；客户端不得试 seed、上传 roster 或覆盖 recipe。v1 固定
`normal` 可避免新 draft 协议和选择 UI，且双方等级、队伍大小和候选分布相同。
现实现按 slot 有放回抽样，队内可能出现重复 species（`battle/arena.ts:324-333`）；v1 保持这项
既有规则。若以后增加 species clause，必须作为新 rules/data revision，而不能静默去重。

`validateTeam` 是 deterministic legality/consistency reconstruction，不是签名：

- 只允许 record 字段并从 seed/DB 重建 species、level、IV、stats、moves、TM/item、capture、
  XP 与 learn history（`battle/arena-team.ts:701-997`）；规则可限制 size、level cap、
  banned 内容和 `requiredKind`（`battle/arena-team.ts:126-149,236-295`）。
- 代码明确说明 `provenanceHash` 不是 ownership signature；认证存储才是信任边界
  （`battle/arena-team.ts:108-123`）。它是公开输入的普通 SHA-256，不是绑定账号和服务端
  secret 的 MAC。
- `uniformLevel` 最后只重算等级相关 stats，仍保留 IV、training points、taste 和技能，
  不是完全竞技归一化（`battle/arena-team.ts:302-318,979-998`）。
- 校验只要求全队 seq 唯一、单只怪内部递增，不要求上传 provenance 跨队连续；完整服务端
  Expedition 才在 `battle/expedition.ts:1148-1152` 检查 1..N 守恒。
- 普通本地存档只保存 `SpawnedMonsterSnapshot[]` party（`battle/extension.ts:148-151`），没有
  服务器签发的 ownership ledger；能编辑存档的人也能构造一条规则自洽的 history。

因此 v1 不接收任何本地 team/provenance。将来自认证服务器存储的长期队伍用于独立队列，
必须是后续功能：客户端只提交 record id/顺序，服务端按账号加载记录、固定 rules（至少
`requiredKind: "expedition"`）再重建；绝不能接收客户端自报 rules、seed 或 inline records。

## 3. 接入在线服务

### 3.1 Auth、入口和兼容性

复用 `AuthDO` 的 GitHub OAuth exchange、HMAC ticket 和 account version，但新增无世界副作用的
内部 `POST /ticket/verify`。不能直接调用现有 `/join`：它会要求 Wander profile，profileless
账号返回 `needCreate`，有 profile 时又会登记世界 session、淘汰旧 session 并产生 Room kick
（`pocket-online-server/src/auth.ts:346-456`、
`pocket-online-server/src/room.ts:2248-2366`）。Tux 玩家不应被迫
创建 Wander 角色，也不应污染世界在线状态。

新增且保持独立：

- `GET /tux/v1/capabilities`：匿名、可缓存，返回 wire/arena version 和 capability flags；
- `POST /tux/v1/matches`：ticket 认证后创建挑战；
- `GET /ws/tux/v1?match=<opaque-id>`：只定位 DO，ticket 与 invite secret 放第一个 WebSocket
  `hello` frame，不放 URL；生产只允许受信 Origin 与 WSS；
- `TUX_BATTLE` namespace / `TuxBattleDO`；
- Auth 内部 `/ticket/verify`，以及按账号限制 waiting/active matches 的 reserve/release index。

match 创建是跨 AuthDO/BattleDO 的 saga，而不是假装有跨 DO 事务。reservation 明确经过
`reserved -> attached -> released`：客户端提交有界 `requestId`；Auth `/battle/reserve`
幂等持久化 `(githubId, requestId) -> { reservationId, matchId, expiresAt, state }` 并只占一次
额度；BattleDO `/create` 用相同 ids 幂等创建 match，并在同一 SQLite 事务写 durable attach
outbox。只有幂等 `/battle/attach` 已把 Auth reservation 变成 `attached` 并 ack 后，对应 seat
才接受连接、`/create` 才返回成功；attach 发现 reservation 已过期时，BattleDO 终止孤儿 match。
第二位玩家兑换 invite 时也先用自己的 requestId/reservation 占额，再由消费 invite、绑定 seat
和写 attach outbox 的单个 BattleDO 事务完成同一 reserve/attach 流程；join attach 失败或过期
则终止 match，不能留下未被账号 index 覆盖的活跃 seat。网关响应丢失后重试相同 requestId。
未 attach 的 reservation 由 Auth TTL job 补偿释放；attached reservation 不再按创建 TTL
过期。比赛进入 ended/expired 的事务同时为**两个 seat**写 durable Auth release outbox，再
重试幂等 `/battle/release` 到 ack，避免响应丢失永久占额或提前释放。

Auth 的 battle index 还必须参与账号删除：先 tombstone 账号、提升 accountVersion/撤销 ticket，
再由 durable deletion job 按 index 幂等 fan-out 终止/清理 waiting/active matches；所有 ack 或明确
过期后才清 index，不能用一次同步调用链。否则每场一个 DO 无法全局枚举。比赛结束后的
recipe-only tape 不含身份，按普通 retention 独立过期。

现有 `/ws`、`/ws/v4` 及其二进制 world protocol 不改；它们当前由
`pocket-online-server/src/worker.ts:170-243` 路由。新字段若也出现在 Wander 的
`realmFeatures`，必须是 optional 且 absent=false；旧客户端无需认识新路由或字段。

### 3.2 邀请与好友

复用 Wander 的 Crockford-like 可读 alphabet、URL fragment 清理和分享页交互，不复用其安全
语义。现有 realm code 只有 8 字符、TTL 1 小时，并允许到期前多人重复兑换
（`pocketjs-wander/examples/wander-online/shared/invite.ts:19-27,100-117`）；它不适合作为
battle seat authorization。

Battle invite 设计：

- 至少 128 bit 不可预测 secret。为让丢失的 `/create` 响应可幂等重放，使用版本化服务端密钥
  计算 `HMAC(K[kid], "tux-invite-v1" || matchId || creatorReservationId)`，其中 `K[kid]` 是仅
  服务端持有的 secret key，`kid` 只是公开 key identifier；截取不少于 128 bit
  后无偏编码到现有 29 字符 alphabet（至少 27 字符）；DO 只保存 `kid` 和 secret hash，服务端
  保留旧 key 至少覆盖 invite TTL 与重试窗口，同一 requestId 可重新派生**同一个** secret，
  不能轮换后让乱序响应产生两个 token。token 为 `<opaqueMatchId>.<secret>`，页面从 fragment
  读取后立刻清除；
- DO 另存 creator、expiry、redeemedAt，TTL 10 分钟；成功占据第二 seat 的
  同一 SQLite 事务即消费，不能重放；
- 两边仍必须提交有效 GitHub ticket；同一账号不能占两边；日志、URL query、Meter 和 replay
  都不得含 ticket/secret；
- v1 不要求好友关系。好友只可作为后续“选择挑战对象”的发现 UX；若挑战预绑定目标，则在
  创建和兑换时都检查 mutual edge/account version，但 invite 本身仍必须单次高熵。

这比把 realm invite 或 `/social/invite` 当授权更窄；后者只是发出 pending friend request，
并不证明已互为好友（`pocket-online-server/src/auth.ts:699-741`）。

### 3.3 `TuxBattleDO` 状态与持久化

状态机：`waiting -> active -> ended`，任意未开始/长期无人状态可到 `expired`。`ready` 只作为
创建 Arena 的同一初始化事务中的瞬时检查点。

SQLite 至少分为：

- `meta`：schema、engine/data/wire/arena versions、phase、创建/过期时间、共享
  `turnRevision`、内部 `mutationRevision`；
- `players`：固定 side、GitHub id/accountVersion、`connectionEpoch`、当前 socket/IP lease id、
  `disconnectedAt/graceAt`；队伍只记服务器 recipe/snapshot；
- `invite`：secret hash、expiry、redeemedAt；
- `battle_snapshot_chunks` + `pending`：最后一个 settled boundary 的完整状态做无损分页；
- `public_refs`：`(recipientSide, internalUid) -> publicId` 与首次公开 revision；只在怪物首次
  对该接收方可见时分配，内部 UID 只留在 DO；
- `requests`：每 side 最近的 `(turnRevision, requestId, reply)`，支持幂等重放；
- `result`：一次写入的胜负、原因、终态 hash、tape/replay object key；
- `usage_outbox`：Meter reporter、单调 sequence 和未确认 debt；
- `auth_outbox`：未确认的 reservation attach/release/account-cleanup ack；
- `deadlines`：invite、turn、每 side grace、IP lease renew/expiry、usage/auth retry 与 retention
  的绝对时间。

每次接受第一方 pending、第二方 settle、timeout default 或 resign，都在单个事务写入状态后才
ACK/广播。不能只存 `tape()`：单边 pending 时 `tape()` 明确拒绝
（`battle/arena.ts:697-712`）。共享 `turnRevision` 只在 pair 结算后增长；第一方提交只增长
内部 revision，否则第二方会因本应保密的 pending 收到 stale，从而泄漏对手已提交。
forfeit/resign 若发生在单边 pending 后，回放从**最后一个 settled boundary** snapshot 中的
config/actions 构造；未配对 action 不进入 tape，pre-terminal hash 也取该 boundary。

DO 构造通过 `blockConcurrencyWhile` 恢复 snapshot、pending、deadline 和 WebSocket attachment；
所有 transition 比较 phase/revision。alarm 是 at-least-once，故重复 alarm、submit 重试和
isolate eviction 必须无副作用。每次连接/重连递增并持久化 seat `connectionEpoch`，把
`{ side, epoch, socketId, ipLeaseId }` 写入 attachment；迟到 message/close/error 只有 attachment
仍匹配当前 epoch 才能改变 seat/grace，旧 socket 只幂等释放自己的 IP lease，不能把新连接
标成离线。

双方初始 active 怪物的 `public_refs` 在 match 初始化事务中分配并落库，任何首个 welcome /
observation 发出前必须已提交；后续怪物首次上场的 mapping 与产生对应公开 presentation 的
settle 事务一起落库。怪物退回 reserve 不删除映射；isolate eviction、重连及再次上场后继续
使用原 `publicId`。这样稳定性来自持久状态，而不是进程内随机表；表永不通过 wire 暴露
internal UID。

### 3.4 超时、重连与默认动作

Arena 只暴露 1,800 reference ticks（`battle/arena.ts:45-49,608-614`），没有规定网络 wall-clock
换算。wire v1 **新增协议选择**：沿用 presentation 的 60 Hz reference tick
（`battle/presentation.ts:1-3`），把它解释为服务端绝对时间 30 秒；改变换算必须升 wire/rules
version：

1. 第一方提交不重置 deadline。
2. deadline 到时只替缺失 side 调用确定性的 `defaultAction()`；双方都缺失时固定按 side 0、
   side 1 顺序提交（`battle/arena.ts:659-686`）。
3. 每次请求先检查过期，再处理 action；alarm 负责无人请求时最终收敛，不承诺毫秒准点。
4. 同一 GitHub id/accountVersion 重连恢复原 seat、自己的 `selfSubmitted`、observation 与剩余
   deadline；替换旧 socket，不重建 battle、不延长 deadline。
5. 建议连续离线 grace 90 秒：回合 deadline 继续，期间以默认动作推进；单方超过 grace 判负，
   双方超过则 abandoned。该值覆盖现有 1/2/4/8/10 秒重连退避
   （`pocketjs-wander/examples/wander-online/net/client.ts:490-519`），但属于待验收的产品策略。

一个 DO 只有一个 alarm。所有绝对 deadline 都持久化；任何 mutation 都把 alarm 重排为最早
值。alarm handler 在有界循环中处理全部已到期项并再次 `min(...)` 调度；同毫秒固定优先级为
`terminal/account grace > IP lease expiry > invite expiry > turn default > lease renew > usage/auth retry > retention cleanup`，所以
grace 判负不会在同一时刻额外推进一回合。超过单次循环预算的剩余工作设 `now + 1` 续跑。

### 3.5 限流、Meter 与预算

入口继续先调用 `MeterDO /gate`，接受后由合法的持久 reporter
`tux_<base64url(sha256(matchId))>`（22..64 个 `[A-Za-z0-9_-]` 字符）以单调 sequence 上报；
现有 `/report`、`/gate`、`/charge` 及 duplicate/gap 语义在
`pocket-online-server/src/meter.ts:147-228`，reporter 约束在同文件 `408-420`。usage outbox
必须先持久化再发送，失败保留 debt，
不能让 Meter 故障丢账或重复计费。

现有 IP counter 没有 lease identity，不能只在 BattleDO 记一个 id。Meter 需要新增持久、
内部认证的 lease API：调用方先生成随机 `leaseId`，`/ip/lease/acquire` 对同一
`(leaseId, ipKey)` 幂等、对 id 换 IP fail closed；`/ip/lease/release` 重复调用无副作用。
lease 带绝对 expiry，由 Meter alarm 回收，活跃 socket 以同一 id 有界续租；BattleDO 只有在
acquire ack 后接纳 socket。这样 acquire/release 响应丢失均可安全重试，旧 socket close 也只
释放自己的 lease。BattleDO 同时持久化 `leaseRenewAt/leaseExpiresAt` 并纳入单 alarm；若到
expiry 前仍未获得续租 ack，必须先关闭/冻结该 socket，不能让 Meter 已释放计数的连接继续
发送。原始 IP 不进入比赛 state、日志或 reporter id。

建议初始安全值（是待压测配置，不是实测容量）：

- invite：每账号和 IP 各 3/min，每账号最多 3 个 waiting，TTL 10 min；
- socket：10 messages/s、burst 20、JSON frame 1 KiB；每 seat 一个当前 socket；
- 每账号最多 2 场 waiting/active；每 decision window 每 side 只接受一个 action；
- 复用全局 IP concurrency 8；
- 沿用现有 Meter schema：upgrade -> `upgrades`，入站消息 -> `inboundMessages`，Auth、Battle
  Worker/其他非 Meter DO RPC 以及 alarm dispatch -> `doRequests`，active time ->
  `awakeSeconds`，alarm -> `wakeups`，SQLite read ->
  `storageRowReads`，write/delete 合并 -> `storageRowWrites`。replay bytes 只进独立 telemetry，
  不伪装成当前 Meter 计费字段；若要纳入 breaker，必须显式版本化扩展 Meter schema/ledger。
  Meter 自身的 `/gate`、`/report` 和 IP lease RPC **不**计入该 reporter 的 `doRequests`，否则
  flush 会递归制造下一笔 debt。创建 match 前做预算 reservation，hard budget fail closed。

对照：当前世界服务是 30 messages/s、512 bytes、IP concurrency 8
（`pocket-online-server/wrangler.toml:49-55`）。实现压测后再调参，不把世界房间速率直接复制
成回合制默认值。

### 3.6 Wire v1 与信息隐藏

wire version 与 `ARENA_VERSION` 分开，JSON 只用于低频控制帧并做 strict schema/size validation。
最小消息：

```json
{ "type": "hello", "v": 1, "caps": 3, "ticket": "...", "invite": "...", "requestId": "..." }
{ "type": "welcome", "v": 1, "arenaV": 1, "caps": 3,
  "side": 0, "turnRevision": 7, "deadlineAtMs": 0,
  "selfSubmitted": false, "observation": {} }
{ "type": "submit", "v": 1, "turnRevision": 7, "requestId": "...", "action": {} }
{ "type": "accepted", "v": 1, "turnRevision": 7, "requestId": "...",
  "selfSubmitted": true }
{ "type": "resolved", "v": 1, "turnRevision": 8, "deadlineAtMs": 0,
  "observation": {}, "presentation": [] }
```

`caps` 是无符号 32-bit 位集：bit 0 = `PUBLIC_PRESENTATION_V1`，bit 1 = `REPLAY_URL_V1`。
客户端 offer 可含服务端未知的新位；服务端只返回 `offer & supportedKnownMask`，双方始终忽略
未知位。缺失按 0；客户端只检查 welcome 是否包含自己的 required known mask。wire v1 把
bit 0 设为 Link 客户端 required mask；能力 endpoint 使用同一位定义。

- side/githubId 只来自认证 socket attachment；客户端不能指定。
- `submit` 必须匹配共享 revision 且 action 是该 side 当前 `legalActions` 的 value-equal 成员。
- 相同 requestId 重放原 reply；同回合不同 request 在已提交后稳定返回
  `ALREADY_SUBMITTED`。
- 单边 accepted 只回复本人；不给对手发送 revision、hash 或任何状态变化。
- settle 后分别发送双方自己的 `observe()`；重连也只返回该 side observation 和自己的
  submitted bit。
- 永不发送完整 `ArenaBattle`、对手 reserve、RNG、pending 或 mid-turn `stateHash`。

`observe()` 已隐藏对手未公开技能、reserve 与 RNG，并只给自己的完整 party/legal actions
（`battle/arena.ts:601-656`）。但它没有动画事件，且没有足够的公开实体 identity；重复 species
不能靠 slug 关联，而现有 scene/presentation 使用内部 monster uid
（`battle/arena.ts:132-175,638-652`、`ui/battle-scene.tsx:75-105`）。wire adapter 为己方使用
稳定 party index，为对手只在首次上场时分配
match/recipient-scoped opaque `publicId`，并在 observation、presentation 与 reconnect snapshot
中复用；该映射按 3.3 的 `public_refs` 持久化，退场、eviction、重连和再次上场不改变 id；
未上场 reserve 没有 id，内部 UID 永不出 wire。

`presentation-v1` 必须按 side 分别生成严格版本化 allowlist，只允许公开引用、动作/技能 slug、
可见 HP percent/status、动画 cue 和本地化 message key；禁止命中 roll、精确对手 HP/damage/stats、
内部 UID、RNG、reserve 或另一方 payload；原始 events 确实含 roll 与精确 damage 数据
（`battle/core.ts:241-260`、`battle/tuxemon.ts:1471-1495`）。不能把 `core.events` 原样发出。保密验收比较第一方
pending 前后及 settle 后双方的**完整 outbound frames**，不只比较 `observe()`。

## 4. Web 客户端

### 4.1 入口和构建隔离

不要给标题根菜单加第八行。当前有 manual save + autosave 时已经是 7 行；布局硬限制 1..7
（`ui/title-battle.tsx:27-35`），现有行组装见 `ui/title-battle-runtime.ts:304-315`。
设计为：

1. 顶层仍是现有 `Battle / 对战`。
2. desktop/PSP 保持当前行为，选择后直接进入本地难度页。
3. 只有 `globalThis.__pocketWeb === true`、构建注入了合法服务配置、且
   `/tux/v1/capabilities` 同时满足 `wireV=1`、`arenaV` 等于客户端内嵌
   `ARENA_VERSION`、以及 `(caps & LINK_REQUIRED_CAPS) === LINK_REQUIRED_CAPS` 时，Battle 内
   才先显示
   `Local Battle / 本地对战` 与 `Link Battle / 联机对战`。
4. Web 构建使用专属 app entry/manifest：它在共享游戏 bootstrap 上接入 Link controller/net/auth，
   并要求 `net.http`（能力探测）与 `net.socket`（比赛）；desktop/PSP 继续构建现有
   `main.tsx` 与主 `pocket.json`，后者不增加这两项。这是一项构建期变体，不依赖 guest 在
   运行时下载第二个 IIFE。PSP 不支持 socket capability，而 desktop 支持，单靠 socket
   capability 仍会错误显示 desktop 入口；UI 再用 Web shell 在 guest bundle 执行前设置的
   `__pocketWeb` 明确门控
   （`vendor/pocket-rpgkit/tools/web/player.js:1357-1363`）。

当前 RPG Kit Web player 只挂载/pump socket host，没有挂载 `net.http` host；仅在 manifest 写
capability 不会使 API 可用。Web host 前置任务必须把现有 `createNetHost` 接入 player 的
mount/reset/beginFrame，并有 contract test；完成前 Web manifest 不能宣告 `net.http`
（`vendor/pocket-rpgkit/tools/web/player.js:50-52,1380-1388,1478-1482`，现成 host 在
`vendor/pocket-rpgkit/vendor/pocketjs/hosts/web/net.js:117-247`）。

服务器只配置一个 HTTP base：构建参数 `--tux-battle-url` 或环境变量
`TUX_BATTLE_BASE_URL`。构建器解析无 userinfo/query/fragment 的绝对 HTTP(S) URL，保留 host、
port 与规范化 path prefix，输出 `{ httpBase, wsBase, trustedReplayBase }`；`wsBase` 只把
`http -> ws`、`https -> wss`，`trustedReplayBase` 则从 `httpBase` 安全 path join 固定的
`tux/v1/replays/` 前缀，endpoint 同样安全追加。不可变历史 replay player 内嵌该 release 的
`trustedReplayBase`，最终响应 URL 必须匹配其 origin 和 pathname 边界，而非只匹配 host。
生产只接受 HTTPS，loopback 开发可用 HTTP。
代码、默认配置和报告不写死部署地址或凭证；配置缺失/无能力/探测失败均是“不显示 Link”，
不影响本地 Battle。测试必须覆盖 path prefix、显式端口、尾斜线和 loopback。

### 4.2 画面、语言与输入

现有 `TuxemonBattleScene` 是 runtime state 的纯视图，已由标题 Battle 与回放复用
（`main.tsx:493-594`）。在线 adapter 负责：

- observation/public refs -> 自己/对手可见 party、HP、status、move menu；
- BTN 选择 -> `ArenaAction`，提交期间只锁自己的 menu；
- sanitized presentation -> 现有 60 Hz animation/dialog queue；
- reconnect snapshot -> 无动画重建当前画面；resolved event -> 播一次动画；
- ended -> 结果页、replay 链接，再安全返回标题。

英中选择继续用现有 `detectLang` 与 battle locale/name resolver；新增所有 Link/auth/error 文案
必须同时有 en_US/zh_CN。键盘与触屏已经走统一 BTN：标题 runtime 映射见
`ui/title-battle-runtime.ts:542-565`，真实浏览器回归已覆盖 Enter 与屏幕 RIGHT/CIRCLE
（`tools/verify-web-double-input.ts:269-315`）。浏览器 physical gamepad 当前没有实现；必须在
Web player 的 `buttons()` 聚合层新增 Gamepad API -> 同一 BTN mask（而不是 Link controller
旁路读取；当前只合并 keyboard/pad，见
`vendor/pocket-rpgkit/tools/web/player.js:1470-1482`），并测试连接、断开、轴 deadzone、确认/
取消 remap。这样标题、Local/Link 菜单与战斗共享行为；不能把 desktop/PSP controller 支持
当成 Web 手柄支持。

## 5. 回放

赛后路径不另造 battle scene，但播放器产物必须按解释器 revision 固定：

```text
TuxBattleDO last settled boundary / terminal
  -> LinkReplayEnvelope { engineRevision, dataDigest, tape,
                          preTerminalHash, terminalOverride? }
  -> server replay(envelope.tape) / stateHash 自校验
  -> 不透明、短时签名的 HTTPS JSON URL
  -> replays/<engineRevision>/replay.html?battleReplay=<encoded-url>&battleReplayExternal=1
  -> loadLinkReplayEnvelope -> revision/digest check
  -> prepareArenaReplay(envelope.tape) -> advanceArenaReplay
  -> arenaReplayRuntimeState -> TuxemonBattleScene
  -> 可选 terminal override 结果页
```

按本设计的 recipe-only v1，`BattleTape` 只有 tape format version、seed、公开 config 与成对
actions，不含 engine/data revision，也不放 GitHub id、ticket、invite、连接或 Meter 信息
（`battle/arena.ts:188-193,697-712`）。因此 `LinkReplayEnvelope` 必须另带
`engineRevision` 与 battle-data digest。发布前服务端完整 replay 并比较终态 hash；每个 Web
发布同时保留不可变的 `replays/<engineRevision>/` replay page/bundle/pak。该页面内嵌自己的
revision/digest，只接受完全匹配的 envelope；当前页面若收到旧 revision，给出对应历史播放器
链接，历史产物缺失则英中提示 incompatible 并 fail closed，绝不能用最新 Arena/DB 猜着播放。

当前 `BattleTape` 只能表达 reducer action pairs，不能表达服务层的 forfeit/abandoned；也不能
伪造成仅野战合法的 `run` action。回放任务应增加很薄的版本化 `LinkReplayEnvelope`：包含从
最后一个 settled boundary 构造的原始 tape、该 boundary 的 hash，以及可选 terminal override
`{ winner, reason, atTurn }`；单边 pending 不进入任何一项。新增 `loadLinkReplayEnvelope` 复用
有界 JSON source loader，先 strict-validate envelope，再把 `.tape` 交给 `prepareArenaReplay`；
现有 `loadArenaReplayTape` 会拒绝 envelope，不能直接复用它。所有战斗帧仍走 Arena replay 链，
最后只显示 override；engine 自然终局时不带 override。页面以显式 `kind` 分派 document，原有
raw `BattleTape` 输入仍走旧 loader，保持向后兼容。envelope 同样禁止身份字段。

strict semantic validation 还要求 `terminalOverride.atTurn === tape.actions.length`、
`preTerminalHash === stateHash(replay(tape))`；若 replay 已自然产生 terminal result，则 envelope
必须没有 override。forfeit/abandoned 只允许受控 winner/reason 组合，且 override 只修饰最后
一个 settled boundary，不能改变或追加 battle action。

短时签名 URL 是 bearer access，不等于内容签名。terminal override 只在来源 URL 匹配构建配置的
trusted replay HTTPS origin **及允许的 replay path prefix**、且 replay/tape hash 校验成功时
生效。`loadLinkReplayEnvelope` 必须保留 fetch 的最终 `Response.url` 与 source kind，信任判断
只看最终 URL；权威 envelope 禁止跨 origin/path redirect。任意外部/inline envelope 若带
override 就 fail closed，不得获得“权威赛果”标识。forfeit/abandoned 与所有 source 错误文案
都要有 en_US/zh_CN。

现有 loader 上限 4 MiB，跨源必须显式 `battleReplayExternal=1`、HTTPS、JSON MIME，且
`credentials: "omit"`（`battle/arena-replay.ts:38-64`、
`battle/replay-source.ts:142-197`）。因此 replay URL 本身应短时签名并允许游戏 Pages origin 的
CORS，不能依赖 cookie。实测最坏 2,048 回合 tape 106,662 bytes，远低于 4 MiB。Web build
已把 `replay.html`、bundle 和 pak 与普通游戏隔离（`tools/web.ts:108-149`）。

## 6. 实现任务拆分

### A. Arena Worker 打包、无损 checkpoint 与性能门禁

依赖：无。

交付：游戏仓导出的纯 server runtime/cooked revision；在线服务固定引用；独立 Battle Worker
和空 `TuxBattleDO`；完整 Arena 的无损分页/重组 storage codec 与跨 Bun/workerd determinism
fixtures。语义 compaction 不在硬范围内。

验收：Wrangler 上传成功并记录 `startup_time_ms`；包 < 8 MiB、used heap < 64 MiB；普通
single/double submit p95 < 10 ms（不含 storage），checkpoint 任一 row < 256 KiB；32+ seed
覆盖 turn-limit；没有 UI/assets/Node/Bun host import；相同 fixtures 在原状态、分页恢复和 replay
后的每回合 hash 一致。

### B. Auth、邀请、权威 match DO 与 Meter

依赖：A。

交付：profile-optional ticket verify、双 seat reserve/attach/release saga、可幂等重派的高熵
单次 invite、`/ws/tux/v1`、
SQLite 状态机、server G12 normal roster、WebSocket hibernation、connection epoch、单 alarm
deadline scheduler、持久 public-ref mapping、幂等 create/submit、usage/auth outbox，以及带
幂等 expiry lease 的 Meter 扩展。

验收：模拟测试覆盖两边各自 reserve/attach 的响应丢失、attach 前 TTL、孤儿 match 终止、
create 重试返回同一 invite、terminal+双 release outbox 原子性、release ack 丢失、账号删除中断恢复、
双方并发 submit、第一方 pending 后 eviction、settle 后 eviction、同毫秒 grace/alarm/第二方竞态、
重复 requestId、ticket/accountVersion 变化、invite 重放、同账号双 seat、旧 socket 迟到 close、
IP lease acquire/release/renew 丢响应、Meter 不可用直至 lease expiry 时 socket fail closed、
Meter 自调用不递归计费、90 秒断线策略和
hard-budget fail-closed；对手在单边 pending 前后完整 outbound frames byte-equal；首个 welcome
后立即 eviction/reconnect 时 initial active publicId 不变，后续 publicId 在分配后经历退回
reserve、eviction、重连和再次上场仍一致；
旧 `/ws`/`/ws/v4` 测试全绿。

### C. Web host 的 HTTP 与物理手柄基础能力

依赖：无；若落在 PocketJS 层，按一个问题一个最小上游补丁交付。

交付：RPG Kit Web player 挂载/reset/beginFrame 既有 bounded `createNetHost`；Gamepad API 在
player BTN 聚合层实现连接/断开、deadzone 与 remap；未声明 capability 的 app 不增加热路径。

验收：Web `net.http` contract 的 size/timeout/redirect/credentials/frame-batching tests 全绿；
synthetic Gamepad 与真实浏览器 smoke 都进入现有 BTN 路径；keyboard/touch 回归不变；无 NET/
Gamepad 使用的工程 bundle/每帧开销保持门禁。

### D. Web Link 客户端与在线 battle adapter

依赖：B 的冻结 wire schema 和 C；可先对 mock server 开发。

交付：能力探测、GitHub ticket 接入、Web-only Local/Link 子菜单、Web 专属 entry/manifest、
base URL config、invite 分享/兑换、connection-epoch reconnect、public-ref observation/presentation
adapter、英中 UI，以及键盘/触屏/浏览器手柄输入。

验收：Playwright 在 desktop/phone viewport 用两浏览器完成一局；验证 keyboard、touch、
physical gamepad；desktop/PSP 产物无 Link 文案/入口且 portable manifest 不要求 net；能力缺失、
旧 wire、Arena version 不匹配、required cap 缺失、断线重连、重复 species public refs、对手
pending 完整 frame secrecy 和双击 submit 均有测试；主 bundle/pak isolation receipt 保持。

### E. 回放发布与端到端可靠性

依赖：B；页面接线依赖 D。

交付：带 engine/data revision 的 `LinkReplayEnvelope` strict loader、终局 tape 自校验、
不可变历史 replay player 产物与精确版本路由、保留最终 URL 的 trusted-origin/path 短时签名
CORS URL、现有 replay scene 接线、英中 terminal/source copy、过期/删除策略、
match/replay telemetry 和端到端 fault injection。

验收：真人完成、默认动作、turn-limit 三类 tape 都可在现有 replay scene 播到相同终态 hash；
forfeit/abandoned envelope 可播到相同 last-settled hash 并仅从 trusted origin 显示权威赛果；
`atTurn`/pre-terminal hash/自然终局 override 错误、trusted URL 重定向到非 trusted origin/path、
同 origin 但 pathname 不在内嵌 `trustedReplayBase` 前缀、
URL 过期、错误 MIME、跨源无 opt-in、超 4 MiB、身份字段泄漏均 fail closed；部署新
engine/data revision 后，旧 replay 仍由匹配 revision 播放，历史播放器缺失则明确 fail closed；
断开任一一次
Auth/Meter/storage/replay 响应后重试不重复推进、不丢账、不发布半成品。

## 7. 风险与最终判定

- **主要技术风险不是 bundle，而是长局增长状态。** 2/32 seed 命中 2,048 回合，单 blob 已
  逼近 DO 2 MB 限制；A 的无损分页/重组是 B 的前置条件，语义 compaction 不是。
- **专用 Worker 是隔离边界。** 网关只做能力、Origin、Auth/Meter gate 与转发；约 80 ms 数据
  冷加载只发生在默认 30 s/event 的 DO，不影响现有服务的版本、故障域和普通请求 telemetry。
- **实时画面不能把 replay projection 冒充交互状态。** online adapter 只使用 observation 与
  脱敏 presentation；完整 tape 只在赛后公开。
- **本地队伍无法防作弊。** v1 的 G12 server rental 是上线边界；自带队要等认证长期存储。
- **报警与重连必须幂等。** absolute-deadline scheduler、connection epoch、共享/内部双
  revision、requestId cache 以及 durable usage/auth outbox 都是正确性条件，不是优化项。

没有发现不可行且无替代的阻断项；上述五项按依赖实施即可。

subagent 使用：4 个；分别审查引擎/Workers、防作弊队伍、服务协议安全、客户端与回放；并行只读审查节省了交叉核对时间，正式性能测量期间全部停止。

PASS

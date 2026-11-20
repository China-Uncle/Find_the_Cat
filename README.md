# 找猫 · Find the Cat

温暖糖果色的全栈逻辑闯关游戏：每行、每列、每个连通色块恰好一只猫，猫咪八邻域互不相邻。

## 本地启动

需要 **Node.js 22.13+** 与 npm；SQLite 使用 Node 内置 `node:sqlite`，无需安装数据库服务。部分 Node 版本会输出 ExperimentalWarning，不影响运行。

```bash
npm install
npm run setup
node seed_levels.js 200
npm start
```

访问 `http://localhost:3000`，点击“游客测试”即可开始。`npm run setup` 从 `.env.example` 创建 `.env`，自动生成两个随机密钥，**不会覆盖已有配置**。开发游客按浏览器 UUID 恢复进度、不进入公开排行榜；正式环境禁止游客登录。

> 采用“本地即时判定、通关一次验收”：服务端只下发色块，不下发答案；浏览器在载入关卡时用纯 JS MRV 求解器计算唯一解，单击/拖动标叉、双击放猫/移猫、判错扣心均为本地操作。找齐全部猫后才提交最终坐标，服务器独立核对题库答案、当前解锁关、局次与有效期，原子记分并解锁下一关。进入关卡、重开、登录和查榜仍需网络；载入后可断网继续操作，通关需联网验收。

## 文件结构与迁移边界

| 文件 | 职责 |
| --- | --- |
| `schema.sql` / `db.js` | SQLite 表、索引、WAL、事务和数据库连接 |
| `level_generator.js` | 纯 MRV 求解器、逻辑回放、连通区域生成、指纹去重、增量扩容 |
| `seed_levels.js` | CLI 和后台 Worker 共用的扩容入口 |
| `practice_service.js` | 管理员隔离试关局次，不修改正式进度/榜单 |
| `game_service.js` | 服务端开局计时、最终答案验收、进度锁、幂等成绩、排行榜；保留旧逐步接口兼容 |
| `server.js` | Express 路由、GitHub OAuth、Bearer JWT、管理员鉴权 |
| `public/index.html` | CSS、SVG、本地 `PuzzleSolver` / `GameEngine`、`PlatformAdapter`、触控坐标和 UI |
| `scripts/setup_env.js` | 无覆盖安全初始化配置 |
| `scripts/audit_levels.js` | 只读遍历现有题库，验证唯一解、连通性、答案和指纹去重 |
| `tests/` | 算法、数据库、业务与前端逻辑回归 |
| `docs/legacy-standalone.html` | 原单文件版本备份 |

`PuzzleSolver` / `GameEngine` 不访问 DOM、网络或存储。网络、持久化由 `PlatformAdapter` 收口；视图层负责渲染与坐标映射。迁移小程序时可以复用引擎和坐标公式，将适配器改成 `wx.request` / `wx.setStorageSync`，再替换 WXML/WXSS 视图。账号以 `(auth_provider, open_id)` 唯一标识，已为 `wechat` 预留；实际微信登录接口仍需届时实现，并非已经接入微信。

## 算法与难度

1. 回溯随机生成每行、每列各一只且不相邻的猫终局。
2. 从猫种子多源随机扩张连通色块，控制区域大小，拒绝单格废区。
3. 精确 MRV 求解器优先分支候选最少的行/列/区域；找到第二个解立刻停止。未完成校验、无解、多解均不能入库。
4. 使用可解释的候选排除/唯一位置规则回放检查；唯一解本身不等于一定能用指定简单规则解出。
5. 对颜色标签、旋转、镜像归一化，计算 SHA-256 指纹；数据库 `UNIQUE(size,map_hash)` 再次兜底防重。

关卡尺寸：1–5 为 4×4，6–15 为 5×5，16–35 为 6×6，36–65 为 7×7，66–100 为 8×8，101–135 为 9×9，136–170 为 10×10，171 及之后全部为 11×11。**第 136 关是 10×10 / 10 只猫**，不按需求示例中的 `1/11` 处理。

拒绝采样生成有有限重试与搜索预算，超限会明确失败，不会发出未经验证的关卡。单次耗时取决于尺寸、随机种子和硬件，**不承诺所有关卡严格低于 100ms**。管理员生成在 Worker 中运行，避免堵住 Web 主线程。随机种子作为元数据存储以便复查。

## 无缝追加题库

```bash
# 初次运行追加 200 关
node seed_levels.js 200
# 之后在已有最大编号后继续追加 100 关（例如 201–300）
node seed_levels.js 100
# npm 入口也支持参数
npm run seed -- 50
```

使用同一个 `DATABASE_PATH`，无须重置进度或重启 Web 服务。CLI / 管理员 Worker 共用 SQLite 任务租约，禁止并行生成竞争。逐关事务提交；失败保留已生成前缀，下次从最新最大 ID 继续。总关数始终查询数据库，不固定为 200。单次数量 1–1000；当前末关通关后保留 `current_level=末关+1`，追加后刷新即可继续。

管理员界面：“＋ 扩展题库” → 输入数量和管理员密钥 → 后台生成 → 轮询显示新增数量与总数。密钥不写入前端源码或浏览器持久化存储。

## 本地判定与联网边界

- 每次载入关卡，`PuzzleSolver` 对地图做精确 MRV 搜索（第二解立即停止）；非唯一解会拒绝载入，不用错误答案继续游戏。解只保留在逻辑层，不进入接口响应或本地草稿。
- 单击/拖动标叉、双击放猫/移猫、错误红框和三心均即时执行，没有逐格 HTTP 请求。单击已有猫不操作，双击才移走。
- 本地草稿以 JSON 持久化，按账号、正式/试关模式和局次隔离，并校验关卡、地图、尺寸与服务端修订号。每次操作保存叉号、已找猫和剩余心数；隐藏页面、离开页面时另做尽力保存，加载中的盘面不刷写。普通刷新或切换模式会在同一有效局次恢复；零心失败不会因刷新复活。重开产生新局次，不沿用旧草稿。
- 同账号、模式、局次、关卡、地图和尺寸都匹配但修订号变化时，只合并合法手动叉号，服务端已有猫优先，不回灌旧猫、旧心数或失败状态。若旧草稿心数更少（含零心失败），或本地已找齐而服务端尚未找齐，则锁定该局并提示明确重开；刷新或同步同一局不会解除锁定，服务端已完成/失败的终态优先。
- 被拒绝或冲突的草稿经结构和大小限制后，按账号/模式最多保留一个最近冲突备份（`local-run:<账号>:<模式>:conflict`，不超过 16 KiB），避免被合并结果立即覆盖；重复保存不替换原备份。备份写入失败时保留原持久化草稿，并仅在内存中保存后续状态；无自动恢复备份入口。不同设备/浏览器之间不实时同步未提交盘面。存储被清理、不可用或系统直接终止页面时不能保证恢复；旧版从未保存的叉号也无法补找回来。
- 已载入的棋盘在断网后仍可本地操作；找齐后若提交失败，保留全部猫和剩余心，显示“重试结算”。同一页面正在提交时禁止重复提交或切换局次。开局和刷新恢复仍需要联网获取有效局次，不提供离线加载页面的保证。
- 计时显示包含后台/隐藏标签页经过的墙钟时间；切回页面或重开后会继续更新，最终计榜仍以服务端时间为准。
- 正常通关调用 `/api/game/submit`，管理员试关调用 `/api/admin/practice/submit`；通常每关一次提交。网络失败可重试，首次成功用时保持不变，不重复记榜。
- **安全取舍**：三心属于本地休闲体验，不再保证服务端掌握每次错误。用户可以篡改浏览器状态或自行求解，本系统不是严格反作弊系统。服务端不相信客户端的用时、心数、通关标记，仍要求真实题库答案、所属局次、当前解锁关及有效期；用时以服务端开局到第一次成功收到最终答案为准，包含网络等待/离线/重试时间，客户端不能压低计榜时间。
- 保留旧 `/move`、`/complete` 接口兼容尚未刷新的旧页面。旧接口仍走原来的服务端三心与逐步校验，新界面不调用它们。无需重新登录、重置题库或清空已有局次。

## 通关后继续

通关后状态栏的“重新开始”会变为“继续下一关”（试关模式为“试下一关”），棋盘下方保留“查看通关结果”。误关闭结算弹窗也能继续，不必刷新或重打；网络失败时入口仍保留，可安全重试。当前题库全部完成后按钮改为“检查新关卡”，不会重新计分。结算网络失败时则显示“重试结算”，服务端幂等防止重复写成绩。

## 管理员账号与双模式

在**服务器已有** `/opt/find-the-cat/.env` 中设置：

```dotenv
ADMIN_GITHUB_USERNAME=China-Uncle
# 可选：追加管理员，逗号分隔，原单账号配置继续生效
ADMIN_GITHUB_USERNAMES=chinauncle
```

这里填 GitHub **登录用户名**（个人主页 `github.com/用户名` 中的部分），不是昵称、邮箱或仓库名。不加 `@` 或网址；匹配忽略大小写，但连字符不能省略，例如 `China-Uncle` 与 `chinauncle` 是两个不同账号。两个配置合并为管理员名单，空值不授权。示例 `China-Uncle` 请按实际登录账号替换。修改后执行 `systemctl restart find-the-cat`，刷新页面并使用该 GitHub 账号登录。后端每次请求都校验数据库账号与服务器配置，不相信客户端 `isAdmin`。未匹配的用户和游客没有管理权限。**不要重建 `.env`、不要修改已有 OAuth/JWT 密钥或 3002 端口，也不需要改 OAuth 回调地址。**

管理员登录后有两个独立入口：

- **模式：正常 / 模式：试关**：默认正常模式。正常闯关仍按顺序解锁、正常扣心和计榜。点模式按钮输入任意已生成关卡号进入试关；试关内的关卡列表全部可选，允许重复玩。试关仍有三心、判错、重开和用时，但不写正式成绩、不解锁正式关卡，也不修改题库答案。
- **＋ 扩展题库**：仍需要额外的 `ADMIN_SECRET`，仅该功能会向题库追加关卡。已有有效密钥不必重置；不要把密钥提交到仓库或发送给前端持久化保存。

两种模式分别使用 `runs` 和 `practice_runs` 保存服务端局次，旧逐步兼容接口另用 `run_moves` / `practice_moves`；服务端接口隔离；试关局次不能提交到正式计分接口，反之亦然。返回正常模式会恢复服务端的正式局次，同浏览器且局次/修订匹配的手动叉号、已找猫和剩余心数也会从本地草稿恢复（修订冲突按上述规则处理）。正式计时按墙钟运行，切到试关不会暂停正式计时。首次登录默认正常模式；刷新页面会恢复该账号最近成功进入的模式和试关关号，非管理员不会恢复试关模式。旧题库和玩家进度不迁移、不清空；首次启动仅增建试关用表。

试关不是“改当前关号”或编辑题库。它不需要输入扩容密钥，但所有试关接口都必须具有有效 JWT 和服务端确认的 GitHub 管理员身份。管理员本来就能读题库，管理员试关不应被理解成对管理员的严格反作弊隔离。

## GitHub OAuth 与生产部署

在 GitHub Settings → Developer settings → OAuth Apps 新建应用：

- Homepage URL：你的 HTTPS 站点根地址
- Authorization callback URL：`PUBLIC_URL` + `GITHUB_CALLBACK_PATH`（默认 `/api/auth/github/callback`）

编辑 `.env`（只在服务器保存，禁止提交到 Git）：

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
PUBLIC_URL=https://cat.example.com
GITHUB_CALLBACK_PATH=/api/auth/github/callback
DATABASE_PATH=./data/cats.sqlite
JWT_SECRET=请替换为至少32字符的随机密钥
GITHUB_CLIENT_ID=你的OAuth应用ClientID
GITHUB_CLIENT_SECRET=你的OAuth应用ClientSecret
ADMIN_GITHUB_USERNAME=你的GitHub登录名
ADMIN_SECRET=请替换为至少24字符的随机管理密钥
ALLOW_GUEST_LOGIN=false
TRUST_PROXY_HOPS=1
RUN_TTL_HOURS=24
```

`PUBLIC_URL` 只能是站点来源，不支持挂在子路径。仅在确实有一层受信反向代理时使用 `TRUST_PROXY_HOPS=1`；应用直连保持 `0`。使用 HTTPS 终止代理转发到 `127.0.0.1:3000`，不要将 SQLite、`.env`、仓库根目录暴露为静态目录。静态根只能是 `public/`。生产要求 HTTPS，关闭游客登录，并验证 OAuth 配置。

OAuth 使用单次 state、PKCE、浏览器随机挑战绑定和短时单次交换票据。回调 URL fragment 仅携带交换票据；JWT 不进入 URL。后续请求统一 `Authorization: Bearer <token>`，不依赖 Cookie。JWT 7 天有效，退出会删除本地凭证，失窃 token 在过期前不能单独即时撤销；需要撤销时轮换 JWT 密钥会使所有 token 失效。不要在浏览器输入来路不明的脚本。

生产建议由 systemd / 容器管理进程，配置失败重启与日志轮转。备份数据库使用 SQLite 在线备份（或停服后完整备份），不要在 WAL 写入中只复制主 `.sqlite` 文件。

## API 概览

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/config`, `/api/health` | 登录开关、题库总数、健康状态 |
| POST | `/api/auth/guest` | 仅开发：`{guestId,username?}` |
| GET | `/api/auth/github/start?browser_hash=...` | 获取 GitHub 授权 URL |
| GET | `GITHUB_CALLBACK_PATH`（默认 `/api/auth/github/callback`） | 处理 OAuth 回调 |
| POST | `/api/auth/exchange` | `{ticket,browserSecret}` 换 JWT |
| GET | `/api/me` | 当前用户、管理员状态和总关数 |
| GET | `/api/levels?offset=0&limit=50` | 分页关卡状态与历史成绩 |
| POST | `/api/game/start` | `{restart?:boolean}` 恢复或重开当前关 |
| POST | `/api/game/submit` | 新界面最终一次验收：`{runId,levelId,cats}`，服务端计时并幂等计榜 |
| POST | `/api/game/move` | `{runId,requestId,revision,cell,operation}`，operation 为 `place` / `remove` |
| POST | `/api/game/complete` | `{runId,levelId,cats}`，cats 是行优先格子索引数组 |
| GET | `/api/levels/:id/top3` | 单关最快三名 |
| GET | `/api/leaderboard?offset=0&limit=50` | 通关数降序、总耗时升序 |
| POST | `/api/admin/practice/start` | 管理员试关：`{levelId,restart?:boolean}`，不改正式局次 |
| POST | `/api/admin/practice/submit` | 管理员试关最终验收：`{runId,levelId,cats}`，不写正式成绩/进度 |
| POST | `/api/admin/practice/move` | 管理员试关放猫/移猫，字段同正式 move |
| POST | `/api/admin/practice/complete` | 管理员试关结算，不写排行榜或正式进度 |
| POST | `/api/admin/generate-levels` | `{count}`；同时要求管理员 JWT 和 `X-Admin-Secret` |
| GET | `/api/admin/generation-jobs/:id` | 管理员查询任务进度 |

每个账号的每种模式仅一局有效，重开会使旧页面局次失效。新的 `submit` 接口仅验收完整正确答案，以服务端开局至第一次成功验收的时间计榜；不接受前端传来的用时/心数作为权威证据。事务与唯一约束保证重试不重复推进或写成绩。旧逐步接口继续用 `requestId` / `revision` 幂等回执。已通关不允许重玩刷成绩（管理员隔离试关除外），过期局次会在重新载入时自动换新局。

## 测试

```bash
npm test
```

测试使用临时 SQLite，不会写入正式题库。纯算法/业务测试无需第三方依赖；HTTP 集成测试需要先 `npm install`。真实 GitHub 端到端登录需要有效 OAuth App 和可联网的部署环境，单元测试只模拟上游响应，不能替代真实授权验收。

## 已有题库全量核验（只读）

```bash
# 默认使用 .env / DATABASE_PATH；不指定则读取 data/cats.sqlite
node scripts/audit_levels.js
# 指定线上库并保存逐关报告（只读连接，不运行建表、不改关卡或玩家数据）
node scripts/audit_levels.js /opt/find-the-cat/data/cats.sqlite --json > /tmp/find-cat-audit.json
```

审计不把已有答案作为求解前提：每关从空盘开始精确 MRV 搜索，发现第二解即判失败；同时检查区域四邻接连通、存储答案及地图指纹，重新计算旋转/镜像/颜色重命名归一化指纹做同尺寸全局去重。所有关卡均检查完成才汇总，进程退出码 `0` 表示全部通过，`1` 表示异常或无法完成。发现异常只报告，不自动删除、重排或覆盖运营中的关卡；先备份再评估修复，以保护玩家进度。

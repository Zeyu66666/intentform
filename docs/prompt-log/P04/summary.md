# P04 · 闭环数据层（SQLite 快照 / 登录 / 提交判分 / 看板 CSV）

- 迭代：`I4` · 日期：`2026-10-26` · 涉及模块：`server`（`db` / `auth` / `*route` / `seed`）、`web`（`api` / `fill` / `dashboard` / `auth` / `router`）、根 `scripts/verify.mjs`
- 会话导出：`raw-20261026-i4-server.md`（已脱敏；DSH 会话无 `/export`，该文件为提问原文 + 交付动作整理，已在文件头注明）
- 上游依赖（`pnpm --filter @intentform/server add --save-exact`）：`better-sqlite3@13.0.3`、`@node-rs/argon2`（预编译二进制，免 node-gyp）；dev：`@types/better-sqlite3@9.6.0`
- 数据层选型变更：**用 `better-sqlite3` 而不是 `node:sqlite`**（用户 m00984 直接指定）。原计划 I4 写的是 `node:sqlite`，换成 better-sqlite3 的代价是 `pnpm-workspace.yaml` 要放行原生构建（`allowBuilds: better-sqlite3: true`），收益是仓储层可以写同步事务、`prepare` 复用与 `PRAGMA` 控制。

## 提问

这轮我把 I4 拆成两个共享任务，派给 `persistence`（`server/src` + `scripts/verify.mjs`）与 `fill-ui`（`web/**`），brief 与 I2/I3 同形态，八项要素 + 四条硬约束：

- 写作用域互斥；`packages/schema/**` 只读，缺类型来找我。
- 不许任何 git 命令，不许 spawn 子队友，不许新增依赖（better-sqlite3 与 argon2 我已提前装好并单独提交）。
- 学生端只能经 `publicView()` 出数据；**填答页 DOM 里连分值都不许有**。
- 交付必须贴验收命令的实际输出。

开跑前我先落盘两份契约，避免两个人各自发明 HTTP 形状：

1. `packages/schema/src/api.ts`（`c496e4e`）：路径表、8 个错误码与状态码映射、登录/建表单/发布/提交/看板的请求与响应 Zod Schema、`VERSION_CONFLICT_MESSAGE`、CSV 列定义。放在 `schema` 而不是新包的**理由写在文件头**：`AGENTS.md` 规定 `web` 只能依赖 `schema`，契约若写在 `server` 里，前端就得手抄一遍形状。
2. `06bcaf9`：只装依赖、只改 `pnpm-workspace.yaml` 与 `.gitignore`（补 `*.db-wal` / `*.db-shm`），零业务代码——这样队友动手时 `pnpm install` 已经不再需要跑。

## AI 修改建议

1. **AI 建议加一个 `packages/contracts` 包或 `openapi.yaml` 做前后端契约**。否决：`web` 只被允许依赖 `schema`，多一个包就要改 `paths`、workspace 与三条 typecheck 命令，收益是"看着更正规"。把契约放进 `schema` 的 `api.ts`，前端 `import type` 直接用，一行配置都不用动。
2. **AI 提议 I4 换成 Hono（原计划就是这么写的）**。否决，并把理由写进 `server/src/main.ts` 的文件头注释：本作品的难点在"分帧 + 背压 + 断开取消"，框架会把它藏起来；路由表 + 三个横切点（CORS 预检、跨站写保护、错误兜底）手写几十行，换来评审能把整条 HTTP 链路一次读完。计划偏离已记在下面的表里。
3. **AI 建议给 `form_versions` 的追加式加一层仓储 API 保护即可**。我改成**数据库触发器**（`form_versions_append_only_update` / `_delete` 都 `SELECT RAISE(ABORT, ...)`）：约定靠自觉，约束靠引擎。同时仓储层干脆不提供 update/delete 版本的函数——两道都留着。
4. **AI 建议 `db/index.ts` 开 WAL**（并发读更顺）。我先让它**关掉**：WAL 会在库旁边生 `*.db-wal` / `*.db-shm`，当时 `.gitignore` 只忽略 `*.db`，一旦 `DATABASE_PATH` 指到仓库里就会把两个临时文件带进提交。做法是先把忽略规则补上（`26f59fc`），WAL 留到有真实并发时再开，并在注释里写明"现在不开是因为单进程 + 演示规模"。
5. **AI 建议 CSV 加 UTF-8 BOM**，理由是 Excel 双击不 BOM 会把中文显示成乱码。这个建议**有道理但我否决了**：BOM 会让 `curl` / `pandas.read_csv` / 我们自己的 `verify.mjs` 在首列多出一个不可见字符，毒化"字节级检查"这条证据链。折中是保留无 BOM，把代价写进注释与交付话术（"用 Excel 请走「数据 → 从文本/CSV」"）。这是典型的"两种都有人骂"的选择，必须显式记录选了哪个。
6. **AI 建议登录失败计数按 IP 而不是按邮箱**。采纳一半：`login_attempts` 的 key 用 `sha256(email)`（不额外多存一份 PII），同时把"每 IP 每路由"的限流交给 `rate-limit.ts`（submit 30/min、generate 10/min）。**没做的是登录路由本身的 IP 限流**——见"已知缺口"。

## 我如何引导 AI 修复 Bug

本轮 7 个真实问题，按发现顺序：

1. **两个 secret-scan 假阳性**（`server/src/testing/harness.ts:26` 的 `TEST_SESSION_SECRET`、`scripts/verify.mjs` 的写死会话密钥）。
   前者是测试常量，处理方式是加 `// secret-scan:allow` 并在上一行写清"只在本进程内存库里签 cookie，不是任何环境的凭据"——**允许标注，但必须写理由**，否则下一个读代码的人会以为这是逃检。
   后者我改了做法：`const SESSION_SECRET = \`verify-session-${randomUUID()}\``。校验脚本不需要跨运行保持同一密钥（服务进程和客户端在同一个脚本里），现生成就不存在"写死"这件事，比加标注更干净。
   教训：假阳性的正确解法是**换掉触发形状**，而不是关规则。

2. **`fill-ui` 全线 403**：它把 vite 代理指向后端后，每个写请求都被跨站写保护拒掉。根因是 `changeOrigin: true` 把 `Host` 改写成后端地址，于是服务端推导出的允许来源（`http://127.0.0.1:8788`）和浏览器真实 `Origin`（`http://127.0.0.1:5199`）不一致。
   修法不是放宽校验，而是**把"服务端认哪个来源"打印到启动日志**（`main.ts` 的 `origin:` 行 + 代理改写 Host 的警告），并让 `APP_ORIGIN` 成为显式配置。这类 bug 的症状永远是"缺 Origin / Origin 不被允许"，唯一能解释它的信息就是这一行日志。

3. **问卷的平均分永远是 `null`**。`fill-ui` 报的：问卷没有分值，`maxScore` 恒为 0，原来的 `avgScore` 用 `maxScore === 0 ? null : ...` 判，于是问卷看板永远显示"—"。
   修法：只有 `count === 0` 才 `null`，`maxScore: 0` 时 `avgScore: 0`（问卷的"平均分"就是 0，不是"没有数据"），并把这条写进注释与测试。

4. **填空判分只认全角 `／`**。中文输入法下学生打的是全角，但答题卡也允许半角 `/`。
   修法：`grading.ts` 用 `/[／/]/` 切；但**单空题不切**——`1/2` 这类答案里的斜杠是内容不是分隔符。这条边界是 AI 主动补的，我确认后保留。

5. **zod 的英文原文漏到界面**（`String must contain at least 8 character(s)`）。
   修法：`http.ts` 加 `describeZodError()`，把所有校验失败包成中文并指向具体字段；登录页只显示服务端 message。

6. **`.env.example` 里我写了 `WEB_INDEX_HTML`，但服务端启动时不校验它**（`f83773b`）。
   过程是诚实的：我先在 `.env.example` 的注释里写"路径不存在会在启动日志里报出来"，随后读 `main.ts` 发现这句话当时是假的。两个选择——改注释或实现它。我实现它：`existsSync` 判一次，存在就打 `html: <path>`，不存在就打警告并说明"HTML 请求会退回 404 JSON，先跑 `pnpm build:web`"。理由是**配错这项的症状发生在学生扫码那一刻**，那时人已经不在终端前了。
   这条算本轮最值得记的一次自查：注释里的每一句都应该是可以验证的行为。

7. **逐 commit 验证脚本连续误报 `FAIL`**。
   第一版在 worktree 里 `npx tsc -p tsconfig.json`——仓库根根本没有 `tsconfig.json`（只有 `tsconfig.base.json`），所以每个 commit 都 FAIL。改完 tsconfig 路径后又发现 `npx --no-install tsc` 在 worktree 里解析不到 bin，且 `web` 缺 `vite/client` 类型（目录联接对 pnpm 的相对符号链接不友好）。
   最终换办法：**在主工作区逐个 `git checkout <hash>` 后跑 `pnpm -r typecheck`，跑完回 `main`**。8 个 commit 全部 `OK`。
   教训：辅助脚本报"全红"时，先怀疑脚本。这次如果信了第一版输出，就会得出"8 个 commit 全都编译不过"这种荒谬结论。

## 结果

| 验收门 | 结果 |
| --- | --- |
| `pnpm typecheck` | 4 包全 Done |
| `npx vitest run` | **50 文件 / 530 用例全绿**（I4 新增 24 文件、约 200 用例；连跑两次稳定） |
| `npx oxlint --deny-warnings packages server web scripts` | 0 warning 0 error |
| `pnpm build:web` | 成功（`index-*.js` ≈531 kB，>500 kB 提示条保留，理由见 P03） |
| `node scripts/verify.mjs` | **VC1/VC2/VC3 全通过（3/3）**，`exit 0` |
| 逐 commit typecheck | 11 个 P04 commit 全 `OK`（方法见上面 bug 7） |
| 浏览器实测（CDP，无 playwright） | 登录→看板→学生填写页→提交→CSV，见下 |

浏览器实测（1280×800 与 390×844，服务器 8788 + vite 5180 + 临时库）：

- `/login`：邮箱/密码/提交三件套都在，登录后 `location.pathname === "/dashboard"`。
- `/dashboard`：提交数 24、平均分 15.2、满分 25、版本 v1、学生链接 `/f/saa95twb6z`、提交记录 24 行、导出按钮 `/api/forms/f_9d5c3c1af9b2db93/submissions.csv`。
- `/f/saa95twb6z`（390×844）：`innerWidth 390 / scrollWidth 390`，**无横向滚动**；正文里 `answer` / `explanation` / `bloom` / `knowledgePoint` / `objectives` 五个键**一次都没出现**，`documentElement.outerHTML` 也不含 `explanation`；KaTeX 公式正常渲染；选项行高 44px（触控目标）。
- 空提交：`role="alert"` 提示「这是必答题，请先填写」，页面不跳转。
- 填完提交：页面变「0 / 25 分 · 答案已记录，可以关闭这个页面」（脚本全选第一个选项，故 0 分；判分正确性由 `verify.mjs` VC2 的 5/25 与单测覆盖）。新提交使总数 24 → 25。
- CSV：`status 200`，表头 `submission_id,created_at,score,max_score,q1-vertex,q2-axis,q3-roots,q4-min,q5-sum`，**无 `answer` 列**，25 行。

commit 表（`git log a6d1f3a..HEAD` 中本轮 11 条）：

| commit | message |
| --- | --- |
| `c496e4e` | feat(contract): freeze the I4 api surface for auth, forms and submissions [P04] |
| `06bcaf9` | build(server): add better-sqlite3 and argon2 for the I4 persistence layer [P04] |
| `577557f` | feat(server): sqlite schema with append-only versions and repository layer [P04] |
| `2769f9e` | feat(auth): teacher login with signed session cookie, csrf guard and rate limiter [P04] |
| `60112ee` | feat(server): publish snapshot, fill view and version-conflict submission [P04] |
| `26f59fc` | feat(server): wire i4 routes, dashboard csv, demo seed and real verify checks [P04] |
| `f64376e` | feat(web): http client, hand-rolled router and shared formatters [P04] |
| `80db292` | feat(web): mobile fill page that renders only the public view [P04] |
| `b8b9758` | feat(web): teacher dashboard v1 with csv export entry [P04] |
| `a31b73d` | feat(web): wire fill, dashboard and login pages behind one route shell [P04] |
| `f83773b` | docs(server): document WEB_INDEX_HTML and warn at boot when it points nowhere [P04] |

## 相对计划的偏离

| 计划原文 | 实际做法 | 原因 |
| --- | --- | --- |
| I4 的 6 条 commit（auth / publish / mobile fill / grading / dashboard / seed） | 11 条：契约单独一条 + 依赖单独一条 + 持久层/鉴权/发布提交/接线四个后端 commit + web 四个 commit + 文档一条 | 契约与依赖必须排在任何业务代码之前（否则队友开工时 `pnpm install` 没跑、类型不存在）；diff 粒度按可回滚单元切，不按功能名切 |
| 「I4 用 Hono 替换 `node:http` 这一层」 | 不换，保留手写路由表 | 见 AI 建议 2，理由写进 `main.ts` 文件头 |
| 数据层用 `node:sqlite` | `better-sqlite3@13.0.3` | 用户 m00984 直接指定 |
| `scripts/verify.mjs` 是 I0 的失败占位 | 实现 VC1/VC2/VC3，自带起服务与临时库 | 计划 I4 要求"快照验证不依赖 Patch UI"，校验必须是真跑 |
| —— | 新增 `x-intentform-llm-mode` 之外的启动日志三行（db / origin / html） | 这三项配错都会表现为"能起服务但页面全错"，日志是最便宜的诊断面 |

## 已知缺口

1. **登录路由没有 IP 级限流**：`login_attempts` 按 `sha256(email)` 锁 15 分钟（5 次失败），但攻击者换邮箱枚举密码时不受 IP 约束。生成与提交两条路已按「IP × 路由」限流。
2. **`.tsx` 组件没有自动化测试**：`vitest.config.ts` 只收 `.ts`。I4 的页面逻辑该抽的都抽到了 `.ts`（路由、答案状态机、CSV 组装、失败分类），交互行为靠 CDP 手跑留证；真机截图在仓库外 `D:\project1\.scratch\`。
3. **版本冲突只在 API 层验证过**（`verify.mjs` VC2 的 409 + `fill/errors.ts` 的单测），浏览器里没有真跑一次"打开旧页 → 别处重新发布 → 提交被拒"。原因：换版需要在演示过程中改库，留到 I5 的浏览器闭环一齐做。
4. **CSV 无 BOM**（见 AI 建议 5），Excel 双击中文乱码，需走导入向导。
5. **看板只有提交时间与得分两列**，没有逐题分布，与《计划》"数字表 v1"一致，图表留给 I6。
6. **没有做 `usage_daily` 的写入口**：表建好了，但生成链路的 token 统计还没落库（I6 的意图控制面板要用），现在只有 `usage` 事件。

## 脱敏记录

- 本文件与 `raw-20261026-i4-server.md` 里的会话密钥、邮箱、教师口令全部是演示用虚构值（`teacher@example.com` / `intentform-demo`）；`DATABASE_PATH` 指向 `.tmp/` 与 `./data/`，未入库。
- 真实 `SESSION_SECRET`、任何上游 LLM Key 从未出现在会话、日志或仓库中；`verify.mjs` 的密钥改为每次运行现生成。
- 学生提交的 IP 只存 `sha256(SESSION_SECRET + ip)`；不存完整答卷到任何日志。

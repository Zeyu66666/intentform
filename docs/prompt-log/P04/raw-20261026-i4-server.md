# P04 原始会话记录（I4 · 数据层 / 登录 / 提交判分 / 看板）

> 整理说明：DSH 会话没有 `/export`，本文件是**提问原文 + 交付动作的整理**，不是逐条转录。
> 凡是我没在会话里说过的句子都不会出现在这里；凡是交付里的数字都来自当轮命令的真实输出。
> 已脱敏：演示口令、邮箱、会话密钥均为虚构值。

## 1. 用户提问（原文）

- m00801：`把I3收尾 survey 契约按审查附录 A 改 DSL`
- m00984：`继续 使用 better-sqlite3`

（更早的 m00684 `补齐`、m00675 `I2做完了吗` 属 P02 范围，已在 `P02/summary.md` 记录。）

## 2. 我派给队友的任务书要点（原文摘录）

### `persistence`（task-3，写作用域 `server/src` + `scripts/verify.mjs`）

- 项目一句话：意卷 IntentForm，教师说一句需求 → 生成一份可发的卷子；本迭代做**闭环**：发布的卷子学生能填、能判分、老师能看见数。
- 本次目标对应《计划 v3.0》§4.1 I4 行：登录、快照、手机提交、客观判分、数字表、CSV、收集页回收、**版本冲突拒绝**。
- 硬约束：`packages/schema/**` 只读；不许任何 git 命令；不许 spawn 子队友；不许新增依赖（`better-sqlite3` 与 `@node-rs/argon2` 我已装好并单独提交）。
- 数据契约：六表结构见任务书；`form_versions` **追加式不可改**；发布 = 写 `published_version_id` 指针；学生端只经 `publicView()`。
- 验收：`pnpm typecheck`、`npx vitest run server`、`npx oxlint --deny-warnings server scripts`、`node scripts/verify.mjs` 全绿，且**贴实际输出**。

### `fill-ui`（task-4，写作用域 `web/**`）

- 三个页面：`/login`、`/dashboard`、`/f/:slug`；不装路由库、不装表单库、不装 UI 库。
- `fill` 态**绝不渲染**答案/解析/分值/bloom/知识点；学生页 DOM 里连分值都不许有。
- 409 → 显示契约里的 `VERSION_CONFLICT_MESSAGE` + 刷新按钮，**不自动 reload**。
- 验收同上四件套 + `pnpm build:web`。

## 3. 我落盘的两份前置产物

1. `packages/schema/src/api.ts`：路径表 / 8 个错误码与状态码映射 / 各接口的请求与响应 Zod Schema / `VERSION_CONFLICT_MESSAGE` / CSV 列定义。契约放 `schema` 的理由写在文件头（`web` 只能依赖 `schema`）。
2. 装依赖 + `pnpm-workspace.yaml` 放行 `better-sqlite3` 原生构建 + `.gitignore` 补 `*.db-wal` / `*.db-shm`，单独一条 commit，让队友开工时不用再跑 `pnpm install`。

## 4. 我对交付的裁决（发给队友的原话要点）

- publish 跑整表 `validateForm` 门禁：**保留**，但失败响应要带前 3 条 `错误码@路径` + 总数，否则教师看到「未通过校验」无从下手。
- 重复发布**复用旧 slug**：保留。老师已经印了二维码，换版不能改短链。
- 提交返回 **201** + `location` 指向集合：保留。
- 未发布表单的看板 **404**：保留（`summary.versionId` 不可空，编不出合法响应）。
- CSV **不加 BOM**：保留，但注释里写清代价与话术。
- 登录补 **dummy argon2**：采纳——否则「邮箱不存在」与「密码错」的响应时间差一个 KDF 量级。
- 补 `rate-limit.ts`（submit 30/min、generate 10/min，429 + `retry-after`）、`NODE_ENV=production` 缺 `SESSION_SECRET` 启动即抛、缺 `web/dist` 时回 404 **JSON** 不吐栈、启动日志打印 `origin`、zod 失败包中文、填空同时接受 `／` 与 `/`、问卷 `maxScore:0 ⇒ avgScore:0` 写进注释。

## 5. 复核时我实际跑的命令与输出（摘录）

```
$ pnpm typecheck              → 4 包全 Done
$ npx vitest run              → 50 文件 / 530 用例全绿
$ npx oxlint --deny-warnings packages server web scripts → 0 warnings 0 errors
$ pnpm build:web              → ✓ built（index-*.js ≈531 kB，保留 >500 kB 提示）
$ node scripts/verify.mjs     → VC1/VC2/VC3 全部通过（3/3），exit 0
```

浏览器实测（CDP；服务器 8788 + vite 5180 + 临时库 `.tmp/i4/demo.db`）：

```
登录      → /dashboard
看板      → 提交数 24 / 平均分 15.2 / 满分 25 / 版本 v1 / 24 行提交记录
学生页    → innerWidth 390 = scrollWidth 390，无横向滚动
泄漏检查  → answer / explanation / bloom / knowledgePoint / objectives 命中 0
空提交    → role=alert「这是必答题，请先填写」
填完提交  → 「0 / 25 分 · 答案已记录，可以关闭这个页面」（脚本全选首项，故 0 分）
CSV       → 200，表头 submission_id,created_at,score,max_score,q1-vertex,...,q5-sum，无 answer 列
```

## 6. 本轮踩到的坑（按发生顺序，均为实际路径）

1. `secret-scan` 对 `server/src/testing/harness.ts` 的 `TEST_SESSION_SECRET` 报假阳性 → 加 `// secret-scan:allow` 并写明"测试用固定值、不是任何环境的凭据"。
2. `secret-scan` 对 `scripts/verify.mjs` 的会话密钥报假阳性 → 改成 `verify-session-${randomUUID()}`，从形状上消除，而不是关规则。
3. `fill-ui` 修代理后全线 403 → `changeOrigin` 改写 `Host`，服务端推导出的允许来源与浏览器 `Origin` 不一致；改为把允许来源打印进启动日志。
4. 问卷看板平均分恒为 `null` → `maxScore === 0` 时应当是 `0` 而不是 `null`，只有 `count === 0` 才 `null`。
5. 填空只认全角 `／` → 改成 `/[／/]/`，但单空题不切（`1/2` 是内容）。
6. 登录 400 漏 zod 英文原文 → `describeZodError()` 统一包中文。
7. `.env.example` 里我写的"路径不存在会报错"当时并不成立 → 实现 `existsSync` 启动检查（`f83773b`）。
8. 逐 commit 验证脚本连续误报 `FAIL`（根无 `tsconfig.json`；`npx tsc` 在 worktree 里解析不到）→ 改为在主工作区逐个 `git checkout <hash>` 跑 `pnpm -r typecheck`，8 个 commit 全 `OK`。

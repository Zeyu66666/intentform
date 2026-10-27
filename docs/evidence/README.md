# 复现证据（I5 最小浏览器闭环）

这个目录回答评审唯一需要机器核验的问题：**在我说的那个提交上，一条完整的链能不能跑起来。**

一条链 = 教师说一句需求 → 流式生成卷子 → 保存并发布 → 学生扫短链在手机上填 → 判分 → 教师看板看见这条提交。

## 两种证据，不要混用

| 证据 | 在哪 | 能证明什么 | 不能证明什么 |
|---|---|---|---|
| `node scripts/verify.mjs`（VC1–VC4） | 本仓库，随时可跑 | 在没有浏览器的情况下，HTTP 语义层面的闭环成立：快照隔离、版本冲突拒绝、学生端零泄漏、生成→发布→提交→看板的数据一致 | 不能证明界面能用、按钮点了有反应 |
| `node scripts/browser-closed-loop.mjs` | 本仓库，需要本机 Chrome | 真浏览器里点完这条链，每一步的截图落盘 | 不能证明别的机器环境一致；它依赖 `LLM_MODE=mock` 的确定性 |

`verify.mjs` 里跑的是**服务端真逻辑**（真 SQLite、真 HTTP、真判分），不是打桩。
`browser-closed-loop.mjs` 里生成步骤强制 `LLM_MODE=mock`：mock 是内置脚本 + 一条故意写坏再修复的题，
**不调用任何模型**。这样截图每次一致，但也就意味着——它证明的是"链路通电"，不是"模型答得好"。
需要后者时看 `fixtures/replays/` 的三条回放（`LLM_MODE=replay`，同样不调模型）与《计划 v3.0》§7 的 live 说明。

## 怎么跑

```bash
pnpm install                      # 一次性
node scripts/verify.mjs           # 期望：VC1..VC4 全部通过，exit 0
node scripts/browser-closed-loop.mjs   # 期望：每步截图进本目录 + stdout 打 JSON 摘要
```

`browser-closed-loop.mjs` 用 `CHROME_PATH` 指定浏览器；未设置时按 Windows 常见路径探测，
找不到会 `exit 2` 并列出找过的路径（不猜、不静默跳过截图）。

## 证据与版本对应

截图文件名前缀是步骤序号，同一次运行内连号。**每次改动可观察行为后必须重跑并覆盖截图**，
旧截图不与新代码混放；`README.md` 末尾的「最近一次运行」必须与 `git log -1` 对得上，
对不上就是证据过期（《计划 v3.0》§8 风险表第 1 条）。

## 最近一次运行

（由 `browser-closed-loop.mjs` 跑完后人工回填：commit、时间、浏览器版本、截图清单。）

| 项 | 值 |
|---|---|
| commit | 待填 |
| 时间 | 待填 |
| 浏览器 | 待填 |
| 截图 | 待填 |

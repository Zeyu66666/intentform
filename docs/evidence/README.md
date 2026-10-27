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

| 项 | 值 |
|---|---|
| commit | `c6389b3`（本轮截图与脚本的入库提交） |
| 时间 | 2026-10-27 08:23（Asia/Shanghai） |
| 浏览器 | Chrome 156.0.8078.47，headless=new，CDP 驱动 |
| 服务 | `LLM_MODE=mock`；每次运行自起 server + vite，端口临时分配（本轮 59957/59958/59959） |
| 结果 | 6 步全绿：登录 → 生成 → 发布（UI 路径，`publishMode: "ui"`）→ 学生页作答（可信鼠标事件）→ 提交 `20 / 20` → 看板新增 1 行 |
| 截图 | `01-login.png`、`02-generate.png`、`03a-publish-panel.png`、`03b-published-dashboard.png`、`04-student.png`、`05-student-answered.png`、`06-submitted.png`、`07-dashboard.png`（全部同一次运行，08:23:05–06） |

选项类控件在这一轮改由 CDP `Input.dispatchMouseEvent` 点击（可信输入，走命中测试与默认行为），
并回读 `getBoundingClientRect()` 断言触控目标 ≥44px（实测 50px）。合成 `element.click()`
也能点亮，但它绕过命中测试——控件被遮挡、尺寸不足同样会"点中"，证明力弱。

## 这份证据还差什么（诚实口径）

1. **版本冲突只有 HTTP 级证据（VC2），没有浏览器级证据。** 制造"已换版"需要第二版 draft，而修改表单的
   路由（Patch）排在 I7；现在只能用 `node:sqlite` 直插一行 `form_versions`，那就不是"全链路只经 HTTP"了。
   界面侧的冲突分支（`fill-conflict`）已有单测，缺的是真点击——等 I7 的 Patch 上线后补这一段。
2. **生成步骤强制 `LLM_MODE=mock`。** 它证明链路通电，不证明模型产出质量；后者属于 §7 的 live 说明与
   I6 的 `pnpm eval`（整份需求达标率）。
3. **只在 Windows + Chrome 156 验证过。** 换浏览器/系统需要重跑一遍再改这一栏，否则视为证据过期。

这次运行抓到的真实缺陷：单选（`radio`）选不亮——`web/src/fill/StudentField.tsx` 用只认数组的
`selectedValues()` 算选中态，而单选在状态里存的是字符串，于是"点得动、存得下、界面上不亮"。
I4 的验收只看"能否提交、有无泄漏"，没看选中态，所以漏到这一步；修法与回归测试见 `f63613d`。
按纪律，它属于 I4 的缺陷在 I5 被闭环脚本抓到，叙事上写到这里，**不补造修复当时的那次会话**。

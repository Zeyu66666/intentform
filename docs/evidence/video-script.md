# 演示视频录制手册（零基础版）

这份文件写给**第一次录这个视频的人**。不用懂代码，只要会照抄命令、会点鼠标。
每一步都写了「敲什么」「看到什么算对」「不对怎么办」。

录制硬指标（《计划 v3.0》§7）：**成片 5:00–8:00**、**AI 协同段 ≥2:00**、**1080p 可过审**。

---

## 第 0 步：先确认你手里有什么

| 东西 | 怎么确认 | 没有怎么办 |
|---|---|---|
| 一台 Windows 电脑 | —— | —— |
| 仓库代码 | 文件夹 `D:\project1\intentform` 存在 | 从 GitHub 克隆下来 |
| Node.js（≥20.11） | 开终端敲 `node -v`，看到 `v20.x`/`v22.x`/`v24.x` 都行 | 去 nodejs.org 下 LTS 版，一路下一步 |
| pnpm | 敲 `pnpm -v`，看到版本号 | 敲 `npm i -g pnpm` |
| Chrome 浏览器 | 装了就有 | 装一个（自动化脚本要用它） |
| DeepSeek API Key（可选） | 一串 `sk-` 开头的字符 | **没有也能录**，只是播的是录好的模型输出，见 §3 |

**怎么打开终端**：按 `Win` 键 → 输入 `powershell` → 回车。出现黑底/蓝底窗口就是终端。
下文的命令**一次只粘一条**，粘一条按一次回车。

---

## 第 1 步：把项目跑起来看看（不用录，先熟悉）

```powershell
cd D:\project1\intentform
```

```powershell
pnpm install
```

> 第一次会下载依赖，等 1–3 分钟，最后一行出现 `Done` 就好。

```powershell
pnpm seed
```

> 这条命令会重建演示数据库，屏幕上会打印类似这样的三行，**记下它们**：
> ```
> teacher@example.com / intentform-demo
> /f/6vs4s37d9x
> /f/kq85amtymm
> ```
> 第一行是登录账号密码，后两行是两个学生填写的短链接尾号。

开**第一个**终端窗口，启动后端（这个窗口录视频时要一直开着）：

```powershell
pnpm dev:server
```

> 看到 `intentform-server listening on http://127.0.0.1:8787 (LLM_MODE=replay)` 就对了。
> **这个窗口不要关**，关了网页就没数据。

开**第二个**终端窗口（`Win` 后再开一个），启动网页：

```powershell
cd D:\project1\intentform
pnpm dev:web
```

> 看到 `Local: http://127.0.0.1:5173/` 就对了。

浏览器打开 **http://127.0.0.1:5173**

> ⚠️ 必须敲 `127.0.0.1`，**不能**敲 `localhost`。两者在电脑里是不同名字，
> 服务端按名字校验来源，敲错会满屏 403。

此时你应该看到：左边输入需求、中间空白预览、右边一条时间线。
点一个预置按钮（比如「初二数学·二次函数」）→ 点「开始生成」→ 中间的题目会**一道一道冒出来**。

**看到题目一道道出现 = 环境正常，可以往下走了。**

---

## 第 2 步：弄懂「模式」这三个字（决定视频里能不能说实话）

右上角（顶栏）会显示当前用的是哪种数据：

| 屏幕上的字 | 意思 | 能不能说"真的在调模型" |
|---|---|---|
| `回放录像（不调模型）` | 播上次录好的模型输出，不需要 Key | ❌ 不能说 |
| `内置假数据` | 程序内置的假数据，连网都不出 | ❌ 不能说 |
| `录制上游` | 真正调模型，并把过程录下来 | ✅ 能说 |
| `真实上游` | 真正调模型 | ✅ 能说 |

**视频里屏幕上写哪个词，嘴里就说哪个词。**说了 `live` 但画面写着"回放录像"，是评审最容易抓的点。

---

## 第 3 步（有 Key 才做）：把三条回放换成真实模型输出

### 3.1 为什么要做这一步

仓库里现在有 3 条录好的模型输出，它们的"来源"记录写的是 `local-stub`——意思是
**当时是用一个本地假服务器录的**，格式是真的、模型不是。
你有 Key，就能把这 3 条换成真 DeepSeek 输出，《计划》里"3 条真实回放"这句话才**字面成立**。
不做这一步也能录视频，但面试/答辩被追问"这是真模型跑的吗"，你只能答"不是"。

### 3.2 把 Key 放到仓库外面

Key 绝对不能进仓库（会被提交上去）。在仓库外面建一个文件夹：

```powershell
mkdir D:\project1\.secrets
```

把下面这**一整段**粘进终端回车（注意结尾那行 `"@` 必须顶格，不能有缩进）：

```powershell
mkdir D:\project1\.secrets
Set-Content -Path D:\project1\.secrets\intentform.env -Value @"
LLM_MODE=record
LLM_API_KEY=PASTE_YOUR_KEY_HERE
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_CHAT_MODEL=deepseek-chat
PORT=8790
APP_ORIGIN=http://127.0.0.1:5173
"@
```

然后打开这个文件，把 `PASTE_YOUR_KEY_HERE` 换成你的 Key（**用记事本改，别用这里粘**，避免引号被吃掉）：

```powershell
notepad D:\project1\.secrets\intentform.env
```

> 为什么用文件而不是直接把 Key 敲在命令行：直接敲会留在命令历史里，也会被录进画面。
> 为什么要记事本而不用中文占位符：不同版本 PowerShell 存文件的编码不一样，占位符里放中文可能变乱码；
> 全英文占位符没有这个问题。

### 3.3 生成三条请求体（不要手抄需求文字）

需求文字**参与计算文件名**，抄错一个标点就会录成一个新文件，旧的没被覆盖。
用这条命令自动生成（已经验证过能跑）：

```powershell
cd D:\project1\intentform
node --experimental-strip-types -e "const fs=require('node:fs');import('./packages/schema/src/presets.ts').then(m=>{for(const p of m.GENERATE_PRESETS){fs.writeFileSync('D:/project1/.secrets/rec-'+p.id+'.json',JSON.stringify({requirement:p.requirement}))}});console.log('done')"
```

> 看到 `done`，`D:\project1\.secrets\` 里会多出 `rec-math-quadratic.json` 等三个文件。

### 3.4 启动"录制模式"服务

**先把第 1 步的后端窗口关掉**（那个占着 8787）。然后新开一个终端：

```powershell
cd D:\project1\intentform
node --env-file=D:\project1\.secrets\intentform.env --experimental-strip-types server/src/main.ts
```

> 看到 `listening on http://127.0.0.1:8790 (LLM_MODE=record)` 就对了。

### 3.5 把三条需求发给它（真调模型，会产生费用）

再开一个终端窗口，粘这一段（它会一条一条发，每条之间停 2 秒，避免撞上限流）：

```powershell
Get-ChildItem D:\project1\.secrets\rec-*.json | ForEach-Object {
  Write-Host "== $($_.Name)"
  curl.exe -sN -X POST http://127.0.0.1:8790/api/generate -H "content-type: application/json" --data "@$($_.FullName)" | Select-Object -Last 2
  Start-Sleep -Seconds 2
}
```

**每条最后一行必须以 `data: {"type":"done"` 开头**才算录成功。实测长这样：

```
data: {"type":"done","seq":19,"versionId":"gen_...","stats":{"fields":6,"errors":0,"repairs":1,"ms":11800}}
```

如果最后一行是 `"type":"error"`，把括号里的中文读一遍，最常见的是 `上游模型返回 HTTP 401`（Key 错/余额不足）。

> 三条里某一条失败没关系：**单独再发那一条**就行，用下面这条（把文件名换成失败的那条）：
>
> ```powershell
> curl.exe -sN -X POST http://127.0.0.1:8790/api/generate -H "content-type: application/json" --data "@D:\project1\.secrets\rec-math-quadratic.json" | Select-Object -Last 2
> ```
>
> 或者干脆保留原来那条 fixture——**不要手改 `meta.json` 假装录过**，那比不换更糟。

> 三条大概几十秒到两分钟，取决于网络。中途别按 `Ctrl+C`——录制只有**正常跑完**才写文件，
> 中断了等于这次白跑（不会留下坏文件，这点是设计好的）。

### 3.6 检查：真的换成真模型了吗

```powershell
cd D:\project1\intentform
node packages/llm/src/check-fixtures.ts
```

看到最后一行 **`全部通过（3 条 fixture）`** 算过。再看来源变了没有：

```powershell
Select-String -Path D:\project1\intentform\fixtures\replays\*.meta.json -Pattern upstream
```

应该是三行 `"upstream": "openai-compatible:api.deepseek.com"`。

再看有没有多出文件（**关键检查**）：

```powershell
cd D:\project1\intentform
git status --short fixtures/
```

**期望：恰好 3 行，每行以空格 + `M` 开头**（` M fixtures/...`），意思是"这三个文件被改了"。
如果出现 `??`（问号）说明出现了**新文件**，即需求文字没对上——按下面两步清理后回到 §3.5 重录：

```powershell
cd D:\project1\intentform
git status --short fixtures/          # 先看清多出来的是哪个文件（形如 fixtures/replays/abcdef12....ndjson）
git clean -n fixtures/                # 先干跑，只打印不删；确认列出的都该删
git clean -f fixtures/                # 真正删除（只删未跟踪文件，不会动那三个旧文件）
```

### 3.7 关掉录制服务

在录制服务的窗口按 `Ctrl+C`，或者直接关掉那个窗口。

---

## 第 4 步：录前检查（每次录之前都跑一遍）

```powershell
cd D:\project1\intentform
git log --oneline -1
```

> 记下这行开头的 7 位字符（叫 commit hash，比如 `fd02180`）。视频第一帧的字幕要写它。

```powershell
node scripts/verify.mjs
```

> 期望最后打印通过，以 `exit 0` 结束；这一步大约 20 秒。

```powershell
node scripts/browser-closed-loop.mjs
```

> 它会自己开 Chrome、自己点一遍、自己关掉，最后打印六步全绿，并刷新
> `docs/evidence/` 里的八张截图。如果提示找不到 Chrome，说明没装或路径不对。

两条都过了，再回到第 1 步把后端 + 网页起起来，正式开始录。

---

## 第 5 步：怎么录（分 7 段，分开录，最后剪起来）

### 5.1 录屏软件

最简单的：Windows 自带 **Xbox Game Bar**，按 `Win + G` → 点录制。
要求 1080p 的话，OBS Studio 更稳（免费），设置里把「输出分辨率」设成 1920×1080。

### 5.2 录制参数（照做就行）

- 分辨率 **1920×1080**，浏览器缩放 100%，浏览器书签栏隐藏（`Ctrl+Shift+B`）。
- 手机那段：Chrome 按 `F12` → 左上角有个手机图标 → 选 iPhone 12 Pro（390×844）。
- 终端字号调大（`Ctrl` + 滚轮），深色背景。
- 命令**一条一条敲**，不要一次粘一屏。
- 一段里**不要**改环境变量、不要切分支。要换模式就停下，在 §5.4 里切。

### 5.3 七段清单

| 段 | 时长 | 用什么模式 | 你要做什么 | 屏幕上必须出现 |
|---|---|---|---|---|
| 1 | 1:30 | 回放（有 Key 可换 live） | 首页点预置「初二数学·二次函数」→「开始生成」 | 题目**一道一道**出现；顶栏模式与你说的一致 |
| 2 | 1:00 | 同上 | 生成完别动，滚右栏时间线 | 六个阶段 + 各自耗时；底部有 token 数 |
| 3 | 0:40 | 内置假数据 | 生成时**盯着右栏时间线**，指出"规则校验"阶段里的错误条目为什么被判错，接着讲"定向修复"那条把它改好了 | 时间线里先出现 `规则校验` 阶段，挂着一条错误（字段 id + 错误码，如 `E_BLOOM_INVALID、E_SCHEMA_SHAPE`）；紧接着出现 `定向修复` 阶段，条目文字是 `第 1 轮：E_BLOOM_INVALID、E_SCHEMA_SHAPE → 已修复`；最终表单里那道题是**好的**（不是被删掉） |
| 4 | 1:40 | 内置假数据 | 生成成功后「保存并发布」→复制 `/f/xxxx` →手机视口打开 →逐题作答→提交 →回看板 →点「导出 CSV」 | 手机上没有横向滚动条、**单选圆点是实心的**；提交后给分；看板多一行；CSV 表头没有 answer 列 |
| 5 | 0:50 | 内置假数据 | 看板切到「问卷」那张表 → 学生页填完 → 回看板导出 | 问卷显示"已记录"而不是分数 |
| 6 | 0:50 | 回放 | 终端敲 `node scripts/verify.mjs`，再发一次第 1 段那条需求 | 全部通过；字段顺序与第 1 段**一模一样** |
| 7 | ≥2:00 | —— | 录 AI 协作的真实过程（提问→AI 给方案→你否掉一条→追一个真 bug 到修好） | 至少一次真实的"错了→查→改"，不许剪成"我早就知道" |

> **段 3 为什么不是"演示发布被拒"**：内置假数据是**固定脚本**，不听你输入的需求，
> 里面每道题都带分值，所以发布**不会**被门禁拦。想演示"发布被拒"，只有真模型这条路：
> `live` 模式输入「出 5 道题，但不要给分值」，模型照做 → 发布被拦、红字给出 `E_SCORE_SUM@items[i]`。
> 没有 Key 就别演这一段，用时间线里的修复环比划更稳，也不会被追问"这不是真模型吗"。


### 5.4 三种模式怎么切换

**先关掉后端窗口**（`Ctrl+C`），再按需要启动：

| 想用哪种 | 启动命令 |
|---|---|
| 回放（默认，最省事） | `pnpm dev:server` |
| 内置假数据 | `$env:LLM_MODE="mock"; pnpm dev:server` |
| 真实 model（有 Key） | 先按 §6.1 建 `live.env`，再 `node --env-file=D:\project1\.secrets\live.env --experimental-strip-types server/src/main.ts` |

> 用 `$env:LLM_MODE="mock"` 这种方式设置，**只对当前这个终端窗口有效**，关掉就恢复默认，很安全。

### 5.5 每段开头叠字幕

第一帧打一行小字（必须是录制当时真实的值，不能后期编）：

```
意卷 IntentForm · <commit hash> · LLM_MODE=<replay|mock|live>
```

作用：让评审能把视频和仓库对上。

### 5.6 时长算账

1:30 + 1:00 + 0:40 + 1:40 + 0:50 + 0:50 = **6:30**，加 AI 段 2:00 ≈ **8:30**。
超了就先砍第 5 段（问卷回收在第 4 段的 CSV 画面里已经能看出来了）。

---

## 第 6 步：出问题了怎么办

### 6.1 想用 live，但不知道 env 文件怎么写

```powershell
cd D:\project1\intentform
(Get-Content D:\project1\.secrets\intentform.env) -replace '^LLM_MODE=record','LLM_MODE=live' | Set-Content D:\project1\.secrets\live.env
node --env-file=D:\project1\.secrets\live.env --experimental-strip-types server/src/main.ts
curl.exe -s http://127.0.0.1:8790/healthz
```

最后那条命令要看到 `"llmMode":"live"`。

> 顺便说清一个容易误解的字段：`"needsApiKey":true` 的意思是"这个模式**需要**凭据"，
> **不是**"缺 Key"。Key 真缺的时候进程根本起不来，会直接报 `LLM_API_KEY is empty` 然后退出。

### 6.2 常见翻车表

| 屏幕现象 | 原因 | 怎么办 |
|---|---|---|
| 网页一片 403 | 用了 `localhost` 而不是 `127.0.0.1` | 地址栏改回 `127.0.0.1:5173` |
| 生成点不动 / 转圈 | 后端窗口关了，或后端不在 8787 | 看后端窗口还在不在；`node scripts/verify.mjs` 自检 |
| 顶栏写"未知（等待响应头回执）" | 后端没起或代理指错 | 同上 |
| 生成一半红字 `HTTP 401` | Key 错/过期/余额不足 | 检查 `.secrets\intentform.env` 里那行 Key |
| 点了生成立刻报 429 | 生成限流 **10 次/分钟** | 等一分钟再点 |
| 点选项不变色 | 用了太旧的代码 | `git log --oneline -1` 必须晚于 `f63613d` |
| 视频里出现"待补" | 用了模板没填 | 录前把要展示的页面都点一遍 |
| `pnpm dev:server` 报端口占用 | 8787 上还有旧进程 | `netstat -ano \| findstr :8787`，拿最后一列 PID 后 `taskkill /PID <pid> /F` |

---

## 第 7 步：Key 的安全（有 Key 才需要看）

- Key 只放 `D:\project1\.secrets\` 里的文件，**不要**放进仓库目录。
- 不要 `echo` 它、不要 `type` 它、不要拖进编辑器再录屏。
- 为这次演示**单独申请一把** Key，录完去控制台**禁用或轮换**。
- 万一入镜了：立刻去控制台吊销，**重录那一段**。打码糊过去更糟——打码本身就在承认"这里有问题"。

---

## 第 8 步：录完之后

1. 把视频链接和上传日期填进 `docs/prompt-log/README.md` 的进度表，以及《计划 v3.0》§13 证据索引。
2. 如果视频里用的是某个 commit，而之后代码又变了：**不用重录**，但在 §13 写明"该段录制于 `<hash>`"。
3. 如果做了第 3 步（重录三条回放），把这几个文件的改动单独提交一次，并在
   `docs/prompt-log/P02/summary.md` 的「已知缺口」里把"回放来自本地 stub"这条标成**已关闭**。

---

## 附：一页速查（录的时候把这段贴在旁边）

```powershell
# 起后端（回放模式）
cd D:\project1\intentform; pnpm dev:server
# 起后端（假数据模式）
cd D:\project1\intentform; $env:LLM_MODE="mock"; pnpm dev:server
# 起前端
cd D:\project1\intentform; pnpm dev:web
# 打开
#   http://127.0.0.1:5173        （必须 127.0.0.1）
# 演示账号
#   teacher@example.com / intentform-demo
# 自检
node scripts/verify.mjs
node scripts/browser-closed-loop.mjs
# 当前版本（字幕用）
git log --oneline -1
```

# 演示视频录制清单（I5 · 有 Key / 无 Key 两版都能录）

录制标准（《计划 v3.0》§7）：实测 **5:00–8:00**、AI 协同段 **≥2:00**、**1080p 可过审**。
本文件只写"在哪个 commit 上、敲哪几条命令、点哪里、屏幕上应该出现什么"，
不写旁白定稿——旁白见 §11 的三反例讲法。

---

## 0. 录制前的一次性准备

```bash
cd D:/project1/intentform
git log --oneline -1                 # 记下这个 hash，填进第 7 节的表
pnpm install                         # 只在依赖变动后需要
pnpm build:web                       # 发布页/看板走 dist 时需要
```

**开录前必须做一次**，否则画面里会出现"过期的旧行为"：

```bash
node scripts/verify.mjs              # 期望 VC1..VC4 4/4
node scripts/browser-closed-loop.mjs # 期望 6 步全绿，截图刷新到 docs/evidence/
```

跑完把 `docs/evidence/README.md` 的「最近一次运行」核对一遍，与本机 `git log -1` 不一致就重跑。

---

## 1. 如果你有 DeepSeek Key：先重录三条回放，再开录

这一步不是可选项。现在入库的三条 fixture，`meta.upstream` 写的是
`local-stub:127.0.0.1:8903`——也就是**用本地 stub 走真实 record 路径录的**。
它是诚实的，但严格说不是"真实模型输出"。你手上有 Key，就能把这一行换成真的，
让《计划》里"3 条真实回放"这句话从字面成立。

### 1.1 把 Key 放在仓库外面（不要放进仓库，也不要敲在会入镜的终端里）

```bash
mkdir -p D:/project1/.secrets
printf 'LLM_MODE=record\nLLM_API_KEY=sk-你的真实key\nLLM_BASE_URL=https://api.deepseek.com/v1\nLLM_CHAT_MODEL=deepseek-chat\nPORT=8790\n' > D:/project1/.secrets/intentform.env
```

为什么用文件而不是 `export`：**服务端刻意不读 `.env`**（`server/src/env.ts` 明确写了"仓库里没有 dotenv"），
它只认进程环境变量。而把 `LLM_API_KEY=...` 直接写在命令行里，会留进 shell 历史、也会被录进画面。
`node --env-file=<仓库外路径>` 既能生效，又不会在屏幕上留下 Key（已在本机实测可用）。

### 1.2 起 record 服务，用三条预置需求的**原文**打一遍

需求文本进回放键，所以必须用 `packages/schema/src/presets.ts` 里那三条原文，一个字都不能差。
**别手抄**——手抄一个标点就会录出一个新键（旧的没被覆盖，还多出一个文件）。用这条命令把三份
请求体直接生成出来（已在本机验证；`node -e` 在仓库根直接 `import('@intentform/schema')` 是拿不到的，
必须用相对路径导入源文件）：

```bash
node --experimental-strip-types -e "const fs=require('node:fs');import('./packages/schema/src/presets.ts').then(m=>{for(const p of m.GENERATE_PRESETS){fs.writeFileSync('D:/project1/.secrets/rec-'+p.id+'.json',JSON.stringify({requirement:p.requirement}))};console.log('wrote', m.GENERATE_PRESETS.map(p=>p.id).join(', '))})"
```

然后起 record 服务（`LLM_MODE=record` 在 `.secrets/intentform.env` 里）：

```bash
node --env-file=D:/project1/.secrets/intentform.env --experimental-strip-types server/src/main.ts
```

另开一个终端，把三份请求体逐条发出去（每条之间等一两秒，别撞上 10 次/分钟的限流）：

```bash
for f in D:/project1/.secrets/rec-*.json; do
  echo "== $f"
  curl -sN -X POST http://127.0.0.1:8790/api/generate \
    -H 'content-type: application/json' --data @"$f" | tail -2
  sleep 2
done
```

每条最后一行必须是 `{"type":"done",...}` 才算录成功——**record 只在流正常结束时落盘**，
中途 Ctrl+C 不会留下半截文件（半截 fixture 会被读侧判成损坏，不如不写）。
三条都录完，`fixtures/replays/` 里同名的三个 hash 会被**覆盖**（键由需求+模型+prompt 版本+schema 版本决定）。

### 1.3 录完立刻验证，并检查 meta 里那一行

```bash
node packages/llm/src/check-fixtures.ts
git status --porcelain fixtures/        # 期望恰好 3 行 " M "，没有 "??" 新文件
grep -h '"upstream"' fixtures/replays/*.meta.json
```

- 第一条期望末行 `全部通过（3 条 fixture）`。
- 第二条**如果出现 `??` 新文件**，说明请求体与预置不一致，没命中同一个键——把新文件删掉，
  回到 1.2 用生成好的请求体重录（`rm fixtures/replays/<新hash>.*`）。
- 第三条应当是 `"upstream": "openai-compatible:api.deepseek.com"`；仍是 `local-stub:` 说明文件没被覆盖。

> 这三条 fixture 与真实模型输出一起进 git，属于证据升级，值得单独一条 commit；
> 提交时 `meta.recordedAt` 是真实录制时间，不要改。

### 1.4 成本与限流（录之前心里有数）

- 默认 `LLM_MAX_TOKENS=4096`、`LLM_TEMPERATURE=0`、`LLM_TIMEOUT_MS=60000`。
- 一次生成的 token 数不靠猜：`usage` 事件里有 `promptTokens`/`completionTokens`，
  页面右栏时间线底部也会显示。用这两个数乘你账号后台的单价，就是这一次的钱。
- 服务端限流 **生成 10 次/分钟**（超出返回 429 + `retry-after`）。录 live 段时别手快点十几次，
  重录前等一分钟。

---

## 2. 三套环境（分段切换，别边录边改环境变量）

| 用途 | 命令 | 说明 |
|---|---|---|
| **A：回放**（无 Key 也能录；第 1、2、6 段） | `LLM_MODE=replay PORT=8787 node --experimental-strip-types server/src/main.ts` + `VITE_DEV_PROXY_TARGET=http://127.0.0.1:8787 pnpm --filter @intentform/web dev` | 播 `fixtures/replays/` 的三条录制；做了第 1 步之后，这里播的就是**真实 DeepSeek 输出** |
| **B：mock**（第 3 段门禁、第 4–5 段闭环） | 同上，`LLM_MODE=mock` | 内置脚本，含一条故意写坏再修的题；**不出网**，判定确定性最高 |
| **C：live**（想做"真的在调模型"时） | `node --env-file=D:/project1/.secrets/live.env --experimental-strip-types server/src/main.ts`（文件里 `LLM_MODE=live`）+ 同上 web 命令 | 真出网；模型输出不可预测，**先预演一遍**再正式录 |

顶栏会显示实际生效的模式（来自响应头 `x-intentform-llm-mode`）：
`真实上游` / `录制上游` / `回放录像（不调模型）` / `内置假数据`。**看到哪个词就说哪个词**，
不要嘴上说 live、画面写着"回放录像"。

### 2.1 要用 C（live）段时，单独准备一份环境文件

```bash
sed 's/^LLM_MODE=record/LLM_MODE=live/' D:/project1/.secrets/intentform.env > D:/project1/.secrets/live.env
node --env-file=D:/project1/.secrets/live.env --experimental-strip-types server/src/main.ts
curl -s http://127.0.0.1:8790/healthz   # 必须看到 "llmMode":"live"
```

`healthz` 里的 `"needsApiKey":true` **不是**"缺 Key"，它的意思是"这个模式需要凭据"（`live`/`record` 恒为 true）。
Key 真的缺失时进程根本起不来——启动期就抛 `LLM_API_KEY is empty` 并 `exit 1`，不会拖到第一次生成。
所以判断标准只有一条：进程起来了 + `llmMode:"live"`，Key 就一定在且非空。

录之前先空跑一次生成，确认能拿到 `done` 再开录——真正的失败形态是：SSE 先发
`understand`/`plan`，随后发终态 `error`（"上游模型返回 HTTP 401，请稍后重试"），界面不会卡死，
但这一段就不能用了。

> 没有 Key 就照 A/B 录，**不要**在视频里声称是 live。回放模式的时间线与事件是真代码跑的，
> 模型输出是录下来的，这个差别主动说出来，比被评审发现要值钱。

---

## 3. 分镜与实机路径

"有 Key 时"一列是建议：live 适合展示"真的在调模型"，但不适合展示确定性结论。

| 段 | 时长 | 环境 | 有 Key 时 | 怎么点到 | 屏幕上必须看见的 |
|---|---|---|---|---|---|
| 1 需求 → 逐字段生成 | 1:30 | A | 可改 C（live） | `/` 三栏页，点预置「初二数学·二次函数」→「开始生成」 | 左栏需求、中栏字段**一张张出现**（不是一次性刷出）、右栏时间线同时推进；顶栏模式标记与实际一致 |
| 2 时间线：阶段与耗时 + 一行修复 | 1:00 | A | 可改 C | 停在生成完成那屏，滚右栏时间线 | `理解 → 规划 → 生成 → 校验 → 修复 → 完成` 六阶段与各段耗时；修复条目能点开看"改了什么"（**不显示推理原文**，§2.4 已删）；底部 usage 显示 token 数 |
| 3 整表门禁拦一次不合格生成 | 0:40 | B | 保持 B | 输入"要求出 5 道但没给分值"的需求 → 生成 → 点「保存并发布」 | 发布被拒，红字给出 `错误码@路径`（如 `E_SCORE_SUM@items[2]`），**没有**学生链接 |
| 4 发布 → 手机 → 判分 → 看板/CSV | 1:40 | B | 保持 B | 生成成功后点「保存并发布」→ 复制学生短链 → 开 390×844 → 逐题作答 → 提交 → 回看板 → 导出 CSV | 短链形如 `/f/xxxxxxxx`；手机页无横向滚动、单选圆点**实心**；提交卡片给分；看板出现这一行；CSV 表头**没有** answer 列 |
| 5 收集页 → 回收 → CSV | 0:50 | B | 保持 B | 看板选「问卷」那张表 → 学生页填完 → 回看板导出 | 问卷不判分（显示"已记录"），平均分口径与注释一致 |
| 6 回放现场复现 | 0:50 | A | 保持 A | 终端 `node scripts/verify.mjs`，再发一次第 1 段同一条预置 | 4/4 通过；同一条需求播出的字段序列与第 1 段**一字不差**——"可复现"的直接证据 |
| 7 AI 协同段（真实会话） | ≥2:00 | — | — | 屏幕录制 DSH 会话：提问 → 我的改法 → 某条被否决的建议 → 某个真实 bug 被定位到修复 | 至少一次真实的"错了 → 查 → 改"闭环；不许用"我早就知道"式剪辑 |

总时长按 1:30+1:00+0:40+1:40+0:50+0:50 = **6:30**，加 AI 段 2:00 ≈ **8:30**；
压到 8:00 以内时优先砍第 5 段（收集页回收在 CSV 段已有画面）。

**有 Key 时的推荐录法**：先录 C 环境的一段（网络状态好的时候优先做），再录 B/A 的其余段。
live 段万一输出不合规（被门禁拦），那**本身是第 3 段的好素材**——不要删，正好说明门禁真的会拦。

---

## 4. 录制参数

- 分辨率 1920×1080，浏览器缩放 100%，hide bookmarks bar；手机段用 **390×844** 设备模拟并保持同一窗口。
- 终端字号 ≥16pt，深色底；命令一条一条敲，不要粘贴出一整屏。
- 每段单独录，剪辑时按上表拼；**不要**在同一段里改环境变量或切 commit。
- 画面里不要出现：`D:/project1/.secrets/`、任何 Key、`data/*.db`、其它项目的窗口。

---

## 5. 每段开头的"版本字幕"

第一帧叠一行小字（不可后期造假，必须是录制当时 `git log -1` 的值）：

```
意卷 IntentForm · <commit hash> · LLM_MODE=<replay|mock|live>
```

这一段的作用是让评审能把视频和仓库对上；没有它，视频只能算"某人某时的演示"。
用了真实 Key 的段落，把 `LLM_MODE=live` 一起写进字幕。

---

## 6. 已知会翻车的地方（照此规避）

| 现象 | 原因 | 规避 |
|---|---|---|
| 顶栏写着 `真实上游` 但实际没出网 | 模式来自响应头 `x-intentform-llm-mode` | 开录前 `curl -s http://127.0.0.1:8790/healthz` 看 `llmMode` |
| 生成到一半出现红字"上游模型返回 HTTP 401" | Key 错/过期/余额不足。实测：SSE 会先发 `understand/plan`，随后发终态 `error`，**不会静默卡死** | 开录前先发一次试探请求；确认 `.secrets/*.env` 里是有效 Key |
| 30 秒后没动静 | `LLM_TIMEOUT_MS=60000`，慢模型可能接近上限 | live 段留足时间；视频里说明"设了 60 秒超时并会中断上游" |
| 点了生成立刻 429 | 生成限流 10 次/分钟 | 等一分钟再点；重录时别连点 |
| 学生页选项点了不亮 | 已在 `f63613d` 修复 | 录制前 `git log --oneline -1` 必须晚于 `f63613d` |
| 发布报 403 | `APP_ORIGIN` 与浏览器地址不一致（代理会改写 Host） | 用同一个 `127.0.0.1:<port>` 打开，别混用 `localhost`，并显式设 `APP_ORIGIN` |
| 生成页点了没反应 | 后端没起或 `/api` 代理指错端口 | 开录前跑一次 `verify.mjs`，它自己起服务验证同一套路径 |
| 视频里出现"待补"字样 | 计划模板允许留空，但视频不能展示未完成态 | 录前把要展示的页面都点一遍 |

---

## 7. 密钥卫生（有 Key 时必读）

- Key 只出现在 `D:/project1/.secrets/*.env`，该目录在仓库外、不进 git；`.gitignore` 已含 `.env`、`.env.*`（双保险）。
- 不要 `echo $LLM_API_KEY`、不要 `cat` 那个 env 文件、不要把它拖进编辑器再录屏。
- 专为演示建一把 Key，录完在控制台禁用或轮换——视频会公开，历史里也不该留长期凭据。
- 若不小心入镜：立刻在控制台吊销、重录那一段，不要在剪辑里打码了事（打码本身说明你在掩饰）。

---

## 8. 完成后

- 视频链接与上传日期补进 `docs/prompt-log/README.md` 的进度表与《计划 v3.0》§13 证据索引。
- 视频所用的 commit 若被后续提交覆盖，不需要重录，但**必须**在 §13 写明"该段录制于 `<hash>`"。
- 若做了第 1 步重录，把 `fixtures/replays/*.meta.json` 的 `upstream` 变更与 commit hash 写进
  `docs/prompt-log/P02/summary.md` 的「已知缺口 → 已关闭」一节（那条"回放来自本地 stub"的缺口就正式关掉了）。

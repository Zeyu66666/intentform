"""生成《意卷 IntentForm · 参赛说明》DOCX（后续导出 PDF）。

约定：正文里的引用一律用「」，避免与 Python 字符串定界符冲突。
"""

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

CJK = "Microsoft YaHei"
LATIN = "Segoe UI"
INK = RGBColor(0x1F, 0x23, 0x28)
MUTED = RGBColor(0x5B, 0x63, 0x6B)
ACCENT = RGBColor(0x1D, 0x4E, 0xD8)


def set_run_font(run, size=None, bold=None, color=None):
    run.font.name = LATIN
    run._element.rPr.rFonts.set(qn("w:eastAsia"), CJK)
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.bold = bold
    if color is not None:
        run.font.color.rgb = color


def para(doc, text="", size=10, bold=False, color=INK, space_after=6):
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(space_after)
    p.paragraph_format.line_spacing = 1.33
    r = p.add_run(text)
    set_run_font(r, size=size, bold=bold, color=color)
    return p


def rich(doc, parts, size=10, space_after=6):
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(space_after)
    p.paragraph_format.line_spacing = 1.33
    for text, bold in parts:
        r = p.add_run(text)
        set_run_font(r, size=size, bold=bold, color=INK)
    return p


def heading(doc, text, level=1):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(14 if level == 1 else 10)
    p.paragraph_format.space_after = Pt(5)
    r = p.add_run(text)
    set_run_font(r, size=14 if level == 1 else 11.5, bold=True, color=ACCENT)
    return p


def bullet(doc, text, size=10):
    p = doc.add_paragraph(style="List Bullet")
    p.paragraph_format.space_after = Pt(3)
    p.paragraph_format.line_spacing = 1.4
    r = p.add_run(text)
    set_run_font(r, size=size)
    return p


def table(doc, rows, widths=None, size=8.5):
    t = doc.add_table(rows=len(rows), cols=len(rows[0]))
    t.style = "Table Grid"
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    for ri, row in enumerate(rows):
        for ci, cell_text in enumerate(row):
            cell = t.cell(ri, ci)
            cell.text = ""
            p = cell.paragraphs[0]
            p.paragraph_format.space_after = Pt(1)
            p.paragraph_format.line_spacing = 1.25
            r = p.add_run(cell_text)
            set_run_font(
                r,
                size=size,
                bold=(ri == 0),
                color=ACCENT if ri == 0 else INK,
            )
    if widths:
        for ci, w in enumerate(widths):
            for row in t.rows:
                row.cells[ci].width = Cm(w)
    return t


doc = Document()
for section in doc.sections:
    section.top_margin = Cm(1.9)
    section.bottom_margin = Cm(1.7)
    section.left_margin = Cm(2.4)
    section.right_margin = Cm(2.4)

# ── 第 1 页：封面 ────────────────────────────────────────────
para(doc, "意卷 IntentForm", size=30, bold=True, color=ACCENT, space_after=2)
para(doc, "一句话生成一份可发的卷子", size=13, bold=True, color=MUTED, space_after=18)
para(doc, "参赛说明（预指导提交版）", size=12, bold=True, space_after=4)
para(doc, "单人作品 · 智能体团队辅助开发 · 2026-10-27", size=10, color=MUTED, space_after=14)

table(
    doc,
    [
        ["项", "内容"],
        ["作品定位", "教师说一句需求，系统流式生成整份表单：逐字段上屏、逐行校验、整表门禁，通过后一键发布成学生短链"],
        ["仓库", "https://github.com/Zeyu66666/intentform"],
        ["提交版本", "main 分支 65ad312（本文档所引证据的运行版本）"],
        ["技术栈", "TypeScript · Node 20+ · pnpm monorepo · React 18 + Vite 5 · SQLite（better-sqlite3）· Zod"],
        ["不用框架", "生成层不引入 LangChain / LlamaIndex / Vercel AI SDK；表单层不引入 formily / amis / SurveyJS / react-jsonschema-form"],
        ["验证命令", "pnpm typecheck · npx vitest run（52 文件 / 566 用例）· pnpm lint · node scripts/verify.mjs（4/4）· node scripts/browser-closed-loop.mjs（6 步）"],
    ],
    widths=[3.0, 13.0],
)

para(
    doc,
    "本文档结构：第 2 页问题与判断，第 3 页技术方案，第 4–5 页四层意图控制，第 6 页三条核心链，"
    "第 7 页复现证据，第 8 页工程质量，第 9 页评分维度自评，第 10 页已知缺口。所有结论都指向仓库里可执行的命令或带 commit 的产物。",
    size=10,
    color=MUTED,
    space_after=0,
)
doc.add_page_break()

# ── 第 2 页：问题与判断 ──────────────────────────────────────
heading(doc, "1　问题与判断")
para(
    doc,
    "出错卷这件事，老师每天在做，但它不是一个表单填写问题。真正的负担有三段：题干要写得像题、分值要配平、发出去以后要能收回来并对得上。"
    "现有工具（问卷星、腾讯问卷、表单项生成器）把这三段拆成三次手工劳动，而且第一段——写题——完全没法被生成替代，因为它们要求人先有结构。",
)
heading(doc, "1.1　三个反例（评审最容易怀疑的三件事）", level=2)
rich(
    doc,
    [
        ("反例一：把生成当成一次性大文本。", True),
        (
            "常见做法是让模型吐一段 JSON 再 parse。这在真实需求下必然崩：题目多、输出长，中途一个字段写错就整份作废，人只能重来。"
            "我们做成逐行生成 + 逐行校验 + 只修坏的那一行，坏一行不废整份。",
            False,
        ),
    ],
)
rich(
    doc,
    [
        ("反例二：把生成完当成能发布。", True),
        (
            "模型完全可能产出一份看起来像卷子的东西：总分和每题分值不符、两道题撞 id、问卷里混进判分题。"
            "这些错误单看每一行都合法，只有整表才看得出来，所以我们在发布前设了一道整表门禁，不通过就不发学生链接。",
            False,
        ),
    ],
)
rich(
    doc,
    [
        ("反例三：把能演示当成能复现。", True),
        (
            "演示视频里一切顺利，评审一跑就发现没 Key、没网、模型换了。我们做了三件事：回放模式（录制上游 chunk，无 Key 也能跑）、"
            "mock 模式（内置脚本，连网都不出）、真浏览器闭环脚本（自起服务与 headless Chrome，点完六步落八张图）。",
            False,
        ),
    ],
)
heading(doc, "1.2　我们赌的那一个判断", level=2)
para(
    doc,
    "意图不是一次对齐，而是四层递进的对齐。用户说「初二二次函数随堂测，10 题，要有图像题」，这句话里"
    "「初二」决定难度与知识点，「随堂测」决定题量与题型，「图像题」决定渲染能力。任何一层没对齐，结果都不能用。"
    "所以系统把这句话拆成四层可验证的东西：澄清、蓝图、校验、修复，每层都有产出证据（第 4 页展开）。",
)
doc.add_page_break()

# ── 第 3 页：技术方案 ────────────────────────────────────────
heading(doc, "2　技术方案：四个包，一条事件流")
para(
    doc,
    "生成的过程必须看得见。只在最后给一份结果，用户无法判断系统是否理解了他的话。所以整条链路建在一条 SSE 事件流上："
    "每次阶段切换、每个字段落定、每次修复，都是流上的一个事件，前端据此逐字段渲染并把时间线画出来。",
    size=10,
)
table(
    doc,
    [
        ["包", "职责", "可以依赖", "不可以依赖"],
        ["packages/schema", "结构事实源：Zod 定义、校验规则 R1–R8、错误码、公开投影 publicView、SSE 事件契约、HTTP 契约", "zod、katex（校验 LaTeX）", "Node 内置、浏览器 API、其它业务包"],
        ["packages/llm", "OpenAI 兼容 Provider、NDJSON 行切分、逐行校验、修复环、整表门禁、四种模式（live/record/replay/mock）", "schema 的类型与纯函数", "server、web"],
        ["server", "零框架 HTTP：鉴权、CSRF、限流、发布快照、提交判分、看板与 CSV、SSE 写出", "schema、llm、better-sqlite3、@node-rs/argon2", "web"],
        ["web", "三栏生成页、字段渲染器（edit / fill 两态）、时间线、发布面板、学生填写页、教师看板", "schema 的类型与纯函数、React、Vite、KaTeX", "server、llm、任何密钥"],
    ],
    widths=[2.6, 6.6, 3.6, 3.2],
)
heading(doc, "2.1　七类事件与递增 seq", level=2)
para(
    doc,
    "流上只有 7 个类别：phase（阶段）、thinking（思考摘要）、field（字段落定）、field_error（某行不合格，附错误码与截断原文）、"
    "repair（一轮修复的结果：修前错误码、修后错误码、fixed 或 failed）、usage（token 与耗时）、done 或 error（终态）。"
    "每个事件带递增 seq；心跳是注释行不算事件，15 秒一次。前端遇到乱序先缓存再归位，跳号超过 3 秒才放弃并显式标注，"
    "不静默跳过一个可能存在的字段。",
    size=10,
)
heading(doc, "2.2　三种环境都能跑", level=2)
bullet(doc, "live：真调上游。Key 只在服务端，前端零 Key。")
bullet(doc, "replay：按「规范化需求 + 模型 + prompt 版本 + schema 版本」的 sha256 命中录像，逐 chunk 重放真实时序；未命中显式报错，不静默回落假数据。")
bullet(doc, "mock：内置脚本 + 一条故意写坏再修复的题，完全不出网，用于确定性演示与端到端测试。")
doc.add_page_break()

# ── 第 4 页：四层意图控制 ────────────────────────────────────
heading(doc, "3　四层意图控制：澄清 · 蓝图 · 校验 · 修复")
heading(doc, "3.1　澄清与蓝图", level=2)
para(
    doc,
    "需求进来先规整：截断到 4000 字、统一空白、识别「几题」「多少分」「什么学段」这类槽位。缺失的关键槽位不猜，"
    "而是在时间线上标注「按默认值补全：10 题、每题 2 分」这种人能看见的决定。然后先出结构（题型序列与分值分配）再出内容，"
    "因为结构错了改内容就是白写；结构对了，内容可以一行一行修。",
    size=10,
)
heading(doc, "3.2　逐行校验：错误必须落到某一行", level=2)
para(
    doc,
    "模型每吐完一行立刻校验一次，分两层：结构层（节点类型是否合法、字段是否齐全、id 是否符合 ^[a-z0-9_-]{3,32}$）"
    "与语义层（答案是否在选项内、多选答案是否重复、填空答案是否空白、bloom 是否在 6 级内、知识点是否在登记表里、LaTeX 是否可渲染）。"
    "不合格就把这一行连同错误码数组与原文（截断到 2000 字符）发成 field_error，然后只修这一行，其它已通过的行不动。",
    size=10,
)
heading(doc, "3.3　整表门禁：单行合法不等于整卷可发", level=2)
para(doc, "六条判据，任一不满足就不发学生链接：", size=10)
table(
    doc,
    [
        ["#", "判据", "错误码"],
        ["1", "字段 id 全局唯一", "E_DUP_ID"],
        ["2", "测验每题都有答案；问卷每题都不带答案与分值", "E_ANSWER_MISSING / E_SURVEY_HAS_ANSWER"],
        ["3", "答案落在选项内；多选不重复、不越界", "E_ANSWER_NOT_IN_OPTIONS / E_MULTI_ANSWER_INVALID"],
        ["4", "分值合计与 meta.totalScore 一致；测验至少一道可判分题", "E_SCORE_SUM"],
        ["5", "LaTeX 能被 KaTeX 渲染（trust: false）", "E_LATEX_INVALID"],
        ["6", "字段数 ≤100、选项 2–8 个、题面与解析不越界", "E_OPTIONS_INVALID / E_SCHEMA_SHAPE"],
    ],
    widths=[1.2, 10.4, 4.4],
)
para(
    doc,
    "门禁失败时接口返回「前 3 条 错误码@路径 + 总数」，前端原样显示，例如 E_SCORE_SUM@items[2]。"
    "教师看到的是第 3 题分值不对，不是发布失败。",
    size=10,
    color=MUTED,
)
heading(doc, "3.4　修复环：最多两轮，且必须单调变小", level=2)
para(
    doc,
    "每轮把坏行的错误码交给修复钩子，拿到替换行；只有新错误码集合是旧集合的真子集才算有进展。两轮没进展就停，"
    "把现状如实报给用户。修复是真实事件：时间线上看得到「第 2 题 E_BLOOM_INVALID + E_SCHEMA_SHAPE → 修复 → 通过」。"
    "mock 脚本每次都会真的走一遍这条路径，所以演示里它不是动画。",
    size=10,
)
doc.add_page_break()

# ── 第 5 页：三条核心链 ──────────────────────────────────────
heading(doc, "4　三条核心链（P01 / P02 / P04）")
para(doc, "比赛要求的完整链不是功能列表，而是从一句人话到一件可交付物的闭环。我们只讲三条，每条都能在仓库里跑。", size=10)
table(
    doc,
    [
        ["链", "从 → 到", "关键产物", "可核验方式"],
        ["P01 结构契约", "一句话 → 一份合法的表单结构", "Zod 结构定义、R1–R8 校验、11 个错误码与修复提示、publicView 公开投影", "packages/schema 单测"],
        ["P02 生成管线", "一句话 → 流式逐字段上屏 + 一行修复", "手写 SSE 读、NDJSON 行切分、逐行校验、修复环、整表门禁、四种模式、3 条回放录像", "node scripts/verify.mjs 的 VC4；replay 打同一需求，事件序列与录像一致"],
        ["P04 发布闭环", "生成完 → 学生手机填 → 判分 → 教师看板", "教师登录、发布快照、学生短链、客观判分、版本冲突拒绝、看板与 CSV", "node scripts/browser-closed-loop.mjs 六步；verify.mjs VC1–VC3"],
    ],
    widths=[2.6, 4.4, 5.6, 3.4],
)
heading(doc, "4.1　发布这一刀切在哪", level=2)
para(
    doc,
    "发布等于把某个版本号写进 published_version_id，而不是复制一份数据。form_versions 是追加式表，数据库层用两个 trigger"
    "直接拒掉对历史版本的 UPDATE 与 DELETE，仓库层干脆不提供这类方法。于是「已发布的内容不会被后来的改动悄悄改掉」"
    "不是靠自觉，是靠约束；学生端永远只读发布那一刻的快照。",
    size=10,
)
heading(doc, "4.2　版本冲突的处理", level=2)
para(
    doc,
    "学生页面提交时携带自己看到的那一版版本号。服务端发现当前发布版已经不是它，回 409 并附一句人话："
    "「版本已更新，请刷新页面后重试」。不做历史版本继续收卷——那会让同一张表的两批答案无法合并，也解释不了分数为什么不同。"
    "这条在 verify.mjs 的 VC2 里是真断言，不是文档承诺。",
    size=10,
)
heading(doc, "4.3　学生端只经 publicView()", level=2)
para(
    doc,
    "答案、解析、bloom 层级、知识点、整卷目标这五类信息在 schema 层就被剥掉，投影成 PublicForm。服务端出学生页只有一处调用 publicView()；"
    "前端渲染层还有第二道白名单（纵深防御，不是主防线）。verify.mjs 的 VC3 扫响应体里有没有这五个键，浏览器脚本则扫 DOM。",
    size=10,
)
doc.add_page_break()

# ── 第 6 页：复现证据 ────────────────────────────────────────
heading(doc, "5　复现证据：两种，不混用")
table(
    doc,
    [
        ["证据", "命令", "能证明什么", "不能证明什么"],
        ["HTTP 语义闭环", "node scripts/verify.mjs", "快照隔离、版本冲突拒绝、学生端零泄漏、生成→发布→提交→看板的数据一致（真 SQLite、真判分、真 HTTP）", "界面能不能用、按钮点了有没有反应"],
        ["真浏览器闭环", "node scripts/browser-closed-loop.mjs", "headless Chrome 里点完六步，每步落一张图；选项用 CDP 可信鼠标事件点击，并断言触控目标 ≥44px", "换环境是否一致；生成步骤强制 mock，不证明模型质量"],
    ],
    widths=[2.6, 4.0, 6.2, 3.2],
)
heading(doc, "5.1　本轮实测结果（2026-10-27 08:23，commit c6389b3）", level=2)
bullet(doc, "verify.mjs：VC1 发布快照、VC2 判分与版本冲突、VC3 学生端零泄漏、VC4 生成→发布→提交→看板，4/4 通过，exit 0。")
bullet(doc, "browser-closed-loop.mjs：6 步全绿，publishMode 为 ui（走真按钮而非 API 兜底），提交得分 20/20，看板新增 1 行。")
bullet(doc, "八张分步截图同一次运行（08:23:05–06）：登录、生成、发布面板（含学生短链）、看板、学生页、已作答、已提交、看板新行。")
heading(doc, "5.2　这条链上真实发生过的缺陷（事实，不粉饰）", level=2)
table(
    doc,
    [
        ["缺陷", "为什么会漏", "怎么修的"],
        ["学生页单选点了不亮", "I4 的浏览器验收只看能否提交、有无泄漏，没看选中态；根因是选中态计算只认数组，而单选在状态里存字符串", "新增 choiceValues() 统一两种形态并补回归测试（f63613d）"],
        ["判分题缺分值修不到", "只在整表门禁报，修复环拿不到这一行", "行级也报 E_SCORE_SUM（318d89c）"],
        ["缺 dist 时路由返回栈", "HTML 路由缺文件按未捕获异常处理", "改为 404 JSON 并提示先 pnpm build:web（f83773b）"],
    ],
    widths=[4.4, 7.0, 4.6],
)
doc.add_page_break()

# ── 第 7 页：工程质量 ────────────────────────────────────────
heading(doc, "6　工程质量可以怎么查")
table(
    doc,
    [
        ["维度", "我们做了什么", "在哪看"],
        ["类型契约先行", "结构只有一份事实源（Zod），类型全部由它推导；跨包只走包名；禁用 as any 与 @ts-ignore，全仓 0 命中", "packages/schema/src/types.ts、AGENTS.md §3"],
        ["模块边界", "四个包的可以依赖与不可以依赖写成表；web 编译期拿不到 Node 类型，前端拿不到密钥", "AGENTS.md §2、web/tsconfig.json"],
        ["测试", "52 个测试文件、566 条用例，覆盖校验规则、行切分（含 chunk 与 UTF-8 多字节截断）、修复环、SSE 序号、判分、鉴权与限流", "npx vitest run"],
        ["提交纪律", "commit message 正则强约束（feat/fix/test 必带迭代号），pre-commit 跑密钥扫描，禁用 squash 与 force push", ".githooks/commit-msg、scripts/secret-scan.mjs"],
        ["过程留痕", "每个迭代一份提问记录与一份 summary（含被否决的 AI 建议、真实 bug、偏离计划的条目）", "docs/prompt-log/P00–P04"],
    ],
    widths=[2.8, 9.4, 3.8],
)
heading(doc, "6.1　数据与安全（分级，不是口号）", level=2)
bullet(doc, "口令用 argon2id 加盐哈希；会话是 HMAC 签名的 httpOnly cookie；失败 5 次锁 15 分钟，key 是邮箱哈希。")
bullet(doc, "所有写操作过 CSRF 双闸：Origin 必须等于配置的允许来源，且带自定义请求头；预检只回显允许来源，从不回星号。")
bullet(doc, "生成 10 次/分钟、提交 30 次/分钟，超限回 429 并给 retry-after；每日 token 有上限。")
bullet(doc, "不存明文 IP（只存 sha256(SESSION_SECRET + ip)）；不记录 Key、口令、完整答卷；答卷上限 64KB；参数化 SQL，全仓无拼接。")
bullet(doc, "禁用生成框架是项目策略而非能力缺失：链路的每一层（请求、切分、校验、修复、事件）都是自己写的，所以能被单测钉住。")
doc.add_page_break()

# ── 第 8 页：评分维度自评 ────────────────────────────────────
heading(doc, "7　对着评分维度自评")
table(
    doc,
    [
        ["维度", "权重", "我们的证据", "页码"],
        ["过程可复现", "25%", "main 分支逐条可跑的提交；三条独立证据链（HTTP、浏览器、回放录像）；每个迭代一份带真实 bug 的提问记录", "第 7、8 页"],
        ["闭环完整", "25%", "一句话 → 生成 → 发布 → 手机填写 → 判分 → 看板 → CSV，六步在真浏览器里点通", "第 6、7 页"],
        ["意图控制", "20%", "四层递进（澄清、蓝图、校验、修复）+ 整表门禁六判据 + 修复必须单调收敛", "第 4、5 页"],
        ["工程质量", "15%", "类型契约单一事实源、模块边界表、566 条用例、提交纪律与密钥扫描钩子", "第 8 页"],
        ["体验", "15%", "三栏生成页（需求、实时预览、时间线）、设计 Token 冻结、手机页 390×844 无横向滚动、44px 触控目标", "第 3、7 页"],
    ],
    widths=[3.0, 1.6, 10.4, 2.0],
)
heading(doc, "7.1　怎么在两分钟内自己验一遍", level=2)
para(
    doc,
    "一、克隆仓库并 pnpm install。二、pnpm typecheck 与 npx vitest run（应 52 文件、566 用例全绿）。"
    "三、node scripts/verify.mjs（应 4/4，自带起服务与临时库，不污染任何数据）。"
    "四、node scripts/browser-closed-loop.mjs（需本机 Chrome；自起 server、vite 与 headless Chrome，六步全绿并把八张图写入 docs/evidence/）。"
    "全程不需要任何 API Key。",
    size=10,
)
heading(doc, "7.2　视频与文档的关系", level=2)
para(
    doc,
    "演示视频按录制清单七段拍：需求到逐字段、时间线与真实修复、整表门禁拦一次、发布到手机判分看板、收集页回收、"
    "回放模式现场复现、AI 协同段；每段第一帧叠当前 commit 与 LLM_MODE，让评审把画面与仓库对上。"
    "视频看它怎么动，本文档查它凭什么对。",
    size=10,
)
doc.add_page_break()

# ── 第 9 页：已知缺口 ────────────────────────────────────────
heading(doc, "8　已知缺口：现在做不到的，写清楚")
table(
    doc,
    [
        ["缺口", "现状", "计划"],
        ["改表（Patch）", "生成后只能整份重发或手工改 JSON，没有受限修改入口", "I7 做选中字段改一处并支持撤销，把版本差异落成 form_versions 的一行"],
        ["版本冲突的浏览器级证据", "只有 HTTP 级（VC2 真断言）；浏览器里造第二版需要 Patch", "I7 上线后补这一段点击证据"],
        ["模型质量", "预指导演示走 replay 或 mock，证明链路通电，不证明答得好", "I6 用整份需求达标率作主指标，跑 pnpm eval 出报告"],
        ["登录的 IP 级限流", "只有账号级（邮箱哈希 key）", "如需公网部署再加一层"],
        ["CSV 的 Excel 兼容", "不加 BOM，Excel 双击可能出现中文乱码", "提供用导入向导打开的说明，而不是偷偷改格式"],
        ["浏览器兼容", "只在 Windows 与 Chrome 156 验证", "换环境需重跑闭环脚本并更新证据版本戳"],
    ],
    widths=[4.0, 6.6, 5.4],
)
para(
    doc,
    "这份清单的用法：评审看到任何一条看起来没做的功能，先来这里对一下——是我们没做，还是我们已经在别处说了它没做。"
    "我们不把未来会做写成已经做了。",
    size=10,
    color=MUTED,
)
para(
    doc,
    "本文档引用的每个数字都来自某一轮真实命令输出；引用的每个 commit 都能 git show 出来。",
    size=10,
    color=MUTED,
    space_after=0,
)

doc.save("D:/project1/intentform/docs/deliverables/参赛说明-意卷IntentForm.docx")
print("saved ok")

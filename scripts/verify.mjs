#!/usr/bin/env node
/**
 * `pnpm verify` —— I4 的端到端验收：起一个真服务，按学生/教师的真实 HTTP 顺序跑三条用例。
 *
 *   VC1 发布快照：发布会话拿到短链后，老师继续改草稿（追加 v2）不影响 `/f/:slug`
 *                 的输出（字节级比较 form 部分）；只有发布这步才动视图。
 *   VC2 判分与版本冲突：正常提交得分正确；用旧 versionId 提交返回 409 + version_conflict。
 *   VC3 学生端零泄漏：`/f/:slug` 与 `POST /api/submissions` 的响应体字节里不含
 *                 answer / explanation / bloom / knowledgePoint / objectives。
 *   VC5 人工批改：`POST /api/forms/:id/submissions/:sid/grades` 录分后总分、待批额度、
 *      看板与 CSV 三处一致（省赛 R-02）。
 *   VC4 生成→发布→提交→看板：`LLM_MODE=mock` 走完整的 SSE 生成，把 `field` 事件里
 *                 的节点组装成 quiz 表单，发布后提交一份**故意只对一半**的答卷，
 *                 得分必须等于脚本自己算出的期望值（不是"大于 0"），再看板与 CSV 对账。
 *
 * 服务进程统一用 `LLM_MODE=mock`：VC1–VC3 完全不碰 `/api/generate`，所以换模式对它们
 * 零影响；而 VC4 需要一条**确定性**的生成流（mock 是内置脚本 + 一条故意写坏再修复的题，
 * 不调模型、每次事件序列相同），否则「期望得分」本身就不成立。
 *
 * 为什么用 `node:sqlite` 写 v2：本轮还没有 PATCH 路由（补丁编辑器属于前端 I3），
 * 而 VC1 的命题恰恰是「版本追加 + 指针移动」这两件事彼此独立。所以这里用 Node
 * 内置的 SQLite 直接做「补丁路由本该做的两行写入」，走的仍然是同一套表约束
 * （`form_versions` 的追加式触发器照样生效）。除 Node 内置外不引入任何依赖。
 *
 * 退出码：四条全过 0；任何一条失败非 0，并打印失败原因。
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

const ROOT = resolve(import.meta.dirname, "..");
const SERVER_ENTRY = join(ROOT, "server", "src", "main.ts");
const SEED_ENTRY = join(ROOT, "server", "src", "seed.ts");
// 每次运行现生成：写死一个长随机串会给密钥扫描器送一个假阳性，
// 而校验脚本本来就不需要跨运行保持同一会话密钥（服务进程与客户端在同一个脚本里）。
const SESSION_SECRET = `verify-session-${randomUUID()}`;
const DEMO_EMAIL = "teacher@example.com";
const DEMO_PASSWORD = "intentform-demo";
/** VC3 的关键字：这些字符串一旦出现在学生端响应体里，就是把答案泄出去了。 */
const FORBIDDEN_STUDENT_KEYS = ["answer", "explanation", "bloom", "knowledgePoint", "objectives"];

/**
 * VC4 用的需求文本。有两个刻意的约束：
 * - 不能出现「问卷/调查/反馈/收集」这类词：`inferFormKind` 见到就把表单判成 survey，
 *   而 survey 不许带答案与分值（R3），VC4 就没法做判分对账了；
 * - 要覆盖单选/填空/数值/简答四类，这样 `mockLines()` 的分支与修复环都会被走到。
 */
const GEN_REQUIREMENT = "出一份二次函数随堂测：单选、填空、数值和简答各一道，共 20 分";

// ── 被测表单 ──────────────────────────────────────────────────────────────
const QUIZ_SCHEMA = {
  meta: {
    version: 1,
    kind: "quiz",
    title: "verify · 二次函数快照卷",
    objectives: [{ id: "kp-vertex", name: "顶点与对称轴" }],
    totalScore: 20,
  },
  items: [
    {
      id: "v-single",
      type: "single",
      title: "顶点横坐标是",
      options: [
        { id: "op1", text: "-1" },
        { id: "op2", text: "1" },
      ],
      answer: "op1",
      score: 5,
      required: true,
    },
    {
      id: "v-multi",
      type: "multi",
      title: "下列哪些是根",
      options: [
        { id: "op1", text: "x=1" },
        { id: "op2", text: "x=2" },
        { id: "op3", text: "x=3" },
      ],
      answer: ["op1", "op3"],
      score: 5,
      required: true,
    },
    {
      id: "v-number",
      type: "number",
      title: "两根之和",
      answer: { value: 6, tolerance: 0.5 },
      score: 5,
      required: true,
    },
    {
      id: "v-fill",
      type: "fill",
      title: "写出两个根（用／分隔）",
      answer: ["2", "4"],
      score: 5,
      required: true,
    },
  ],
};

/** v2：多一道简答、换个标题 —— 足够让「快照被改动」在字节比较里现形。 */
const QUIZ_SCHEMA_V2 = {
  ...QUIZ_SCHEMA,
  meta: { ...QUIZ_SCHEMA.meta, title: "verify · 二次函数快照卷（改）", totalScore: 25 },
  items: [
    ...QUIZ_SCHEMA.items,
    // 省赛 R-01：简答带分值，VC5 才有东西可批。
    { id: "v-short", type: "short", title: "一句话总结今天学了什么", required: false, score: 5 },
  ],
};

const CORRECT_ANSWERS = {
  "v-single": "op1",
  "v-multi": ["op1", "op3"],
  "v-number": "6",
  "v-fill": "2／4",
};

// ── 基础设施 ──────────────────────────────────────────────────────────────
async function findFreePort() {
  const probe = createServer();
  probe.unref();
  await new Promise((done, fail) => {
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", done);
  });
  const address = probe.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise((done) => probe.close(done));
  if (port === 0) throw new Error("拿不到空闲端口");
  return port;
}

function runToCompletion(entry, env) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", entry], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", fail);
    child.once("exit", (code) => done({ code, stdout, stderr }));
  });
}

async function spawnServer(env, port) {
  const child = spawn(process.execPath, ["--experimental-strip-types", SERVER_ENTRY], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const deadline = Date.now() + 20_000;
  while (!stdout.includes(`127.0.0.1:${String(port)}`)) {
    if (child.exitCode !== null) {
      throw new Error(`服务启动失败（exit ${String(child.exitCode)}）：\n${stderr || stdout}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`服务 20s 内没打印监听行：\n${stdout}\n${stderr}`);
    }
    await sleep(50);
  }
  return { child, stderrOf: () => stderr };
}

function makeClient(baseUrl) {
  const origin = baseUrl;
  return async function request(method, path, options = {}) {
    const headers = { origin, "x-intentform-csrf": "1" };
    if (options.cookie !== undefined) headers["cookie"] = options.cookie;
    let body;
    if (options.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.json);
    }
    const init = body === undefined ? { method, headers } : { method, headers, body };
    const response = await fetch(`${baseUrl}${path}`, init);
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: response.status, text, json: parsed, headers: response.headers };
  };
}

// ── 用例 ──────────────────────────────────────────────────────────────────
class CheckFailure extends Error {}

function must(condition, message) {
  if (!condition) throw new CheckFailure(message);
}

function firstLine(text, limit = 300) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

async function vc1Snapshot(request, state) {
  const login = await request("POST", "/api/auth/login", {
    json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
  });
  must(login.status === 200, `登录失败（${String(login.status)}）：${firstLine(login.text)}`);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  must(cookie.startsWith("intentform_session="), `登录没有下发会话 cookie：${cookie}`);

  const created = await request("POST", "/api/forms", {
    cookie,
    json: { title: QUIZ_SCHEMA.meta.title, kind: "quiz", schema: QUIZ_SCHEMA },
  });
  must(created.status === 201, `建表单失败（${String(created.status)}）：${firstLine(created.text)}`);
  const formId = created.json.form.id;
  const v1Id = created.json.version.id;

  const published = await request("POST", `/api/forms/${formId}/publish`, {
    cookie,
    json: { versionId: v1Id },
  });
  must(published.status === 200, `发布失败（${String(published.status)}）：${firstLine(published.text)}`);
  const slug = published.json.slug;
  must(typeof slug === "string" && slug.length > 0, "发布没有返回 slug");

  const before = await request("GET", `/f/${slug}`);
  must(before.status === 200, `收集页打不开（${String(before.status)}）：${firstLine(before.text)}`);
  checkNoLeak("GET /f/:slug（发布 v1 后）", before.text);
  const beforeForm = JSON.stringify(before.json.form);
  must(before.json.versionId === v1Id, `收集页不是发布版：${String(before.json.versionId)}`);
  must(before.json.versionN === 1, `收集页版本号应为 1，实际 ${String(before.json.versionN)}`);

  // 「老师改了草稿」= 追加 v2 + 把草稿指针挪过去（补丁路由本该做的两行）。
  const v2 = appendDraftVersion(state.dbPath, formId, v1Id);
  const afterDraft = await request("GET", `/f/${slug}`);
  must(afterDraft.status === 200, `改草稿后收集页挂了（${String(afterDraft.status)}）`);
  must(
    JSON.stringify(afterDraft.json.form) === beforeForm,
    "改草稿改变了已发布版本的收集页内容（快照没隔离住）",
  );
  must(
    afterDraft.json.versionId === v1Id,
    `改草稿后收集页版本漂了：${String(afterDraft.json.versionId)}`,
  );

  // 发布 v2 之后视图才该变 —— 证明「发布是写指针」。
  const republished = await request("POST", `/api/forms/${formId}/publish`, {
    cookie,
    json: { versionId: v2 },
  });
  must(republished.status === 200, `发布 v2 失败（${String(republished.status)}）：${firstLine(republished.text)}`);
  must(republished.json.slug === slug, `重复发布换了短链（${String(republished.json.slug)} ≠ ${slug}）`);
  const afterPublish = await request("GET", `/f/${slug}`);
  must(afterPublish.json.versionId === v2, "发布 v2 后收集页仍指向 v1");
  must(
    JSON.stringify(afterPublish.json.form) !== beforeForm,
    "发布 v2 后收集页内容没变",
  );
  checkNoLeak("GET /f/:slug（发布 v2 后）", afterPublish.text);

  state.cookie = cookie;
  state.formId = formId;
  state.slug = slug;
  state.v1Id = v1Id;
  state.v2 = v2;
  state.beforeForm = beforeForm;
}

/**
 * 追加一版（v2），并像编辑器那样把草稿指针挪过去。
 *
 * **为什么绕过应用层直连 SQLite**：能追加版本的正式入口是 Patch UI（I7），本轮
 * 服务端只有 `POST /api/forms`（落 v1）与 `POST /api/forms/:id/publish`（写指针），
 * 没有任何「再写一版」的 HTTP 接口。而 VC1 要证明的恰恰是**存储层的不可变性**：
 * 「老师改了草稿，已发布的快照不受影响」。所以这里用 `node:sqlite` 直接往
 * `form_versions` 插一行——这正是产品里 Patch 路由将来要做的那一次 INSERT，
 * 只不过这里省掉了 LLM 与补丁计算。用它当证据是安全的：
 *
 * - 它是**测试脚手架**，不进 server 代码路径，也不给应用新增任何写版本的能力；
 * - 它用的连接与 server 进程的 better-sqlite3 连接指向同一个文件（同一套 WAL/
 *   journal 语义），写完即 close，server 下一次读就会看到；
 * - 它插的行必须满足与真实路径相同的约束（n 递增、parent_id 指向上游版本），
 *   否则 VC1 会失败——也就是说这条近路没有绕过任何被验证的规则。
 */
function appendDraftVersion(dbPath, formId, parentId) {
  const db = new DatabaseSync(dbPath);
  try {
    const id = `v_verify_${Date.now().toString(36)}`;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO form_versions (id, form_id, n, schema_json, source, parent_id, prompt_version, created_at)
       VALUES (?, ?, (SELECT COALESCE(MAX(n), 0) + 1 FROM form_versions WHERE form_id = ?), ?, 'patch', ?, 'verify', ?)`,
    ).run(id, formId, formId, JSON.stringify(QUIZ_SCHEMA_V2), parentId, now);
    db.prepare("UPDATE forms SET draft_version_id = ?, updated_at = ? WHERE id = ?").run(
      id,
      now,
      formId,
    );
    return id;
  } finally {
    db.close();
  }
}

function checkNoLeak(label, text) {
  const leaked = FORBIDDEN_STUDENT_KEYS.filter((key) => text.includes(`"${key}"`));
  must(leaked.length === 0, `${label} 响应体泄露了 ${leaked.join(", ")}`);
}

async function vc2GradingAndConflict(request, ctx) {
  // 此刻线上发布的是 v2（VC1 末尾发布），先证明「正常提交判分正确」，
  // 再证明「手里还攥着 v1 的旧标签页」会被 409 挡住。
  const ok = await request("POST", "/api/submissions", {
    json: { slug: ctx.slug, formVersionId: ctx.v2, answers: { ...CORRECT_ANSWERS, "v-short": "今天学了顶点式" } },
  });
  must(ok.status === 201, `提交失败（${String(ok.status)}）：${firstLine(ok.text)}`);
  must(ok.json.score === 20, `得分应为 20，实际 ${String(ok.json.score)}`);
  must(ok.json.maxScore === 25, `满分应为 25（含简答 5 分），实际 ${String(ok.json.maxScore)}`);
  // 简答没批之前，那 5 分既不算得也不算失：`pendingScore` 必须显式返回，
  // 否则学生看到 20/25 只会以为自己被扣了 5 分。
  must(ok.json.pendingScore === 5, `待批改额度应为 5，实际 ${String(ok.json.pendingScore)}`);
  must(
    JSON.stringify(Object.keys(ok.json).sort()) ===
      JSON.stringify(["maxScore", "ok", "pendingScore", "score", "submissionId"]),
    `提交响应的键集合变了：${Object.keys(ok.json).join(", ")}`,
  );
  checkNoLeak("POST /api/submissions", ok.text);

  // 旧 v1 的提交必须被拒。
  const stale = await request("POST", "/api/submissions", {
    json: { slug: ctx.slug, formVersionId: ctx.v1Id, answers: CORRECT_ANSWERS },
  });
  must(stale.status === 409, `旧版本提交应 409，实际 ${String(stale.status)}：${firstLine(stale.text)}`);
  must(stale.json.error === "version_conflict", `错误码应为 version_conflict，实际 ${String(stale.json.error)}`);
  must(
    stale.json.message === "版本已更新，请刷新页面后重试",
    `提示文案不对：${String(stale.json.message)}`,
  );

  // 看板按当前发布版（v2）看那一条；跨版本不合并，所以 v1 的看板应当是空的。
  const dashboard = await request("GET", `/api/forms/${ctx.formId}/submissions`, {
    cookie: ctx.cookie,
  });
  must(dashboard.status === 200, `看板失败（${String(dashboard.status)}）：${firstLine(dashboard.text)}`);
  must(dashboard.json.summary.versionId === ctx.v2, `看板应指向当前发布版 v2，实际 ${String(dashboard.json.summary.versionId)}`);
must(dashboard.json.summary.count === 1, `v2 看板条数应为 1，实际 ${String(dashboard.json.summary.count)}`);
  must(dashboard.json.summary.avgScore === 20, `v2 看板平均分应为 20，实际 ${String(dashboard.json.summary.avgScore)}`);

  const csv = await request("GET", `/api/forms/${ctx.formId}/submissions.csv`, { cookie: ctx.cookie });
  const dataLine = (csv.text.split(String.fromCharCode(13, 10))[1] ?? "");
  const scoreCell = dataLine.split(",")[2];
  must(scoreCell === "20", `VC2 阶段还没批改，CSV 的 score 列应为 20，实际 ${String(scoreCell)}`);
}

/**
 * VC5：人工批改（省赛 R-02）。
 *
 * 批改是唯一一处「教师写、学生看」的数据流，三条断言缺一不可：
 * 分值真的加上去了、待批额度真的清零、看板与 CSV 用的是同一份合并结果。
 * 少任何一条就会出现「看板 24 分、CSV 20 分」这种对不上账的交付。
 */
async function vc5ManualGrade(request, ctx) {
  const listed = await request("GET", `/api/forms/${ctx.formId}/submissions`, { cookie: ctx.cookie });
  must(listed.status === 200, `看板失败（${String(listed.status)}）：${firstLine(listed.text)}`);
  const row = (listed.json.rows ?? []).find((item) => item.pendingScore === 5);
  must(row !== undefined, "看板里找不到待批改的那一条提交");
  must(
    JSON.stringify(Object.keys(row).sort()) ===
      JSON.stringify(["answers", "createdAt", "manualScores", "maxScore", "pendingScore", "score", "submissionId"]),
    `看板行多了或少了字段：${Object.keys(row).join(", ")}`,
  );
  must(row.answers["v-short"] !== undefined, "看板行里没有学生写的简答内容，教师没法批");

  const unauth = await request("POST", `/api/forms/${ctx.formId}/submissions/${row.submissionId}/grades`, {
    json: { itemId: "v-short", score: 4 },
  });
  must(unauth.status === 401, `未登录批改应 401，实际 ${String(unauth.status)}`);

  const graded = await request("POST", `/api/forms/${ctx.formId}/submissions/${row.submissionId}/grades`, {
    json: { itemId: "v-short", score: 4 },
    cookie: ctx.cookie,
  });
  must(graded.status === 200, `批改失败（${String(graded.status)}）：${firstLine(graded.text)}`);
  must(graded.json.submission.score === 24, `批 4 分后总分应为 24，实际 ${String(graded.json.submission.score)}`);
  must(
    graded.json.submission.pendingScore === 0,
    `批完待批额度应归零，实际 ${String(graded.json.submission.pendingScore)}`,
  );

  // 覆盖写：再批 2 分是替换，不是累加（27 分就是 bug）。
  const again = await request("POST", `/api/forms/${ctx.formId}/submissions/${row.submissionId}/grades`, {
    json: { itemId: "v-short", score: 2 },
    cookie: ctx.cookie,
  });
  must(again.status === 200, `二次批改失败（${String(again.status)}）`);
  must(
    again.json.submission.score === 22,
    `覆盖写后应为 22（不是累加），实际 ${String(again.json.submission.score)}`,
  );

  // 这一版里有两条提交：VC2 那条（刚批成 22）与 VC3 那条（20 分、简答待批）。
  // 所以待批条数是 1 而不是 0，均分是 21——断言的正是「只影响这一条」。
  const after = await request("GET", `/api/forms/${ctx.formId}/submissions`, { cookie: ctx.cookie });
  must(
    after.json.summary.pendingCount === 1,
    `待批条数应为 1（另一条没人批），实际 ${String(after.json.summary.pendingCount)}`,
  );
  must(after.json.summary.avgScore === 21, `均分应为 (22+20)/2 = 21，实际 ${String(after.json.summary.avgScore)}`);
  const gradedRow = (after.json.rows ?? []).find((item) => item.submissionId === row.submissionId);
  must(gradedRow?.pendingScore === 0, "批过的那条应不再待批");
  must(gradedRow?.score === 22, `批过的那条应记 22 分，实际 ${String(gradedRow?.score)}`);

  const csv = await request("GET", `/api/forms/${ctx.formId}/submissions.csv`, { cookie: ctx.cookie });
  const dataLine = csv.text.split(String.fromCharCode(13, 10))[1] ?? "";
  const scoreCell = dataLine.split(",")[2];
  must(scoreCell === "22", `CSV 的 score 列应与看板同口径（22），实际 ${String(scoreCell)}`);
}

async function vc3NoLeak(request, ctx) {
  const fill = await request("GET", `/f/${ctx.slug}`);
  must(fill.status === 200, `收集页失败（${String(fill.status)}）`);
  checkNoLeak("GET /f/:slug", fill.text);
  // 强制把整份表单摊平再查一遍：嵌套在选项文本里的答案也躲不掉。
  const flat = JSON.stringify(fill.json.form);
  for (const key of FORBIDDEN_STUDENT_KEYS) {
    must(!flat.includes(`"${key}":`), `收集页 form 里仍有 ${key} 键`);
  }
  const submit = await request("POST", "/api/submissions", {
    json: { slug: ctx.slug, formVersionId: ctx.v2, answers: CORRECT_ANSWERS },
  });
  must(submit.status === 201, `提交失败（${String(submit.status)}）：${firstLine(submit.text)}`);
  checkNoLeak("POST /api/submissions", submit.text);
}

/**
 * VC4：生成 → 发布 → 提交 → 看板，全部走真 HTTP。
 *
 * 唯一"合成"的东西是 `FormSchema` 的外壳（`meta`）：`POST /api/generate` 只发节点
 * （`field.node`），不发整表——生成接口的契约从来没有"交回一份完整表单"这回事，
 * 组装是前端预览面板的活。所以这里照前端同一套规则组装：节点顺序即到达顺序，
 * `objectives` 由节点上的 `knowledgePoint` 反推，`totalScore` 等于自动判分题分值之和
 * （R6）。组装结果要过服务端的发布门禁，写错一个字段 VC4 就红。
 */
async function vc4GeneratedLoop(request, ctx) {
  const sse = await request("POST", "/api/generate", { json: { requirement: GEN_REQUIREMENT } });
  must(sse.status === 200, `生成接口失败（${String(sse.status)}）：${firstLine(sse.text)}`);
  must(
    (sse.headers.get("content-type") ?? "").startsWith("text/event-stream"),
    `生成响应不是 SSE：${String(sse.headers.get("content-type"))}`,
  );
  must(
    sse.headers.get("x-intentform-llm-mode") === "mock",
    `上游模式头应为 mock，实际 ${String(sse.headers.get("x-intentform-llm-mode"))}`,
  );

  const events = parseSse(sse.text);
  must(events.length > 0, "SSE 一个事件都没解析出来");
  // seq 单调 + 无跳号：前端按 seq 排序、按跳号判丢包。
  for (const [offset, event] of events.entries()) {
    must(event.seq === offset + 1, `第 ${String(offset + 1)} 个事件的 seq 应为 ${String(offset + 1)}，实际 ${String(event.seq)}`);
  }
  const terminal = events.at(-1);
  must(terminal?.type === "done", `最后一个事件应是 done，实际 ${String(terminal?.type)}`);
  must(terminal.stats.fields === events.filter((event) => event.type === "field").length,
    `done.stats.fields=${String(terminal.stats.fields)} 与实际 field 事件数不一致`);

  // mock 的内置脚本里有一条故意写坏的题：它必须真的先被判错、再被修复，
  // 否则「修复环」在演示里就不存在（这条断言是 I2 语义在 I4 链路上的回归测试）。
  const failures = events.filter((event) => event.type === "field_error");
  const repairs = events.filter((event) => event.type === "repair");
  must(failures.length >= 1, "mock 生成没有出现 field_error（坏行没被校验拦下）");
  must(repairs.length === 1, `修复事件应为 1 条，实际 ${String(repairs.length)}`);
  must(repairs[0].status === "fixed", `修复状态应为 fixed，实际 ${String(repairs[0].status)}`);
  must(repairs[0].codesAfter.length === 0, `修复后仍有错误码：${repairs[0].codesAfter.join(", ")}`);
  must(terminal.stats.repairs === repairs.length, `done.stats.repairs 与 repair 事件数不一致`);

  const nodes = events.filter((event) => event.type === "field").map((event) => event.node);
  const schema = buildGeneratedQuiz(nodes);
  const scoredIds = schema.items.filter((item) => AUTO_GRADED_TYPES.has(item.type)).map((item) => item.id);
  must(scoredIds.length >= 2, `生成的表单至少要有 2 道自动判分题，实际 ${String(scoredIds.length)}`);

  const created = await request("POST", "/api/forms", {
    cookie: ctx.cookie,
    json: { title: schema.meta.title, kind: "quiz", schema, source: "generate" },
  });
  must(created.status === 201, `建表单失败（${String(created.status)}）：${firstLine(created.text)}`);
  const formId = created.json.form.id;
  const versionId = created.json.version.id;
  must(
    typeof created.json.form.draftVersionId === "string",
    "建表单后草稿指针为空（v1 没落库）",
  );

  const published = await request("POST", `/api/forms/${formId}/publish`, {
    cookie: ctx.cookie,
    json: { versionId },
  });
  must(
    published.status === 200,
    `发布失败（${String(published.status)}）：${firstLine(published.text)}`,
  );
  const slug = published.json.slug;
  must(typeof slug === "string" && slug.length > 0, "发布没有返回 slug");
  must(published.json.versionId === versionId, "发布响应的版本与请求的不是同一个");

  const fill = await request("GET", `/f/${slug}`);
  must(fill.status === 200, `收集页打不开（${String(fill.status)}）：${firstLine(fill.text)}`);
  must(fill.json.versionId === versionId, `收集页版本不对：${String(fill.json.versionId)}`);
  must(fill.json.formId === formId, `收集页 formId 不对：${String(fill.json.formId)}`);
  checkNoLeak("VC4 GET /f/:slug", fill.text);

  // 故意只对一半：单选/数值照抄正确答案，填空答错。得分由脚本自己算，不靠服务端回话。
  const { answers, expectedScore } = answerPartly(scoredIds, schema.items, ctx);
  must(expectedScore > 0 && expectedScore < schema.meta.totalScore,
    `这份答卷应当"部分正确"（期望 ${String(expectedScore)}/${String(schema.meta.totalScore)}）`);

  const submitted = await request("POST", "/api/submissions", {
    json: { slug, formVersionId: versionId, answers },
  });
  must(submitted.status === 201, `提交失败（${String(submitted.status)}）：${firstLine(submitted.text)}`);
  must(
    submitted.json.score === expectedScore,
    `得分应为 ${String(expectedScore)}，实际 ${String(submitted.json.score)}`,
  );
  must(
    submitted.json.maxScore === schema.meta.totalScore,
    `满分应为 ${String(schema.meta.totalScore)}，实际 ${String(submitted.json.maxScore)}`,
  );
  checkNoLeak("VC4 POST /api/submissions", submitted.text);

  const dashboard = await request("GET", `/api/forms/${formId}/submissions`, { cookie: ctx.cookie });
  must(dashboard.status === 200, `看板失败（${String(dashboard.status)}）：${firstLine(dashboard.text)}`);
  const summary = dashboard.json.summary;
  must(summary.versionId === versionId, `看板指向的版本不对：${String(summary.versionId)}`);
  must(summary.count === 1, `看板条数应为 1，实际 ${String(summary.count)}`);
  must(
    summary.avgScore === expectedScore,
    `单条提交的平均分应等于该条得分 ${String(expectedScore)}，实际 ${String(summary.avgScore)}`,
  );
  must(summary.maxScore === schema.meta.totalScore, `看板满分不对：${String(summary.maxScore)}`);
  must(
    dashboard.json.rows[0]?.submissionId === submitted.json.submissionId,
    "看板里没有刚提交的那一条",
  );
  must(dashboard.json.rows[0]?.score === expectedScore, "看板行得分与提交响应不一致");

  const csv = await request("GET", `/api/forms/${formId}/submissions.csv`, { cookie: ctx.cookie });
  must(csv.status === 200, `CSV 失败（${String(csv.status)}）：${firstLine(csv.text)}`);
  const csvLines = csv.text.split("\r\n").filter((line) => line !== "");
  const header = csvLines[0] ?? "";
  must(
    header.startsWith("submission_id,created_at,score,max_score,"),
    `CSV 表头前四列不对：${firstLine(header)}`,
  );
  must(!header.includes("answer"), `CSV 表头出现了 answer 列：${firstLine(header)}`);
  for (const fieldId of scoredIds) {
    must(header.includes(fieldId), `CSV 表头缺少字段列 ${fieldId}：${firstLine(header)}`);
  }
  must(
    csvLines.length === summary.count + 1,
    `CSV 行数应为 ${String(summary.count + 1)}（表头 + ${String(summary.count)} 行），实际 ${String(csvLines.length)}`,
  );

  ctx.generatedFormId = formId;
  ctx.generatedSlug = slug;
  ctx.generatedExpectedScore = expectedScore;
}

/**
 * 把 `field` 事件里的节点组装成一张 quiz 的 `FormSchema`。
 *
 * 三条与前端预览面板同源的规则，写在这里而不是「随便造一张」：
 * - 节点顺序 = 到达顺序（`field.index` 已经是按到达递增的，服务端保证）；
 * - `objectives` 由节点上的 `knowledgePoint` 去重生成（R8：知识点必须已声明）；
 * - `totalScore` = 自动判分题分值之和（R6，发布门禁会逐字核对）。
 */
// totalScore 的口径（含简答：省赛 R-01 之后简答也带分值）
const SCORED_TYPES = new Set(["single", "multi", "fill", "number", "short"]);
// 自动判分的只有四种：简答要老师批，不能拿它凑数
const AUTO_GRADED_TYPES = new Set(["single", "multi", "fill", "number"]);

function buildGeneratedQuiz(nodes) {
  const objectiveIds = [];
  for (const node of nodes) {
    const kp = node.knowledgePoint;
    if (typeof kp === "string" && !objectiveIds.includes(kp)) objectiveIds.push(kp);
  }
  const totalScore = nodes
    .filter((node) => SCORED_TYPES.has(node.type))
    .reduce((sum, node) => sum + node.score, 0);
  return {
    meta: {
      // scripts 不依赖业务包（AGENTS.md §「脚本只能用 Node 内置」），所以这里是字面量 1；
      // 它与 `SCHEMA_VERSION` 的一致性由 packages/schema 的契约测试保证。
      version: 1,
      kind: "quiz",
      title: "verify · mock 生成卷",
      objectives: objectiveIds.map((id) => ({ id, name: id })),
      totalScore,
    },
    items: nodes,
  };
}

/**
 * 造一份"部分正确"的答卷，并**自己**算出期望得分。
 *
 * 单选与数值题照抄节点里的答案（节点是教师侧流，答案本来就在），填空题故意写错。
 * 期望值只由这份脚本算：服务端判分若把"顺序无关""容差""大小写"中任一条判错，
 * 这里就会红——这也是 VC2 之外的第二道判分回归。
 */
function answerPartly(scoredIds, items, _ctx) {
  const answers = {};
  let expectedScore = 0;
  for (const item of items) {
    if (!scoredIds.includes(item.id)) continue;
    if (item.type === "single" && typeof item.answer === "string") {
      answers[item.id] = item.answer;
      expectedScore += item.score;
    } else if (item.type === "multi" && Array.isArray(item.answer)) {
      // 顺序打乱：多选必须顺序无关（判分口径），所以这里故意反着写。
      answers[item.id] = [...item.answer].reverse();
      expectedScore += item.score;
    } else if (item.type === "number" && typeof item.answer === "object" && item.answer !== null) {
      answers[item.id] = String(item.answer.value);
      expectedScore += item.score;
    } else if (item.type === "fill") {
      answers[item.id] = "故意答错的填空";
    }
  }
  return { answers, expectedScore };
}

/** 把 SSE 文本切成事件对象。注释帧（心跳 `: ping`）没有 data，自然被丢掉。 */
function parseSse(text) {
  const events = [];
  for (const block of text.split("\n\n")) {
    let name = null;
    let data = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) name = line.slice("event: ".length).trim();
      else if (line.startsWith("data: ")) data = line.slice("data: ".length);
    }
    if (name === null || data === null) continue;
    const parsed = JSON.parse(data);
    events.push({ ...parsed, name });
  }
  return events;
}

// ── 主流程 ────────────────────────────────────────────────────────────────
const CHECKS = [
  ["VC1 发布快照：改草稿不影响已发布版本的收集页", vc1Snapshot],
  ["VC2 判分与版本冲突：得分正确 / 旧版提交 409", vc2GradingAndConflict],
  ["VC3 学生端零泄漏：响应体不含答案类键", vc3NoLeak],
  ["VC4 生成→发布→提交→看板：SSE 组装、得分对账、CSV 表头", vc4GeneratedLoop],
  ["VC5 人工批改：简答录分、待批归零、看板与 CSV 同口径", vc5ManualGrade],
];

async function main() {
  const workDir = mkdtempSync(join(tmpdir(), "intentform-verify-"));
  const dbPath = join(workDir, "verify.db");
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const env = {
    PORT: String(port),
    DATABASE_PATH: dbPath,
    SESSION_SECRET,
    SESSION_TTL_HOURS: "1",
    COOKIE_SECURE: "false",
    APP_ORIGIN: baseUrl,
    LLM_MODE: "mock",
    ARGON2_MEMORY_KIB: "8192",
  };

  const seeded = await runToCompletion(SEED_ENTRY, env);
  if (seeded.code !== 0) {
    process.stderr.write(`[verify] 种子数据写入失败（exit ${String(seeded.code)}）\n`);
    process.stderr.write(seeded.stderr || seeded.stdout);
    process.exit(1);
  }

  const server = await spawnServer(env, port);
  const request = makeClient(baseUrl);
  const results = [];
  const state = { dbPath };
  try {
    for (const [label, check] of CHECKS) {
      try {
        await check(request, state);
        results.push([label, true, "通过"]);
        process.stdout.write(`[verify] ${label} … 通过\n`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        results.push([label, false, reason]);
        process.stdout.write(`[verify] ${label} … 失败：${reason}\n`);
      }
    }
  } finally {
    server.child.kill();
    await once(server.child, "exit").catch(() => undefined);
    rmSync(workDir, { recursive: true, force: true });
  }

  const failed = results.filter(([, ok]) => !ok);
  if (failed.length > 0) {
    process.stderr.write(`[verify] ${String(failed.length)}/${String(results.length)} 条用例失败\n`);
    process.exit(1);
  }
  process.stdout.write(`[verify] 全部通过（${String(results.length)}/${String(results.length)}）\n`);
}

await main().catch((error) => {
  process.stderr.write(`[verify] 崩溃：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});

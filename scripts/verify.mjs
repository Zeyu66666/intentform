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
 *   VC6 受限修改与撤销：`PATCH /api/forms/:id` 追加草稿版本、旧 `baseVersionId` 409、
 *      `POST /api/forms/:id/undo` 退回父版本（省赛 R-03）。
 *   VC7 每题正确率：三份提交（全对 / 只对一半 / 未作答）下逐题统计的 total / answered /
 *      correct / rate 逐个对；零提交时 rate 是 null（省赛 R-04）。
 *   VC9 两阶段蓝图：`/api/plan` 产出自洽蓝图、补答拼进需求；带蓝图生成时 plan 阶段与
 *      蓝图对照真实出现，不带时两者都不出现（省赛 R-06）。
 *   VC4 生成→发布→提交→看板：`LLM_MODE=mock` 走完整的 SSE 生成，把 `field` 事件里
 *                 的节点组装成 quiz 表单，发布后提交一份**故意只对一半**的答卷，
 *                 得分必须等于脚本自己算出的期望值（不是"大于 0"），再看板与 CSV 对账。
 *
 * 服务进程统一用 `LLM_MODE=mock`：VC1–VC3 完全不碰 `/api/generate`，所以换模式对它们
 * 零影响；而 VC4 需要一条**确定性**的生成流（mock 是内置脚本 + 一条故意写坏再修复的题，
 * 不调模型、每次事件序列相同），否则「期望得分」本身就不成立。
 *
 * 曾经用 `node:sqlite` 直连数据库伪造「改草稿」：那时没有 PATCH 路由，而 VC1 的命题
 * 是「版本追加 + 指针移动彼此独立」。R-03 落地后 `PATCH /api/forms/:id` 就是那条真路，
 * 于是 VC1 改成打真接口——近路连同 `node:sqlite` 依赖一起删掉，证据链上不再有
 * 「脚本替应用做了它做不到的事」这一段。
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

  // 「老师改了草稿」= 真 PATCH：追加 v2 + 把草稿指针挪过去（R-03）。
  const patched = await request("PATCH", `/api/forms/${formId}`, {
    cookie,
    json: {
      baseVersionId: v1Id,
      // 两步改动正好覆盖「改题干」与「加题」：v2 因此比 v1 多一道简答（R-01 的
      // 简答带分值要在这里进来，否则 VC5 没有东西可批）。
      ops: [
        { op: "setStem", itemId: "v-single", title: "顶点横坐标是（改过草稿）" },
        {
          op: "addItem",
          index: QUIZ_SCHEMA.items.length,
          item: { id: "v-short", type: "short", title: "一句话总结今天学了什么", required: false, score: 5, maxLength: 100 },
        },
      ],
    },
  });
  must(patched.status === 200, `改草稿失败（${String(patched.status)}）：${firstLine(patched.text)}`);
  const v2 = patched.json.version.id;
  must(patched.json.version.n === 2, `改草稿应产生 v2，实际 n=${String(patched.json.version.n)}`);
  must(patched.json.version.source === "patch", `版本来源应为 patch，实际 ${String(patched.json.version.source)}`);
  must(
    patched.json.version.parentId === v1Id,
    `v2 的 parentId 应指向 v1，实际 ${String(patched.json.version.parentId)}`,
  );
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

/**
 * VC6：受限修改与撤销（省赛 R-03）。
 *
 * 四条命题，缺一条这个功能就不成立：
 * 1. PATCH 真的追加一版草稿，**不改已发布版本**（快照隔离在写路径上也成立）；
 * 2. 拿旧的 `baseVersionId` 再改 → 409，而不是静默覆盖别人刚做的改动；
 * 3. `undo` 把草稿指针退回父版本，**不多造版本**（版本行只增不改）；
 * 4. 撤销后仍能继续改，且新版本仍然挂在原来的父版本上。
 *
 * 第 2 条是这一轮最容易写错的地方：乐观锁一旦退化成"总是覆盖"，两个老师同时编辑
 * 就会互相吞改动，而这种 bug 在单用户演示里永远看不见。
 */
async function vc6PatchAndUndo(request, ctx) {
  const before = await request("GET", `/f/${ctx.slug}`);
  must(before.status === 200, `收集页失败（${String(before.status)}）`);
  const beforeForm = JSON.stringify(before.json.form);
  const draftVersionId = before.json.versionId === ctx.v2 ? ctx.v2 : undefined;
  must(draftVersionId !== undefined, `VC6 期望当前发布版是 v2，实际 ${String(before.json.versionId)}`);

  const patched = await request("PATCH", `/api/forms/${ctx.formId}`, {
    cookie: ctx.cookie,
    json: { baseVersionId: ctx.v2, ops: [{ op: "setScore", itemId: "v-single", score: 8 }] },
  });
  must(patched.status === 200, `PATCH 失败（${String(patched.status)}）：${firstLine(patched.text)}`);
  must(patched.json.version.n === 3, `PATCH 应产生 v3，实际 n=${String(patched.json.version.n)}`);
  // 总分由服务端重算：25 → 28（v-single 5→8）。前端传不进来，也不该传。
  must(
    patched.json.schema.meta.totalScore === 28,
    `改分值后总分应为 28，实际 ${String(patched.json.schema.meta.totalScore)}`,
  );
  const changed = patched.json.schema.items.find((item) => item.id === "v-single");
  must(changed?.score === 8, `v-single 的分值应为 8，实际 ${String(changed?.score)}`);

  // 命题 1：改草稿不影响已发布的收集页。
  const afterDraft = await request("GET", `/f/${ctx.slug}`);
  must(
    JSON.stringify(afterDraft.json.form) === beforeForm,
    "PATCH 改草稿后已发布收集页内容变了（快照没隔离住）",
  );
  must(afterDraft.json.versionId === ctx.v2, `收集页版本漂了：${String(afterDraft.json.versionId)}`);

  // 命题 2：旧 baseVersionId → 409，不静默覆盖。
  const stale = await request("PATCH", `/api/forms/${ctx.formId}`, {
    cookie: ctx.cookie,
    json: { baseVersionId: ctx.v2, ops: [{ op: "setStem", itemId: "v-single", title: "并发改动" }] },
  });
  must(stale.status === 409, `过期 baseVersionId 应 409，实际 ${String(stale.status)}：${firstLine(stale.text)}`);
  must(stale.json.error === "version_conflict", `错误码应为 version_conflict，实际 ${String(stale.json.error)}`);

  // 命题 3：撤销退回父版本，且不多造一行版本。
  const undo = await request("POST", `/api/forms/${ctx.formId}/undo`, {
    cookie: ctx.cookie,
    json: { fromVersionId: patched.json.version.id },
  });
  must(undo.status === 200, `撤销失败（${String(undo.status)}）：${firstLine(undo.text)}`);
  must(undo.json.undone === true, "撤销应返回 undone=true");
  must(undo.json.version.id === ctx.v2, `撤销后草稿应回到 v2，实际 ${String(undo.json.version.id)}`);
  must(
    undo.json.schema.meta.totalScore === 25,
    `撤销后总分应回到 25，实际 ${String(undo.json.schema.meta.totalScore)}`,
  );
  const detail = await request("GET", `/api/forms/${ctx.formId}`, { cookie: ctx.cookie });
  must(
    detail.json.form.draftVersionId === ctx.v2,
    `撤销后草稿指针应回到 v2，实际 ${String(detail.json.form.draftVersionId)}`,
  );

  // 命题 4：撤销后仍能改，且版本号只增（v3 不复用）。
  const again = await request("PATCH", `/api/forms/${ctx.formId}`, {
    cookie: ctx.cookie,
    json: { baseVersionId: ctx.v2, ops: [{ op: "setStem", itemId: "v-single", title: "顶点横坐标（再改）" }] },
  });
  must(again.status === 200, `撤销后再改失败（${String(again.status)}）：${firstLine(again.text)}`);
  must(again.json.version.n === 4, `撤销后再改应得 v4，实际 n=${String(again.json.version.n)}`);
  must(
    again.json.version.parentId === ctx.v2,
    `新版本的父版本应是 v2，实际 ${String(again.json.version.parentId)}`,
  );

  // 收尾：把草稿指针退回 v2，别把「未发布的改动」留给后面的用例。
  const restore = await request("POST", `/api/forms/${ctx.formId}/undo`, {
    cookie: ctx.cookie,
    json: { fromVersionId: again.json.version.id },
  });
  must(restore.status === 200, `收尾撤销失败（${String(restore.status)}）`);
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

/**
 * VC7：每题正确率（省赛 R-04）。
 *
 * 自带一份两张单选的卷子，不从 VC1 的卷子借数据——三个数必须一眼可算：
 * 第 1 份两题全对、第 2 份只对第一题、第 3 份整份没作答。
 * 于是第一题 `2/3`、第二题 `1/3`，而**分母都是 3**（未作答也算没答对）。
 *
 * 第二个断言在提交之前做：还没有人提交时 `rate` 必须是 `null`。
 * 如果这里出现 `0`，看板会把「还没人做」显示成「全班全错」——那是本轮最想防的误读。
 */
async function vc7ItemStats(request, ctx) {
  const schema = {
    meta: {
      version: 1,
      kind: "quiz",
      title: "verify · 逐题正确率",
      objectives: [{ id: "kp-basic", name: "基础运算" }],
      totalScore: 10,
    },
    items: [
      {
        id: "s-one",
        type: "single",
        title: "一加一等于",
        options: [
          { id: "op1", text: "1" },
          { id: "op2", text: "2" },
        ],
        answer: "op2",
        score: 5,
        bloom: "remember",
        knowledgePoint: "kp-basic",
        required: true,
      },
      {
        id: "s-two",
        type: "single",
        title: "二加二等于",
        options: [
          { id: "op3", text: "3" },
          { id: "op4", text: "4" },
        ],
        answer: "op4",
        score: 5,
        bloom: "apply",
        knowledgePoint: "kp-basic",
        required: true,
      },
    ],
  };
  const created = await request("POST", "/api/forms", {
    cookie: ctx.cookie,
    json: { title: schema.meta.title, kind: "quiz", schema },
  });
  must(created.status === 201, `VC7 建表单失败（${String(created.status)}）：${firstLine(created.text)}`);
  const formId = created.json.form.id;
  const versionId = created.json.version.id;
  const published = await request("POST", `/api/forms/${formId}/publish`, {
    cookie: ctx.cookie,
    json: { versionId },
  });
  must(published.status === 200, `VC7 发布失败（${String(published.status)}）：${firstLine(published.text)}`);
  const slug = published.json.slug;

  const empty = await request("GET", `/api/forms/${formId}/submissions`, { cookie: ctx.cookie });
  must(empty.status === 200, `VC7 看板失败（${String(empty.status)}）`);
  must(
    Array.isArray(empty.json.itemStats) && empty.json.itemStats.length === 2,
    `VC7 零提交时应有 2 条逐题统计，实际 ${JSON.stringify(empty.json.itemStats)}`,
  );
  const matrix = empty.json.coverageMatrix;
  must(
    matrix !== undefined && Array.isArray(matrix.blooms) && matrix.blooms.length === 6,
    `VC7 覆盖矩阵缺少六级布鲁姆列，实际 ${JSON.stringify(matrix)}`,
  );
  must(Array.isArray(matrix?.rows) && matrix.rows.length === 1, `VC7 矩阵应有 1 个知识点行，实际 ${JSON.stringify(matrix?.rows)}`);
  must(
    matrix.rows[0]?.objectiveId === "kp-basic" &&
      matrix.rows[0]?.counts.remember === 1 &&
      matrix.rows[0]?.counts.apply === 1 &&
      matrix.rows[0]?.counts.understand === 0,
    `VC7 矩阵计数不对：${JSON.stringify(matrix?.rows)}`,
  );
  for (const stat of empty.json.itemStats) {
    must(stat.total === 0, `VC7 零提交时 total 应为 0，实际 ${String(stat.total)}`);
    must(stat.rate === null, `VC7 零提交时 rate 应为 null（不是 0），实际 ${String(stat.rate)}`);
  }

  const submit = async (answers) => {
    const response = await request("POST", "/api/submissions", {
      json: { slug, formVersionId: versionId, answers },
    });
    must(response.status === 201, `VC7 提交失败（${String(response.status)}）：${firstLine(response.text)}`);
  };
  await submit({ "s-one": "op2", "s-two": "op4" }); // 两题全对
  await submit({ "s-one": "op2", "s-two": "op3" }); // 只对第一题
  await submit({}); // 整份没作答

  const after = await request("GET", `/api/forms/${formId}/submissions`, { cookie: ctx.cookie });
  must(after.status === 200, `VC7 看板失败（${String(after.status)}）`);
  const [first, second] = after.json.itemStats;
  must(
    first.itemId === "s-one" && first.total === 3 && first.answered === 2 && first.correct === 2,
    `VC7 第一题统计不对：${JSON.stringify(first)}`,
  );
  must(first.rate === 0.6667, `VC7 第一题 rate 应为 0.6667，实际 ${String(first.rate)}`);
  must(
    second.itemId === "s-two" && second.total === 3 && second.answered === 2 && second.correct === 1,
    `VC7 第二题统计不对：${JSON.stringify(second)}`,
  );
  must(second.rate === 0.3333, `VC7 第二题 rate 应为 0.3333，实际 ${String(second.rate)}`);
  must(
    after.json.summary.count === 3,
    `VC7 提交份数应为 3，实际 ${String(after.json.summary.count)}`,
  );
}

/**
 * VC8：意图澄清（省赛 R-05）。
 *
 * 四件事缺一不可：
 * 1. 含糊需求能被认出缺哪几个槽位（不是恒问、也不是不问）；
 * 2. 已经写全的需求**一个问题都不问**（预置需求走的是这条路，问一句就打断演示）；
 * 3. 补答会拼进需求，并由生成器在 `thinking` 里如实记一笔（时间线可定位）；
 * 4. 不补答时行为与以前一致——这也是 `VC4` 那类老用例还能过的前提。
 */
async function vc8Clarify(request) {
  const vague = await request("POST", "/api/clarify", {
    json: { requirement: "帮我出一份英语卷子" },
  });
  must(vague.status === 200, `澄清接口失败（${String(vague.status)}）：${firstLine(vague.text)}`);
  const slots = (vague.json.questions ?? []).map((question) => question.slot);
  must(slots.length >= 1 && slots.length <= 3, `追问应为 1–3 条，实际 ${String(slots.length)}`);
  must(
    JSON.stringify(slots) === JSON.stringify(["count", "score", "types"]),
    `含糊需求的槽位应为 count/score/types，实际 ${JSON.stringify(slots)}`,
  );
  for (const question of vague.json.questions) {
    must(typeof question.question === "string" && question.question.length > 0, "追问缺少问句");
  }

  const complete = await request("POST", "/api/clarify", {
    json: { requirement: "出一份初三物理小测：5 道题，3 道单选、2 道简答，共 25 分" },
  });
  must(complete.status === 200, `澄清接口失败（${String(complete.status)}）`);
  must(
    (complete.json.questions ?? []).length === 0,
    `完整需求不该被追问，实际问了 ${String((complete.json.questions ?? []).length)} 条`,
  );

  // 带着补答生成：只断言"事件流里真的记了这笔"，具体的 schema 由 mock 决定。
  const sse = await request("POST", "/api/generate", {
    json: {
      requirement: "帮我出一份英语卷子",
      clarifications: [
        { slot: "count", answer: "10 题" },
        { slot: "score", answer: "100 分" },
      ],
    },
  });
  must(sse.status === 200, `带补答生成失败（${String(sse.status)}）：${firstLine(sse.text)}`);
  const thinking = parseSse(sse.text).filter((event) => event.type === "thinking");
  const note = thinking.find((event) => typeof event.delta === "string" && event.delta.includes("澄清"));
  must(note !== undefined, "时间线里没有澄清记录（补答没被当成真实事件）");
  must(note.delta.includes("题量=10 题"), `澄清记录字段不对：${String(note.delta)}`);
  must(note.delta.includes("总分=100 分"), `澄清记录字段不对：${String(note.delta)}`);

  // 不带补答：事件流里不许出现澄清（只发真实事件）。
  const plain = await request("POST", "/api/generate", {
    json: { requirement: "帮我出一份英语卷子" },
  });
  must(plain.status === 200, `无补答生成失败（${String(plain.status)}）`);
  must(
    !parseSse(plain.text).some(
      (event) => event.type === "thinking" && typeof event.delta === "string" && event.delta.includes("澄清"),
    ),
    "没有补答却出现了澄清事件（时间线在演没发生的事）",
  );
}

/**
 * VC9：两阶段蓝图（省赛 R-06）。
 *
 * 四条命题：
 * 1. `/api/plan` 在 mock 下给出**自洽**蓝图（章节题量之和 = 总题量 = 题型分布之和）；
 * 2. 补答先拼进需求再规划，与生成用的是同一串；
 * 3. 带蓝图生成：时间线出现 plan 阶段与「蓝图已确认」，流尾有「蓝图对照」；
 * 4. 不带蓝图生成：既不出现 plan，也不出现蓝图对照（未发生不许演出）。
 */
async function vc9Blueprint(request) {
  const requirement = "出 6 道题：4 道单选、2 道填空，共 30 分，覆盖《顶点坐标》";
  const planned = await request("POST", "/api/plan", { json: { requirement } });
  must(planned.status === 200, `规划接口失败（${String(planned.status)}）：${firstLine(planned.text)}`);
  const blueprint = planned.json.blueprint;
  must(blueprint !== undefined, "规划接口没有返回蓝图");
  must(blueprint.totalCount === 6, `蓝图总题量应为 6，实际 ${String(blueprint.totalCount)}`);
  const sectionSum = (blueprint.sections ?? []).reduce((sum, section) => sum + section.count, 0);
  must(sectionSum === blueprint.totalCount, "蓝图不自洽：章节题量之和不等于总题量");
  const typeSum = Object.values(blueprint.typeMix ?? {}).reduce((sum, count) => sum + count, 0);
  must(typeSum === blueprint.totalCount, "蓝图不自洽：题型分布之和不等于总题量");
  must(typeof planned.json.summary === "string" && planned.json.summary.length > 0, "蓝图缺少摘要");

  const withClarify = await request("POST", "/api/plan", {
    json: { requirement: "帮我出一份英语卷子", clarifications: [{ slot: "count", answer: "10 题" }] },
  });
  must(withClarify.status === 200, `带补答规划失败（${String(withClarify.status)}）`);
  must(
    typeof withClarify.json.requirement === "string" && withClarify.json.requirement.includes("教师补充的约束"),
    "规划没有把补答拼进需求",
  );
  must(withClarify.json.blueprint.totalCount === 10, `补答说 10 题，蓝图应规划 10 题，实际 ${String(withClarify.json.blueprint.totalCount)}`);

  const generated = await request("POST", "/api/generate", { json: { requirement, blueprint } });
  must(generated.status === 200, `带蓝图生成失败（${String(generated.status)}）：${firstLine(generated.text)}`);
  const events = parseSse(generated.text);
  must(
    events.some((event) => event.type === "phase" && event.phase === "plan"),
    "带蓝图生成却没有 plan 阶段",
  );
  must(
    events.some((event) => event.type === "thinking" && String(event.delta).includes("蓝图已确认")),
    "时间线没有蓝图摘要",
  );
  must(
    events.some((event) => event.type === "thinking" && String(event.delta).includes("蓝图对照")),
    "流尾没有蓝图对照（偏差不可度量）",
  );

  const plain = await request("POST", "/api/generate", { json: { requirement } });
  const plainEvents = parseSse(plain.text);
  must(
    !plainEvents.some((event) => event.type === "phase" && event.phase === "plan"),
    "没有蓝图却出现了 plan 阶段（时间线在演没发生的事）",
  );
  must(
    !plainEvents.some((event) => event.type === "thinking" && String(event.delta).includes("蓝图")),
    "没有蓝图却出现了蓝图事件",
  );
}

/**
 * VC10：知识点 × 布鲁姆覆盖矩阵（省赛 R-07）。
 *
 * 矩阵必须来自当前版本的真实 Schema：六个层级固定可见，声明的知识点保留空单元格，
 * 未标注的字段不被猜测成覆盖，也不产生任何补题操作。
 */
async function vc10CoverageMatrix(request) {
  const schema = {
    meta: {
      version: 1,
      kind: "quiz",
      title: "verify · 覆盖矩阵",
      objectives: [
        { id: "kp-basic", name: "基础运算" },
        { id: "kp-empty", name: "未覆盖知识点" },
      ],
      totalScore: 10,
    },
    items: [
      {
        id: "m-one",
        type: "single",
        title: "概念题",
        options: [{ id: "a", text: "对" }, { id: "b", text: "错" }],
        answer: "a",
        score: 5,
        bloom: "remember",
        knowledgePoint: "kp-basic",
        required: true,
      },
      {
        id: "m-two",
        type: "single",
        title: "应用题",
        options: [{ id: "a", text: "对" }, { id: "b", text: "错" }],
        answer: "a",
        score: 5,
        bloom: "apply",
        knowledgePoint: "kp-basic",
        required: true,
      },
      { id: "m-note", type: "short", title: "未标注题", required: false, maxLength: 100 },
    ],
  };
  const login = await request("POST", "/api/auth/login", {
    json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
  });
  must(login.status === 200, `VC10 登录失败（${String(login.status)}）`);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const created = await request("POST", "/api/forms", {
    cookie,
    json: { title: schema.meta.title, kind: "quiz", schema },
  });
  must(created.status === 201, `VC10 建表单失败（${String(created.status)}）：${firstLine(created.text)}`);
  const published = await request("POST", `/api/forms/${created.json.form.id}/publish`, {
    cookie,
    json: { versionId: created.json.version.id },
  });
  must(published.status === 200, `VC10 发布失败（${String(published.status)}）`);
  const response = await request("GET", `/api/forms/${created.json.form.id}/submissions`, { cookie });
  must(response.status === 200, `VC10 看板失败（${String(response.status)}）`);
  const matrix = response.json.coverageMatrix;
  must(JSON.stringify(matrix.blooms) === JSON.stringify(["remember", "understand", "apply", "analyze", "evaluate", "create"]), "VC10 布鲁姆列不完整");
  must(matrix.rows.length === 2, `VC10 知识点行数应为 2，实际 ${String(matrix.rows.length)}`);
  const covered = matrix.rows.find((row) => row.objectiveId === "kp-basic");
  const empty = matrix.rows.find((row) => row.objectiveId === "kp-empty");
  must(covered?.counts.remember === 1 && covered.counts.apply === 1 && covered.counts.understand === 0, `VC10 已覆盖行计数不对：${JSON.stringify(covered)}`);
  must(empty !== undefined && Object.values(empty.counts).every((count) => count === 0), `VC10 空知识点单元格未保留：${JSON.stringify(empty)}`);
}

/**
 * VC11：survey 收集页闭环（省赛 R-09）。
 *
 * 问卷不参与评分：看板只展示逐字段填写数/分母/填写率；随后验证学生提交
 * 真正进入 CSV，避免只测一个静态 survey 页面。
 */
async function vc11SurveyCollection(request, ctx) {
  const schema = {
    meta: { version: 1, kind: "survey", title: "verify · 课程反馈", objectives: [] },
    items: [
      { id: "s-feedback", type: "short", title: "最有收获的一点", required: true, maxLength: 200 },
      { id: "s-confidence", type: "scale", title: "掌握信心", required: true, min: 1, max: 5 },
      { id: "s-suggest", type: "short", title: "建议", required: false, maxLength: 200 },
    ],
  };
  const created = await request("POST", "/api/forms", {
    cookie: ctx.cookie,
    json: { title: schema.meta.title, kind: "survey", schema },
  });
  must(created.status === 201, `VC11 建表单失败（${String(created.status)}）：${firstLine(created.text)}`);
  const formId = created.json.form.id;
  const versionId = created.json.version.id;
  const published = await request("POST", `/api/forms/${formId}/publish`, {
    cookie: ctx.cookie,
    json: { versionId },
  });
  must(published.status === 200, `VC11 发布失败（${String(published.status)}）：${firstLine(published.text)}`);
  const slug = published.json.slug;

  const empty = await request("GET", `/api/forms/${formId}/submissions`, { cookie: ctx.cookie });
  must(empty.status === 200, `VC11 空看板失败（${String(empty.status)}）`);
  must(empty.json.summary.kind === "survey", `VC11 summary.kind 应为 survey：${JSON.stringify(empty.json.summary)}`);
  must(empty.json.collectionStats.length === 3, `VC11 应返回 3 个可回收字段：${JSON.stringify(empty.json.collectionStats)}`);
  must(empty.json.collectionStats.every((stat) => stat.rate === null), `VC11 零提交填写率应为 null：${JSON.stringify(empty.json.collectionStats)}`);

  // 两份提交、量表分别取 4 与 2：既验填写率，也验「各选项分布」（A-09）。
  for (const answers of [
    { "s-feedback": "很有收获", "s-confidence": "4" },
    { "s-feedback": "一般", "s-confidence": "2" },
  ]) {
    const submitted = await request("POST", "/api/submissions", {
      json: { slug, formVersionId: versionId, answers },
    });
    must(submitted.status === 201, `VC11 收集页提交失败（${String(submitted.status)}）：${firstLine(submitted.text)}`);
  }
  const dashboard = await request("GET", `/api/forms/${formId}/submissions`, { cookie: ctx.cookie });
  must(dashboard.status === 200, `VC11 回收看板失败（${String(dashboard.status)}）`);
  must(dashboard.json.summary.kind === "survey", "VC11 回收看板类型不是 survey");
  const feedback = dashboard.json.collectionStats.find((stat) => stat.itemId === "s-feedback");
  const confidence = dashboard.json.collectionStats.find((stat) => stat.itemId === "s-confidence");
  must(feedback?.answered === 2 && feedback.rate === 1, `VC11 简答回收数不对：${JSON.stringify(feedback)}`);
  must(confidence?.rate === 1, `VC11 量表填写率不对：${JSON.stringify(confidence)}`);
  const confidenceOptions = confidence?.options ?? [];
  must(confidenceOptions.length === 5, `VC11 量表应给出 5 档分布：${JSON.stringify(confidenceOptions)}`);
  const byValue = Object.fromEntries(confidenceOptions.map((option) => [option.optionId, option.count]));
  must(byValue["4"] === 1 && byValue["2"] === 1 && byValue["1"] === 0, `VC11 量表分布计数不对：${JSON.stringify(byValue)}`);
  must(confidenceOptions.find((option) => option.optionId === "4")?.rate === 0.5, "VC11 量表选项占比应为 1/2");
  must(dashboard.json.itemStats.length === 0, `VC11 survey 不应出现正确率：${JSON.stringify(dashboard.json.itemStats)}`);

  const csv = await request("GET", `/api/forms/${formId}/submissions.csv`, { cookie: ctx.cookie });
  must(csv.status === 200, `VC11 CSV 导出失败（${String(csv.status)}）`);
  must(csv.text.includes("s-feedback") && csv.text.includes("很有收获"), `VC11 CSV 未回收填写数据：${firstLine(csv.text)}`);
}

/**
 * VC12：提交后答案解析开关（省赛附加 A-18）。
 *
 * 三个命题：
 * 1. 默认关闭：提交响应里连 `review` 键都没有，`GET /f/:slug` 依然零答案；
 * 2. 开启后：`review` 只随这次提交返回，选项 id 已换成文字，简答 `correct: null`；
 * 3. 开关是表单级设置，不进版本快照——开启后版本号不变。
 */
async function vc12AnswerReview(request, ctx) {
  const schema = {
    meta: { version: 1, kind: "quiz", title: "verify · 答案解析", objectives: [], totalScore: 10 },
    items: [
      {
        id: "r-single",
        type: "single",
        title: "一加一等于",
        options: [
          { id: "op1", text: "1" },
          { id: "op2", text: "2" },
        ],
        answer: "op2",
        score: 5,
        required: true,
        explanation: "基础加法",
      },
      { id: "r-short", type: "short", title: "说说思路", required: false, score: 5, maxLength: 100 },
    ],
  };
  const created = await request("POST", "/api/forms", {
    cookie: ctx.cookie,
    json: { title: schema.meta.title, kind: "quiz", schema },
  });
  must(created.status === 201, `VC12 建表单失败（${String(created.status)}）`);
  const formId = created.json.form.id;
  const versionId = created.json.version.id;
  const published = await request("POST", `/api/forms/${formId}/publish`, {
    cookie: ctx.cookie,
    json: { versionId },
  });
  must(published.status === 200, `VC12 发布失败（${String(published.status)}）`);
  const slug = published.json.slug;

  const settings = await request("GET", `/api/forms/${formId}/settings`, { cookie: ctx.cookie });
  must(settings.status === 200 && settings.json.showAnswersAfterSubmit === false, `VC12 默认应关闭：${settings.text}`);

  const answers = { "r-single": "op2", "r-short": "因为 1+1=2" };
  const closed = await request("POST", "/api/submissions", {
    json: { slug, formVersionId: versionId, answers },
  });
  must(closed.status === 201, `VC12 关闭态提交失败（${String(closed.status)}）`);
  must(!Object.hasOwn(closed.json, "review"), "VC12 关闭时提交响应不应带 review");
  must(!closed.text.includes("基础加法"), "VC12 关闭时提交响应泄露了解析");

  const enabled = await request("POST", `/api/forms/${formId}/settings`, {
    cookie: ctx.cookie,
    json: { showAnswersAfterSubmit: true },
  });
  must(enabled.status === 200 && enabled.json.showAnswersAfterSubmit === true, `VC12 开启失败：${enabled.text}`);

  const opened = await request("POST", "/api/submissions", {
    json: { slug, formVersionId: versionId, answers },
  });
  must(opened.status === 201, `VC12 开启态提交失败（${String(opened.status)}）`);
  const review = opened.json.review;
  must(Array.isArray(review) && review.length === 2, `VC12 review 应有 2 条：${opened.text}`);
  must(review[0].given === "2" && review[0].expected === "2" && review[0].correct === true, `VC12 单选题回看不对：${JSON.stringify(review[0])}`);
  must(review[0].explanation === "基础加法", "VC12 解析没有随 review 返回");
  must(review[1].correct === null && review[1].expected === "", `VC12 简答应为 null/空串：${JSON.stringify(review[1])}`);

  const view = await request("GET", `/f/${slug}`);
  must(view.status === 200 && !view.text.includes("基础加法") && !view.text.includes('"answer"'), "VC12 开启后公开视图仍应零答案");

  const detail = await request("GET", `/api/forms/${formId}`, { cookie: ctx.cookie });
  must(detail.json.version.n === 1, "VC12 展示设置不应产生新版本");
}

/**
 * VC13：单题修改（省赛附加 A-20 / P18）。
 *
 * 三段：
 * 1. **建议只改这一题**：mock 生成三题以上的卷子（第 2 题是 `q_single`），带
 *    `targetItemId` 请求建议 → `scope` 是 item、ops/changes 全指向第 2 题、建议
 *    本身不写库；采用后第 1/3 题字节不变。
 * 2. **答案改动进判分口径**：发布改前版本并交一份老答案 → 再 PATCH `setAnswer`
 *    （新版本 v3，**发布指针仍停在 v2**）→ 发布 v3 后用同一份老答案提交，该题判错；
 *    再按 `?versionId=v2` 查历史看板，旧提交得分不变。
 * 3. **作用域兜底**：不存在的 `targetItemId` 回 422，且不产生版本。
 *
 * 「模型越界被拦」在 HTTP 层构造不出来（mock 不越界），归
 * `packages/llm/src/patch-suggest.test.ts` 与 `server/src/suggest-route.test.ts`
 * 的单测覆盖——这里不假装验证过。
 */
async function vc13SingleItemEdit(request, ctx) {
  const sse = await request("POST", "/api/generate", { json: { requirement: GEN_REQUIREMENT } });
  must(sse.status === 200, `VC13 生成接口失败（${String(sse.status)}）：${firstLine(sse.text)}`);
  const nodes = parseSse(sse.text)
    .filter((event) => event.type === "field")
    .map((event) => event.node);
  const schema = buildGeneratedQuiz(nodes);
  must(schema.items.length >= 3, `VC13 至少需要 3 道题，实际 ${String(schema.items.length)}`);

  const created = await request("POST", "/api/forms", {
    cookie: ctx.cookie,
    json: { title: schema.meta.title, kind: "quiz", schema, source: "generate" },
  });
  must(created.status === 201, `VC13 建表单失败（${String(created.status)}）：${firstLine(created.text)}`);
  const formId = created.json.form.id;
  const v1 = created.json.version.id;
  // 建表单的响应不带 schema（契约如此），从详情读回落库后的形状（已补默认值）。
  const initial = await request("GET", `/api/forms/${formId}`, { cookie: ctx.cookie });
  must(initial.status === 200, `VC13 读详情失败（${String(initial.status)}）`);
  const storedBefore = initial.json.schema.items.map((item) => JSON.stringify(item));
  const targetIndex = 1;
  const target = initial.json.schema.items[targetIndex];
  must(target !== undefined && target.type === "single", `VC13 第 2 题应是单选题：${JSON.stringify(target)}`);

  // ── 第 1 段：单题建议 ────────────────────────────────────────────────
  const suggested = await request("POST", `/api/forms/${formId}/suggest`, {
    cookie: ctx.cookie,
    json: { baseVersionId: v1, instruction: "把这题改简单点", targetItemId: target.id },
  });
  must(suggested.status === 200, `VC13 单题建议失败（${String(suggested.status)}）：${firstLine(suggested.text)}`);
  must(suggested.json.scope?.kind === "item" && suggested.json.scope.itemId === target.id,
    `VC13 scope 应指向目标题：${JSON.stringify(suggested.json.scope)}`);
  must(suggested.json.ops.length > 0, "VC13 单题建议不应为空");
  must(suggested.json.ops.every((op) => op.itemId === target.id),
    `VC13 建议越界：${JSON.stringify(suggested.json.ops)}`);
  must(suggested.json.changes.length > 0 && suggested.json.changes.every((change) => change.where.startsWith(`第 ${String(targetIndex + 1)} 题`)),
    `VC13 changes 应只含第 ${String(targetIndex + 1)} 题：${JSON.stringify(suggested.json.changes)}`);

  // 建议本身不写库：版本号仍停在 v1。
  const afterSuggest = await request("GET", `/api/forms/${formId}`, { cookie: ctx.cookie });
  must(afterSuggest.json.version.n === 1, `VC13 建议不应写库，实际 n=${String(afterSuggest.json.version.n)}`);

  const adopted = await request("PATCH", `/api/forms/${formId}`, {
    cookie: ctx.cookie,
    json: { baseVersionId: v1, ops: suggested.json.ops },
  });
  must(adopted.status === 200, `VC13 采用建议失败（${String(adopted.status)}）：${firstLine(adopted.text)}`);
  must(adopted.json.version.n === 2, `VC13 采用后应为 v2，实际 n=${String(adopted.json.version.n)}`);
  const v2 = adopted.json.version.id;
  const afterAdopt = adopted.json.schema.items.map((item) => JSON.stringify(item));
  for (const [index, serialized] of storedBefore.entries()) {
    if (index === targetIndex) continue;
    must(afterAdopt[index] === serialized, `VC13 采用建议后第 ${String(index + 1)} 题被改动了`);
  }
  must(afterAdopt[targetIndex] !== storedBefore[targetIndex], "VC13 目标题应当发生变化");

  // ── 第 2 段：改答案 → 新版本、发布指针不随草稿走 ─────────────────────
  const publishedV2 = await request("POST", `/api/forms/${formId}/publish`, {
    cookie: ctx.cookie,
    json: { versionId: v2 },
  });
  must(publishedV2.status === 200, `VC13 发布 v2 失败（${String(publishedV2.status)}）`);
  const slug = publishedV2.json.slug;
  const oldAnswer = typeof target.answer === "string" ? target.answer : "b";
  const baseline = await request("POST", "/api/submissions", {
    json: { slug, formVersionId: v2, answers: { [target.id]: oldAnswer } },
  });
  must(baseline.status === 201, `VC13 基准提交失败（${String(baseline.status)}）`);
  must(baseline.json.score === target.score, `VC13 基准得分应为 ${String(target.score)}，实际 ${String(baseline.json.score)}`);

  const otherOption = target.options.find((option) => option.id !== oldAnswer);
  must(otherOption !== undefined, "VC13 目标题没有第二个选项可改成");
  const answerPatched = await request("PATCH", `/api/forms/${formId}`, {
    cookie: ctx.cookie,
    json: {
      baseVersionId: v2,
      ops: [{ op: "setAnswer", itemId: target.id, answer: { type: "single", answer: otherOption.id } }],
    },
  });
  must(answerPatched.status === 200, `VC13 改答案失败（${String(answerPatched.status)}）：${firstLine(answerPatched.text)}`);
  must(answerPatched.json.version.n === 3, `VC13 改答案应产生 v3，实际 n=${String(answerPatched.json.version.n)}`);
  const v3 = answerPatched.json.version.id;

  // D4：草稿前进到 v3，但发布指针仍停在 v2；收集页仍发 v2。
  const afterAnswer = await request("GET", `/api/forms/${formId}`, { cookie: ctx.cookie });
  must(afterAnswer.json.form.draftVersionId === v3, `VC13 草稿指针应到 v3：${String(afterAnswer.json.form.draftVersionId)}`);
  must(afterAnswer.json.form.publishedVersionId === v2, `VC13 改答案不应前移发布指针：${String(afterAnswer.json.form.publishedVersionId)}`);
  const publicBeforePublish = await request("GET", `/f/${slug}`);
  must(publicBeforePublish.json.versionId === v2, `VC13 收集页应仍指向 v2：${String(publicBeforePublish.json.versionId)}`);

  const publishedV3 = await request("POST", `/api/forms/${formId}/publish`, {
    cookie: ctx.cookie,
    json: { versionId: v3 },
  });
  must(publishedV3.status === 200, `VC13 发布 v3 失败（${String(publishedV3.status)}）：${firstLine(publishedV3.text)}`);

  const staleAnswer = await request("POST", "/api/submissions", {
    json: { slug, formVersionId: v3, answers: { [target.id]: oldAnswer } },
  });
  must(staleAnswer.status === 201, `VC13 老答案提交失败（${String(staleAnswer.status)}）`);
  must(staleAnswer.json.score === 0, `VC13 改答案后老答应判错得 0，实际 ${String(staleAnswer.json.score)}`);
  must(staleAnswer.json.maxScore === schema.meta.totalScore,
    `VC13 满分应为 ${String(schema.meta.totalScore)}，实际 ${String(staleAnswer.json.maxScore)}`);

  // 历史提交按它自己的 v2 快照判分：发布 v3 之后，v2 的看板仍是 5 分。
  const oldDashboard = await request("GET", `/api/forms/${formId}/submissions?versionId=${encodeURIComponent(v2)}`, { cookie: ctx.cookie });
  must(oldDashboard.status === 200, `VC13 历史看板失败（${String(oldDashboard.status)}）`);
  must(oldDashboard.json.rows.length === 1 && oldDashboard.json.rows[0].score === target.score,
    `VC13 旧版提交得分被改答案影响：${JSON.stringify(oldDashboard.json.rows)}`);

  // ── 第 3 段：不存在的目标题 → 422，且不产生版本 ─────────────────────
  const missing = await request("POST", `/api/forms/${formId}/suggest`, {
    cookie: ctx.cookie,
    json: { baseVersionId: v3, instruction: "改一下这题", targetItemId: "q_missing" },
  });
  must(missing.status === 422, `VC13 不存在的目标题应 422，实际 ${String(missing.status)}：${firstLine(missing.text)}`);
  const afterMissing = await request("GET", `/api/forms/${formId}`, { cookie: ctx.cookie });
  must(afterMissing.json.version.n === 3, `VC13 422 不应产生版本，实际 n=${String(afterMissing.json.version.n)}`);
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

/**
 * VC14：通用 JSON Patch + 重做栈（2026-11-02）。
 *
 * 三段：
 * 1. RFC 6902 的 replace 能改题目字段，响应里的 `changes` 仍是受限 op 的人话 diff；
 * 2. 越界路径（删题）整包 400，版本号不动；
 * 3. 撤销 → 重做回到同一版本；撤销后再改，重做栈清空（不会把旧分支拨回来）。
 */
async function vc14JsonPatchAndRedo(request, ctx) {
  const schema = JSON.parse(JSON.stringify(QUIZ_SCHEMA));
  const created = await request("POST", "/api/forms", {
    cookie: ctx.cookie,
    json: { title: schema.meta.title, kind: "quiz", schema, source: "generate" },
  });
  must(created.status === 201, `VC14 建表单失败（${String(created.status)}）：${firstLine(created.text)}`);
  const formId = created.json.form.id;
  const v1 = created.json.version.id;

  const patched = await request("PATCH", `/api/forms/${formId}`, {
    cookie: ctx.cookie,
    json: {
      baseVersionId: v1,
      jsonPatch: [
        { op: "replace", path: "/items/0/title", value: "JSON Patch 改过的题干" },
        { op: "replace", path: "/items/0/score", value: 7 },
      ],
    },
  });
  must(patched.status === 200, `VC14 通用 Patch 失败（${String(patched.status)}）：${firstLine(patched.text)}`);
  must(patched.json.version.n === 2, `VC14 通用 Patch 应产生 v2，实际 n=${String(patched.json.version.n)}`);
  const itemChanges = patched.json.changes.filter((change) => change.itemId === "v-single");
  must(
    itemChanges.map((change) => change.op).join(",") === "setStem,setScore",
    `VC14 changes 应翻译回 setStem,setScore：${JSON.stringify(patched.json.changes)}`,
  );
  must(patched.json.schema.meta.totalScore === 22, `VC14 总分应为 22，实际 ${String(patched.json.schema.meta.totalScore)}`);

  const structural = await request("PATCH", `/api/forms/${formId}`, {
    cookie: ctx.cookie,
    json: { baseVersionId: patched.json.version.id, jsonPatch: [{ op: "remove", path: "/items/1" }] },
  });
  must(structural.status === 400, `VC14 删题应 400，实际 ${String(structural.status)}：${firstLine(structural.text)}`);
  const afterReject = await request("GET", `/api/forms/${formId}`, { cookie: ctx.cookie });
  must(afterReject.json.version.n === 2, `VC14 被拒的 Patch 不应写库，实际 n=${String(afterReject.json.version.n)}`);

  const undo = await request("POST", `/api/forms/${formId}/undo`, {
    cookie: ctx.cookie,
    json: { fromVersionId: patched.json.version.id },
  });
  must(undo.status === 200 && undo.json.undone === true, `VC14 撤销失败：${firstLine(undo.text)}`);
  must(undo.json.redoAvailable === true, "VC14 撤销后 redoAvailable 应为 true");

  const redo = await request("POST", `/api/forms/${formId}/redo`, {
    cookie: ctx.cookie,
    json: { fromVersionId: undo.json.version.id },
  });
  must(redo.status === 200 && redo.json.redone === true, `VC14 重做失败：${firstLine(redo.text)}`);
  must(redo.json.version.id === patched.json.version.id, "VC14 重做应回到被撤销的那一版");
  must(redo.json.redoAvailable === false, "VC14 重做到底后 redoAvailable 应为 false");

  // 再撤销一次，然后从父版本改出新版本：旧的重做分支必须作废。
  const undoAgain = await request("POST", `/api/forms/${formId}/undo`, {
    cookie: ctx.cookie,
    json: { fromVersionId: redo.json.version.id },
  });
  must(undoAgain.json.redoAvailable === true, "VC14 第二次撤销后应有可重做项");
  const branched = await request("PATCH", `/api/forms/${formId}`, {
    cookie: ctx.cookie,
    json: { baseVersionId: undoAgain.json.version.id, ops: [{ op: "setStem", itemId: "v-single", title: "另一条分支" }] },
  });
  must(branched.status === 200, `VC14 撤销后再改失败：${firstLine(branched.text)}`);
  const staleRedo = await request("POST", `/api/forms/${formId}/redo`, {
    cookie: ctx.cookie,
    json: { fromVersionId: branched.json.version.id },
  });
  must(staleRedo.json.redone === false, "VC14 撤销后再改，旧分支不应还能重做");
}

/**
 * VC15：覆盖矩阵补题（2026-11-03）。
 *
 * 三段：合法知识点 × 层级回一道候选、**不写库**；知识点不在大纲里 422；
 * 旧 baseVersionId 409（补题和改题一样以草稿指针为基准）。
 */
async function vc15SupplementItem(request, ctx) {
  const schema = JSON.parse(JSON.stringify(QUIZ_SCHEMA));
  const created = await request("POST", "/api/forms", {
    cookie: ctx.cookie,
    json: { title: schema.meta.title, kind: "quiz", schema, source: "generate" },
  });
  must(created.status === 201, `VC15 建表单失败（${String(created.status)}）：${firstLine(created.text)}`);
  const formId = created.json.form.id;
  const v1 = created.json.version.id;

  const suggested = await request("POST", `/api/forms/${formId}/supplement`, {
    cookie: ctx.cookie,
    json: { baseVersionId: v1, knowledgePoint: "kp-vertex", bloom: "apply" },
  });
  must(suggested.status === 200, `VC15 补题失败（${String(suggested.status)}）：${firstLine(suggested.text)}`);
  must(suggested.json.item.type !== "section" && suggested.json.item.type !== "scale", "VC15 补题不能回分节/量表");
  must(suggested.json.item.knowledgePoint === "kp-vertex", `VC15 知识点应钉在请求上：${JSON.stringify(suggested.json.item)}`);
  must(suggested.json.item.bloom === "apply", `VC15 层级应钉在请求上：${JSON.stringify(suggested.json.item)}`);
  must(suggested.json.source === "mock", `VC15 应标注 mock 来源，实际 ${String(suggested.json.source)}`);
  must(typeof suggested.json.item.id === "string" && suggested.json.item.id.startsWith("q_"), "VC15 题目 id 应由服务端生成");

  const after = await request("GET", `/api/forms/${formId}`, { cookie: ctx.cookie });
  must(after.json.version.n === 1, `VC15 补题不应写库，实际 n=${String(after.json.version.n)}`);

  const unknown = await request("POST", `/api/forms/${formId}/supplement`, {
    cookie: ctx.cookie,
    json: { baseVersionId: v1, knowledgePoint: "kp_missing", bloom: "apply" },
  });
  must(unknown.status === 422, `VC15 未知知识点应 422，实际 ${String(unknown.status)}`);
  const stale = await request("POST", `/api/forms/${formId}/supplement`, {
    cookie: ctx.cookie,
    json: { baseVersionId: "v_stale", knowledgePoint: "kp-vertex", bloom: "apply" },
  });
  must(stale.status === 409, `VC15 旧版本应 409，实际 ${String(stale.status)}`);
}

/**
 * VC16：主观题 AI 辅助评分（A-23）。
 *
 * 五段：表单开关默认关闭时 403；开启后只回建议（mock 给满分一半）；
 * **不写 manual_grades**；只接受简答；旧版/别人不可见由归属与提交版本约束。
 */
async function vc16AiGrade(request, ctx) {
  const schema = {
    meta: { version: 1, kind: "quiz", title: "AI 评分卷", objectives: [], totalScore: 10 },
    items: [
      {
        id: "g-single",
        type: "single",
        title: "单选",
        required: true,
        score: 5,
        options: [
          { id: "a", text: "A" },
          { id: "b", text: "B" },
        ],
        answer: "a",
      },
      { id: "g-short", type: "short", title: "简答", required: true, score: 5, maxLength: 100 },
    ],
  };
  const created = await request("POST", "/api/forms", {
    cookie: ctx.cookie,
    json: { title: schema.meta.title, kind: "quiz", schema, source: "generate" },
  });
  must(created.status === 201, `VC16 建表单失败（${String(created.status)}）：${firstLine(created.text)}`);
  const formId = created.json.form.id;
  const versionId = created.json.version.id;
  const published = await request("POST", `/api/forms/${formId}/publish`, {
    cookie: ctx.cookie,
    json: { versionId },
  });
  must(published.status === 200, `VC16 发布失败（${String(published.status)}）：${firstLine(published.text)}`);
  const submitted = await request("POST", "/api/submissions", {
    json: {
      slug: published.json.slug,
      formVersionId: versionId,
      answers: { "g-single": "a", "g-short": "先把函数配方，顶点横坐标是 -b/2a。" },
    },
  });
  must(submitted.status === 201, `VC16 提交失败（${String(submitted.status)}）：${firstLine(submitted.text)}`);
  const submissionId = submitted.json.submissionId;
  const path = `/api/forms/${formId}/submissions/${submissionId}/ai-grade`;

  const closed = await request("POST", path, { cookie: ctx.cookie, json: { itemId: "g-short" } });
  must(closed.status === 403, `VC16 默认关闭应 403，实际 ${String(closed.status)}`);

  const enabled = await request("POST", `/api/forms/${formId}/settings`, {
    cookie: ctx.cookie,
    json: { showAnswersAfterSubmit: false, aiGradingEnabled: true },
  });
  must(enabled.status === 200 && enabled.json.aiGradingEnabled === true, "VC16 开启 AI 评分失败");

  const suggested = await request("POST", path, { cookie: ctx.cookie, json: { itemId: "g-short" } });
  must(suggested.status === 200, `VC16 建议失败（${String(suggested.status)}）：${firstLine(suggested.text)}`);
  must(suggested.json.suggestedScore === 2, `VC16 mock 建议应为满分一半 2，实际 ${String(suggested.json.suggestedScore)}`);
  must(suggested.json.maxScore === 5, `VC16 满分应为 5，实际 ${String(suggested.json.maxScore)}`);
  must(suggested.json.source === "mock", `VC16 应标注 mock 来源，实际 ${String(suggested.json.source)}`);
  must(suggested.json.promptVersion === "grade.v1", `VC16 prompt 版本应为 grade.v1，实际 ${String(suggested.json.promptVersion)}`);

  const rows = await request("GET", `/api/forms/${formId}/submissions`, { cookie: ctx.cookie });
  const row = rows.json.rows.find((entry) => entry.submissionId === submissionId);
  must(row !== undefined, "VC16 找不到刚提交的行");
  must(Object.keys(row.manualScores).length === 0, `VC16 建议不应落分：${JSON.stringify(row.manualScores)}`);
  must(row.pendingScore === 5, `VC16 待批分应仍为 5，实际 ${String(row.pendingScore)}`);

  const wrongType = await request("POST", path, { cookie: ctx.cookie, json: { itemId: "g-single" } });
  must(wrongType.status === 400, `VC16 单选题应 400，实际 ${String(wrongType.status)}`);
}

// ── 主流程 ────────────────────────────────────────────────────────────────
const CHECKS = [
  ["VC1 发布快照：改草稿不影响已发布版本的收集页", vc1Snapshot],
  ["VC2 判分与版本冲突：得分正确 / 旧版提交 409", vc2GradingAndConflict],
  ["VC3 学生端零泄漏：响应体不含答案类键", vc3NoLeak],
  ["VC4 生成→发布→提交→看板：SSE 组装、得分对账、CSV 表头", vc4GeneratedLoop],
  ["VC5 人工批改：简答录分、待批归零、看板与 CSV 同口径", vc5ManualGrade],
  ["VC6 受限修改与撤销：PATCH 追加版本、旧 baseVersionId 409、undo 回退", vc6PatchAndUndo],
  ["VC7 每题正确率：分母是提交份数、未作答按未答对计、零提交 rate 为 null", vc7ItemStats],
  ["VC8 意图澄清：缺槽位追问 1–3 条、完整需求不问、补答在事件流里可定位", vc8Clarify],
  ["VC9 两阶段蓝图：规划自洽、补答同源、plan 阶段只在有蓝图时出现", vc9Blueprint],
  ["VC10 覆盖矩阵：实际 Schema 的知识点 × 布鲁姆计数与空单元格", vc10CoverageMatrix],
  ["VC11 收集页闭环：survey 填写、回收看板与 CSV", vc11SurveyCollection],
  ["VC12 答案解析开关：默认关闭、开启后随提交返回、公开视图不变", vc12AnswerReview],
  ["VC13 单题修改：建议作用域、答案改动进判分、越界 422 不写库", vc13SingleItemEdit],
  ["VC14 通用 Patch 与重做：RFC 6902 翻译、越界不写库、撤销可重做", vc14JsonPatchAndRedo],
  ["VC15 覆盖矩阵补题：按知识点×层级回一题、不写库、越界 422", vc15SupplementItem],
  ["VC16 AI 辅助评分：默认关闭、只回建议、不写人工分", vc16AiGrade],
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

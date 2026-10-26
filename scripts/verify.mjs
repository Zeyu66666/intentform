#!/usr/bin/env node
/**
 * `pnpm verify` —— I4 的端到端验收：起一个真服务，按学生/教师的真实 HTTP 顺序跑三条用例。
 *
 *   VC1 发布快照：发布会话拿到短链后，老师继续改草稿（追加 v2）不影响 `/f/:slug`
 *                 的输出（字节级比较 form 部分）；只有发布这步才动视图。
 *   VC2 判分与版本冲突：正常提交得分正确；用旧 versionId 提交返回 409 + version_conflict。
 *   VC3 学生端零泄漏：`/f/:slug` 与 `POST /api/submissions` 的响应体字节里不含
 *                 answer / explanation / bloom / knowledgePoint / objectives。
 *
 * 为什么用 `node:sqlite` 写 v2：本轮还没有 PATCH 路由（补丁编辑器属于前端 I3），
 * 而 VC1 的命题恰恰是「版本追加 + 指针移动」这两件事彼此独立。所以这里用 Node
 * 内置的 SQLite 直接做「补丁路由本该做的两行写入」，走的仍然是同一套表约束
 * （`form_versions` 的追加式触发器照样生效）。除 Node 内置外不引入任何依赖。
 *
 * 退出码：三条全过 0；任何一条失败非 0，并打印失败原因。
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
  meta: { ...QUIZ_SCHEMA.meta, title: "verify · 二次函数快照卷（改）" },
  items: [
    ...QUIZ_SCHEMA.items,
    { id: "v-short", type: "short", title: "一句话总结今天学了什么", required: false },
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
    json: { slug: ctx.slug, formVersionId: ctx.v2, answers: CORRECT_ANSWERS },
  });
  must(ok.status === 201, `提交失败（${String(ok.status)}）：${firstLine(ok.text)}`);
  must(ok.json.score === 20, `得分应为 20，实际 ${String(ok.json.score)}`);
  must(ok.json.maxScore === 20, `满分应为 20，实际 ${String(ok.json.maxScore)}`);
  must(
    JSON.stringify(Object.keys(ok.json).sort()) === JSON.stringify(["maxScore", "ok", "score", "submissionId"]),
    `提交响应多了字段：${Object.keys(ok.json).join(", ")}`,
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

  const csv = await request("GET", `/api/forms/${ctx.formId}/submissions.csv`, {
    cookie: ctx.cookie,
  });
  must(csv.status === 200, `CSV 失败（${String(csv.status)}）：${firstLine(csv.text)}`);
  const header = csv.text.split("\r\n")[0] ?? "";
  must(
    header.startsWith("submission_id,created_at,score,max_score,"),
    `CSV 表头前四列不对：${firstLine(header)}`,
  );
  must(!header.includes("answer"), `CSV 表头出现了 answer 列：${firstLine(header)}`);
  must(csv.text.split("\r\n").length >= 2, "CSV 没有数据行");
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

// ── 主流程 ────────────────────────────────────────────────────────────────
const CHECKS = [
  ["VC1 发布快照：改草稿不影响已发布版本的收集页", vc1Snapshot],
  ["VC2 判分与版本冲突：得分正确 / 旧版提交 409", vc2GradingAndConflict],
  ["VC3 学生端零泄漏：响应体不含答案类键", vc3NoLeak],
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
    LLM_MODE: "replay",
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

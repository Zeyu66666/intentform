#!/usr/bin/env node
/**
 * `pnpm eval` —— 整份需求达标率的实测入口。
 *
 * 一次运行 = 起一个真服务（replay / mock / live 由 `--mode` 定）→ 按 requirements.jsonl
 * 逐条打 `POST /api/generate` → 读完整条 SSE → 用 `eval/judge.mjs` 判「这份成品有没有满足
 * 需求里写死的约束」→ 落盘原始事件流 + report.json + report.md。
 *
 * 三条纪律（与《计划 v3.0》附录 B 对齐）：
 * 1. **分母固定**：跑了几条判分需求，分母就是几条。缺题、超时、解析失败都留在分母里。
 * 2. **来源分开标**：`replay` 只复核既有录像，`mock` 只演练链路，只有 `live` 才是「模型
 *    能力」的证据。报告首页把来源写死，不让人把三种混成一句「达标率 92%」。
 * 3. **验收条件先冻结**：需求集 sha256 与判定器版本写进报告；改一个字节就是另一把尺子。
 *
 * 用法：
 *   node eval/run.mjs --mode mock                 # 不联网，演练链路与判据
 *   node eval/run.mjs --mode replay --set debug   # 复核 3 条回放录像
 *   node --env-file=D:/project1/.secrets/live.env eval/run.mjs --mode live
 *   常用开关：--set all|debug|holdout  --only id1,id2  --limit 5  --delay-ms 0
 *            --timeout-ms 120000  --out eval/runs  --label <自由标签>
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { JUDGE_VERSION, judgeForm, summarize } from "./judge.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const SERVER_ENTRY = join(ROOT, "server", "src", "main.ts");
const REQUIREMENTS = join(ROOT, "eval", "requirements.jsonl");
const VALID_MODES = ["mock", "replay", "live", "record"];

/** 来源标签：报告首页显示的那句话，不允许含糊。 */
const SOURCE_NOTE = {
  mock: "内置脚本（不联网、不调模型）：只演练链路与判据，不代表模型能力",
  replay: "既有录像重放（不调模型）：只能复核历史样本，不算新实验",
  live: "真实上游：这一组才代表模型能力",
  record: "录制模式：结果同时写入 fixtures/replays，本报告按 live 看待",
};

function parseArgs(argv) {
  const args = { mode: "mock", set: "all", only: null, limit: 0, delayMs: 0, timeoutMs: 120_000, out: "eval/runs", label: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[i + 1]?.startsWith("--") === false ? argv[++i] : "true";
    switch (key) {
      case "mode":
        args.mode = value;
        break;
      case "set":
        args.set = value;
        break;
      case "only":
        args.only = value.split(",").map((id) => id.trim()).filter(Boolean);
        break;
      case "limit":
        args.limit = Number.parseInt(value, 10);
        break;
      case "delay-ms":
        args.delayMs = Number.parseInt(value, 10);
        break;
      case "timeout-ms":
        args.timeoutMs = Number.parseInt(value, 10);
        break;
      case "out":
        args.out = value;
        break;
      case "label":
        args.label = value;
        break;
      default:
        throw new Error(`未知参数 --${key}`);
    }
  }
  if (!VALID_MODES.includes(args.mode)) throw new Error(`--mode 只能是 ${VALID_MODES.join(" / ")}`);
  return args;
}

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
  const deadline = Date.now() + 30_000;
  while (!stdout.includes(`127.0.0.1:${String(port)}`)) {
    if (child.exitCode !== null) {
      throw new Error(`服务启动失败（exit ${String(child.exitCode)}）：\n${stderr || stdout}`);
    }
    if (Date.now() > deadline) throw new Error(`服务 30s 内没打印监听行：\n${stdout}\n${stderr}`);
    await sleep(50);
  }
  return {
    child,
    close: async () => {
      child.kill();
      await new Promise((done) => child.once("exit", done));
    },
    stderrOf: () => stderr,
  };
}

/** 极简 SSE 解析：只认 `event:` / `data:` 两种行，data 一律按 JSON 解。 */
function parseSse(text) {
  const events = [];
  for (const block of text.split("\n\n")) {
    if (block.trim() === "") continue;
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (data === "") continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      // 半截帧（连接被掐）不算证据，丢掉；终态缺失会被下面的 judge 抓到
    }
  }
  return events;
}

/** 从 thinking 摘要里读生成器自己判的表单类型，而不是在评测脚本里再猜一遍。 */
function kindFromEvents(events) {
  for (const event of events) {
    if (event.type !== "thinking" || event.kind !== "summary") continue;
    const match = /判定为\s*(考卷|问卷)/u.exec(String(event.delta ?? ""));
    if (match !== null) return match[1] === "考卷" ? "quiz" : "survey";
  }
  return null;
}

/** 把 `field` 事件按到达顺序拼成一份成品。 */
function assembleForm(events) {
  const items = [];
  for (const event of events) {
    if (event.type === "field" && typeof event.node === "object" && event.node !== null) items.push(event.node);
  }
  return { kind: kindFromEvents(events), items };
}

function collectStats(events) {
  const errorCodes = {};
  const repairs = [];
  let usage = null;
  let done = null;
  let terminalError = null;
  for (const event of events) {
    if (event.type === "field_error") {
      for (const code of event.codes ?? []) errorCodes[code] = (errorCodes[code] ?? 0) + 1;
    } else if (event.type === "repair") {
      repairs.push({ id: event.id, round: event.round, status: event.status, codesBefore: event.codesBefore, codesAfter: event.codesAfter });
    } else if (event.type === "usage") {
      usage = { promptTokens: event.promptTokens, completionTokens: event.completionTokens, ms: event.ms };
    } else if (event.type === "done") {
      done = event;
    } else if (event.type === "error") {
      terminalError = event;
    }
  }
  return { errorCodes, repairs, usage, done, terminalError };
}

async function runOne(baseUrl, row, args) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  let text = "";
  let httpStatus = 0;
  let failure = null;
  try {
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requirement: row.requirement }),
      signal: controller.signal,
    });
    httpStatus = response.status;
    text = await response.text();
  } catch (error) {
    failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } finally {
    clearTimeout(timer);
  }
  const ms = Date.now() - startedAt;
  const events = parseSse(text);
  const stats = collectStats(events);
  const form = assembleForm(events);

  const gateBlocked = stats.terminalError !== null && stats.terminalError.code === "llm_invalid_output";
  const judged = row.judgeable === true
    ? judgeForm(form, row.expect)
    : {
        passed: false,
        checks: [
          {
            layer: "clarify",
            name: "clarify-needed",
            ok: false,
            detail: "该需求缺槽位（题量/题型/分值），本应先追问再生成；产品当前没有追问层",
          },
        ],
        deviation: null,
      };

  return {
    id: row.id,
    set: row.set,
    judgeable: row.judgeable === true,
    requirement: row.requirement,
    expect: row.expect,
    httpStatus,
    failure,
    ms,
    eventCount: events.length,
    gateBlocked,
    terminalError: stats.terminalError === null ? null : { code: stats.terminalError.code, message: stats.terminalError.message },
    errorCodes: stats.errorCodes,
    repairs: stats.repairs,
    usage: stats.usage,
    done: stats.done === null ? null : stats.done.stats,
    form: { kind: form.kind, items: form.items },
    passed: judged.passed,
    checks: judged.checks,
    deviation: judged.deviation,
    raw: text,
  };
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function buildMarkdown(report) {
  const lines = [];
  const { meta, summary, records } = report;
  lines.push(`# 整份需求达标率实测（${meta.mode}）`);
  lines.push("");
  lines.push(`- 运行 id：\`${meta.runId}\``);
  lines.push(`- 数据来源：**${meta.sourceNote}**`);
  lines.push(`- 需求集：\`eval/requirements.jsonl\`，sha256 \`${meta.setSha256.slice(0, 16)}…\`，共 ${String(meta.total)} 条`);
  lines.push(`- 判定器：\`${meta.judgeVersion}\`，跑 ${String(meta.judgeable)} 条判分需求（澄清探针 ${String(meta.clarifyProbes)} 条单列）`);
  lines.push(`- 模式参数：model=\`${meta.model}\` promptVersion=\`${meta.promptVersion}\` schema=\`${meta.schemaVersion}\``);
  lines.push(`- 开始时间：${meta.startedAt}；耗时：${(meta.durationMs / 1000).toFixed(1)} 秒`);
  lines.push("");
  lines.push("## 1. 主指标：整份达标率");
  lines.push("");
  lines.push("| 口径 | 数值 |");
  lines.push("|---|---|");
  lines.push(`| 分母（判分需求数） | ${String(summary.judged)} |`);
  lines.push(`| 完全满足需求 | ${String(summary.passed)} |`);
  lines.push(`| **整份达标率** | **${pct(summary.rate)}** |`);
  lines.push(`| 首轮达标（无错行、无修复） | ${String(summary.validation.firstPass)} |`);
  lines.push(`| 其中：一条字段都没产出 | ${String(summary.noOutput)}（计入分母，按未达标算） |`);
  lines.push("");
  lines.push("## 1b. 第二口径：只看产品能表达的需求");
  lines.push("");
  lines.push(
    `分母里有 **${String(summary.capability.gap)} 条**需求在当前 schema 下无解：简答题没有分值字段（\`packages/schema/src/types.ts:99\`），` +
      "而需求写了「含 N 道简答、每题 5 分、共 M 分」，总分在结构上凑不出来。这一组不剔除出主指标（上表照算未达标），" +
      "但单列一份「能表达的需求上模型做到多少」，避免把产品缺口记成模型能力。",
  );
  lines.push("");
  lines.push("| 口径 | 数值 |");
  lines.push("|---|---|");
  lines.push(`| 产品能表达的需求 | ${String(summary.capability.expressible)} 条 |`);
  lines.push(`| 其中达标 | ${String(summary.capability.expressiblePassed)} 条 |`);
  lines.push(`| **可表达子集达标率** | **${pct(summary.capability.expressibleRate)}** |`);
  if (summary.capability.gap > 0) {
    lines.push(`| 结构不可表达（简答计分） | ${summary.capability.gapIds.map((id) => `\`${id}\``).join("、")} |`);
  }
  lines.push("");
  lines.push("## 2. 四层意图控制的可量化部分");
  lines.push("");
  lines.push("| 层 | 指标 | 数值 |");
  lines.push("|---|---|---|");
  lines.push(`| 澄清 | 缺槽位需求是否被追问 | 0 / ${String(meta.clarifyProbes)}（未实现，见 eval/README.md） |`);
  lines.push(`| 蓝图 | 结构完全匹配（题量/题型/分值/知识点） | ${String(summary.blueprint.exact)} / ${String(summary.judged)}（${pct(summary.blueprint.rate)}） |`);
  lines.push(`| 蓝图 | 题量平均绝对偏差（只在有产出的条目上算） | ${summary.blueprint.meanAbsCountDelta.toFixed(2)} 题 |`);
  lines.push(`| 蓝图 | 题型不符 / 分值不符 / 知识点缺失 | ${String(summary.blueprint.typeMismatch)} / ${String(summary.blueprint.scoreMismatch)} / ${String(summary.blueprint.objectiveGaps)} |`);
  lines.push(`| 校验 | 错行总数 / 错误码分布 | ${String(summary.validation.fieldErrors)}（${Object.entries(summary.validation.byCode).map(([code, n]) => `${code}×${String(n)}`).join(" ") || "无"}） |`);
  lines.push(`| 校验 | 整表门禁拦下的需求数 | ${String(summary.validation.gateBlocked)} |`);
  lines.push(`| 校验 | 问卷误带答案的需求数 | ${String(summary.validation.answerPolicyViolations)} |`);
  lines.push(`| 修复 | 救回 / 尝试（第 1 轮 ${String(summary.repair.rounds[1] ?? 0)} 次，第 2 轮 ${String(summary.repair.rounds[2] ?? 0)} 次） | ${String(summary.repair.fixed)} / ${String(summary.repair.attempts)} |`);
  lines.push(`| 修复 | 无关改动 | ${String(summary.repair.irrelevantEdits)}（机制上恒为 0：只回喂出错字段） |`);
  lines.push(`| 能力 | 需求在当前结构下可表达 | ${String(summary.capability.expressible)} / ${String(summary.judged)} |`);
  lines.push("");
  lines.push("## 3. 代价");
  lines.push("");
  lines.push("| 项 | 数值 |");
  lines.push("|---|---|");
  lines.push(`| 单条耗时（均值 / 最长） | ${String(summary.cost.meanMs)} ms / ${String(summary.cost.maxMs)} ms |`);
  lines.push(`| prompt / completion tokens | ${String(summary.cost.promptTokens)} / ${String(summary.cost.completionTokens)} |`);
  lines.push("");
  lines.push("## 4. 失败清单（分母内，不剔除）");
  lines.push("");
  if (summary.failures.length === 0) {
    lines.push("无。");
  } else {
    lines.push("| 需求 | 未满足的约束 |");
    lines.push("|---|---|");
    for (const failure of summary.failures) {
      lines.push(`| \`${failure.id}\` | ${failure.failed.join("<br>")} |`);
    }
  }
  lines.push("");
  lines.push("## 5. 逐条明细");
  lines.push("");
  lines.push("| id | set | 题量 期望→实得 | 判定 | 耗时 | 错行 | 修复 |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const record of records) {
    const want = record.judgeable ? String(record.expect.count) : "—";
    const got = String(record.form.items.filter((item) => item.type !== "section").length);
    const verdict = record.judgeable ? (record.passed ? "达标" : "未达标") : "探针";
    lines.push(
      `| \`${record.id}\` | ${record.set} | ${want}→${got} | ${verdict} | ${String(record.ms)} ms | ${String(Object.values(record.errorCodes).reduce((a, b) => a + b, 0))} | ${String(record.repairs.length)} |`,
    );
  }
  lines.push("");
  lines.push("原始事件流在同目录 `raw/<id>.sse`（`event:`/`data:` 原文），逐条可回放核对。");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const rawText = readFileSync(REQUIREMENTS, "utf8");
  const setSha256 = createHash("sha256").update(rawText).digest("hex");
  const allRows = rawText
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));

  let rows = allRows.filter((row) => args.set === "all" || row.set === args.set);
  if (args.only !== null) {
    const wanted = new Set(args.only);
    rows = allRows.filter((row) => wanted.has(row.id));
  }
  if (args.limit > 0) rows = rows.slice(0, args.limit);
  if (rows.length === 0) throw new Error("筛选后没有任何需求可跑");

  const runId = `${args.mode}-${new Date().toISOString().replace(/[:.]/gu, "-").slice(0, 19)}${args.label === "" ? "" : `-${args.label}`}`;
  const outDir = resolve(ROOT, args.out, runId);
  const rawDir = join(outDir, "raw");
  mkdirSync(rawDir, { recursive: true });

  const port = await findFreePort();
  const databasePath = join(tmpdir(), `intentform-eval-${randomUUID()}.db`);
  const appOrigin = "http://127.0.0.1:5173";
  const env = {
    PORT: String(port),
    APP_ORIGIN: appOrigin,
    DATABASE_PATH: databasePath,
    SESSION_SECRET: `eval-${randomUUID()}`,
    LLM_MODE: args.mode,
    // 评测要连打几十条，限流必须放开；否则第 11 条会被 429 挡掉，
    // 那测的就不是生成质量而是限流阈值了。
    RATE_GENERATE_PER_MIN: "1000",
  };

  const startedAt = new Date();
  const server = await spawnServer(env, port);
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const records = [];

  try {
    const health = await fetch(`${baseUrl}/healthz`);
    const healthJson = await health.json();
    if (healthJson.llmMode !== args.mode) {
      throw new Error(`服务实际模式 ${String(healthJson.llmMode)} 与 --mode ${args.mode} 不一致`);
    }
    process.stdout.write(`[eval] ${runId}  模式=${args.mode}  需求=${String(rows.length)} 条  →  ${outDir}\n`);

    for (const [index, row] of rows.entries()) {
      const record = await runOne(baseUrl, row, args);
      records.push(record);
      const flags = [];
      if (record.failure !== null) flags.push(`传输失败 ${record.failure}`);
      if (record.gateBlocked) flags.push("门禁拦截");
      if (record.terminalError !== null && !record.gateBlocked) flags.push(`终态错误 ${record.terminalError.code}`);
      const verdict = record.judgeable ? (record.passed ? "达标" : "未达标") : "探针";
      process.stdout.write(
        `  ${String(index + 1).padStart(2, " ")}/${String(rows.length)}  ${row.id.padEnd(24, " ")} ${verdict.padEnd(4, " ")} ${String(record.ms).padStart(6, " ")}ms  错行=${String(Object.values(record.errorCodes).reduce((a, b) => a + b, 0))} 修复=${String(record.repairs.length)} ${flags.join(" ")}\n`,
      );
      writeFileSync(join(rawDir, `${row.id}.sse`), record.raw, "utf8");
      if (args.delayMs > 0) await sleep(args.delayMs);
    }
  } finally {
    await server.close();
    try {
      const { rmSync } = await import("node:fs");
      rmSync(databasePath, { force: true });
    } catch {
      // 临时库删不掉不影响结论；Windows 上句柄释放有延迟
    }
  }

  const summary = summarize(records);
  const report = {
    meta: {
      runId,
      mode: args.mode,
      sourceNote: SOURCE_NOTE[args.mode],
      label: args.label,
      setFilter: args.set,
      only: args.only,
      total: rows.length,
      judgeable: records.filter((record) => record.judgeable).length,
      clarifyProbes: records.filter((record) => !record.judgeable).length,
      setSha256,
      judgeVersion: JUDGE_VERSION,
      model: process.env.LLM_CHAT_MODEL ?? "deepseek-chat",
      promptVersion: process.env.LLM_PROMPT_VERSION ?? "generate.v1",
      schemaVersion: "1",
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
    },
    summary,
    // 原始事件流不重复进 report.json：它已经逐条落在 raw/<id>.ndjson，
    // 复制一份会让报告大到打不开，也会与 raw 目录产生两处真相
    records: records.map(({ raw: _raw, ...rest }) => rest),
  };

  writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(join(outDir, "report.md"), buildMarkdown(report), "utf8");
  // 根目录留一份「最近一次」的软副本，README 与文档引它时不用去翻时间戳目录
  writeFileSync(join(resolve(ROOT, args.out), "latest.json"), `${JSON.stringify({ runId, mode: args.mode, setSha256 }, null, 2)}\n`, "utf8");

  process.stdout.write(
    `\n[eval] 分母 ${String(summary.judged)} 条，达标 ${String(summary.passed)} 条，整份达标率 ${pct(summary.rate)}\n` +
      `[eval] 蓝图层结构完全匹配 ${pct(summary.blueprint.rate)}；错行 ${String(summary.validation.fieldErrors)} 个；修复救回 ${String(summary.repair.fixed)}/${String(summary.repair.attempts)}\n` +
      `[eval] 报告：${join(outDir, "report.md")}\n` +
      `[eval] 来源：${SOURCE_NOTE[args.mode]}\n`,
  );
}

await main();

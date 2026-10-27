/**
 * `fixtures/replays/` 自检（README 第 6 节的校验项）。
 *
 * 为什么用 `.ts` 而不是 `scripts/check-fixtures.mjs`：`scripts/` 是 Lead 的范围，
 * 这里只交付实现，由 Lead 决定怎么挂到根 `package.json`（例如
 * `"check:fixtures": "node --experimental-strip-types packages/llm/src/check-fixtures.ts"`）。
 *
 * 校验项（README §6 原文 + 两条我认为必须加的）：
 * 1. `<hash>` 与 `meta.requirementHash` 一致、文件名是 64 位小写十六进制；
 * 2. 有 `.ndjson` 必有 `.meta.json`，有 `.meta.json` 必有 `.ndjson`；
 * 3. `meta.chunks` 等于 `.ndjson` 行数；
 * 4. `meta.totalMs` 与 `sum(dt)` 相差 ≤ 10%；
 * 5. `meta.mode === "record"`；`meta.upstream` 非空（如实标注）；
 * 6. `.ndjson` ≤ 256 KB；
 * 7. **加**：每行都是合法 JSON、`d` 是字符串、`dt` 是非负整数、文件以 `\n` 结尾无空行；
 * 8. **加**：把 `d` 拼回去后每一行都能被 `formItemSchema` 吃下（否则这份 fixture
 *    即使"文件格式正确"也生成不出一张表单，回放时只会得到 `llm_invalid_output`）。
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_FIXTURE_DIR } from "./config.ts";
import { FIXTURE_MAX_BYTES, fixturePaths } from "./fixtures.ts";
import { inferFormKind } from "./generate.ts";
import { LineSplitter } from "./line-splitter.ts";
import { REPLAY_HASH_PATTERN, normalizeRequirement, replayKey } from "./replay-key.ts";
import { validateLine } from "./validate-line.ts";

/** 总数上限（README §5：仓库里最多 3 条，对应 3 个预置需求按钮）。 */
export const MAX_FIXTURES = 3;

export interface FixtureCheckItem {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface FixtureCheckReport {
  readonly hash: string;
  readonly ok: boolean;
  readonly items: readonly FixtureCheckItem[];
}

export interface CheckReport {
  readonly fixtureDir: string;
  readonly fixtures: readonly FixtureCheckReport[];
  readonly problems: readonly string[];
  readonly ok: boolean;
}

interface ParsedChunk {
  readonly d: string;
  readonly dt: number;
}

function parseChunkLines(text: string, problems: string[], hash: string): readonly ParsedChunk[] {
  const chunks: ParsedChunk[] = [];
  if (text.length === 0) {
    problems.push(`${hash}: .ndjson 是空文件`);
    return chunks;
  }
  if (!text.endsWith("\n")) problems.push(`${hash}: .ndjson 没有以换行结尾`);

  const rawLines = text.split("\n");
  // 末尾换行会 split 出一个空串，只允许这一个。
  if (rawLines.at(-1) === "") rawLines.pop();
  rawLines.forEach((line, index) => {
    if (line.trim() === "") {
      problems.push(`${hash}: 第 ${String(index + 1)} 行是空行`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      problems.push(`${hash}: 第 ${String(index + 1)} 行不是合法 JSON`);
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
      problems.push(`${hash}: 第 ${String(index + 1)} 行不是对象`);
      return;
    }
    const record = parsed as Record<string, unknown>;
    const d = record["d"];
    const dt = record["dt"];
    if (typeof d !== "string") {
      problems.push(`${hash}: 第 ${String(index + 1)} 行缺少字符串字段 d`);
      return;
    }
    if (typeof dt !== "number" || !Number.isInteger(dt) || dt < 0) {
      problems.push(`${hash}: 第 ${String(index + 1)} 行 dt 不是非负整数`);
      return;
    }
    chunks.push({ d, dt });
  });
  return chunks;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

async function checkOne(dir: string, hash: string, problems: string[]): Promise<FixtureCheckReport> {
  const items: FixtureCheckItem[] = [];
  const paths = fixturePaths(dir, hash);

  const hashOk = REPLAY_HASH_PATTERN.test(hash);
  items.push({ name: "hash 格式", ok: hashOk, detail: "64 位小写十六进制" });
  if (!hashOk) problems.push(`${hash}: 文件名不是 64 位小写十六进制`);

  let ndjsonText = "";
  let ndjsonBytes = 0;
  let metaText = "";
  try {
    ndjsonText = await readFile(paths.ndjsonPath, "utf8");
    ndjsonBytes = (await stat(paths.ndjsonPath)).size;
    items.push({ name: ".ndjson 存在", ok: true, detail: `${String(ndjsonBytes)} 字节` });
  } catch {
    items.push({ name: ".ndjson 存在", ok: false, detail: paths.ndjsonPath });
    problems.push(`${hash}: 缺少 .ndjson`);
  }
  try {
    metaText = await readFile(paths.metaPath, "utf8");
    items.push({ name: ".meta.json 存在", ok: true, detail: paths.metaPath });
  } catch {
    items.push({ name: ".meta.json 存在", ok: false, detail: paths.metaPath });
    problems.push(`${hash}: 缺少 .meta.json`);
  }

  const sizeOk = ndjsonBytes > 0 && ndjsonBytes <= FIXTURE_MAX_BYTES;
  items.push({
    name: "大小 ≤ 256KB",
    ok: sizeOk,
    detail: `${String(ndjsonBytes)} / ${String(FIXTURE_MAX_BYTES)}`,
  });
  if (!sizeOk) problems.push(`${hash}: .ndjson 大小 ${String(ndjsonBytes)} 超出上限`);

  const chunks = parseChunkLines(ndjsonText, problems, hash);
  const meta = metaText === "" ? null : (JSON.parse(metaText) as Record<string, unknown>);

  if (meta !== null) {
    const required = [
      "recordedAt",
      "model",
      "promptVersion",
      "schemaVersion",
      "requirementHash",
      "chunks",
      "totalMs",
      "usage",
      "upstream",
      "mode",
    ];
    const missing = required.filter((key) => meta[key] === undefined);
    items.push({
      name: "meta 必填字段",
      ok: missing.length === 0,
      detail: missing.length === 0 ? required.join(",") : `缺 ${missing.join(",")}`,
    });
    if (missing.length > 0) problems.push(`${hash}: meta 缺字段 ${missing.join(",")}`);

    const metaHash = readString(meta, "requirementHash");
    const hashMatches = metaHash === hash;
    items.push({ name: "hash 与 meta 一致", ok: hashMatches, detail: `meta=${metaHash ?? "<空>"}` });
    if (!hashMatches) problems.push(`${hash}: meta.requirementHash=${metaHash ?? "<空>"} 与文件名不一致`);

    const declaredChunks = typeof meta["chunks"] === "number" ? meta["chunks"] : -1;
    const chunksOk = declaredChunks === chunks.length;
    items.push({
      name: "chunks 等于行数",
      ok: chunksOk,
      detail: `meta=${String(declaredChunks)} 实际=${String(chunks.length)}`,
    });
    if (!chunksOk) problems.push(`${hash}: meta.chunks=${String(declaredChunks)} 与行数 ${String(chunks.length)} 不一致`);

    const declaredMs = typeof meta["totalMs"] === "number" ? meta["totalMs"] : -1;
    const sumMs = chunks.reduce((sum, chunk) => sum + chunk.dt, 0);
    const tolerance = Math.max(1, sumMs * 0.1);
    const msOk = declaredMs >= 0 && Math.abs(declaredMs - sumMs) <= tolerance;
    items.push({
      name: "totalMs 与实际相差 ≤10%",
      ok: msOk,
      detail: `meta=${String(declaredMs)} sum(dt)=${String(sumMs)}`,
    });
    if (!msOk) problems.push(`${hash}: meta.totalMs=${String(declaredMs)} 与 sum(dt)=${String(sumMs)} 相差超过 10%`);

    const modeOk = meta["mode"] === "record";
    items.push({ name: "mode 为 record", ok: modeOk, detail: String(meta["mode"]) });
    if (!modeOk) problems.push(`${hash}: meta.mode=${String(meta["mode"])}，mock/回放产物不许进 fixtures/replays`);

    const upstream = readString(meta, "upstream");
    items.push({ name: "upstream 如实标注", ok: upstream !== null, detail: upstream ?? "<空>" });
    if (upstream === null) problems.push(`${hash}: meta.upstream 为空`);

    const recordedAt = readString(meta, "recordedAt");
    let recordedOk = false;
    let recordedDetail = "<空>";
    if (recordedAt !== null) {
      const parsedAt = Date.parse(recordedAt);
      recordedOk = Number.isFinite(parsedAt) && parsedAt <= Date.now() + 60_000;
      recordedDetail = recordedAt;
    }
    items.push({ name: "recordedAt 合法且非未来", ok: recordedOk, detail: recordedDetail });
    if (!recordedOk) problems.push(`${hash}: recordedAt=${recordedDetail} 非法或指向未来`);

    // 回放键自洽性：用 meta 里记录的 model/promptVersion/schemaVersion 与 demand 预览
    // 无法反推需求原文，所以只校验 hash 形状——真正的键一致性由 record 时保证。
    const preview = readString(meta, "requirementPreview");
    const previewOk = preview !== null && preview === normalizeRequirement(preview).slice(0, 80);
    items.push({ name: "requirementPreview 已规范化", ok: previewOk, detail: preview ?? "<空>" });
    if (!previewOk) problems.push(`${hash}: requirementPreview 不是规范化后的前 80 字`);
  }

  // 拼回原始 NDJSON，确认这份 fixture 真能生成表单（否则回放只会得到 llm_invalid_output）。
  const splitter = new LineSplitter();
  const lines: string[] = [];
  for (const chunk of chunks) lines.push(...splitter.push(chunk.d));
  lines.push(...splitter.flush());
  // 逐行校验必须带 kind：`validateLine` 默认按 quiz 判（判分题没有 answer/score 就报错），
  // 拿它去校验问卷回放会把「问卷里合法的无答案选择题」全判成非法——这是校验器的错，不是 fixture 的。
  const kind = inferFormKind(meta === null ? "" : (readString(meta, "requirementPreview") ?? ""));
  const badLines = lines.filter((line) => line.trim() !== "" && !validateLine(line, { kind }).ok);
  const linesOk = lines.filter((line) => line.trim() !== "").length > 0 && badLines.length === 0;
  items.push({
    name: "回放行能被 formItemSchema 吃下",
    ok: linesOk,
    detail:
      linesOk
        ? `${String(lines.filter((line) => line.trim() !== "").length)} 行全部合法`
        : `${String(badLines.length)} 行非法；首条：${(badLines[0] ?? "").slice(0, 120)}`,
  });
  if (!linesOk) problems.push(`${hash}: 有 ${String(badLines.length)} 行拼回去后不是合法 FormItem`);

  void replayKey;
  return { hash, ok: items.every((item) => item.ok), items };
}

export async function checkFixtures(fixtureDir: string = DEFAULT_FIXTURE_DIR): Promise<CheckReport> {
  const problems: string[] = [];
  const entries = await readdir(fixtureDir);
  const ndjsonHashes = entries.filter((name) => name.endsWith(".ndjson")).map((name) => name.slice(0, -".ndjson".length));
  const metaHashes = entries
    .filter((name) => name.endsWith(".meta.json"))
    .map((name) => name.slice(0, -".meta.json".length));

  for (const hash of ndjsonHashes) {
    if (!metaHashes.includes(hash)) problems.push(`${hash}: 有 .ndjson 但缺少 .meta.json`);
  }
  for (const hash of metaHashes) {
    if (!ndjsonHashes.includes(hash)) problems.push(`${hash}: 有 .meta.json 但缺少 .ndjson`);
  }

  const hashes = [...new Set(ndjsonHashes)].sort();
  const fixtures: FixtureCheckReport[] = [];
  for (const hash of hashes) {
    fixtures.push(await checkOne(fixtureDir, hash, problems));
  }

  if (fixtures.length > MAX_FIXTURES) {
    problems.push(`fixture 数量 ${String(fixtures.length)} 超过上限 ${String(MAX_FIXTURES)}（README §5）`);
  }

  return {
    fixtureDir,
    fixtures,
    problems,
    ok: problems.length === 0 && fixtures.every((fixture) => fixture.ok),
  };
}

function printReport(report: CheckReport): void {
  process.stdout.write(`fixture 目录：${report.fixtureDir}\n`);
  for (const fixture of report.fixtures) {
    process.stdout.write(`\n${fixture.ok ? "✓" : "✗"} ${fixture.hash}\n`);
    for (const item of fixture.items) {
      process.stdout.write(`   ${item.ok ? "ok  " : "FAIL"} ${item.name} — ${item.detail}\n`);
    }
  }
  if (report.problems.length === 0) {
    process.stdout.write(`\n全部通过（${String(report.fixtures.length)} 条 fixture）\n`);
    return;
  }
  process.stdout.write(`\n发现 ${String(report.problems.length)} 个问题：\n`);
  for (const problem of report.problems) process.stdout.write(` - ${problem}\n`);
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("llm/src/check-fixtures.ts") === true;

if (invokedDirectly) {
  const dirArg = process.argv[2];
  const report = await checkFixtures(dirArg === undefined ? DEFAULT_FIXTURE_DIR : join(dirArg));
  printReport(report);
  process.exitCode = report.ok ? 0 : 1;
}

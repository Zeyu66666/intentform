/**
 * 回放 fixture 的读写层（`fixtures/replays/<hash>.ndjson` + `<hash>.meta.json`）。
 *
 * 格式定义在 `fixtures/replays/README.md`，本模块是它唯一的实现者：
 * - 一行一个 chunk：`{"d": <上游 delta 原文>, "dt": <相对上一块的毫秒延迟>}`；
 * - `<hash>.meta.json` 承载「这份文件从哪来」，评审不读代码也能判断可不可信。
 *
 * 两条硬规矩：
 * 1. **缺文件 ≠ 空结果**。`replay` 未命中必须抛错，绝不返回空流假装成功——
 *    否则前端会显示空表单，而学生/评委以为模型什么也没生成出来。
 * 2. **手写损坏 = 报错**。`chunks` 与行数不符、`meta` 字段缺失、hash 对不上，
 *    一律按「fixture 损坏」处理，而不是「尽量读」。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SCHEMA_VERSION } from "@intentform/schema";
import type { SchemaVersion } from "@intentform/schema";

import { LlmError } from "./errors.ts";
import { asRecord, readNumber, readString, tryParseJson } from "./json.ts";
import {
  REPLAY_HASH_PATTERN,
  replayKey,
  requirementPreview,
  normalizeRequirement,
} from "./replay-key.ts";

/** README 第 5 节：单条 `.ndjson` 上限。超了说明不该录这么长的输出，该拆需求。 */
export const FIXTURE_MAX_BYTES = 256 * 1024;

/** `record` 写盘时最多允许的 chunk 数——防止上游疯狂逐字符吐 delta 撑爆文件。 */
export const FIXTURE_MAX_CHUNKS = 20_000;

/** 未命中时给前端的提示。`replay` 走这条路是**预期内的正常分支**，要说得清楚。 */
export const REPLAY_MISS_HINT =
  "回放未命中：本机没有这条需求的录制文件。replay 模式不会伪造结果——请改用 LLM_MODE=mock 预览，或配好 Key 后用 record 模式重录。";

export interface FixtureChunk {
  /** 上游 `choices[0].delta.content` 原文，原样保留（含 `\n` 与中文）。 */
  readonly d: string;
  /** 相对上一块的到达延迟（毫秒，整数 ≥ 0）。 */
  readonly dt: number;
}

export interface FixtureUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export type UsageSource = "upstream" | "estimated";

export interface FixtureMeta {
  readonly recordedAt: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly schemaVersion: SchemaVersion;
  readonly requirementHash: string;
  readonly requirementPreview: string;
  readonly chunks: number;
  readonly totalMs: number;
  readonly usage: FixtureUsage;
  /** 上游没给 `usage` 时补 `estimated`（README 第 4 节）。 */
  readonly usageSource?: UsageSource;
  readonly upstream: string;
  readonly mode: "record";
}

export interface FixturePaths {
  readonly ndjsonPath: string;
  readonly metaPath: string;
}

export function fixturePaths(dir: string, hash: string): FixturePaths {
  return { ndjsonPath: join(dir, `${hash}.ndjson`), metaPath: join(dir, `${hash}.meta.json`) };
}

export function sumChunkDurations(chunks: readonly FixtureChunk[]): number {
  let total = 0;
  for (const chunk of chunks) total += chunk.dt;
  return total;
}

/** 序列化：一行一个对象，**以 `\n` 结尾、不留空行**。 */
export function serializeFixtureChunks(chunks: readonly FixtureChunk[]): string {
  return chunks.map((chunk) => `${JSON.stringify({ d: chunk.d, dt: chunk.dt })}\n`).join("");
}

export interface CreateFixtureMetaInput {
  /** 用户需求原文；规范化与 hash 都在这里做，调用方不要自己先规范化。 */
  readonly requirement: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly schemaVersion: SchemaVersion;
  /** `describeUpstream()` 的产物，例如 `local-stub:127.0.0.1:53101`。 */
  readonly upstream: string;
  /** 录制完成的那一刻。由调用方传 `new Date()`，测试注入固定值。 */
  readonly recordedAt: Date;
  /** 上游给的 token 用量；上游没给传 `null`（会写成零值 + `usageSource: estimated`）。 */
  readonly usage: FixtureUsage | null;
}

/**
 * 由 chunks 与来源信息拼出 `meta`。
 *
 * `chunks` / `totalMs` / `requirementHash` / `requirementPreview` 全部**算出来**，
 * 不接受调用方手填——手填的值正是「fixture 与内容对不上」的唯一来源。
 */
export function createFixtureMeta(
  chunks: readonly FixtureChunk[],
  input: CreateFixtureMetaInput,
): FixtureMeta {
  if (input.upstream.trim() === "") {
    throw new LlmError("internal", "录制 meta 缺少 upstream 标注");
  }
  const normalized = normalizeRequirement(input.requirement);
  const usage = input.usage ?? { promptTokens: 0, completionTokens: 0 };
  const usageSource: UsageSource | null = input.usage === null ? "estimated" : null;
  const hash = replayKey({
    requirement: input.requirement,
    model: input.model,
    promptVersion: input.promptVersion,
    schemaVersion: input.schemaVersion,
  });
  return {
    recordedAt: input.recordedAt.toISOString(),
    model: input.model,
    promptVersion: input.promptVersion,
    schemaVersion: input.schemaVersion,
    requirementHash: hash,
    requirementPreview: requirementPreview(normalized),
    chunks: chunks.length,
    totalMs: sumChunkDurations(chunks),
    usage,
    ...(usageSource === null ? {} : { usageSource }),
    upstream: input.upstream,
    mode: "record",
  };
}

export interface WriteFixtureResult extends FixturePaths {
  readonly bytes: number;
  readonly hash: string;
}

/** 先写 `.ndjson` 再写 `.meta.json`：中途崩了会留下「.ndjson 无 meta」，被读侧判为损坏。 */
export async function writeFixture(
  dir: string,
  hash: string,
  chunks: readonly FixtureChunk[],
  meta: FixtureMeta,
): Promise<WriteFixtureResult> {
  if (!REPLAY_HASH_PATTERN.test(hash)) {
    throw new LlmError("internal", `回放键非法：${hash}`, { detail: "expect 64 lowercase hex chars" });
  }
  if (chunks.length === 0) {
    throw new LlmError("llm_invalid_output", "上游没有产生任何内容增量，未写入回放文件");
  }
  if (chunks.length > FIXTURE_MAX_CHUNKS) {
    throw new LlmError("llm_invalid_output", `录制到 ${chunks.length} 个 chunk，超过单条上限`, {
      detail: `max ${String(FIXTURE_MAX_CHUNKS)} chunks`,
    });
  }
  for (const chunk of chunks) {
    if (!Number.isInteger(chunk.dt) || chunk.dt < 0) {
      throw new LlmError("internal", "chunk 延迟必须是非负整数", { detail: `dt=${String(chunk.dt)}` });
    }
  }
  if (meta.requirementHash !== hash) {
    throw new LlmError("internal", "meta.requirementHash 与文件名不一致", {
      detail: `meta=${meta.requirementHash} file=${hash}`,
    });
  }
  if (meta.chunks !== chunks.length) {
    throw new LlmError("internal", "meta.chunks 与实际行数不一致", {
      detail: `meta=${String(meta.chunks)} actual=${String(chunks.length)}`,
    });
  }

  const body = serializeFixtureChunks(chunks);
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > FIXTURE_MAX_BYTES) {
    throw new LlmError("llm_invalid_output", "录制内容超过单条 fixture 上限（256 KB），请拆分需求", {
      detail: `bytes=${String(bytes)}`,
    });
  }

  const paths = fixturePaths(dir, hash);
  await mkdir(dir, { recursive: true });
  await writeFile(paths.ndjsonPath, body, "utf8");
  await writeFile(paths.metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  return { ...paths, bytes, hash };
}

function isNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return "code" in error && (error as { readonly code?: unknown }).code === "ENOENT";
}

function corrupt(hash: string, reason: string): LlmError {
  return new LlmError(
    "llm_config",
    `回放文件损坏：${hash.slice(0, 12)}… 的 ndjson 与 meta.json 不配套或内容非法。请重新录制该 fixture。`,
    { detail: reason },
  );
}

function missing(hash: string, dir: string): LlmError {
  return new LlmError("llm_config", REPLAY_MISS_HINT, {
    detail: `no fixture for hash ${hash} under ${dir}`,
  });
}

/** 一行 → chunk；形状不对返回 `undefined`（由调用方统一报损坏）。 */
export function parseFixtureChunkLine(line: string): FixtureChunk | undefined {
  const parsed = tryParseJson(line);
  if (!parsed.ok) return undefined;
  const record = asRecord(parsed.value);
  if (record === undefined) return undefined;
  const d = readString(record, "d");
  const dt = readNumber(record, "dt");
  if (d === undefined || dt === undefined) return undefined;
  if (!Number.isInteger(dt) || dt < 0) return undefined;
  return { d, dt };
}

function parseFixtureMeta(value: unknown, hash: string): FixtureMeta | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;

  const recordedAt = readString(record, "recordedAt");
  const model = readString(record, "model");
  const promptVersion = readString(record, "promptVersion");
  const schemaVersion = readNumber(record, "schemaVersion");
  const requirementHash = readString(record, "requirementHash");
  const requirementPreviewValue = readString(record, "requirementPreview");
  const chunks = readNumber(record, "chunks");
  const totalMs = readNumber(record, "totalMs");
  const upstream = readString(record, "upstream");
  const mode = readString(record, "mode");
  const usageRecord = asRecord(record["usage"]);
  const usageSourceRaw = readString(record, "usageSource");

  if (
    recordedAt === undefined ||
    model === undefined ||
    promptVersion === undefined ||
    schemaVersion === undefined ||
    requirementHash === undefined ||
    requirementPreviewValue === undefined ||
    chunks === undefined ||
    totalMs === undefined ||
    upstream === undefined ||
    mode === undefined ||
    usageRecord === undefined
  ) {
    return undefined;
  }
  if (!Number.isInteger(schemaVersion) || !Number.isInteger(chunks) || !Number.isInteger(totalMs)) {
    return undefined;
  }
  if (recordedAt.trim() === "" || model.trim() === "" || upstream.trim() === "") return undefined;
  if (schemaVersion !== SCHEMA_VERSION) return undefined;
  if (requirementHash !== hash) return undefined;
  if (mode !== "record") return undefined;

  const promptTokens = readNumber(usageRecord, "promptTokens");
  const completionTokens = readNumber(usageRecord, "completionTokens");
  if (promptTokens === undefined || completionTokens === undefined) return undefined;
  if (!Number.isInteger(promptTokens) || promptTokens < 0) return undefined;
  if (!Number.isInteger(completionTokens) || completionTokens < 0) return undefined;

  let usageSource: UsageSource | null = null;
  if (usageSourceRaw !== undefined) {
    if (usageSourceRaw !== "upstream" && usageSourceRaw !== "estimated") return undefined;
    usageSource = usageSourceRaw;
  }

  return {
    recordedAt,
    model,
    promptVersion,
    schemaVersion: SCHEMA_VERSION,
    requirementHash,
    requirementPreview: requirementPreviewValue,
    chunks,
    totalMs,
    usage: { promptTokens, completionTokens },
    ...(usageSource === null ? {} : { usageSource }),
    upstream,
    mode: "record",
  };
}

export interface LoadedFixture {
  readonly hash: string;
  readonly chunks: readonly FixtureChunk[];
  readonly meta: FixtureMeta;
}

/**
 * 读一条 fixture。任何不正常都抛 `LlmError`（码 `llm_config`）：
 * 未命中与损坏的文案不同，但都**不降级成空流**。
 */
export async function readFixture(dir: string, hash: string): Promise<LoadedFixture> {
  if (!REPLAY_HASH_PATTERN.test(hash)) {
    throw new LlmError("llm_config", "回放键非法：必须是 64 位小写十六进制", { detail: hash });
  }
  const paths = fixturePaths(dir, hash);

  const [ndjsonRaw, metaRaw] = await Promise.all([
    readFile(paths.ndjsonPath, "utf8").catch((error: unknown) => {
      if (isNotFound(error)) return null;
      throw error;
    }),
    readFile(paths.metaPath, "utf8").catch((error: unknown) => {
      if (isNotFound(error)) return null;
      throw error;
    }),
  ]);

  if (ndjsonRaw === null && metaRaw === null) throw missing(hash, dir);
  if (ndjsonRaw === null || metaRaw === null) {
    throw corrupt(hash, `.ndjson 与 .meta.json 必须成对存在（缺失 ${ndjsonRaw === null ? "ndjson" : "meta"}）`);
  }
  if (ndjsonRaw.trim() === "") throw corrupt(hash, "ndjson 为空文件");

  const metaParsed = tryParseJson(metaRaw);
  if (!metaParsed.ok) throw corrupt(hash, `meta.json 解析失败：${metaParsed.reason}`);
  const meta = parseFixtureMeta(metaParsed.value, hash);
  if (meta === undefined) throw corrupt(hash, "meta.json 字段缺失、类型不对或与文件名不一致");

  const lines = ndjsonRaw.split("\n");
  // 文件必须以 `\n` 结尾 → 最后一段必为空串；否则说明末行没换行（视为损坏）。
  if (lines[lines.length - 1] !== "") throw corrupt(hash, "ndjson 未以换行结尾");
  lines.pop();

  const chunks: FixtureChunk[] = [];
  for (const [index, line] of lines.entries()) {
    if (line === "") throw corrupt(hash, `ndjson 第 ${String(index + 1)} 行是空行`);
    const chunk = parseFixtureChunkLine(line);
    if (chunk === undefined) throw corrupt(hash, `ndjson 第 ${String(index + 1)} 行不是合法 chunk`);
    chunks.push(chunk);
  }
  if (chunks.length === 0) throw corrupt(hash, "ndjson 没有任何 chunk");
  if (meta.chunks !== chunks.length) {
    throw corrupt(hash, `meta.chunks=${String(meta.chunks)} 与实际 ${String(chunks.length)} 行不一致`);
  }

  return { hash, chunks, meta };
}

/**
 * 一键录制 3 条回放 fixture：`node --experimental-strip-types src/testing/record-fixtures.ts`
 *
 * 走的是**真实的 record 代码路径**（`createRecordSource` → `streamChatCompletion` →
 * 真正的 `fetch` → SSE 解析 → chunk 落盘），只是把上游换成
 * `./stub-upstream.ts` 起的本地 OpenAI 兼容 stub。本机没有 API Key，这是唯一能
 * 既"真实录制"又不伪造 meta 的做法。
 *
 * 三条需求的原文**直接取 `GENERATE_PRESETS`**：需求文本与回放键同源，手抄一遍
 * 就等于给"改一个错别字 → 回放未命中"埋雷。
 *
 * 录完会把每条的 hash / recordedAt / upstream / chunks / totalMs 打出来，方便
 * 交付说明里逐条贴。
 */

import { readFile } from "node:fs/promises";

import { GENERATE_PRESETS } from "@intentform/schema";

import {
  DEFAULT_CHAT_MODEL,
  DEFAULT_FIXTURE_DIR,
  DEFAULT_PROMPT_VERSION,
  resolveLlmRuntimeConfig,
} from "../config.ts";
import { generateForm } from "../generate.ts";
import { silentLogger } from "../logger.ts";
import { createRecordSource } from "../sources.ts";
import type { WriteFixtureResult } from "../fixtures.ts";
import { startStubUpstream } from "./stub-upstream.ts";

/**
 * 录制用模型名 = 项目的默认模型名（`deepseek-chat`）。
 *
 * 它进回放键，所以名字必须与回放时 `config.model` 一致。取默认值而不是自造一个
 * 名字，是为了让 `LLM_MODE=replay` 单独就能命中——否则演示时还要额外记住
 * `LLM_CHAT_MODEL=...`，而忘记它的表现是"回放未命中"，非常难自查。
 * 注意：这不影响 `meta.upstream` 的如实标注（仍是 `local-stub:...`）。
 */
export const RECORD_MODEL = DEFAULT_CHAT_MODEL;

/** 假凭据：本地 stub 不校验，但 `record` 模式要求非空（缺凭据会抛 `llm_config`）。 */
const STUB_CREDENTIAL = "local-stub-not-a-real-key"; // secret-scan:allow 本地假凭据

export interface RecordedFixture {
  readonly presetId: string;
  readonly hash: string;
  readonly chunks: number;
  readonly totalMs: number;
  readonly upstream: string;
  readonly recordedAt: string;
  readonly fields: number;
  readonly errors: number;
  readonly repairs: number;
  readonly bytes: number;
}

export interface RecordFixturesOptions {
  readonly fixtureDir?: string;
  readonly frameDelayMs?: number;
}

export async function recordFixtures(options: RecordFixturesOptions = {}): Promise<readonly RecordedFixture[]> {
  const fixtureDir = options.fixtureDir ?? DEFAULT_FIXTURE_DIR;
  const stub = await startStubUpstream({
    frameDelayMs: options.frameDelayMs ?? 3,
    onRequest: (path, requirement) => {
      process.stdout.write(`  stub <- POST ${path} (${String(requirement.length)} 字需求)\n`);
    },
  });

  const results: RecordedFixture[] = [];
  try {
    for (const preset of GENERATE_PRESETS) {
      // 每条需求单独建 config：baseUrl 要带上 stub 的真实端口。
      const config = resolveLlmRuntimeConfig(
        "record",
        {
          LLM_API_KEY: STUB_CREDENTIAL,
          LLM_BASE_URL: stub.url,
          LLM_CHAT_MODEL: RECORD_MODEL,
          LLM_TIMEOUT_MS: "30000",
        },
        { fixtureDir, promptVersion: DEFAULT_PROMPT_VERSION },
      );

      // 用容器而不是裸 let：赋值发生在回调里，TS 的收窄看不穿闭包。
      const held: { result: WriteFixtureResult | null } = { result: null };
      const source = createRecordSource(config, {
        onRecorded: (result) => {
          held.result = result;
        },
      });

      let fields = 0;
      let errors = 0;
      let repairs = 0;
      let terminal = "none";

      for await (const event of generateForm({ config, source, logger: silentLogger }, { requirement: preset.requirement })) {
        if (event.type === "field") fields += 1;
        else if (event.type === "field_error") errors += 1;
        else if (event.type === "repair") repairs += 1;
        else if (event.type === "done") terminal = `done(${String(event.stats.fields)} fields)`;
        else if (event.type === "error") terminal = `error(${event.code})`;
      }

      const finished: WriteFixtureResult | null = held.result;
      if (finished === null) {
        throw new Error(`录制未落盘：${preset.id}（terminal=${terminal}）`);
      }
      if (terminal.startsWith("error")) {
        throw new Error(`录制以错误收尾：${preset.id}（${terminal}）`);
      }

      const meta = await readMeta(finished.metaPath);
      results.push({
        presetId: preset.id,
        hash: finished.hash,
        chunks: meta.chunks,
        totalMs: meta.totalMs,
        upstream: meta.upstream,
        recordedAt: meta.recordedAt,
        fields,
        errors,
        repairs,
        bytes: finished.bytes,
      });
    }
  } finally {
    await stub.close();
  }
  return results;
}

interface MetaShape {
  readonly chunks: number;
  readonly totalMs: number;
  readonly upstream: string;
  readonly recordedAt: string;
  readonly requirementHash: string;
}

async function readMeta(path: string): Promise<MetaShape> {
  const text = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) throw new Error(`meta 不是对象：${path}`);
  const record = parsed as Record<string, unknown>;
  const num = (key: string): number => {
    const value = record[key];
    if (typeof value !== "number") throw new Error(`meta.${key} 不是数字：${path}`);
    return value;
  };
  const str = (key: string): string => {
    const value = record[key];
    if (typeof value !== "string") throw new Error(`meta.${key} 不是字符串：${path}`);
    return value;
  };
  return {
    chunks: num("chunks"),
    totalMs: num("totalMs"),
    upstream: str("upstream"),
    recordedAt: str("recordedAt"),
    requirementHash: str("requirementHash"),
  };
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("testing/record-fixtures.ts") === true;

if (invokedDirectly) {
  const started = Date.now();
  const results = await recordFixtures();
  process.stdout.write("\n录好的 fixture：\n");
  for (const item of results) {
    process.stdout.write(
      [
        `- preset=${item.presetId}`,
        `  hash=${item.hash}`,
        `  recordedAt=${item.recordedAt}`,
        `  upstream=${item.upstream}`,
        `  chunks=${String(item.chunks)} totalMs=${String(item.totalMs)} bytes=${String(item.bytes)}`,
        `  fields=${String(item.fields)} fieldError=${String(item.errors)} repair=${String(item.repairs)}`,
      ].join("\n") + "\n",
    );
  }
  process.stdout.write(`总耗时 ${String(Date.now() - started)} ms；目录 ${DEFAULT_FIXTURE_DIR}\n`);
}

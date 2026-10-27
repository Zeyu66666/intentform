import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { GENERATE_PRESETS, SCHEMA_VERSION } from "@intentform/schema";

import { DEFAULT_CHAT_MODEL, DEFAULT_PROMPT_VERSION } from "./config.ts";
import { LlmError } from "./errors.ts";
import { createFixtureMeta, readFixture, writeFixture } from "./fixtures.ts";
import { normalizeRequirement, replayKey } from "./replay-key.ts";
import { validateLine } from "./validate-line.ts";

const FIXTURE_DIR = fileURLToPath(new URL("../../../fixtures/replays/", import.meta.url));

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "intentform-fixtures-"));
  tempDirs.push(dir);
  return dir;
}

const HASH_A = "a".repeat(64);

describe("writeFixture / readFixture", () => {
  it("写进去再读出来：chunks 与 meta 一致，chunks/totalMs 由内容算出", async () => {
    const dir = await tempDir();
    const chunks = [
      { d: '{"type":"section","id":"sec_main","title":"小测验"}\n', dt: 12 },
      { d: '{"type":"short","id":"q_short","title":"补充？"}\n', dt: 34 },
    ];
    const requirement = "出一份测验";
    const hash = replayKey({
      requirement,
      model: DEFAULT_CHAT_MODEL,
      promptVersion: DEFAULT_PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
    });
    const meta = createFixtureMeta(chunks, {
      requirement,
      model: DEFAULT_CHAT_MODEL,
      promptVersion: DEFAULT_PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      upstream: "local-stub:127.0.0.1:9999",
      recordedAt: new Date("2026-01-01T00:00:00.000Z"),
      usage: { promptTokens: 10, completionTokens: 20 },
    });
    await writeFixture(dir, hash, chunks, meta);

    const loaded = await readFixture(dir, hash);
    expect(loaded.chunks).toEqual(chunks);
    expect(loaded.meta.requirementHash).toBe(hash);
    expect(loaded.meta.upstream).toBe("local-stub:127.0.0.1:9999");
    expect(loaded.meta.usage).toEqual({ promptTokens: 10, completionTokens: 20 });
    expect(loaded.meta.recordedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(loaded.meta.mode).toBe("record");
    expect(loaded.meta.chunks).toBe(2);
    expect(loaded.meta.totalMs).toBe(46);
  });

  it("meta 与文件名不一致时拒绝写入（防止手填 hash 混进来）", async () => {
    const dir = await tempDir();
    const chunks = [{ d: '{"type":"short","id":"q_short","title":"x"}\n', dt: 1 }];
    const meta = createFixtureMeta(chunks, {
      requirement: "别的需求",
      model: DEFAULT_CHAT_MODEL,
      promptVersion: DEFAULT_PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      upstream: "local-stub:127.0.0.1:9999",
      recordedAt: new Date("2026-01-01T00:00:00.000Z"),
      usage: null,
    });
    const error = await writeFixture(dir, HASH_A, chunks, meta).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).message).toContain("requirementHash");
  });

  it("未命中抛 llm_config 且带「回放未命中」提示，不返回空 chunk 数组", async () => {
    const dir = await tempDir();
    const error = await readFixture(dir, "b".repeat(64)).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).code).toBe("llm_config");
    expect((error as LlmError).message).toContain("回放未命中");
  });

  it("只有一半（缺 meta）判损坏，同样不静默成功", async () => {
    const dir = await tempDir();
    const hash = "c".repeat(64);
    await writeFile(join(dir, `${hash}.ndjson`), '{"type":"section","id":"sec_main","title":"x"}\n', "utf8");
    const error = await readFixture(dir, hash).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).message).toContain("损坏");
  });

  it("回放键不是 64 位十六进制 → 直接拒绝（不拿它当文件名去试探）", async () => {
    const dir = await tempDir();
    const error = await readFixture(dir, "../etc/passwd").then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).code).toBe("llm_config");
  });
});

describe("仓库里已录制的 3 条 fixture", () => {
  it("每条都能按 replayKey(需求原文) 命中，meta 自洽，内容逐行合法", async () => {
    expect(GENERATE_PRESETS.length).toBe(3);

    for (const preset of GENERATE_PRESETS) {
      const hash = replayKey({
        requirement: preset.requirement,
        model: DEFAULT_CHAT_MODEL,
        promptVersion: DEFAULT_PROMPT_VERSION,
        schemaVersion: SCHEMA_VERSION,
      });
      const fixture = await readFixture(FIXTURE_DIR, hash);

      expect(fixture.meta.requirementHash).toBe(hash);
      expect(fixture.meta.mode).toBe("record");
      expect(fixture.meta.model).toBe(DEFAULT_CHAT_MODEL);
      expect(fixture.meta.promptVersion).toBe(DEFAULT_PROMPT_VERSION);
      expect(fixture.meta.schemaVersion).toBe(SCHEMA_VERSION);
      expect(fixture.meta.requirementPreview).toBe(normalizeRequirement(preset.requirement).slice(0, 80));
      // 只要求「如实标注」：本地 stub 录的写 local-stub:…，真上游录的写 openai-compatible:<host>。
      // 钉死成 stub 会挡住「有 Key 后重录」这条路，而重录是计划里明确要求的一步。
      expect(fixture.meta.upstream).toMatch(/^(local-stub:127\.0\.0\.1:\d+|openai-compatible:[\w.-]+)$/);
      if (fixture.meta.upstream.startsWith("openai-compatible:")) {
        // 真上游的 usage 不该是 0：写 0 说明当时没解析到 usage，`usageSource` 会标 estimated。
        expect(fixture.meta.usage.promptTokens).toBeGreaterThan(0);
        expect(fixture.meta.usage.completionTokens).toBeGreaterThan(0);
      }
      expect(fixture.meta.chunks).toBe(fixture.chunks.length);
      expect(fixture.meta.totalMs).toBe(fixture.chunks.reduce((sum, chunk) => sum + chunk.dt, 0));
      expect(fixture.meta.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      const text = fixture.chunks.map((chunk) => chunk.d).join("");
      const lines = text.split("\n").filter((line) => line.trim() !== "");
      expect(lines.length).toBeGreaterThan(2);
      for (const line of lines) {
        const result = validateLine(line);
        expect(result.ok, `${preset.id} 的回放里有一行不合法：${line}`).toBe(true);
      }
    }
  });
});

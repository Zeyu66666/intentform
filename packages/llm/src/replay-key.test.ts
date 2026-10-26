import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { SCHEMA_VERSION } from "@intentform/schema";

import { REPLAY_HASH_PATTERN, normalizeRequirement, replayKey, requirementPreview } from "./replay-key.ts";

const MODEL = "deepseek-chat";
const PROMPT = "generate.v1";

describe("normalizeRequirement", () => {
  it("NFC 规范化：全角/组合字符收敛成同一种编码", () => {
    const decomposed = "e\u0301"; // e + 组合尖音符
    expect(normalizeRequirement(decomposed)).toBe("\u00e9");
  });

  it("换行统一为 \\n，\\r\\n 与 \\r 都折成 \\n", () => {
    expect(normalizeRequirement("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("行内连续空格/制表符/全角空格折叠为一个半角空格，每行去首尾空白", () => {
    expect(normalizeRequirement("  出  一份\t\t测验\u3000\u3000吧  ")).toBe("出 一份 测验 吧");
  });

  it("连续 3 行以上空行折叠为 1 个空行，整体去首尾空白", () => {
    expect(normalizeRequirement("\n\n甲\n\n\n\n乙\n\n")).toBe("甲\n\n乙");
  });

  it("只差首尾空白与换行风格的两段文本规范化后相同（＝同一个回放键）", () => {
    const a = "出一份初二数学测验，8 道题。";
    const b = "\n\n  出一份初二数学测验，8 道题。\r\n\r\n";
    expect(normalizeRequirement(a)).toBe(normalizeRequirement(b));
    expect(replayKey({ requirement: a, model: MODEL, promptVersion: PROMPT, schemaVersion: SCHEMA_VERSION })).toBe(
      replayKey({ requirement: b, model: MODEL, promptVersion: PROMPT, schemaVersion: SCHEMA_VERSION }),
    );
  });
});

describe("replayKey", () => {
  const requirement = "出一份初二数学《二次函数》的入门测验";

  it("按 README 第 2 节的拼法算 sha256：normalize + \\0 + model + \\0 + promptVersion + \\0 + 'v' + schemaVersion", () => {
    const expected = createHash("sha256")
      .update(
        [
          normalizeRequirement(requirement),
          MODEL,
          PROMPT,
          `v${String(SCHEMA_VERSION)}`,
        ].join("\u0000"),
        "utf8",
      )
      .digest("hex");
    expect(replayKey({ requirement, model: MODEL, promptVersion: PROMPT, schemaVersion: SCHEMA_VERSION })).toBe(
      expected,
    );
  });

  it("是完整 64 位小写十六进制，不截断", () => {
    const hash = replayKey({ requirement, model: MODEL, promptVersion: PROMPT, schemaVersion: SCHEMA_VERSION });
    expect(hash).toMatch(REPLAY_HASH_PATTERN);
    expect(hash).toHaveLength(64);
  });

  it("模型或 prompt 版本任一变化都换键（schema 版本是字面量类型，运行期无法变化）", () => {
    const base = replayKey({ requirement, model: MODEL, promptVersion: PROMPT, schemaVersion: SCHEMA_VERSION });
    expect(replayKey({ requirement, model: "other-model", promptVersion: PROMPT, schemaVersion: SCHEMA_VERSION })).not.toBe(base);
    expect(replayKey({ requirement, model: MODEL, promptVersion: "generate.v2", schemaVersion: SCHEMA_VERSION })).not.toBe(base);
  });
});

describe("requirementPreview", () => {
  it("取规范化后前 80 字，且本身是规范化的", () => {
    const preview = requirementPreview(normalizeRequirement("  甲  \n\n\n\n 乙 "));
    expect(preview).toBe("甲\n\n乙");
    const long = "字".repeat(120);
    expect(requirementPreview(long).length).toBe(80);
  });
});

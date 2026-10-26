/**
 * @intentform/llm — 上游模型适配层。
 *
 * I0 只固化模式枚举与解析入口（评委复现的关键开关），I2 补 Provider、
 * LineSplitter、record/replay/mock 的落盘与回放。
 *
 * 设计取舍：模式解析不读 process.env 的具体键名而接收一个普通对象，
 * 这样单测可以在不污染环境变量的前提下覆盖全部非法输入。
 */

import type { SchemaVersion } from "@intentform/schema";

export const LLM_MODES = ["live", "record", "replay", "mock"] as const;

export type LlmMode = (typeof LLM_MODES)[number];

/**
 * 默认回放模式：评委没有 API Key 也能 10 分钟跑通闭环，
 * 这是「过程可复现性」评分的硬前提。
 */
export const DEFAULT_LLM_MODE: LlmMode = "replay";

export function isLlmMode(value: unknown): value is LlmMode {
  return typeof value === "string" && (LLM_MODES as readonly string[]).includes(value);
}

/**
 * 环境变量视图。用索引签名而不是 `{ LLM_MODE?: string }`：后者是 weak type，
 * `process.env`（`NodeJS.ProcessEnv`）传进来时会被 TS 判定「无共同属性」而报错，
 * 导致调用处被迫包一层对象拷贝——那正是最容易写错环境变量名的写法。
 */
export type LlmModeEnv = Readonly<Record<string, string | undefined>>;

/**
 * 解析 `LLM_MODE`。
 * 未设置或空串 → 回落到 `replay`；非法值直接抛错，绝不静默降级
 * （静默降级会让「记了回放却跑了实时」这类问题在 CI 里隐身）。
 */
export function resolveLlmMode(env: LlmModeEnv): LlmMode {
  const raw = env["LLM_MODE"]?.trim();
  if (raw === undefined || raw === "") {
    return DEFAULT_LLM_MODE;
  }
  const normalized = raw.toLowerCase();
  if (!isLlmMode(normalized)) {
    throw new Error(`invalid LLM_MODE: ${raw}; expected one of ${LLM_MODES.join(" | ")}`);
  }
  return normalized;
}

/** 只有 live/record 会真正打到上游，用来决定是否需要校验 Key。 */
export function requiresUpstreamCredentials(mode: LlmMode): boolean {
  return mode === "live" || mode === "record";
}

/**
 * 回放键的输入（计划 v1.1 §3.7）：`hash(规范化需求 + 模型 + prompt 版本 + schema 版本)`。
 *
 * 三处细节决定了「同一个键」的含义，别在 I2 里各写一套：
 * - `requirement` 是**规范化之后**的文本（去首尾空白、内部连续空白折叠、换行统一为 \n），
 *   否则教师多打一个空格就会换一个键，回放必然未命中。
 * - `schemaVersion` 必须进键：FormSchema 形状变了，旧 fixture 的合法性就不能复用。
 * - `promptVersion` 是 prompt 文件名里的版本号（如 `generate.v3`），不是 commit hash。
 *
 * I2 用真实 sha256 落盘，这里只固化形状。
 */
export interface ReplayKeyInput {
  readonly requirement: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly schemaVersion: SchemaVersion;
}

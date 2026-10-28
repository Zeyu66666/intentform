/**
 * @intentform/llm — 上游模型适配层。
 *
 * I0 只固化模式枚举与解析入口（评委复现的关键开关），I2 补 Provider、
 * LineSplitter、record/replay/mock 的落盘与回放。
 *
 * 设计取舍：模式解析不读 process.env 的具体键名而接收一个普通对象，
 * 这样单测可以在不污染环境变量的前提下覆盖全部非法输入。
 */

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
 * 对外导出面（barrel）。
 *
 * 规则：**内部模块之间不经过 barrel 互 import**，否则 `index.ts` 会重新卷入循环
 * 依赖；barrel 只服务包外消费者（server / web / scripts）。
 */
export * from "./config.ts";
export * from "./errors.ts";
export * from "./fixtures.ts";
export * from "./generate.ts";
export * from "./json.ts";
export * from "./line-splitter.ts";
export * from "./logger.ts";
export * from "./patch-suggest.ts";
export * from "./plan.ts";
export * from "./prompt.ts";
export * from "./provider.ts";
export * from "./repair.ts";
export * from "./replay-key.ts";
export * from "./sources.ts";
export * from "./sse-writer.ts";
export * from "./validate-line.ts";

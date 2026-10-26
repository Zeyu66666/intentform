/**
 * 运行时配置解析：把环境变量折成一个**全字段有值**的 `LlmRuntimeConfig`。
 *
 * 三条纪律（都是被 §5「不许静默回落」逼出来的）：
 * 1. 非法值一律抛 `llm_config`，不猜、不回落默认值。`LLM_REPLAY_SPEED=1.5x`
 *    静默当成 `instant` 的话，录视频时节奏全错，而人不会怀疑是配置的锅。
 * 2. `live`/`record` 缺 Key 在**启动期**就抛，不拖到第一次生成——失败快速，
 *    而且 `readConfig()` 的调用方（`startServer`）不会启动一个注定失败的进程。
 * 3. `replay`/`mock` 不需要 Key，所以 `apiKey` 是 `string | null` 而不是可选：
 *    让「没有 Key」是一个明确的值，调用方不必区分「字段缺失」和「空串」。
 *
 * 这里只读 `.env.example` 里列出的键，多一个都不读（隐式配置是复现性的敌人）。
 */

import { fileURLToPath } from "node:url";

import { LlmError } from "./errors.ts";
import type { LlmMode, LlmModeEnv } from "./index.ts";

/** 默认回放目录：`packages/llm/src/` 往上三层是仓库根。 */
export const DEFAULT_FIXTURE_DIR = fileURLToPath(new URL("../../../fixtures/replays/", import.meta.url));

export const DEFAULT_LLM_BASE_URL = "https://api.deepseek.com/v1";

export const DEFAULT_CHAT_MODEL = "deepseek-chat";

export const DEFAULT_TIMEOUT_MS = 60_000;

export const DEFAULT_MAX_TOKENS = 4096;

export const DEFAULT_TEMPERATURE = 0;

/**
 * prompt 版本号（`prompts/generate.v1.md` 里的文件名部分）。它进回放键，
 * 所以改 prompt 必须递增版本号，否则旧 fixture 会被当成「同一次请求」而命中。
 */
export const DEFAULT_PROMPT_VERSION = "generate.v1";

export const REPLAY_SPEEDS = ["1x", "2x", "instant"] as const;

export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export const DEFAULT_REPLAY_SPEED: ReplaySpeed = "instant";

export function isReplaySpeed(value: unknown): value is ReplaySpeed {
  return typeof value === "string" && (REPLAY_SPEEDS as readonly string[]).includes(value);
}

export interface LlmRuntimeConfig {
  readonly mode: LlmMode;
  readonly replaySpeed: ReplaySpeed;
  /** 上游根地址（不含 `/chat/completions`）。mock/replay 下仅用于展示与日志。 */
  readonly baseUrl: string;
  /** `live`/`record` 必填；`replay`/`mock` 为 `null`。 */
  readonly apiKey: string | null;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxTokens: number;
  readonly temperature: number;
  readonly seed: number | null;
  readonly promptVersion: string;
  readonly fixtureDir: string;
  /** `meta.upstream` 的取值：`openai-compatible:<host>` 或 `local-stub:<host:port>`。 */
  readonly upstreamLabel: string;
}

export interface ResolveConfigOptions {
  readonly fixtureDir?: string;
  readonly promptVersion?: string;
}

function readString(env: LlmModeEnv, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function readInteger(
  env: LlmModeEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = readString(env, key);
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/.test(raw)) {
    throw new LlmError("llm_config", `${key} 必须是整数`, { detail: `received ${JSON.stringify(raw)}` });
  }
  const value = Number.parseInt(raw, 10);
  if (value < min || value > max) {
    throw new LlmError("llm_config", `${key} 超出允许范围（${min}–${max}）`, {
      detail: `received ${String(value)}`,
    });
  }
  return value;
}

function readDecimal(
  env: LlmModeEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = readString(env, key);
  if (raw === undefined) return fallback;
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) {
    throw new LlmError("llm_config", `${key} 必须是数字`, { detail: `received ${JSON.stringify(raw)}` });
  }
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new LlmError("llm_config", `${key} 超出允许范围（${min}–${max}）`, {
      detail: `received ${String(value)}`,
    });
  }
  return value;
}

/** 校验并去掉结尾多余的 `/`，避免拼出 `//chat/completions`。 */
function readBaseUrl(env: LlmModeEnv): string {
  const raw = readString(env, "LLM_BASE_URL") ?? DEFAULT_LLM_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new LlmError("llm_config", "LLM_BASE_URL 不是合法 URL", { detail: `received ${JSON.stringify(raw)}` });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new LlmError("llm_config", "LLM_BASE_URL 只支持 http/https", { detail: `protocol ${parsed.protocol}` });
  }
  return raw.replace(/\/+$/, "");
}

/**
 * `meta.upstream` 的取值。本地 stub 必须如实写成 `local-stub:<host:port>`——
 * 评审看到它就知道这不是真实模型输出；编造这一行比没有这一行更糟。
 */
export function describeUpstream(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return "openai-compatible:unknown";
  }
  const host = parsed.host;
  const isLocal =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "::1" ||
    parsed.hostname === "[::1]";
  return `${isLocal ? "local-stub" : "openai-compatible"}:${host}`;
}

/** 解析 `LLM_REPLAY_SPEED`。空串 → 默认 `instant`；非法值抛错，不降级。 */
export function resolveReplaySpeed(env: LlmModeEnv): ReplaySpeed {
  const raw = readString(env, "LLM_REPLAY_SPEED");
  if (raw === undefined) return DEFAULT_REPLAY_SPEED;
  const normalized = raw.toLowerCase();
  if (!isReplaySpeed(normalized)) {
    throw new LlmError("llm_config", "LLM_REPLAY_SPEED 只能是 1x / 2x / instant", {
      detail: `received ${JSON.stringify(raw)}`,
    });
  }
  return normalized;
}

/**
 * 主入口。`mode` 由调用方先用 `resolveLlmMode()` 解析好再传进来：
 * 这样本模块不需要在运行时依赖 `index.ts`（避免 barrel 循环 import），
 * 也让「模式非法」与「模式配套参数非法」的错误来自两个明确的边界。
 */
export function resolveLlmRuntimeConfig(
  mode: LlmMode,
  env: LlmModeEnv,
  options: ResolveConfigOptions = {},
): LlmRuntimeConfig {
  const baseUrl = readBaseUrl(env);
  const model = readString(env, "LLM_CHAT_MODEL") ?? DEFAULT_CHAT_MODEL;
  const apiKey = readString(env, "LLM_API_KEY") ?? null;
  const seedRaw = readString(env, "LLM_SEED");
  const seed =
    seedRaw === undefined ? null : readInteger(env, "LLM_SEED", 0, 0, 2_147_483_647);

  if ((mode === "live" || mode === "record") && apiKey === null) {
    throw new LlmError("llm_config", "live/record 模式需要 LLM_API_KEY", {
      detail: "LLM_API_KEY is empty; replay/mock 不需要 Key",
    });
  }

  const fixtureDir = options.fixtureDir ?? DEFAULT_FIXTURE_DIR;
  if (fixtureDir.trim() === "") {
    throw new LlmError("llm_config", "回放 fixture 目录不能为空");
  }

  return {
    mode,
    replaySpeed: resolveReplaySpeed(env),
    baseUrl,
    apiKey,
    model,
    timeoutMs: readInteger(env, "LLM_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 1, 600_000),
    maxTokens: readInteger(env, "LLM_MAX_TOKENS", DEFAULT_MAX_TOKENS, 1, 32_768),
    temperature: readDecimal(env, "LLM_TEMPERATURE", DEFAULT_TEMPERATURE, 0, 2),
    seed,
    promptVersion: options.promptVersion ?? DEFAULT_PROMPT_VERSION,
    fixtureDir,
    upstreamLabel: describeUpstream(baseUrl),
  };
}

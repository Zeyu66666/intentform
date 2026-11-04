/**
 * 进程内可变的模型运行设置（2026-11-03）。
 *
 * 为什么要可变：网页上的「模型设置」允许教师切换 live/record/replay/mock、
 * 改端点和 Key。这些值不落盘、不改 `.env`，只活在当前进程里；重启后回到
 * 环境变量里的启动配置。这样「网页改配置」不会悄悄改掉部署事实。
 *
 * Key 只进不出：`publicSettings()` 只回 `hasApiKey`，任何响应/日志都不含 Key。
 */

import {
  LlmError,
  resolveLlmRuntimeConfig,
  type LlmMode,
  type LlmRuntimeConfig,
} from "@intentform/llm";

export interface LlmSettingsInput {
  readonly mode: LlmMode;
  readonly baseUrl: string;
  readonly model: string;
  /** 省略 = 保持原 Key；空串 = 清空。 */
  readonly apiKey?: string;
  /** 联网参考搜索端点；省略 = 保持，空串 = 不配置。 */
  readonly searchBaseUrl?: string;
  /** 搜索 Key；与 `apiKey` 同语义：省略 = 保持，空串 = 清空。 */
  readonly searchApiKey?: string;
}

export interface LlmPublicSettings {
  readonly mode: LlmMode;
  readonly baseUrl: string;
  readonly model: string;
  readonly hasApiKey: boolean;
  readonly searchBaseUrl: string;
  readonly hasSearchKey: boolean;
}

/** 搜索凭据（只进路由，绝不进响应/日志）。 */
export interface LlmSearchSettings {
  readonly baseUrl: string;
  readonly apiKey: string;
}

export interface LlmRuntime {
  readonly config: LlmRuntimeConfig;
  readonly publicSettings: () => LlmPublicSettings;
  readonly searchSettings: () => LlmSearchSettings;
  readonly update: (input: LlmSettingsInput) => LlmPublicSettings;
}

/**
 * 空串 = 不配置；非空必须是 http(s) URL。去掉结尾斜杠，避免拼出 `//`。
 * 非法值抛 `llm_config`（与其他启动期配置同一条纪律：不猜、不静默回落）。
 */
function normalizeSearchBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed === "") return "";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new LlmError("llm_config", "搜索端点不是合法 URL", {
      detail: `received ${JSON.stringify(raw)}`,
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new LlmError("llm_config", "搜索端点只支持 http/https", {
      detail: `protocol ${parsed.protocol}`,
    });
  }
  return trimmed;
}

export function createLlmRuntime(initial: LlmRuntimeConfig, rawEnv: NodeJS.ProcessEnv): LlmRuntime {
  let current = initial;
  // 当前 Key 单独留一份：`update` 里「省略 apiKey」表示保持不变、「空串」表示清空，
  // 只有分开记住才能区分这两种意图，切回 live 时也不必重输。
  // 端点/模型每次更新都必填，所以不需要另存——它们始终跟着 `current` 走。
  let apiKey: string | null = initial.apiKey;
  // 搜索配置与模型配置分开存：它不参与 `resolveLlmRuntimeConfig`（那是上游模型的配置），
  // 但同样只活在进程内存里，重启后回到环境变量。
  let searchBaseUrl = normalizeSearchBaseUrl(rawEnv["SEARCH_BASE_URL"] ?? "");
  let searchApiKey = (rawEnv["SEARCH_API_KEY"] ?? "").trim();

  const rebuild = (
    mode: LlmMode,
    nextBaseUrl: string,
    nextModel: string,
    nextKey: string | null,
  ): LlmRuntimeConfig => {
    const env: NodeJS.ProcessEnv = {
      ...rawEnv,
      LLM_MODE: mode,
      LLM_BASE_URL: nextBaseUrl,
      LLM_CHAT_MODEL: nextModel,
      LLM_API_KEY: nextKey ?? "",
    };
    return resolveLlmRuntimeConfig(mode, env, {});
  };

  return {
    get config() {
      return current;
    },
    publicSettings: () => ({
      mode: current.mode,
      baseUrl: current.baseUrl,
      model: current.model,
      hasApiKey: apiKey !== null && apiKey !== "",
      searchBaseUrl,
      hasSearchKey: searchApiKey !== "",
    }),
    searchSettings: () => ({ baseUrl: searchBaseUrl, apiKey: searchApiKey }),
    update: (input) => {
      const nextKey =
        input.apiKey === undefined
          ? apiKey
          : input.apiKey.trim() === ""
            ? null
            : input.apiKey.trim();
      // 搜索端点先归一化（可能抛）；它不依赖模型配置，失败时什么都不写。
      const nextSearchBaseUrl =
        input.searchBaseUrl === undefined
          ? searchBaseUrl
          : normalizeSearchBaseUrl(input.searchBaseUrl);
      const nextSearchKey =
        input.searchApiKey === undefined ? searchApiKey : input.searchApiKey.trim();
      // 先解析成功再赋值：非法端点/缺 Key 时连「下一次重试要用的端点」也不能被改脏，
      // 否则教师改回合法值时会带着上一笔坏输入一起失败。
      const next = rebuild(input.mode, input.baseUrl, input.model, nextKey);
      apiKey = nextKey;
      searchBaseUrl = nextSearchBaseUrl;
      searchApiKey = nextSearchKey;
      current = next;
      return {
        mode: next.mode,
        baseUrl: next.baseUrl,
        model: next.model,
        hasApiKey: nextKey !== null && nextKey !== "",
        searchBaseUrl: nextSearchBaseUrl,
        hasSearchKey: nextSearchKey !== "",
      };
    },
  };
}

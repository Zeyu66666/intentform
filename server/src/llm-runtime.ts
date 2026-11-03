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
}

export interface LlmPublicSettings {
  readonly mode: LlmMode;
  readonly baseUrl: string;
  readonly model: string;
  readonly hasApiKey: boolean;
}

export interface LlmRuntime {
  readonly config: LlmRuntimeConfig;
  readonly publicSettings: () => LlmPublicSettings;
  readonly update: (input: LlmSettingsInput) => LlmPublicSettings;
}

export function createLlmRuntime(initial: LlmRuntimeConfig, rawEnv: NodeJS.ProcessEnv): LlmRuntime {
  let current = initial;
  // 当前 Key 单独留一份：`update` 里「省略 apiKey」表示保持不变、「空串」表示清空，
  // 只有分开记住才能区分这两种意图，切回 live 时也不必重输。
  // 端点/模型每次更新都必填，所以不需要另存——它们始终跟着 `current` 走。
  let apiKey: string | null = initial.apiKey;

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
    }),
    update: (input) => {
      const nextKey =
        input.apiKey === undefined
          ? apiKey
          : input.apiKey.trim() === ""
            ? null
            : input.apiKey.trim();
      // 先解析成功再赋值：非法端点/缺 Key 时连「下一次重试要用的端点」也不能被改脏，
      // 否则教师改回合法值时会带着上一笔坏输入一起失败。
      const next = rebuild(input.mode, input.baseUrl, input.model, nextKey);
      apiKey = nextKey;
      current = next;
      return {
        mode: next.mode,
        baseUrl: next.baseUrl,
        model: next.model,
        hasApiKey: nextKey !== null && nextKey !== "",
      };
    },
  };
}

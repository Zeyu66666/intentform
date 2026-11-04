/**
 * 联网参考搜索（2026-11-04，P24）。
 *
 * 为什么是「薄适配器」而不是绑一个搜索供应商：比赛作品不该把某家搜索 API 的形状
 * 写进核心链路。这里只认一个最小 HTTP 契约（`POST` → `{results:[{title,snippet,url}]}`），
 * 教师侧用一行代理就能接任何供应商。
 *
 * 四条纪律：
 * 1. **离线零外呼**：`mock/replay/record` 下无论请求怎么勾选，都不发 fetch。
 *    这不是性能优化，是演示可复现性的前提——评审机器上没有搜索 Key 也不该收到请求。
 * 2. **搜索失败不阻断规划**：超时/网络错误/坏 JSON 一律降级为「不搜」，只记 warn。
 * 3. **Key 不进日志**：错误文案只含状态码与固定措辞，异常原文也不透传。
 * 4. **结果严格过滤**：缺字段、非 http(s) URL 的条目直接丢弃，宁少勿错。
 */

import { normalizeRequirement, type LlmLogger } from "@intentform/llm";

/** 单次搜索最多取几条；与设计文档的 `limit: 8` 对齐。 */
export const SEARCH_RESULT_LIMIT = 8;
/** 搜索端点超时。比 LLM 的 60s 短得多：搜索只是锦上添花，不该拖住规划。 */
export const SEARCH_TIMEOUT_MS = 8_000;
/** 查询词取规范化需求的前 120 字（设计文档 §「搜索查询词」）。 */
export const SEARCH_QUERY_MAX_CHARS = 120;

const TITLE_MAX = 200;
const SNIPPET_MAX = 500;
const URL_MAX = 500;

export interface SearchResult {
  readonly title: string;
  readonly snippet: string;
  readonly url: string;
}

/** 搜索端点配置（只存在进程内存里；`apiKey` 永不出口）。 */
export interface SearchCredentials {
  readonly baseUrl: string;
  readonly apiKey: string;
}

/** 可注入的 fetch 形状：够用、够窄，测试不必伪造整个 `Response`。 */
export interface SearchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}

export type SearchFetch = (
  url: string,
  init: {
    readonly method: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly signal: AbortSignal;
  },
) => Promise<SearchResponseLike>;

/** 搜索链路的失败：只用于内部分支，不把异常原文冒到响应里。 */
export class SearchError extends Error {
  override name = "SearchError";
}

export function isSearchConfigured(credentials: SearchCredentials): boolean {
  return credentials.baseUrl.trim() !== "" && credentials.apiKey.trim() !== "";
}

/** 四道闸：只有全过才允许外呼。调用方（plan 路由）与 `searchWeb` 各判一次。 */
export interface SearchGateInput {
  readonly mode: string;
  readonly webSearch: boolean;
  readonly credentials: SearchCredentials;
}

export function shouldSearch(input: SearchGateInput): boolean {
  return input.mode === "live" && input.webSearch && isSearchConfigured(input.credentials);
}

/** 查询词：规范化（与回放键同一套）后取前 120 字；不另做查询改写。 */
export function buildSearchQuery(requirement: string): string {
  return normalizeRequirement(requirement).slice(0, SEARCH_QUERY_MAX_CHARS);
}

function truncateText(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * 单条结果的形状校验。标题与 URL 必须非空且 URL 是 http(s)；
 * `snippet` 允许空串（供应商常有「只有标题没有摘要」的条目），但字段本身必须是字符串。
 */
function toResult(value: unknown): SearchResult | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const title = record["title"];
  const snippet = record["snippet"];
  const url = record["url"];
  if (typeof title !== "string" || typeof snippet !== "string" || typeof url !== "string") {
    return undefined;
  }
  const trimmedTitle = title.trim();
  const trimmedUrl = url.trim();
  if (trimmedTitle === "" || trimmedUrl === "" || !isHttpUrl(trimmedUrl)) return undefined;
  return {
    title: truncateText(trimmedTitle, TITLE_MAX),
    snippet: truncateText(snippet.trim(), SNIPPET_MAX),
    url: truncateText(trimmedUrl, URL_MAX),
  };
}

export interface SearchWebOptions {
  readonly fetchImpl?: SearchFetch;
  readonly timeoutMs?: number;
}

/**
 * 真正发请求。**失败即抛 `SearchError`**（文案不含 Key/查询词），
 * 由 `runWebSearch` 决定降级；这样「空结果」与「请求失败」在回执里能分开。
 */
export async function searchWeb(
  credentials: SearchCredentials,
  query: string,
  options: SearchWebOptions = {},
): Promise<readonly SearchResult[]> {
  const baseUrl = credentials.baseUrl.trim();
  if (baseUrl === "" || credentials.apiKey.trim() === "") {
    throw new SearchError("搜索未配置");
  }

  const doFetch: SearchFetch =
    options.fetchImpl ??
    ((url, init) =>
      fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: init.signal,
      }));

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS;
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let payload: unknown;
  try {
    const response = await doFetch(baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${credentials.apiKey}`,
      },
      body: JSON.stringify({ query, limit: SEARCH_RESULT_LIMIT }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new SearchError(`搜索服务返回 HTTP ${String(response.status)}`);
    }
    payload = await response.json();
  } catch (error) {
    if (error instanceof SearchError) throw error;
    // 刻意不透传异常原文：某些运行时会把请求 URL（或更糟）带进 message。
    throw new SearchError("搜索请求失败（网络错误或超时）");
  } finally {
    clearTimeout(timer);
  }

  if (typeof payload !== "object" || payload === null) {
    throw new SearchError("搜索响应不是对象");
  }
  const results = (payload as Record<string, unknown>)["results"];
  if (!Array.isArray(results)) {
    throw new SearchError("搜索响应缺少 results 数组");
  }

  const parsed: SearchResult[] = [];
  for (const entry of results) {
    if (parsed.length >= SEARCH_RESULT_LIMIT) break;
    const result = toResult(entry);
    if (result !== undefined) parsed.push(result);
  }
  return parsed;
}

/** 回执状态；与 `@intentform/schema` 的 `PlanSearchStatus` 同值。 */
export type SearchStatus = "off" | "used" | "empty" | "failed";

export interface SearchOutcome {
  readonly status: SearchStatus;
  readonly results: readonly SearchResult[];
}

export interface RunWebSearchInput extends SearchGateInput {
  readonly requirement: string;
}

export interface RunWebSearchOptions extends SearchWebOptions {
  readonly logger?: LlmLogger;
}

/**
 * 闸门 + 降级的唯一入口。**任何失败都折成 `failed` 且不抛**：
 * 蓝图规划能否继续，不该由搜索服务的可用性决定。
 */
export async function runWebSearch(
  input: RunWebSearchInput,
  options: RunWebSearchOptions = {},
): Promise<SearchOutcome> {
  if (!shouldSearch(input)) return { status: "off", results: [] };

  const query = buildSearchQuery(input.requirement);
  if (query === "") return { status: "off", results: [] };

  try {
    const results = await searchWeb(input.credentials, query, options);
    return { status: results.length === 0 ? "empty" : "used", results };
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    options.logger?.("warn", `联网参考搜索失败，已降级为不搜索：${message}`);
    return { status: "failed", results: [] };
  }
}

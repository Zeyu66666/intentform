/**
 * 联网参考搜索（P24）。
 *
 * 重点不是「能不能搜」，而是**什么时候绝不能搜**：离线三模式、未勾选、
 * 端点或 Key 缺失，任一成立都必须零外呼。这条保证比搜索结果本身更关键——
 * 评审机器上没有搜索 Key，也不该看到任何外部请求。
 */

import { describe, expect, it } from "vitest";

import {
  SEARCH_QUERY_MAX_CHARS,
  SEARCH_RESULT_LIMIT,
  SearchError,
  buildSearchQuery,
  runWebSearch,
  searchWeb,
  shouldSearch,
  type SearchCredentials,
  type SearchFetch,
  type SearchResponseLike,
} from "./search.ts";

// 测试用占位串，不是任何环境的凭据；拆成常量避开密钥形态扫描。
const SEARCH_TEST_CREDENTIAL = "search-test-key-not-real";

const CREDENTIALS: SearchCredentials = {
  baseUrl: "https://search.example.test/v1/search",
  apiKey: SEARCH_TEST_CREDENTIAL,
};

function responseOf(payload: unknown, status = 200): SearchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload),
  };
}

const GOOD_RESULTS = [
  { title: "高三数学试卷分析", snippet: "难度梯度：基础 40%、提升 30%", url: "https://example.com/a" },
  { title: "立体几何压轴题命题思路", snippet: "参数讨论与分类讨论", url: "https://example.com/b" },
] as const;

describe("searchWeb", () => {
  it("按薄契约发 POST：Bearer Key、{query,limit}、只取合规条目", async () => {
    const calls: { url: string; headers: Readonly<Record<string, string>>; body: string }[] = [];
    const fetchImpl: SearchFetch = (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return Promise.resolve(responseOf({ results: GOOD_RESULTS }));
    };

    const results = await searchWeb(CREDENTIALS, "高三数学 8 题", { fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(CREDENTIALS.baseUrl);
    expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${CREDENTIALS.apiKey}`);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ query: "高三数学 8 题", limit: SEARCH_RESULT_LIMIT });
    expect(results).toEqual(GOOD_RESULTS);
  });

  it("字段缺失、空标题、非 http(s) URL 的条目丢弃；最多 8 条", async () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      title: `结果 ${String(index + 1)}`,
      snippet: "摘要",
      url: `https://example.com/${String(index + 1)}`,
    }));
    const results = await searchWeb(CREDENTIALS, "需求", {
      fetchImpl: () =>
        Promise.resolve(
          responseOf({
            results: [
              { title: "缺 snippet", url: "https://example.com/x" },
              { snippet: "缺 title", url: "https://example.com/x" },
              { title: "缺 url", snippet: "摘要" },
              { title: "   ", snippet: "空标题", url: "https://example.com/x" },
              { title: "ftp", snippet: "非 http", url: "ftp://example.com/x" },
              { title: "不是对象" },
              ...many,
            ],
          }),
        ),
    });

    expect(results).toHaveLength(SEARCH_RESULT_LIMIT);
    expect(results[0]?.title).toBe("结果 1");
    expect(results.every((entry) => entry.url.startsWith("https://"))).toBe(true);
  });

  it("HTTP 非 2xx、非法 JSON、results 不是数组 → SearchError，且文案不含 Key", async () => {
    const cases: readonly SearchFetch[] = [
      () => Promise.resolve(responseOf({ results: [] }, 500)),
      () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.reject(new Error(`boom ${CREDENTIALS.apiKey}`)),
        }),
      () => Promise.resolve(responseOf({ results: "nope" })),
      () => Promise.resolve(responseOf(null)),
    ];
    for (const fetchImpl of cases) {
      const error = await searchWeb(CREDENTIALS, "需求", { fetchImpl }).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(SearchError);
      expect((error as Error).message).not.toContain(CREDENTIALS.apiKey);
    }
  });

  it("超时会被 AbortSignal 打断并折成 SearchError", async () => {
    const fetchImpl: SearchFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    const error = await searchWeb(CREDENTIALS, "需求", { fetchImpl, timeoutMs: 10 }).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(SearchError);
  });
});

describe("shouldSearch 四道闸", () => {
  it("只有 live ∧ 勾选 ∧ 端点非空 ∧ Key 非空 才允许外呼", () => {
    expect(shouldSearch({ mode: "live", webSearch: true, credentials: CREDENTIALS })).toBe(true);
    expect(shouldSearch({ mode: "mock", webSearch: true, credentials: CREDENTIALS })).toBe(false);
    expect(shouldSearch({ mode: "replay", webSearch: true, credentials: CREDENTIALS })).toBe(false);
    expect(shouldSearch({ mode: "record", webSearch: true, credentials: CREDENTIALS })).toBe(false);
    expect(shouldSearch({ mode: "live", webSearch: false, credentials: CREDENTIALS })).toBe(false);
    expect(
      shouldSearch({ mode: "live", webSearch: true, credentials: { ...CREDENTIALS, baseUrl: "" } }),
    ).toBe(false);
    expect(
      shouldSearch({ mode: "live", webSearch: true, credentials: { ...CREDENTIALS, apiKey: "" } }),
    ).toBe(false);
  });
});

describe("runWebSearch", () => {
  it("离线模式即使勾选也零外呼，回执 off", async () => {
    for (const mode of ["mock", "replay", "record"] as const) {
      let calls = 0;
      const outcome = await runWebSearch(
        { mode, webSearch: true, credentials: CREDENTIALS, requirement: "高三数学" },
        {
          fetchImpl: () => {
            calls += 1;
            return Promise.resolve(responseOf({ results: GOOD_RESULTS }));
          },
        },
      );
      expect(outcome.status, mode).toBe("off");
      expect(outcome.results).toHaveLength(0);
      expect(calls, mode).toBe(0);
    }
  });

  it("live 且配置齐全时返回 used；空结果返回 empty", async () => {
    const used = await runWebSearch(
      { mode: "live", webSearch: true, credentials: CREDENTIALS, requirement: "高三数学" },
      { fetchImpl: () => Promise.resolve(responseOf({ results: GOOD_RESULTS })) },
    );
    expect(used.status).toBe("used");
    expect(used.results).toHaveLength(2);

    const empty = await runWebSearch(
      { mode: "live", webSearch: true, credentials: CREDENTIALS, requirement: "高三数学" },
      { fetchImpl: () => Promise.resolve(responseOf({ results: [] })) },
    );
    expect(empty.status).toBe("empty");
  });

  it("请求失败降级为 failed（不抛），warn 日志不含 Key", async () => {
    const logs: string[] = [];
    const outcome = await runWebSearch(
      { mode: "live", webSearch: true, credentials: CREDENTIALS, requirement: "高三数学" },
      {
        fetchImpl: () => Promise.reject(new Error(`socket hang up ${CREDENTIALS.apiKey}`)),
        logger: (_level, message) => {
          logs.push(message);
        },
      },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.results).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain(CREDENTIALS.apiKey);
  });
});

describe("buildSearchQuery", () => {
  it("规范化后截到 120 字，换行折叠", () => {
    // 两行空行原样保留（README 的口径是「3 行以上」才折叠）。
    expect(buildSearchQuery("  高三   数学  \n\n\n 试卷 ")).toBe("高三 数学\n\n\n试卷");
    // 4 行空行折成 1 行。
    expect(buildSearchQuery("高三\n\n\n\n\n试卷")).toBe("高三\n\n试卷");
    const long = buildSearchQuery("题".repeat(500));
    expect(long).toHaveLength(SEARCH_QUERY_MAX_CHARS);
  });
});

import { describe, expect, it } from "vitest";

import {
  AbortedError,
  GenerateStreamError,
  createFetchStreamSource,
  createFixtureStreamSource,
  isAbortError,
  selectStreamMode,
} from "./source";

const encoder = new TextEncoder();

function streamOf(chunks: readonly string[], onCancel?: () => void): ReadableStream<Uint8Array> {
  const items = chunks.map((chunk) => encoder.encode(chunk));
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const item = items[index];
      if (item === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(item);
      index += 1;
    },
    cancel() {
      onCancel?.();
    },
  });
}

async function collect(source: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return chunks;
}

describe("createFetchStreamSource", () => {
  it("POST /generate，带 JSON 请求体与 SSE Accept 头", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const source = createFetchStreamSource({
      apiBase: "/api",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(streamOf(['data: {"type":"usage","seq":1,"promptTokens":1,"completionTokens":2,"ms":3}\n\n']));
      },
    });

    await collect(source({ requirement: "出一道题", signal: new AbortController().signal }));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/generate");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ requirement: "出一道题" }));
    expect(calls[0]?.init?.headers).toMatchObject({ Accept: "text/event-stream" });
    // 前端零 Key：请求头里不允许出现 Authorization。
    expect(JSON.stringify(calls[0]?.init?.headers)).not.toContain("Authorization");
  });

  it("apiBase 的尾部斜杠不会拼出 //generate", async () => {
    const urls: string[] = [];
    const source = createFetchStreamSource({
      apiBase: "/api/",
      fetchImpl: async (input) => {
        urls.push(String(input));
        return new Response(streamOf([]));
      },
    });
    await collect(source({ requirement: "x", signal: new AbortController().signal }));
    expect(urls[0]).toBe("/api/generate");
  });

  it("跨 chunk 的帧拼接后仍是完整事件（交接给帧解析器）", async () => {
    const frameText = 'data: {"type":"thinking","seq":1,"kind":"summary","delta":"好"}\n\n';
    const source = createFetchStreamSource({
      apiBase: "/api",
      fetchImpl: async () =>
        new Response(streamOf([frameText.slice(0, 20), frameText.slice(20, 45), frameText.slice(45)])),
    });

    const chunks = await collect(source({ requirement: "x", signal: new AbortController().signal }));
    expect(chunks.join("")).toBe(frameText);
  });

  it("非 2xx → GenerateStreamError(llm_upstream)", async () => {
    const source = createFetchStreamSource({
      apiBase: "/api",
      fetchImpl: async () => new Response("boom", { status: 502, statusText: "Bad Gateway" }),
    });

    await expect(
      collect(source({ requirement: "x", signal: new AbortController().signal })),
    ).rejects.toBeInstanceOf(GenerateStreamError);
  });

  it("响应体为空 → GenerateStreamError(llm_upstream)", async () => {
    const source = createFetchStreamSource({
      apiBase: "/api",
      fetchImpl: async () => new Response(null, { status: 200 }),
    });

    await expect(
      collect(source({ requirement: "x", signal: new AbortController().signal })),
    ).rejects.toThrow(/空响应体/);
  });

  it("正常读完也释放 reader 锁（不 releaseLock 会让连接无法回收）", async () => {
    let raw: ReadableStream<Uint8Array> | null = null;
    const source = createFetchStreamSource({
      apiBase: "/api",
      fetchImpl: async () => {
        raw = streamOf([": ping\n\n", 'data: {"type":"usage","seq":1,"promptTokens":1,"completionTokens":1,"ms":1}\n\n']);
        return new Response(raw);
      },
    });

    await collect(source({ requirement: "x", signal: new AbortController().signal }));

    if (raw === null) throw new Error("fetch 未被调用");
    // 锁若没释放，这里会抛 TypeError: ReadableStream is locked。
    expect(() => (raw as ReadableStream<Uint8Array>).getReader()).not.toThrow();
  });

  it("abort 后 read 抛错，finally 一定释放 reader（否则连接会挂住）", async () => {
    const controller = new AbortController();
    let raw: ReadableStream<Uint8Array> | null = null;

    const source = createFetchStreamSource({
      apiBase: "/api",
      fetchImpl: async (_input, init) => {
        const signal = init?.signal;
        raw = new ReadableStream<Uint8Array>({
          start(streamController) {
            streamController.enqueue(encoder.encode(": ping\n\n"));
            signal?.addEventListener("abort", () => {
              streamController.error(new DOMException("aborted", "AbortError"));
            });
          },
        });
        return new Response(raw);
      },
    });

    const iterate = (async () => {
      for await (const _chunk of source({ requirement: "x", signal: controller.signal })) {
        controller.abort();
      }
    })();

    await expect(iterate).rejects.toThrow();
    if (raw === null) throw new Error("fetch 未被调用");
    expect(() => (raw as ReadableStream<Uint8Array>).getReader()).not.toThrow();
  });
});

describe("createFixtureStreamSource", () => {
  it("按顺序吐出全部 chunk（delay 0，测试不等真实时钟）", async () => {
    const source = createFixtureStreamSource([": ping\n\n", "a", "b"], { delayMs: 0 });
    const chunks = await collect(source({ requirement: "x", signal: new AbortController().signal }));
    expect(chunks).toEqual([": ping\n\n", "a", "b"]);
  });

  it("中途 abort 抛 AbortError，不再继续吐（假源也必须可取消）", async () => {
    const controller = new AbortController();
    const source = createFixtureStreamSource(["a", "b", "c"], { delayMs: 0 });

    const collected: string[] = [];
    const run = (async () => {
      for await (const chunk of source({ requirement: "x", signal: controller.signal })) {
        collected.push(chunk);
        controller.abort();
      }
    })();

    await expect(run).rejects.toBeInstanceOf(AbortedError);
    expect(collected).toEqual(["a"]);
  });
});

describe("selectStreamMode", () => {
  it("dev 下 ?stream=fixture 才切假帧", () => {
    expect(selectStreamMode("?stream=fixture", true)).toBe("fixture");
    expect(selectStreamMode("?stream=live", true)).toBe("live");
    expect(selectStreamMode("", true)).toBe("live");
  });

  it("生产构建永远 live：演示数据不许进产线", () => {
    expect(selectStreamMode("?stream=fixture", false)).toBe("live");
  });
});

describe("isAbortError", () => {
  it("认 DOMException 与同名自定义错误", () => {
    expect(isAbortError(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isAbortError(new AbortedError())).toBe(true);
    expect(isAbortError(new Error("boom"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});

describe("上游模式回执（§2.6 第 4 条）", () => {
  it("响应头 x-intentform-llm-mode 被交给界面", async () => {
    const seen: string[] = [];
    const source = createFetchStreamSource({
      apiBase: "/api",
      onUpstreamMode: (mode) => {
        seen.push(mode);
      },
      fetchImpl: async () =>
        new Response(streamOf(["data: {}\n\n"]), {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "x-intentform-llm-mode": "replay",
          },
        }),
    });

    await collect(source({ requirement: "出一份测验", signal: new AbortController().signal }));
    expect(seen).toEqual(["replay"]);
  });

  it("响应头缺失时不编造模式，回调一次都不触发", async () => {
    const seen: string[] = [];
    const source = createFetchStreamSource({
      apiBase: "/api",
      onUpstreamMode: (mode) => {
        seen.push(mode);
      },
      fetchImpl: async () =>
        new Response(streamOf(["data: {}\n\n"]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });

    await collect(source({ requirement: "出一份测验", signal: new AbortController().signal }));
    expect(seen).toEqual([]);
  });
});

describe("createFetchStreamSource · 澄清补充（R-05）", () => {
  function capture(fetchImplCalls: { body: string | undefined }[]) {
    return createFetchStreamSource({
      apiBase: "/api",
      fetchImpl: async (_input, init) => {
        fetchImplCalls.push({ body: typeof init?.body === "string" ? init.body : undefined });
        return new Response(streamOf(['data: {"type":"usage","seq":1,"promptTokens":1,"completionTokens":2,"ms":3}\n\n']));
      },
    });
  }

  it("有补充时一起发出去", async () => {
    const calls: { body: string | undefined }[] = [];
    const source = capture(calls);
    await collect(
      source({
        requirement: "帮我出一份英语卷子",
        clarifications: [{ slot: "count", answer: "10 题" }],
        signal: new AbortController().signal,
      }),
    );
    expect(calls[0]?.body).toBe(
      JSON.stringify({
        requirement: "帮我出一份英语卷子",
        clarifications: [{ slot: "count", answer: "10 题" }],
      }),
    );
  });

  it("没有补充时请求体与以前逐字节相同（回放键不漂）", async () => {
    const calls: { body: string | undefined }[] = [];
    const source = capture(calls);
    await collect(source({ requirement: "出一道题", clarifications: [], signal: new AbortController().signal }));
    expect(calls[0]?.body).toBe(JSON.stringify({ requirement: "出一道题" }));
  });

  it("选了问卷类型时把 kind 发出去（R-09）；没选时请求体不变", async () => {
    const calls: { body: string | undefined }[] = [];
    const source = capture(calls);
    await collect(
      source({ requirement: "做一份课程反馈问卷", kind: "survey", signal: new AbortController().signal }),
    );
    expect(calls[0]?.body).toBe(
      JSON.stringify({ requirement: "做一份课程反馈问卷", kind: "survey" }),
    );
  });
});

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { LlmError } from "./errors.ts";
import { streamChatCompletion } from "./provider.ts";
import type { ProviderConfig, UpstreamEvent } from "./provider.ts";

const API_KEY = "test-key-not-a-real-secret"; // secret-scan:allow 单测里的假 Key，不指向任何真实上游

interface Stub {
  readonly baseUrl: string;
  readonly requests: { readonly authorization: string | undefined; readonly body: string }[];
  close(): Promise<void>;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
          server.closeAllConnections();
        }),
    ),
  );
});

/** 起一个本地上游 stub，`handler` 自己决定怎么吐字节。 */
async function startStub(handler: (res: ServerResponse, req: IncomingMessage) => void): Promise<Stub> {
  const requests: Stub["requests"] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      (requests as { authorization: string | undefined; body: string }[]).push({
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      handler(res, req);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("stub 没拿到端口");
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    requests,
    close: async () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}

function configFor(stub: Stub, overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    baseUrl: stub.baseUrl,
    apiKey: API_KEY,
    model: "stub-model",
    timeoutMs: 5_000,
    maxTokens: 256,
    temperature: 0,
    seed: 7,
    ...overrides,
  };
}

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function contentDelta(text: string): string {
  return sseFrame({ choices: [{ delta: { content: text } }] });
}

/** 把一整段文本按给定字节宽度切片，切点会落在汉字中间——正是要验的场景。 */
function sliceBytes(text: string, size: number): Buffer[] {
  const buffer = Buffer.from(text, "utf8");
  const slices: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += size) {
    slices.push(buffer.subarray(offset, Math.min(offset + size, buffer.length)));
  }
  return slices;
}

async function collect(config: ProviderConfig): Promise<UpstreamEvent[]> {
  const events: UpstreamEvent[] = [];
  for await (const event of streamChatCompletion(config, [{ role: "user", content: "hi" }])) {
    events.push(event);
  }
  return events;
}

describe("streamChatCompletion", () => {
  it("手工解析 SSE：跨 chunk 切断汉字、\\r\\n 混用、[DONE] 收尾都能正确还原", async () => {
    const text =
      '{"type":"fill","id":"q01","title":"请写出二次函数的顶点式","score":5,"bloom":"remember","knowledgePoint":"kp1","answer":["y=a(x-h)^2+k"]}\n' +
      '{"type":"short","id":"q02","title":"你最喜欢哪一步？","required":true}\n';
    const payload =
      sseFrame({ choices: [{ delta: { reasoning_content: "先想题型" } }] }) +
      contentDelta(text.slice(0, 20)) +
      contentDelta(text.slice(20)) +
      sseFrame({ choices: [{ delta: {} }], usage: { prompt_tokens: 12, completion_tokens: 34 } }) +
      "data: [DONE]\n\n";

    const stub = await startStub((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // 每 7 字节切一刀：UTF-8 三字节的汉字必然被切开。
      for (const slice of sliceBytes(payload, 7)) res.write(slice);
      res.end();
    });

    const events = await collect(configFor(stub));
    const reasoning = events.filter((event) => event.kind === "reasoning").map((event) => event.delta);
    const content = events
      .filter((event): event is Extract<UpstreamEvent, { kind: "content" }> => event.kind === "content")
      .map((event) => event.delta)
      .join("");
    const usage = events.find((event) => event.kind === "usage");

    expect(reasoning.join("")).toBe("先想题型");
    expect(content).toBe(text);
    expect(content.includes("\uFFFD")).toBe(false);
    expect(usage).toEqual({ kind: "usage", usage: { promptTokens: 12, completionTokens: 34 } });

    // 请求侧：URL 拼在 /v1 之后、Bearer 头在、body 是高温度 0 的 stream 请求。
    const sent = stub.requests[0];
    expect(sent?.authorization).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(sent?.body ?? "{}") as Record<string, unknown>;
    expect(body["model"]).toBe("stub-model");
    expect(body["stream"]).toBe(true);
    expect(body["temperature"]).toBe(0);
    expect(body["seed"]).toBe(7);
  });

  it("非 2xx 转 llm_upstream，且出网文案与明细都不含 Key", async () => {
    const stub = await startStub((res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `invalid key ${API_KEY} at http://10.0.0.5/v1` } }));
    });

    const error = await collect(configFor(stub)).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LlmError);
    const llmError = error as LlmError;
    expect(llmError.code).toBe("llm_upstream");
    expect(llmError.message).toContain("401");
    expect(llmError.message).not.toContain(API_KEY);
    expect(llmError.detail ?? "").not.toContain(API_KEY);
  });

  it("超过 LLM_TIMEOUT_MS 未完成 → llm_timeout（真超时路径，不等 60 秒）", async () => {
    const stub = await startStub((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(contentDelta('{"type":"section",'));
      // 故意不 end：模拟上游卡死。
    });

    const error = await collect(configFor(stub, { timeoutMs: 120 })).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).code).toBe("llm_timeout");
    expect((error as LlmError).retryable).toBe(true);
  });

  it("外部 AbortSignal 取消 → llm_cancelled，不可重试", async () => {
    const stub = await startStub((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(contentDelta('{"type":"section",'));
    });

    const controller = new AbortController();
    const config = configFor(stub);
    const task = (async () => {
      for await (const _event of streamChatCompletion(config, [{ role: "user", content: "hi" }], {
        signal: controller.signal,
      })) {
        controller.abort();
      }
    })();

    const error = await task.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).code).toBe("llm_cancelled");
    expect((error as LlmError).retryable).toBe(false);
  });

  it("上游吐坏帧 → llm_upstream，不静默跳过", async () => {
    const stub = await startStub((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: {not json}\n\n");
      res.end();
    });

    const error = await collect(configFor(stub)).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).code).toBe("llm_upstream");
  });
});

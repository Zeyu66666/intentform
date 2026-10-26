/**
 * 本地 OpenAI 兼容 stub 上游（只在录制 fixture 时用）。
 *
 * 为什么需要它：本机没有任何 API Key，但 fixture 必须由**真实的 record 代码路径**
 * 录出来，不能手搓。所以这里起一个 `node:http` 服务，讲 `/chat/completions` 的
 * SSE 协议，按固定脚本吐 NDJSON 行；`record` 模式照常 fetch 它、按真实 chunk 落盘。
 *
 * 三条刻意的设计：
 * 1. **按字节切**（不是按字符切）：一串 `Buffer` 以固定 size 切开写出去，所以
 *    UTF-8 多字节字符与 `data:` 帧都会在任意位置被切断——这正是 `LineSplitter` +
 *    `TextDecoder(stream)` 必须扛住的情况。真实网络的切点就是这样。
 * 2. **脚本化内容**：三条预置需求各一份模板（数学考卷 / 英语周测 / 生物问卷），
 *    覆盖 single / fill / short / scale 四种题型，前端联调时能看到真实渲染。
 * 3. **meta 如实**：`describeUpstream()` 对 127.0.0.1 产出 `local-stub:<host:port>`，
 *    评审一眼能看出这不是模型真输出。
 *
 * 它不进生产路径：只有 `testing/` 下的脚本会 import 它。
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { REQUIREMENT_CLOSE, REQUIREMENT_OPEN } from "../prompt.ts";

export type StubTemplateId = "math-quadratic" | "english-vocab" | "bio-survey" | "fallback";

export interface StubTemplate {
  readonly id: StubTemplateId;
  readonly match: readonly string[];
  /** 一行一个 FormItem 的 JSON 文本（`\n` 结尾），顺序即题目顺序。 */
  readonly lines: readonly string[];
}

function line(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

/** 初二数学《二次函数》:4 单选 + 2 填空 + 2 简答 + 1 分节（8 道题，每题 5 分）。 */
const MATH_LINES: readonly string[] = [
  line({
    type: "section",
    id: "sec_intro",
    title: "初二数学《二次函数》入门测验",
    description: "共 8 题，每题 5 分；单选题选出唯一正确项，填空题填最简结果。",
  }),
  line({
    type: "single",
    id: "q_open_dir",
    title: "二次函数 $y=2x^2$ 的图象开口方向是？",
    required: true,
    score: 5,
    bloom: "remember",
    knowledgePoint: "kp1",
    options: [
      { id: "a", text: "向上" },
      { id: "b", text: "向下" },
      { id: "c", text: "向左" },
      { id: "d", text: "向右" },
    ],
    answer: "a",
    explanation: "$a=2>0$，抛物线开口向上。",
  }),
  line({
    type: "single",
    id: "q_vertex_y",
    title: "二次函数 $y=(x-3)^2+1$ 的顶点坐标是？",
    required: true,
    score: 5,
    bloom: "understand",
    knowledgePoint: "kp2",
    options: [
      { id: "a", text: "$(3,1)$" },
      { id: "b", text: "$(-3,1)$" },
      { id: "c", text: "$(3,-1)$" },
      { id: "d", text: "$(1,3)$" },
    ],
    answer: "a",
    explanation: "顶点式 $y=a(x-h)^2+k$ 的顶点为 $(h,k)$。",
  }),
  line({
    type: "single",
    id: "q_axis_form",
    title: "二次函数 $y=x^2-4x+3$ 的对称轴方程是？",
    required: true,
    score: 5,
    bloom: "apply",
    knowledgePoint: "kp3",
    options: [
      { id: "a", text: "$x=2$" },
      { id: "b", text: "$x=-2$" },
      { id: "c", text: "$x=4$" },
      { id: "d", text: "$y=2$" },
    ],
    answer: "a",
    explanation: "对称轴 $x=-\\dfrac{b}{2a}=\\dfrac{4}{2}=2$。",
  }),
  line({
    type: "single",
    id: "q_open_width",
    title: "与 $y=x^2$ 相比，$y=3x^2$ 的图象如何变化？",
    required: true,
    score: 5,
    bloom: "understand",
    knowledgePoint: "kp1",
    options: [
      { id: "a", text: "开口更窄（更陡）" },
      { id: "b", text: "开口更宽（更平）" },
      { id: "c", text: "开口方向相反" },
      { id: "d", text: "形状完全相同" },
    ],
    answer: "a",
    explanation: "$|a|$ 越大，开口越窄。",
  }),
  line({
    type: "fill",
    id: "q_vertex_fill",
    title: "二次函数 $y=x^2+2x+1$ 的顶点横坐标 $x=$ ____。",
    required: true,
    score: 5,
    bloom: "apply",
    knowledgePoint: "kp2",
    answer: ["-1"],
    explanation: "$y=(x+1)^2$，顶点为 $(-1,0)$。",
  }),
  line({
    type: "fill",
    id: "q_axis_fill",
    title: "二次函数 $y=-2x^2+8x-1$ 的对称轴是 $x=$ ____。",
    required: true,
    score: 5,
    bloom: "apply",
    knowledgePoint: "kp3",
    answer: ["2"],
    explanation: "$x=-\\dfrac{b}{2a}=\\dfrac{8}{4}=2$。",
  }),
  line({
    type: "short",
    id: "q_short_steps",
    title: "请写出用配方法求 $y=x^2-6x+5$ 顶点坐标的完整步骤。",
    required: true,
    maxLength: 400,
  }),
  line({
    type: "short",
    id: "q_short_reflect",
    title: "这节课哪一步最容易出错？说说你的理解。",
    required: false,
    maxLength: 200,
  }),
];

/** 高一英语词汇周测：6 单选 + 2 填空 + 2 简答 + 1 分节（10 题）。 */
const ENGLISH_LINES: readonly string[] = [
  line({
    type: "section",
    id: "sec_vocab",
    title: "高一英语 Unit 3 词汇周测",
    description: "共 10 题，满分 50 分；单选题考词义辨析，填空题写词形变化。",
  }),
  line({
    type: "single",
    id: "q_look_up",
    title: "He ____ the word in the dictionary before answering.",
    required: true,
    score: 5,
    bloom: "remember",
    knowledgePoint: "kp1",
    options: [
      { id: "a", text: "looked up" },
      { id: "b", text: "looked after" },
      { id: "c", text: "looked into" },
      { id: "d", text: "looked through" },
    ],
    answer: "a",
    explanation: "look up = 查阅（词典/单词）。",
  }),
  line({
    type: "single",
    id: "q_turn_down",
    title: "She ____ the job offer because the pay was low.",
    required: true,
    score: 5,
    bloom: "understand",
    knowledgePoint: "kp1",
    options: [
      { id: "a", text: "turned down" },
      { id: "b", text: "turned up" },
      { id: "c", text: "turned on" },
      { id: "d", text: "turned off" },
    ],
    answer: "a",
    explanation: "turn down = 拒绝。",
  }),
  line({
    type: "single",
    id: "q_get_over",
    title: "It took him a month to ____ the illness.",
    required: true,
    score: 5,
    bloom: "understand",
    knowledgePoint: "kp2",
    options: [
      { id: "a", text: "get over" },
      { id: "b", text: "get in" },
      { id: "c", text: "get off" },
      { id: "d", text: "get on" },
    ],
    answer: "a",
    explanation: "get over = 从（疾病/打击）中恢复。",
  }),
  line({
    type: "single",
    id: "q_put_off",
    title: "They decided to ____ the meeting until next Monday.",
    required: true,
    score: 5,
    bloom: "apply",
    knowledgePoint: "kp1",
    options: [
      { id: "a", text: "put off" },
      { id: "b", text: "put out" },
      { id: "c", text: "put up" },
      { id: "d", text: "put away" },
    ],
    answer: "a",
    explanation: "put off = 推迟。",
  }),
  line({
    type: "single",
    id: "q_come_up_with",
    title: "Who ____ this idea in the first place?",
    required: true,
    score: 5,
    bloom: "apply",
    knowledgePoint: "kp3",
    options: [
      { id: "a", text: "came up with" },
      { id: "b", text: "came across" },
      { id: "c", text: "came about" },
      { id: "d", text: "came out" },
    ],
    answer: "a",
    explanation: "come up with = 提出（想法）。",
  }),
  line({
    type: "single",
    id: "q_run_out_of",
    title: "We have ____ milk; buy some on your way home.",
    required: true,
    score: 5,
    bloom: "apply",
    knowledgePoint: "kp2",
    options: [
      { id: "a", text: "run out of" },
      { id: "b", text: "run into" },
      { id: "c", text: "run over" },
      { id: "d", text: "run after" },
    ],
    answer: "a",
    explanation: "run out of = 用完。",
  }),
  line({
    type: "fill",
    id: "q_form_decide",
    title: "用 decide 的正确形式填空：It was a difficult ____ to make.",
    required: true,
    score: 5,
    bloom: "apply",
    knowledgePoint: "kp2",
    answer: ["decision"],
    explanation: "decide → decision（名词）。",
  }),
  line({
    type: "fill",
    id: "q_form_achieve",
    title: "用 achieve 的正确形式填空：Her ____ in the exam surprised us.",
    required: true,
    score: 5,
    bloom: "apply",
    knowledgePoint: "kp3",
    answer: ["achievement"],
    explanation: "achieve → achievement。",
  }),
  line({
    type: "short",
    id: "q_short_sentence",
    title: "用 turn down 造一个描述日常生活的句子。",
    required: true,
    maxLength: 200,
  }),
  line({
    type: "short",
    id: "q_short_story",
    title: "用至少三个 Unit 3 的动词短语，写两句连贯的话。",
    required: true,
    maxLength: 300,
  }),
];

/**
 * 高二生物学情调查（**问卷**：contract 禁止 `answer`/`score`，所以只能用
 * section / short / scale；需求里的「单选」在问卷形态下落地为 short，
 * 题干里列出选项让学生填字母）。
 */
const BIO_LINES: readonly string[] = [
  line({
    type: "section",
    id: "sec_survey",
    title: "高二生物 · 课前学情调查",
    description: "本问卷不判分、不计成绩，只为调整上课节奏；请按真实情况填写。",
  }),
  line({
    type: "short",
    id: "s_preview",
    title: "课前你预习了教材吗？（选 A/B/C 填在后面）A 完整预习 B 浏览过 C 没有",
    required: true,
    maxLength: 20,
  }),
  line({
    type: "short",
    id: "s_notes",
    title: "你会自己做课堂笔记吗？（A 每节都做 B 偶尔做 C 不做）",
    required: true,
    maxLength: 20,
  }),
  line({
    type: "short",
    id: "s_exercise",
    title: "上次课后练习你独立完成的比例大概是？（A 80% 以上 B 一半左右 C 少于一成）",
    required: true,
    maxLength: 20,
  }),
  line({
    type: "scale",
    id: "s_confidence",
    title: "你对学好本章（遗传与变异）的信心有多大？",
    required: true,
    min: 1,
    max: 5,
    labels: ["完全没底", "很有把握"],
  }),
  line({
    type: "scale",
    id: "s_lab_confidence",
    title: "你对独立完成显微观察类实验的信心有多大？",
    required: true,
    min: 1,
    max: 5,
    labels: ["完全没底", "很有把握"],
  }),
  line({
    type: "short",
    id: "s_confusion",
    title: "本章你最困惑的具体概念是什么？请写一个（例如：自由组合定律）",
    required: true,
    maxLength: 120,
  }),
  line({
    type: "short",
    id: "s_confusion_why",
    title: "上一题的概念为什么让你觉得难？",
    required: false,
    maxLength: 200,
  }),
  line({
    type: "short",
    id: "s_wish_experiment",
    title: "如果只能做一个实验，你最想搞懂哪个实验？为什么？",
    required: true,
    maxLength: 300,
  }),
];

/** stub 的固定脚本集。`match` 是命中的关键词（顺序即优先级）。 */
export const STUB_TEMPLATES: readonly StubTemplate[] = [
  { id: "math-quadratic", match: ["二次函数"], lines: MATH_LINES },
  { id: "english-vocab", match: ["英语", "词汇"], lines: ENGLISH_LINES },
  { id: "bio-survey", match: ["生物", "问卷"], lines: BIO_LINES },
];

/** 没命中模板时的兜底：仍然是一份合法 NDJSON（前端能渲染，但明显不是预置内容）。 */
const FALLBACK_LINES: readonly string[] = [
  line({ type: "section", id: "sec_fallback", title: "未匹配到脚本的表单", description: "stub 兜底输出" }),
  line({
    type: "single",
    id: "q_fallback",
    title: "stub 兜底单选题：请选择一项",
    required: true,
    score: 5,
    bloom: "remember",
    knowledgePoint: "kp1",
    options: [
      { id: "a", text: "选项 A" },
      { id: "b", text: "选项 B" },
    ],
    answer: "a",
  }),
];

export function selectTemplate(requirement: string): StubTemplate {
  for (const template of STUB_TEMPLATES) {
    if (template.match.every((keyword) => requirement.includes(keyword))) {
      return template;
    }
  }
  return { id: "fallback", match: [], lines: FALLBACK_LINES };
}

/** 从 chat 请求体的最后一个 user message 里抠出需求原文（定界块之间）。 */
export function extractRequirement(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const messages = (body as { readonly messages?: unknown }).messages;
  if (!Array.isArray(messages)) return "";
  const texts: string[] = [];
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const record = message as { readonly role?: unknown; readonly content?: unknown };
    if (record.role !== "user" || typeof record.content !== "string") continue;
    texts.push(record.content);
  }
  const last = texts.at(-1) ?? "";
  const start = last.indexOf(REQUIREMENT_OPEN);
  const end = last.indexOf(REQUIREMENT_CLOSE);
  if (start !== -1 && end > start) {
    return last.slice(start + REQUIREMENT_OPEN.length, end).trim();
  }
  return last.trim();
}

/**
 * 把一行内容切成 2–3 段 delta。切点取行内不同位置，所以同一个 NDJSON 行会跨
 * 多个 SSE 帧到达——`LineSplitter` 必须自己拼回去。
 */
export function sliceLineIntoSegments(text: string): readonly string[] {
  if (text.length <= 8) return [text];
  const firstCut = Math.max(4, Math.floor(text.length / 3));
  const secondCut = Math.max(firstCut + 1, Math.floor((text.length * 2) / 3));
  if (secondCut >= text.length) return [text.slice(0, firstCut), text.slice(firstCut)];
  return [text.slice(0, firstCut), text.slice(firstCut, secondCut), text.slice(secondCut)];
}

/** 把一条脚本编成「上游会发的一串 SSE 帧文本」。 */
export function buildSseFrames(lines: readonly string[], usage: { prompt: number; completion: number }): readonly string[] {
  const frames: string[] = [];
  for (const text of lines) {
    for (const segment of sliceLineIntoSegments(text)) {
      frames.push(`data: ${JSON.stringify({ choices: [{ delta: { content: segment }, index: 0 }] })}\n\n`);
    }
  }
  frames.push(
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.prompt + usage.completion } })}\n\n`,
  );
  frames.push("data: [DONE]\n\n");
  return frames;
}

export interface StubUpstreamOptions {
  /** 每次 `res.write` 的字节数，默认 37——足以在多字节字符中间切断。 */
  readonly chunkBytes?: number;
  /** 帧间延迟（毫秒），默认 4；测试传 0。 */
  readonly frameDelayMs?: number;
  /** 已收到的请求路径，便于断言。 */
  readonly onRequest?: (path: string, requirement: string) => void;
  readonly host?: string;
  /** 固定端口（默认 0 = 随机）。只有手工联调 stub 时才需要。 */
  readonly port?: number;
}

export interface StubUpstream {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly requests: readonly string[];
  close(): Promise<void>;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function writeHeadSse(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 起一个 stub 上游。`chunkBytes` 故意很小：真实网络不会体贴地按字符边界切包，
 * 录制时就要让「半个汉字 + 半截 data: 行」这种情况真的发生一次。
 */
export async function startStubUpstream(options: StubUpstreamOptions = {}): Promise<StubUpstream> {
  const chunkBytes = options.chunkBytes ?? 37;
  const frameDelayMs = options.frameDelayMs ?? 4;
  const host = options.host ?? "127.0.0.1";
  const requests: string[] = [];

  const server: Server = createServer((req, res) => {
    void (async (): Promise<void> => {
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      requests.push(path);

      if (req.method !== "POST" || !path.endsWith("/chat/completions")) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: { message: "stub: unsupported path" } }));
        return;
      }

      const body = await readJsonBody(req);
      const requirement = extractRequirement(body);
      options.onRequest?.(path, requirement);

      const template = selectTemplate(requirement);
      const lines = template.lines.slice();
      const payload = lines.join("");
      const frames = buildSseFrames(lines, {
        prompt: Math.ceil(requirement.length / 2),
        completion: Math.ceil(payload.length / 2),
      });

      writeHeadSse(res);
      for (const frame of frames) {
        const bytes = Buffer.from(frame, "utf8");
        for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
          if (res.destroyed) return;
          res.write(bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.byteLength)));
          if (frameDelayMs > 0) await delay(frameDelayMs);
        }
      }
      res.end();
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      if (!res.writableEnded) res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    throw new Error("stub: 无法获取监听端口");
  }
  const info: AddressInfo = address;

  return {
    url: `http://${host}:${String(info.port)}/v1`,
    host,
    port: info.port,
    requests,
    close: async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

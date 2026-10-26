/**
 * ⚠️ 测试数据 / 开发期假帧 —— **不是真实生成结果**。
 *
 * 用途：I2 的 `/api/generate` 还没落地时，让三栏页、reducer、时间线、FieldRegistry
 * 能被点开、被肉眼检查、被单测覆盖。任何界面在用它时必须标「演示数据」。
 *
 * 形状：**原始 SSE 帧文本**的数组（不是事件对象）。刻意做了两件事：
 * 1. 用 `toSseFrame()` 从 `SseEvent` 生成帧，所以每一帧都过 `sseEventSchema` 校验，
 *    假数据不会因为手抖写错字段而"通过"；`seq` 由 `createSseSequencer()` 单一发放，
 *    与真实服务端一致（从 1 开始、步长 1）。
 * 2. 把整段文本**按 96 字符切片**成 chunk，让帧边界跨 chunk —— 这正是流式解析
 *    最容易写错的地方（`frames.ts` 的缓冲区逻辑如果坏了，这份 fixture 立刻炸）。
 *
 * 覆盖：7 类事件（phase / thinking / field / field_error / repair / usage / done）
 * 与 7 种题型（section / single / multi / number / fill / short / scale）全覆盖；
 * 另外混入 2 个心跳注释帧（`:` 开头，不是事件）。
 *
 * 题型配额与三个预置需求的文本**不对应**是故意的：这份假帧的目的是把渲染注册表
 * 的 7 个分支全部点亮，而不是复刻某条真实回放（真实回放在 `fixtures/replays/`）。
 */

import {
  createSseSequencer,
  formItemSchema,
  type FormItem,
  type SseEventBody,
  toSseFrame,
} from "@intentform/schema";

const BASE_TS = 1_734_000_000_000;

/**
 * `field.node` 的线上类型是 `formItemSchema` 的推断结果（可变），比 `FormItem`
 * （`DeepReadonly`）更宽。这里统一过一遍 `parse`：既拿到准确类型，又让任何不合法的
 * 假数据在加载时就炸掉——假数据本身也必须合法，否则测试是在给假数据背书。
 */
type WireFormItem = ReturnType<typeof formItemSchema.parse>;

function node(raw: unknown): WireFormItem {
  return formItemSchema.parse(raw);
}

type FixtureKey = "section" | "single" | "multi" | "number" | "fill" | "short" | "scale";

const items: Record<FixtureKey, WireFormItem> = {
  section: {
    type: "section",
    id: "sec-basic",
    title: "一、基础概念",
    description: "覆盖开口方向与顶点坐标，题目来自课本 1.2 节。",
  },
  single: {
    type: "single",
    id: "q-opening",
    title: "抛物线 $y=2(x-1)^2+3$ 的开口方向是？",
    required: true,
    score: 5,
    bloom: "understand",
    knowledgePoint: "kp-opening",
    explanation: "二次项系数 $a=2>0$，所以开口向上。顶点为 $(1,3)$。",
    options: [
      { id: "a", text: "向上" },
      { id: "b", text: "向下" },
      { id: "c", text: "向左" },
      { id: "d", text: "无法确定" },
    ],
    answer: "a",
  },
  multi: {
    type: "multi",
    id: "q-vertex",
    title: "下列哪些点在该抛物线上？（多选）",
    required: true,
    score: 5,
    bloom: "apply",
    knowledgePoint: "kp-vertex",
    explanation: "依次代入横坐标求纵坐标即可。",
    options: [
      { id: "a", text: "$(1,3)$" },
      { id: "b", text: "$(0,5)$" },
      { id: "c", text: "$(2,5)$" },
      { id: "d", text: "$(3,11)$" },
    ],
    answer: ["a", "b", "c"],
  },
  number: {
    type: "number",
    id: "q-axis",
    title: "对称轴方程是 $x=$？",
    required: true,
    score: 5,
    bloom: "apply",
    knowledgePoint: "kp-axis",
    explanation: "顶点式 $y=a(x-h)^2+k$ 的对称轴为 $x=h$。",
    answer: { value: 1, tolerance: 0 },
  },
  fill: {
    type: "fill",
    id: "q-vertex-form",
    title: "把 $y=x^2-4x+1$ 写成顶点式：$y=(x-\\_\\_)^2+\\_\\_$",
    required: true,
    score: 5,
    bloom: "apply",
    knowledgePoint: "kp-vertex",
    explanation: "配方：$x^2-4x+1=(x-2)^2-3$。",
    answer: ["2", "-3"],
  },
  short: {
    type: "short",
    id: "q-explain",
    title: "用一句话说明为什么二次函数的图象是抛物线。",
    required: false,
    maxLength: 200,
  },
  scale: {
    type: "scale",
    id: "q-confidence",
    title: "你对本节内容的掌握程度",
    required: true,
    min: 1,
    max: 5,
    labels: ["完全没底", "很有信心"],
  },
};

/**
 * 七个节点按题型顺序导出，供渲染层测试直接复用（不要在别处手搓第二套样例：
 * 两套样例一旦漂移，测试就会替假数据背书而不是替真实契约背书）。
 */
export const FIXTURE_ITEMS: readonly FormItem[] = [
  items.section,
  items.single,
  items.multi,
  items.number,
  items.fill,
  items.short,
  items.scale,
].map((item) => node(item));

const bodies: readonly (SseEventBody | "heartbeat")[] = [
  { type: "phase", phase: "understand", ts: BASE_TS },
  {
    type: "thinking",
    kind: "summary",
    delta: "已理解需求：初二数学《二次函数》入门测验，8 道题，每题 5 分。",
  },
  "heartbeat",
  { type: "phase", phase: "plan", ts: BASE_TS + 780 },
  { type: "thinking", kind: "reasoning", delta: "需求里点明了三个知识点：开口方向、顶点坐标、对称轴。" },
  { type: "thinking", kind: "reasoning", delta: "先按「概念 → 计算 → 表达」排布，再分配单选 4 道、填空 2 道、简答 2 道。" },
  { type: "phase", phase: "generate", ts: BASE_TS + 1_620 },
  { type: "field", index: 0, node: items.section, tMs: 1_690 },
  { type: "field", index: 1, node: items.single, tMs: 1_740 },
  { type: "field", index: 2, node: items.multi, tMs: 1_820 },
  "heartbeat",
  {
    type: "field_error",
    index: 3,
    id: "q-axis",
    codes: ["E_ANSWER_MISSING"],
    raw: '{"type":"number","id":"q-axis","title":"对称轴方程是 x=？"，"answer":null}',
  },
  {
    type: "repair",
    id: "q-axis",
    round: 1,
    codesBefore: ["E_ANSWER_MISSING"],
    codesAfter: [],
    status: "fixed",
  },
  { type: "field", index: 3, node: items.number, tMs: 2_380 },
  { type: "field", index: 4, node: items.fill, tMs: 2_460 },
  { type: "field", index: 5, node: items.short, tMs: 2_540 },
  { type: "field", index: 6, node: items.scale, tMs: 2_620 },
  { type: "usage", promptTokens: 812, completionTokens: 466, ms: 940 },
  { type: "phase", phase: "validate", ts: BASE_TS + 3_560 },
  { type: "thinking", kind: "summary", delta: "8 个节点全部通过 R1–R8 校验，1 处错误已由修复环解决。" },
  { type: "phase", phase: "done", ts: BASE_TS + 4_120 },
  {
    type: "done",
    versionId: "v-fixture-preview",
    stats: { fields: 7, errors: 1, repairs: 1, ms: 4_200 },
  },
];

/** 把事件体串成帧文本；心跳原样插入注释帧。 */
function framesFromBodies(): readonly string[] {
  const sequencer = createSseSequencer();
  const frames: string[] = [];
  for (const body of bodies) {
    if (body === "heartbeat") {
      frames.push(": ping\n\n");
      continue;
    }
    frames.push(toSseFrame(sequencer.next(body)));
  }
  return frames;
}

/** 完整帧（含空行分隔）。单测按帧断言 7 类事件覆盖。 */
export const FIXTURE_FRAMES: readonly string[] = framesFromBodies();

const CHUNK_SIZE = 96;

/** 按固定宽度切片，确保大量帧跨 chunk 边界（缓冲区逻辑的直接考验）。 */
function slice(text: string, size: number): readonly string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += size) {
    chunks.push(text.slice(offset, offset + size));
  }
  return chunks;
}

/** 开发期真正喂给解析器的 chunk 序列。 */
export const FIXTURE_CHUNKS: readonly string[] = slice(FIXTURE_FRAMES.join(""), CHUNK_SIZE);

/**
 * 乱序/跳号样本：把 seq 3 的事件挪到 seq 4 之后发。
 * 用来在界面上验证「跳号会先缓存、缺口补齐后归位，并在时间线上留下异常条目」。
 */
export function disorderedFrames(): readonly string[] {
  const sequencer = createSseSequencer();
  const phase: SseEventBody = { type: "phase", phase: "generate", ts: BASE_TS };
  const first = toSseFrame(sequencer.next(phase));
  // 先发 seq 1，再发 seq 3（跳过 2），最后补 seq 2：缺口的形状要真实存在。
  const second = toSseFrame(
    sequencer.next({ type: "thinking", kind: "summary", delta: "乱序样本" }),
  );
  const third = toSseFrame(sequencer.next({ type: "field", index: 0, node: items.section, tMs: 10 }));
  return [first, third, second];
}

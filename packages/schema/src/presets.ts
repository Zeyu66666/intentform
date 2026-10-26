/**
 * 生成页的 3 个「预置需求」按钮。
 *
 * 为什么放在 `schema` 而不是 `web` 或 `fixtures`：
 * - `fixtures/replays/<hash>.ndjson` 的 hash 把**需求文本原样入 hash**（见 `fixtures/replays/README.md`）；
 * - 按钮点下去发给 `/api/generate` 的也必须是同一段文本。
 * 两边各存一份副本，改一个错别字就换一个 hash，回放当场未命中——所以只能有一个源。
 * 这里是纯数据 + 纯函数，符合 `AGENTS.md` 模块边界表对 schema 的定位，web 可以合法依赖。
 *
 * 改这段文本 = 让 3 条 fixture 全部失效，必须重录。改之前先看 README 第 5 节。
 */

import { LIMITS } from "./constants";

/** 预置需求的 id，只用于 DOM key 与日志，不参与回放 hash。 */
export type GeneratePresetId = "math-quadratic" | "english-vocab" | "bio-survey";

export interface GeneratePreset {
  readonly id: GeneratePresetId;
  /** 按钮上的短标签，不超过 12 字，避免三栏页左栏被撑开。 */
  readonly label: string;
  /** 真正发给 `/api/generate` 的需求原文；入回放 hash 的就是这一串。 */
  readonly requirement: string;
}

export const GENERATE_PRESETS: readonly GeneratePreset[] = Object.freeze([
  {
    id: "math-quadratic",
    label: "初二数学·二次函数",
    requirement:
      "出一份初二数学《二次函数》的入门测验，8 道题：4 道单选、2 道填空、2 道简答，覆盖开口方向、顶点坐标、对称轴三个知识点，难度偏基础，每题 5 分。",
  },
  {
    id: "english-vocab",
    label: "高一英语·词汇周测",
    requirement:
      "生成一份高一英语词汇周测，10 道题：6 道单选考词义辨析、2 道填空考词形变化、2 道简答考用词造句，知识点是 Unit 3 的动词短语，满分 50 分。",
  },
  {
    id: "bio-survey",
    label: "高二生物·学情调查",
    requirement:
      "做一个高二生物的课前学情调查问卷，8 道题：3 道单选了解预习情况、2 道量表题了解学习信心、2 道填空题收集具体困惑、1 道简答题让学生写出最想搞懂的实验。这是问卷，不要标准答案，也不要分值。",
  },
] satisfies GeneratePreset[]);

/** 按 id 取预置需求，取不到返回 `undefined`（调用方自己决定怎么报错）。 */
export function findPreset(id: string): GeneratePreset | undefined {
  return GENERATE_PRESETS.find((preset) => preset.id === id);
}

/** 预置需求是否都在 `LIMITS.requirementMaxChars` 之内——护栏，不是业务逻辑。 */
export function presetsWithinLimit(): boolean {
  return GENERATE_PRESETS.every(
    (preset) => preset.requirement.length > 0 && preset.requirement.length <= LIMITS.requirementMaxChars,
  );
}

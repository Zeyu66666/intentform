/**
 * 回放键：把一次生成请求折叠成一个 64 位小写十六进制串，也就是 fixture 文件名。
 *
 * 契约在 `fixtures/replays/README.md` 第 2 节，这里逐字实现，**顺序不能换**：
 *
 * ```
 * key    = normalize(requirement) + "\u0000" + model + "\u0000" + promptVersion + "\u0000" + "v" + schemaVersion
 * <hash> = sha256(key) 的完整 64 位小写十六进制
 * ```
 *
 * 三个坑：
 * - 规范化在前、入 hash 在后。教师多打一个空格就换键的话，回放必然未命中。
 * - 分隔符用 `\u0000` 而不是 `:`/`|`。需求正文里可以出现任何标点，
 *   只有 NUL 不会出现在合法输入里，所以它才是无歧义的分隔符。
 * - 不截断 hash。截断到 16 位看着好看，一旦撞前缀就会静默播放**错误的流**，
 *   这比未命中更糟：未命中会报错，撞前缀会悄悄给出别人的表单。
 */

import { createHash } from "node:crypto";

import type { SchemaVersion } from "@intentform/schema";

/** 回放键的分隔符（NUL）。导出是为了测试能断言拼接口径，不是给业务用的。 */
export const REPLAY_KEY_SEPARATOR = "\u0000";

/** `requirementPreview` 的长度上限（README 第 4 节：规范化后需求的前 80 个字符）。 */
export const REQUIREMENT_PREVIEW_MAX = 80;

/** 合法 hash：完整 64 位小写十六进制，不接受截断或大写。 */
export const REPLAY_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * 回放键的输入（计划 §3.7）。字段名与 `index.ts` 的历史接口一致，别改名——
 * 改名字等于改契约，`web` 与 `scripts/eval` 会跟着碎。
 */
export interface ReplayKeyInput {
  /** 用户原始需求。**进来的是原文**，规范化在本函数内做。 */
  readonly requirement: string;
  /** 真正发给上游的模型名（`deepseek-chat` 这种），不是别名。 */
  readonly model: string;
  /** prompt 文件名里的版本号（`generate.v1`），不是 commit hash。 */
  readonly promptVersion: string;
  readonly schemaVersion: SchemaVersion;
}

/**
 * 需求规范化（README 第 2 节，五步，顺序有讲究）：
 *
 * 1. `NFC`：把 `e` + 组合重音合成单码位，否则同一个字两种拼法两个 hash；
 * 2. 换行统一为 `\n`：`\r\n`/`\r` 都是「换行」，不是「回车字符」；
 * 3. 行内连续空格/制表符/全角空格折叠为一个半角空格：全角空格是中文输入法
 *    的高频产物，不折叠就会出现「看起来一模一样的两段需求、两个 hash」；
 * 4. 每行去首尾空白；
 * 5. 连续 **3 行以上**空行折叠为 **1** 个空行（2 行原样保留，README 的措辞是
 *    「3 行以上」，不要顺手把 2 行也折了）；
 * 6. 整体去首尾空白。
 */
export function normalizeRequirement(raw: string): string {
  const nfc = raw.normalize("NFC");
  const unified = nfc.replace(/\r\n?/g, "\n");
  const lines = unified.split("\n").map((line) => line.replace(/[ \t\u3000]+/g, " ").trim());

  const collapsed: string[] = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line === "") {
      blankRun += 1;
      continue;
    }
    if (blankRun > 0) {
      const keep = blankRun >= 3 ? 1 : blankRun;
      for (let index = 0; index < keep; index += 1) collapsed.push("");
      blankRun = 0;
    }
    collapsed.push(line);
  }
  return collapsed.join("\n").trim();
}

/** 规范化后需求的前 80 个字符，写进 `meta.requirementPreview`（评审少读一次全文）。 */
export function requirementPreview(normalizedRequirement: string): string {
  return normalizedRequirement.slice(0, REQUIREMENT_PREVIEW_MAX);
}

/** 拼出参与 sha256 的原文。导出是为了让「键怎么拼」在测试与文档里有同一处证据。 */
export function replayKeyMaterial(input: ReplayKeyInput): string {
  const normalized = normalizeRequirement(input.requirement);
  return [
    normalized,
    input.model,
    input.promptVersion,
    `v${input.schemaVersion}`,
  ].join(REPLAY_KEY_SEPARATOR);
}

/** 完整 64 位小写十六进制。Node 的 `digest("hex")` 天然是小写。 */
export function replayKey(input: ReplayKeyInput): string {
  return createHash("sha256").update(replayKeyMaterial(input), "utf8").digest("hex");
}

export function isReplayHash(value: string): boolean {
  return REPLAY_HASH_PATTERN.test(value);
}

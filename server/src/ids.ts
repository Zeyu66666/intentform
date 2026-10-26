/**
 * 主键与短链的生成。
 *
 * 不用 nanoid：AGENTS.md §1.2 要求新增依赖先说理由，而这里的需求只是
 * 「够随机的定长串」，`node:crypto` 一行就够，不值得为它多一个包。
 *
 * 前缀（`f_` / `v_` / `s_` / `t_`）让日志和 CSV 里一眼能看出这是什么 id，
 * 也让「拿 versionId 当 formId 传」这种错当场暴露出形状不对。
 */

import { randomBytes } from "node:crypto";

export function newId(prefix: "t" | "f" | "v" | "s"): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/**
 * 短链字母表：去掉 `0/o/1/l/i` 这类手抄、口述容易混的字符。
 * 长度 10 → 约 32^10 ≈ 1.1e15 种，配合 UNIQUE 冲突重试，穷举不现实。
 */
const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const SLUG_LENGTH = 10;

export function newSlug(): string {
  const bytes = randomBytes(SLUG_LENGTH);
  let slug = "";
  for (const byte of bytes) {
    // byte/256 * 32 的取模偏差对 32 的整数倍是无偏的（256 恰是 32 的 8 倍）。
    const index = byte % SLUG_ALPHABET.length;
    slug += SLUG_ALPHABET[index] ?? "";
  }
  // 防御：万一 SLUG_ALPHABET 被改成非 2 的幂长度，不能返回短串。
  return slug.length === SLUG_LENGTH ? slug : newSlug();
}

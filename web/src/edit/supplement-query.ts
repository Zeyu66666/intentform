/**
 * 覆盖矩阵补题的查询串解析（纯函数，不碰 window）。
 *
 * 地址形状：`/forms/:id/edit?add=1&kp=<知识点 id>&bloom=<层级>`。
 * 任何一项不合法都返回 `null`，编辑页就当普通编辑打开——不猜测、不部分应用。
 */

import { BLOOM_LEVELS, LIMITS, type BloomLevel } from "@intentform/schema";

export interface AddPrefill {
  readonly knowledgePoint: string;
  readonly bloom: BloomLevel;
}

export function parseAddQuery(search: string): AddPrefill | null {
  const params = new URLSearchParams(search);
  if (params.get("add") !== "1") return null;
  const knowledgePoint = params.get("kp");
  const bloom = params.get("bloom");
  if (knowledgePoint === null || bloom === null) return null;
  if (!LIMITS.shortIdPattern.test(knowledgePoint)) return null;
  if (!(BLOOM_LEVELS as readonly string[]).includes(bloom)) return null;
  return { knowledgePoint, bloom: bloom as BloomLevel };
}

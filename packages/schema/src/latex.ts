/**
 * R7：用 KaTeX 判断公式能否解析（计划 v1.1 附录 A.2）。
 *
 * 只关心「能不能渲染」，不关系渲染结果好不好看——好看是前端的事。
 * 安全约束：`trust: false` 禁掉 `\href`、`\includegraphics` 一类可注入命令；
 * `strict: "ignore"` 让 KaTeX 不必为 Unicode 等细节往控制台打警告，
 * 判断标准始终只有一条：抛不抛 ParseError。
 */

import katex from "katex";

/**
 * 公式片段。`(?<!\\)` 是为了放过转义的美元符（`\$` 是正文里的钱，不是公式起点），
 * 行内公式额外禁掉换行与 `$`，避免把两个相邻的人民币金额吞成一个公式。
 */
const FORMULA_PATTERN = /(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$|(?<!\\)\$([^$\n]+?)(?<!\\)\$/g;

export interface FormulaSegment {
  /** 公式体（不含定界符）。 */
  readonly body: string;
  /** 是否为块级公式 `$$...$$`。 */
  readonly display: boolean;
  /** 在原文中的起始下标，便于把错误定位回具体字段。 */
  readonly offset: number;
}

/** 提取一段文本里的全部公式。文本中没有公式时返回空数组。 */
export function findFormulas(text: string): readonly FormulaSegment[] {
  const segments: FormulaSegment[] = [];
  for (const match of text.matchAll(FORMULA_PATTERN)) {
    const displayBody = match[1];
    const inlineBody = match[2];
    segments.push({
      body: displayBody ?? inlineBody ?? "",
      display: displayBody !== undefined,
      offset: match.index ?? 0,
    });
  }
  return segments;
}

/**
 * 校验一段文本里的公式。返回 `null` 表示全部可解析，否则返回首个失败原因。
 * 原因截断到 120 字符：它会被拼进 repair 文本再喂给模型，太长只会挤占有效上下文。
 */

/**
 * 填空横线在公式里的归一化。
 *
 * 模型常把整段算式包进 `$...$`，把空位写成 `___`（例如 `$72-___=45+18$`）。
 * 在 LaTeX 里 `_` 是下标，`___` 必然解析失败——但教师/学生看到的只是「空位」，
 * 不该因此把整道题判成坏公式。两个及以上连续下划线一律当成一个空白横线，
 * 渲染与校验共用这一份归一化，避免「校验过了、显示还是坏」。
 *
 * 单个 `_` 不动：它可能是合法的下标（如 `a_1`）。
 */
export function normalizeMathBlanks(tex: string): string {
  return tex.replace(/_{2,}/gu, (run) => {
    const width = Math.min(6, Math.max(1, run.length * 0.5));
    return `\\underline{\\hspace{${width.toFixed(1)}em}}`;
  });
}

export function checkLatex(text: string): string | null {
  for (const formula of findFormulas(text)) {
    try {
      katex.renderToString(normalizeMathBlanks(formula.body), {
        displayMode: formula.display,
        throwOnError: true,
        strict: "ignore",
        trust: false,
        output: "html",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const kind = formula.display ? "块级公式" : "行内公式";
      return `${kind}「${formula.body}」无法被 KaTeX 解析：${message.slice(0, 120)}`;
    }
  }
  return null;
}

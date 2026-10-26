/**
 * `$...$` 数学片段的切分与 KaTeX 渲染（纯函数，可单测）。
 *
 * 全项目禁止 `dangerouslySetInnerHTML`，唯一例外是 KaTeX 输出（`AGENTS.md` §5），
 * 且必须 `trust: false`。这条例外的落点被刻意收窄到**一个**地方：
 * `render/Latex.tsx` 里的 `<span dangerouslySetInnerHTML>`。本文件只产出 HTML 字符串，
 * 不做注入，因此可以脱离 React 单测。
 *
 * 失败降级：`throwOnError: false` 时 KaTeX 不会抛错，而是把错误写进
 * `<span class="katex-error" title="...">`。所以这里既 try/catch，也检查输出里是否
 * 带 `katex-error`——两种失败都要降级成**纯文本**，而不是把红色错误标记渲染给老师
 * （更不能白屏：学生端的题干里有公式时，一个坏公式不该毁掉整道题）。
 */

import katex from "katex";

export type MathSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "math"; readonly tex: string };

/**
 * 把一段文本按 `$...$` 切成文本/公式片段。
 *
 * 规则（故意保守）：
 * - 不配对、空内容（`$$`）、跨行的 `$...$` 一律当普通文本，不做猜测；
 * - 支持 `\$` 转义成字面美元符；
 * - 不做递归嵌套解析：嵌套属于 Markdown 层的事，这里只管行内公式。
 */
export function splitMath(input: string): readonly MathSegment[] {
  const segments: MathSegment[] = [];
  let buffer = "";
  let index = 0;

  while (index < input.length) {
    const char = input[index];

    if (char === "\\" && input[index + 1] === "$") {
      buffer += "$";
      index += 2;
      continue;
    }

    if (char === "$") {
      const close = input.indexOf("$", index + 1);
      const tex = close === -1 ? "" : input.slice(index + 1, close);
      const balanced = close !== -1 && tex.trim() !== "" && !tex.includes("\n");
      if (balanced) {
        if (buffer !== "") {
          segments.push({ kind: "text", text: buffer });
          buffer = "";
        }
        segments.push({ kind: "math", tex: tex.trim() });
        index = close + 1;
        continue;
      }
      // 落单的 `$`：原样留在文本里，避免把正常文本吃进公式。
      buffer += char;
      index += 1;
      continue;
    }

    buffer += char;
    index += 1;
  }

  if (buffer !== "") segments.push({ kind: "text", text: buffer });
  return segments;
}

export interface KatexRenderOptions {
  /** 渲染为块级公式（`$$...$$` 场景），默认行内。 */
  readonly displayMode?: boolean;
}

/**
 * `throwOnError: false` 的失败形态是**红色错误标记**而不是异常，且不同 `output`
 * 模式下标记不同：`html` 模式给出 `color:#cc0000` 的 mord 片段，`htmlAndMathml`/文本
 * 模式给出 `class="katex-error"`。两种都要抓，否则坏公式会被当成"渲染成功"，
 * 老师看到的是一行红色乱码而不是可读的纯文本。
 */
const ERROR_MARKERS = ["katex-error", "color:#cc0000"] as const;

/**
 * 渲染公式为 HTML 字符串；失败返回 `null`（调用方降级成纯文本）。
 *
 * `trust: false` 是硬要求：不允许 `\href`、`\htmlClass` 之类的扩展执行任意 URL/属性。
 * `maxExpand` / `maxSize` 防 `\def` 递归膨胀把主线程卡死。
 */
export function renderMathToHtml(tex: string, options: KatexRenderOptions = {}): string | null {
  if (tex.trim() === "") return null;

  try {
    const html = katex.renderToString(tex, {
      throwOnError: false,
      trust: false,
      strict: "ignore",
      displayMode: options.displayMode ?? false,
      maxExpand: 1000,
      maxSize: 50,
      output: "htmlAndMathml",
    });
    if (ERROR_MARKERS.some((marker) => html.includes(marker))) return null;
    return html;
  } catch {
    return null;
  }
}

/** 纯文本是否包含公式片段，用于决定要不要走 KaTeX 分支。 */
export function containsMath(input: string): boolean {
  return splitMath(input).some((segment) => segment.kind === "math");
}

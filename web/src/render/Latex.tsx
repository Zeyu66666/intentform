/**
 * 数学文本渲染 —— 全项目**唯一**允许 `dangerouslySetInnerHTML` 的地方。
 *
 * `AGENTS.md` §5 的例外条款只放行 KaTeX 输出（`trust: false`、`strict`）。
 * 为了让这条例外可审计，它被收窄到本文件的一个 `<span>` 上：
 * - 输入永远先过 `splitMath()`，`$...$` 之外的文本以 React 文本节点渲染（不经 innerHTML）；
 * - 公式走 `renderMathToHtml()`，内部固定 `trust: false`，`\href`/`\htmlClass` 之类不会执行；
 * - KaTeX 失败（语法错误、递归膨胀）返回 `null`，这里降级成 `<code>{tex}</code>`，
 *   不让一个坏公式把整张卡片渲染成白屏。
 */

import { Fragment, useMemo } from "react";

import { renderMathToHtml, splitMath } from "./katex";

export interface MathSpanProps {
  readonly tex: string;
  /** 块级公式用 `$$` 场景（说明/解析里偶尔会用到）。 */
  readonly displayMode?: boolean;
}

export function MathSpan({ tex, displayMode = false }: MathSpanProps): JSX.Element {
  const html = useMemo(() => renderMathToHtml(tex, { displayMode }), [tex, displayMode]);

  if (html === null) {
    // 降级：保留可读原文，读者至少能看到"这里有个公式没渲染出来"。
    return (
      <code className="rounded-sm bg-bg px-[4px] py-[1px] text-sm text-[color:var(--color-danger)]">
        {tex}
      </code>
    );
  }

  return (
    <span
      className="inline-block max-w-full align-middle"
      // eslint-disable-next-line -- 全局唯一例外：KaTeX 输出，trust:false 且 trust 已在 katex.ts 固定
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export interface MathTextProps {
  readonly text: string;
}

/**
 * 行内混排：普通文本 + `$...$` 公式。
 *
 * 换行必须变成**结构**而不是只靠 CSS：`white-space: pre-line` 在普通浏览器里能保留
 * 换行，但打印、导出 Word 与 SSR 测试都不该各自赌一次 CSS 是否生效。这里把文本段
 * 按 `\n` 切开，逐段插入 `<br />`——打印页与 DOM 看到的是同一条换行，多问题干
 * （「（1）……\n（2）……」）不会挤成一整行。
 *
 * 外层仍保留 `whitespace-pre-line`：它负责折叠行内连续空格，`<br />` 负责换行，
 * 两者分工，不重复。
 */
export function MathText({ text }: MathTextProps): JSX.Element {
  const segments = useMemo(() => splitMath(text), [text]);

  return (
    <span className="whitespace-pre-line">
      {segments.map((segment, index) =>
        segment.kind === "text" ? (
          <Fragment key={`t${String(index)}`}>{withLineBreaks(segment.text)}</Fragment>
        ) : (
          <MathSpan key={`m${String(index)}`} tex={segment.tex} />
        ),
      )}
    </span>
  );
}

/** 文本段内的换行渲染成 `<br />`；`\r\n` 与单独的 `\r` 都按一个换行处理。 */
function withLineBreaks(text: string): readonly JSX.Element[] {
  const lines = text.split(/\r\n|\r|\n/u);
  return lines.map((line, index) => (
    <Fragment key={`l${String(index)}`}>
      {index === 0 ? null : <br />}
      {line}
    </Fragment>
  ));
}
